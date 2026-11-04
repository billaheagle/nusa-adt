// In-memory server answering the ADT subset Nusa Studio uses. Doubles as an executable
// description of what the local ABAP runner must serve (docs/RUNNER-PROTOCOL.md).
import { HttpRequest, HttpResponse, HttpTransport } from '../src/adt/client';

interface Obj { uri: string; name: string; type: string; pkg: string; desc: string; src: Record<string, string>; active: Record<string, string>; lock?: string }

export class FakeAdtServer implements HttpTransport {
  objs: Obj[] = [{
    uri: '/sap/bc/adt/oo/classes/zcl_demo', name: 'ZCL_DEMO', type: 'CLAS/OC', pkg: 'ZDEMO', desc: 'Demo',
    src: { main: 'CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\nENDCLASS.\n' }, active: {},
  }];
  log: string[] = [];
  bodies: Record<string, string> = {};
  transports: { id: string; desc: string; objs: string[] }[] = [];
  // debugger: a listener waits until a class run reaches a breakpoint; the run waits until resumed
  private bps = 0;
  private listener: ((body: string) => void) | null = null;
  private resume: (() => void) | null = null;

  constructor() { this.objs[0].active = { ...this.objs[0].src }; }

  private ok(body = '', status = 200): HttpResponse { return { status, headers: {}, body }; }
  private find(path: string) { return this.objs.find(o => path === o.uri || path.startsWith(o.uri + '/')); }

