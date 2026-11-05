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
  /** like a release whose request editor ignores object list changes */
  ignoreObjectEdits = false;
  /** text pools per program (symbols, selections, headings), with their own lock */
  texts: Record<string, Record<string, string>> = {};
  private textLock = '';
  traceRequests: string[] = [];
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
    if (p === '/sap/bc/adt/repository/nodestructure' && q.parent_type !== 'FUGR/F') {
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
    const te = p.match(/^\/sap\/bc\/adt\/textelements\/programs\/([^/]+)(?:\/source\/(\w+))?$/);
    if (te) {
      const prog = decodeURIComponent(te[1]).toUpperCase();
      if (q._action === 'LOCK') { this.textLock = 'T' + Date.now(); return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><LOCK_HANDLE>${this.textLock}</LOCK_HANDLE></DATA></asx:values></asx:abap>`); }
      if (q._action === 'UNLOCK') { this.textLock = ''; return this.ok(); }
      const cat = te[2] || '';
      if (r.method === 'GET') { const v = this.texts[prog]?.[cat]; return v === undefined ? this.ok('', 404) : this.ok(v); }
      if (r.method === 'PUT') {
        if (!this.textLock || q.lockHandle !== this.textLock) return this.ok('<exc:exception xmlns:exc="x"><localizedMessage>Text elements are not locked</localizedMessage></exc:exception>', 423);
        (this.texts[prog] ||= {})[cat] = r.body || '';
        return this.ok();
      }
    }
    if (p === '/sap/bc/adt/runtime/traces/abaptraces/parameters') return { status: 201, headers: { location: '/sap/bc/adt/runtime/traces/abaptraces/parameters/P1' }, body: '' };
    if (p === '/sap/bc/adt/runtime/traces/abaptraces/requests') { this.traceRequests.push(`${q.traceUser}|${q.processType}|${q.parametersId}`); return this.ok('<feed/>'); }
    if (p === '/sap/bc/adt/runtime/traces/abaptraces') {
      return this.ok(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces"><atom:entry><atom:id>/sap/bc/adt/runtime/traces/abaptraces/AT1</atom:id><atom:title>ZCL_DEMO console run</atom:title><atom:published>2026-11-05T01:02:03Z</atom:published><trc:extendedData><trc:runtime>12000</trc:runtime><trc:runtimeABAP>3000</trc:runtimeABAP><trc:runtimeDatabase>9000</trc:runtimeDatabase><trc:runtimeSystem>0</trc:runtimeSystem><trc:objectName>ZCL_DEMO</trc:objectName></trc:extendedData></atom:entry></atom:feed>`);
    }
    if (p === '/sap/bc/adt/runtime/traces/abaptraces/AT1/hitlist') {
      return this.ok(`<trc:hitlist xmlns:trc="http://www.sap.com/adt/runtime/traces/abaptraces" xmlns:adtcore="http://www.sap.com/adt/core"><trc:entry trc:index="1" trc:hitCount="2" trc:description="Select ZTAB"><trc:calledProgram trc:context="ZCL_DEMO=====CP"/><trc:callingProgram trc:context="ZCL_DEMO=====CP" adtcore:uri="/sap/bc/adt/oo/classes/zcl_demo/source/main#start=3" adtcore:name="ZCL_DEMO"/><trc:grossTime trc:time="9000" trc:percentage="75"/><trc:traceEventNetTime trc:time="9000" trc:percentage="75"/></trc:entry></trc:hitlist>`);
    }
    if (p === '/sap/bc/adt/repository/nodestructure' && q.parent_type === 'FUGR/F') {
      const fg = String(q.parent_name).toLowerCase();
      return this.ok(`<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TREE_CONTENT><SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>FUGR/FF</OBJECT_TYPE><OBJECT_NAME>Z_DEMO_FM</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/functions/groups/${fg}/fmodules/z_demo_fm</OBJECT_URI><DESCRIPTION>Demo FM</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE><SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>FUGR/I</OBJECT_TYPE><OBJECT_NAME>L${fg.toUpperCase()}TOP</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/functions/groups/${fg}/includes/l${fg}top</OBJECT_URI><DESCRIPTION/></SEU_ADT_REPOSITORY_OBJ_NODE></TREE_CONTENT></DATA></asx:values></asx:abap>`);
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
      if (r.method === 'PUT') {
        t.desc = (r.body || '').match(/<tm:request [^>]*tm:desc="([^"]*)"/)?.[1] ?? t.desc;
        if (!this.ignoreObjectEdits) t.objs = [...(r.body || '').matchAll(/<tm:abap_object [^>]*tm:name="([^"]*)"/g)].map(m => m[1]);
        return this.ok(r.body);
      }
      const objs = t.objs.map(n => `<tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="${n}" tm:wbtype="CLAS/OC" tm:obj_desc="x"/>`).join('');
      return this.ok(`<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:object_type="K"><tm:request tm:number="${t.id}" tm:desc="${t.desc}" tm:owner="DEV">${t.objs.length ? `<tm:task tm:number="${t.id}T" tm:desc="${t.desc}">${objs}</tm:task>` : `<tm:task tm:number="${t.id}T" tm:desc="${t.desc}"/>`}</tm:request></tm:root>`);
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
    // runtime errors (ST22): the feed list names the default query, the feed answers with it
    if (p === '/sap/bc/adt/feeds') return this.ok(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:af="http://www.sap.com/adt/feeds"><atom:entry><atom:title>Runtime Errors</atom:title><atom:link href="/sap/bc/adt/runtime/dumps"/><af:extendedData><af:queryVariants><af:queryVariant af:queryString="$query=and(equals(user,DEV))" af:isDefault="true"/></af:queryVariants></af:extendedData></atom:entry></atom:feed>`);
    if (p === '/sap/bc/adt/runtime/dumps') {
      this.bodies.dumpsQuery = JSON.stringify(q);
      return this.ok(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:author><atom:name>DEV</atom:name></atom:author><atom:category term="ITAB_LINE_NOT_FOUND" label="ABAP runtime error"/><atom:category term="ZCL_DEMO=====CP" label="Terminated ABAP program"/><atom:id>/sap/bc/adt/runtime/dump/D1</atom:id><atom:link href="/sap/bc/adt/oo/classes/zcl_demo/source/main#start=3" rel="http://www.sap.com/adt/relations/objects"/><atom:title>ITAB_LINE_NOT_FOUND</atom:title><atom:updated>2026-11-05T01:00:00Z</atom:updated></atom:entry></atom:feed>`);
    }
    if (p === '/sap/bc/adt/runtime/dump/D1/formatted') return this.ok('Runtime Errors ITAB_LINE_NOT_FOUND\nShort Text: line not found');
    // version history
    const ver = p.match(/^(.*)\/source\/main\/versions(\/v1\/content)?$/);
    if (ver && r.method === 'GET') {
      if (ver[2]) return this.ok('OLD SOURCE');
      return this.ok(`<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core"><atom:entry><atom:author><atom:name>DEV</atom:name></atom:author><atom:content src="${p}/v1/content" type="text/plain"/><atom:id>00001</atom:id><atom:link href="/sap/bc/adt/cts/transportrequests/NPLK900001" adtcore:name="NPLK900001"/><atom:title>first</atom:title><atom:updated>2026-11-01T00:00:00Z</atom:updated></atom:entry></atom:feed>`);
    }
    // function groups and function modules
    if (r.method === 'POST' && p === '/sap/bc/adt/functions/groups') {
      this.bodies.fugr = r.body || '';
      const name = (r.body || '').match(/adtcore:name="([^"]+)"/)?.[1] || '';
      this.objs.push({ uri: `/sap/bc/adt/functions/groups/${name.toLowerCase()}`, name, type: 'FUGR/F', pkg: (r.body || '').match(/packageRef adtcore:name="([^"]+)"/)?.[1] || '', desc: '', src: { main: '' }, active: {} });
      return this.ok('', 201);
    }
    const fm = p.match(/^\/sap\/bc\/adt\/functions\/groups\/([^/]+)\/fmodules$/);
    if (fm && r.method === 'POST') {
      this.bodies.func = r.body || '';
      if (!this.find(`/sap/bc/adt/functions/groups/${fm[1]}`)) return this.ok('<exc:exception xmlns:exc="x"><localizedMessage>Function group does not exist</localizedMessage></exc:exception>', 404);
      const name = (r.body || '').match(/adtcore:name="([^"]+)"/)?.[1] || '';
      this.objs.push({ uri: `/sap/bc/adt/functions/groups/${fm[1]}/fmodules/${name.toLowerCase()}`, name, type: 'FUGR/FF', pkg: '', desc: '', src: { main: '' }, active: {} });
      return this.ok('', 201);
    }
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
      return this.ok(`<class:abapClass xmlns:class="x" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${o.name}" adtcore:type="${o.type}" adtcore:description="${o.desc}" adtcore:version="${inactive ? 'inactive' : 'active'}"><adtcore:packageRef adtcore:name="${o.pkg}"/><atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="source/main/versions" rel="http://www.sap.com/adt/relations/versions"/></class:abapClass>`);
    }
    return this.ok('', 405);
  }
}
