// In-memory server answering the ADT subset Nusa ADT uses. Doubles as an executable
// description of what the local ABAP runner must serve (docs/RUNNER-PROTOCOL.md).
import { HttpRequest, HttpResponse, HttpTransport } from '../src/adt/client';

interface Obj { uri: string; name: string; type: string; pkg: string; desc: string; src: Record<string, string>; active: Record<string, string>; lock?: string }

export class FakeAdtServer implements HttpTransport {
  objs: Obj[] = [{
    uri: '/sap/bc/adt/oo/classes/zcl_demo', name: 'ZCL_DEMO', type: 'CLAS/OC', pkg: 'ZDEMO', desc: 'Demo',
    src: { main: 'CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\nENDCLASS.\n' }, active: {},
  }];
  log: string[] = [];
  transports: { id: string; desc: string; objs: string[] }[] = [];

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
    if (p === '/sap/bc/adt/cts/transportrequests') {
      return this.ok(`<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:workbench><tm:target><tm:modifiable>${this.transports.map(t => `<tm:request tm:number="${t.id}" tm:owner="DEV" tm:desc="${t.desc}">${t.objs.map(n => `<tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="${n}"/>`).join('')}</tm:request>`).join('')}</tm:modifiable></tm:target></tm:workbench></tm:root>`);
    }
    if (p === '/sap/bc/adt/checkruns') return this.ok('<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkReport><chkrun:checkMessageList/></chkrun:checkReport></chkrun:checkRunReports>');
    if (p === '/sap/bc/adt/activation') {
      const uris = [...(r.body || '').matchAll(/adtcore:uri="([^"]+)"/g)].map(m => m[1]);
      for (const u of uris) { const o = this.find(u); if (o) o.active = { ...o.src }; }
      return this.ok('');
    }
    if (p.startsWith('/sap/bc/adt/oo/classrun/')) return this.ok('Hello from ' + p.split('/').pop());
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