  async request(_conn: string, r: HttpRequest): Promise<HttpResponse> {
    const q = r.query || {};
    this.log.push(`${r.method} ${r.path}${q._action ? ' ' + q._action : ''}`);
    const p = r.path;
    if (p === '/sap/bc/adt/discovery') return this.ok('<app:service xmlns:app="http://www.w3.org/2007/app"><app:workspace><app:collection href="/sap/bc/adt/oo/classes"/></app:workspace></app:service>');
    if (p === '/sap/bc/adt/system/components') return this.ok('', 404);
    if (p === '/sap/bc/adt/activation/inactiveobjects') {
      const list = this.objs.filter(o => JSON.stringify(o.src) !== JSON.stringify(o.active));
      return this.ok(`<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">${list.map(o => `<ioc:entry><ioc:object><ioc:ref adtcore:uri="${o.uri}"/></ioc:object></ioc:entry>`).join('')}</ioc:inactiveObjects>`.replace(/ioc:ref/g, 'adtcore:objectReference'));
    }
    if (p === '/sap/bc/adt/repository/nodestructure') {
      const list = this.objs.filter(o => o.pkg === q.parent_name);
      return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TREE_CONTENT>${list.map(o => `<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>${o.type}</OBJECT_TYPE><OBJECT_NAME>${o.name}</OBJECT_NAME><OBJECT_URI>${o.uri}</OBJECT_URI><DESCRIPTION>${o.desc}</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>`).join('')}</TREE_CONTENT></DATA></asx:values></asx:abap>`);
    }
    if (p === '/sap/bc/adt/cts/transportchecks') {
      const reqs = this.transports.map(t => `<CTS_REQUEST><REQ_HEADER><TRKORR>${t.id}</TRKORR><AS4USER>DEV</AS4USER><AS4TEXT>${t.desc}</AS4TEXT></REQ_HEADER></CTS_REQUEST>`).join('');
      return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><RECORDING>X</RECORDING><LOCKS/><REQUESTS>${reqs}</REQUESTS></DATA></asx:values></asx:abap>`);
    }
    if (p === '/sap/bc/adt/cts/transports') {
      const id = `NPLK9${String(this.transports.length + 1).padStart(5, '0')}`;
      const desc = (r.body || '').match(/<REQUEST_TEXT>(.*?)<\/REQUEST_TEXT>/)?.[1] || '';
      this.transports.push({ id, desc, objs: [] });
      return this.ok(`/com.sap.cts/object_record/${id}`);
    }
    if (p === '/sap/bc/adt/quickfixes/evaluation') {
      this.bodies.quickfix = r.body || '';
      return this.ok(`<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core"><evaluationResult><adtcore:objectReference adtcore:uri="/sap/bc/adt/quickfixes/declare" adtcore:name="Declare local variable LV_X" adtcore:description="DATA lv_x TYPE i."/><userContent>U&amp;1</userContent></evaluationResult></qf:evaluationResults>`);
    }
    if (p === '/sap/bc/adt/quickfixes/declare') {
      this.bodies.fix = r.body || '';
      return this.ok(`<qf:proposalResult xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core"><deltas><unit><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo/source/main#start=4,0;end=4,0" adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC"/><content>    DATA lv_x TYPE i.
</content></unit></deltas></qf:proposalResult>`);
    }
    if (p === '/sap/bc/adt/refactorings') {
      this.bodies[String(q.step)] = r.body || '';
      const gen = (oldN: string, newN: string) => `<generic:genericRefactoring><generic:title>Rename Field</generic:title><generic:affectedObjects><generic:affectedObject adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC" adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo/source/main"><generic:textReplaceDeltas><generic:textReplaceDelta><generic:rangeFragment>#start=1,6;end=1,14</generic:rangeFragment><generic:contentOld>${oldN}</generic:contentOld><generic:contentNew>${newN}</generic:contentNew></generic:textReplaceDelta></generic:textReplaceDeltas><generic:userContent/></generic:affectedObject></generic:affectedObjects><generic:transport/><generic:userContent/></generic:genericRefactoring>`;
      const NS = 'xmlns:adtcore="http://www.sap.com/adt/core" xmlns:generic="http://www.sap.com/adt/refactoring/genericrefactoring" xmlns:rename="http://www.sap.com/adt/refactoring/renamerefactoring"';
      if (q.step === 'evaluate') return this.ok(`<?xml version="1.0" encoding="utf-8"?><rename:renameRefactoring ${NS}><rename:oldName>ZCL_DEMO</rename:oldName><rename:newName/>${gen('zcl_demo', 'zcl_demo')}<rename:userContent/></rename:renameRefactoring>`);
      const newName = (r.body || '').match(/<rename:newName>([^<]*)</)?.[1] || 'x';
      if (q.step === 'preview') return this.ok(`<?xml version="1.0" encoding="utf-8"?><rename:renameRefactoring ${NS}><rename:oldName>ZCL_DEMO</rename:oldName><rename:newName>${newName}</rename:newName>${gen('zcl_demo', newName)}<rename:userContent/></rename:renameRefactoring>`);
      if (q.step === 'execute') {
        const to = (r.body || '').match(/<generic:contentNew>([^<]*)</)?.[1] || '';
        const o = this.objs[0];
        o.src.main = o.src.main.replace('zcl_demo', to);
        return this.ok(r.body || '');
      }
    }
    if (p === '/sap/bc/adt/debugger/breakpoints') {
      this.bps = ((r.body || '').match(/<breakpoint /g) || []).length;
      return this.ok(`<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger">${(r.body || '').match(/<breakpoint [^>]*\/>/g)?.join('') || ''}</dbg:breakpoints>`);
    }
    if (p === '/sap/bc/adt/debugger/listeners') {
      if (r.method === 'DELETE') { this.listener?.(''); this.listener = null; return this.ok(); }
      return new Promise(res => { this.listener = body => res(this.ok(body)); });
    }
    if (p === '/sap/bc/adt/debugger/stack') return this.ok('<dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core"><stackEntry stackPosition="1" programName="ZCL_DEMO" eventName="IF_OO_ADT_CLASSRUN~MAIN" adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo/source/main#start=4,4"/></dbg:stack>');
    if (p === '/sap/bc/adt/debugger') {
      if (q.method === 'attach') return this.ok('<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true"/>');
      if (q.method === 'getChildVariables') {
        const parent = (r.body || '').match(/<PARENT_ID>([^<]*)</)?.[1];
        const kids = parent === '@ROOT' ? [['@LOCALS', '', '', '']] : parent === '@LOCALS' ? [['LV_N', 'I', 'simple', '42'], ['LT_X', 'STRING_TABLE', 'table', '']] : [];
        return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><HIERARCHIES>${kids.map(k => `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${parent}</PARENT_ID><CHILD_ID>${k[0]}</CHILD_ID></STPDA_ADT_VARIABLE_HIERARCHY>`).join('')}</HIERARCHIES><VARIABLES>${kids.map(k => `<STPDA_ADT_VARIABLE><ID>${k[0]}</ID><NAME>${k[0]}</NAME><DECLARED_TYPE_NAME>${k[1]}</DECLARED_TYPE_NAME><META_TYPE>${k[2]}</META_TYPE><VALUE>${k[3]}</VALUE><TABLE_LINES>2</TABLE_LINES></STPDA_ADT_VARIABLE>`).join('')}</VARIABLES></DATA></asx:values></asx:abap>`);
      }
      if (q.method === 'getVariables') {
        const ids = [...(r.body || '').matchAll(/<ID>([^<]*)</g)].map(m => m[1]);
        return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>${ids.map((id, i) => `<STPDA_ADT_VARIABLE><ID>${id}</ID><NAME>${id}</NAME><META_TYPE>simple</META_TYPE><VALUE>row ${i + 1}</VALUE></STPDA_ADT_VARIABLE>`).join('')}</DATA></asx:values></asx:abap>`);
      }
      if (q.method === 'setVariableValue') { this.bodies.setValue = `${q.variableName}=${r.body}`; return this.ok(''); }
      if (q.method === 'stepContinue') { this.resume?.(); this.resume = null; return this.ok('<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="false"/>'); }
      if (q.method === 'terminateDebuggee') { this.resume?.(); this.resume = null; return this.ok(''); }
      return this.ok('<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true"/>');
    }
    const trDoc = p.match(/^\/sap\/bc\/adt\/cts\/transportrequests\/(\w+)$/);
    if (trDoc) {
      const t = this.transports.find(x => x.id === trDoc[1]);
      if (!t) return this.ok('<exc:exception xmlns:exc="x"><localizedMessage>Request does not exist</localizedMessage></exc:exception>', 404);
      if (r.method === 'DELETE') { this.transports = this.transports.filter(x => x !== t); return this.ok(); }
      if (r.method === 'PUT') { t.desc = (r.body || '').match(/<tm:request [^>]*tm:desc="([^"]*)"/)?.[1] ?? t.desc; return this.ok(r.body); }
      return this.ok(`<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:object_type="K"><tm:request tm:number="${t.id}" tm:desc="${t.desc}" tm:owner="DEV"><tm:task tm:number="${t.id}T" tm:desc="${t.desc}"/></tm:request></tm:root>`);
    }
    if (p === '/sap/bc/adt/cts/transportrequests') {
      return this.ok(`<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:workbench><tm:target><tm:modifiable>${this.transports.map(t => `<tm:request tm:number="${t.id}" tm:owner="DEV" tm:desc="${t.desc}">${t.objs.map(n => `<tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="${n}"/>`).join('')}</tm:request>`).join('')}</tm:modifiable></tm:target></tm:workbench></tm:root>`);
    }
    if (p === '/sap/bc/adt/checkruns') return this.ok('<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkReport><chkrun:checkMessageList/></chkrun:checkReport></chkrun:checkRunReports>');
    if (p === '/sap/bc/adt/activation') {
      const uris = [...(r.body || '').matchAll(/adtcore:uri="([^"]+)"/g)].map(m => m[1]);
      // like SAP: activation runs in its own session and stops at an editor's enqueue lock
      const locked = uris.map(u => this.find(u)).find(o => o && o.lock);
      if (locked) return this.ok(`<exc:exception xmlns:exc="x"><localizedMessage>User DEV is currently editing ${locked.name}</localizedMessage></exc:exception>`, 400);
      for (const u of uris) { const o = this.find(u); if (o) o.active = { ...o.src }; }
      return this.ok('');
    }
    if (p.startsWith('/sap/bc/adt/oo/classrun/')) {
      const out = this.ok('Hello from ' + p.split('/').pop());
      if (!this.bps || !this.listener) return out;
      this.listener('<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><STPDA_DEBUGGEE><CLIENT>001</CLIENT><DEBUGGEE_ID>DBG42</DEBUGGEE_ID><TERMINAL_ID>T</TERMINAL_ID><IDE_ID>I</IDE_ID><DEBUGGEE_USER>DEV</DEBUGGEE_USER></STPDA_DEBUGGEE></DATA></asx:values></asx:abap>');
      this.listener = null;
      return new Promise(res => { this.resume = () => res(out); });
    }
    if (p.startsWith('/nusa/run/programs/')) return this.ok('list output');
    const o = this.find(p);
    if (!o) return this.ok('<exc:exception xmlns:exc="x"><localizedMessage>Resource does not exist</localizedMessage></exc:exception>', 404);
    if (r.method === 'POST' && q._action === 'LOCK') {
      if (!r.stateful) return this.ok('<exc:exception xmlns:exc="x"><localizedMessage>Lock requires a stateful session</localizedMessage></exc:exception>', 400);
      o.lock = 'H' + Date.now();
      return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>${o.lock}</LOCK_HANDLE><CORRNR/><IS_LOCAL/></DATA></asx:values></asx:abap>`);
    }
    if (r.method === 'POST' && q._action === 'UNLOCK') { o.lock = undefined; return this.ok(); }
    const inc = p.endsWith('/source/main') ? 'main' : (p.match(/\/includes\/(\w+)$/) || [])[1];
    if (inc && r.method === 'GET') {
      const src = (q.version === 'active' ? o.active : o.src)[inc];
      return src === undefined ? this.ok('', 404) : this.ok(src);
    }
    if (inc && r.method === 'PUT') {
      if (q.lockHandle !== o.lock) return this.ok('<exc:exception xmlns:exc="x"><localizedMessage>Object is not locked</localizedMessage></exc:exception>', 423);
      if (inc !== 'main' && o.src[inc] === undefined) return this.ok('', 404);
      o.src[inc] = r.body || '';
      if (q.corrNr) this.transports.find(t => t.id === q.corrNr)?.objs.push(o.name);
      return this.ok();
    }
    if (p.endsWith('/includes') && r.method === 'POST') { const kind = (r.body || '').match(/includeType="(\w+)"/)?.[1] || ''; o.src[kind] = ''; return this.ok(); }
    if (r.method === 'GET' && p === o.uri) {
      const inactive = JSON.stringify(o.src) !== JSON.stringify(o.active);
      return this.ok(`<class:abapClass xmlns:class="x" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${o.name}" adtcore:type="${o.type}" adtcore:description="${o.desc}" adtcore:version="${inactive ? 'inactive' : 'active'}"><adtcore:packageRef adtcore:name="${o.pkg}"/></class:abapClass>`);
    }
    return this.ok('', 405);
  }
}
