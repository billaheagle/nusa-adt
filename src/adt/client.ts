// ADT REST client. One instance per connection. The transport underneath (Rust in the
// desktop app) owns cookies, CSRF tokens, sap-client/sap-language, auth and the stateful
// session; this file only knows ADT URLs, payloads and responses.

import { asxValues, attr, all, base64Utf8, encode, first, kid, kids, parseStart, parseXml, textOf, XEl } from './xml';
import { Include, ObjRef, ObjType, Transport, TYPE_INFO } from '../core/types';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: string;
  stateful?: boolean;          // send X-sap-adt-sessiontype: stateful on the connection's stateful session
  timeoutMs?: number;
}
export interface HttpResponse { status: number; headers: Record<string, string>; body: string }
export interface HttpTransport { request(conn: string, req: HttpRequest): Promise<HttpResponse> }

export class AdtError extends Error {
  constructor(message: string, readonly status: number, readonly type?: string) { super(message); }
}

export const ADT_TYPE: Record<string, ObjType> = { 'CLAS/OC': 'CLAS', 'INTF/OI': 'INTF', 'PROG/P': 'PROG', 'DDLS/DF': 'DDLS' };
const ADT_TYPE_OF: Record<ObjType, string> = { CLAS: 'CLAS/OC', INTF: 'INTF/OI', PROG: 'PROG/P', DDLS: 'DDLS/DF' };

export interface AdtMessage { type: string; text: string; uri: string; line: number; col: number }
export interface LockInfo { handle: string; transport?: string; isLocal: boolean }
export interface TransportCheck { recording: boolean; lockedIn?: string; requests: { id: string; desc: string; owner: string }[] }

export function sourceUrl(uri: string, include: Include): string {
  return include === 'main' ? `${uri}/source/main` : `${uri}/includes/${include}`;
}
/** Split an ADT source URI back into object URI and include. */
export function splitSourceUrl(u: string): { uri: string; include: Include } {
  const path = u.split('#')[0];
  let m = path.match(/^(.*)\/source\/main$/);
  if (m) return { uri: m[1], include: 'main' };
  m = path.match(/^(.*)\/includes\/(definitions|implementations|macros|testclasses|main)$/);
  if (m) return { uri: m[1], include: m[2] as Include };
  return { uri: path, include: 'main' };
}

export class AdtClient {
  constructor(private http: HttpTransport, readonly conn: string) {}

  async req(r: HttpRequest & { accept?: string; contentType?: string }): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...(r.headers || {}) };
    if (r.accept) headers.Accept = r.accept;
    if (r.contentType) headers['Content-Type'] = r.contentType;
    const res = await this.http.request(this.conn, { ...r, headers });
    if (res.status >= 400) throw AdtClient.error(res);
    return res;
  }

  static error(res: HttpResponse): AdtError {
    if (/<exc:exception|<exception/.test(res.body)) {
      const x = parseXml(res.body);
      const msg = textOf(x, 'localizedMessage') || textOf(x, 'message') || `HTTP ${res.status}`;
      return new AdtError(msg, res.status, attr(first(x, 'type'), 'id'));
    }
    if (res.status === 401) return new AdtError('Logon failed. Check user and password, or log in again.', 401);
    if (res.status === 403) return new AdtError('No authorization for this ADT service (HTTP 403).', 403);
    const plain = res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    return new AdtError(plain || `HTTP ${res.status}`, res.status);
  }

  // ------------------------------------------------------------------ system
  async discovery(): Promise<string[]> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/discovery', accept: 'application/atomsvc+xml' });
    return all(parseXml(r.body), 'collection').map(c => attr(c, 'href') || '').filter(Boolean);
  }

  async components(): Promise<string[]> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/system/components', accept: 'application/atom+xml;type=feed' });
    return all(parseXml(r.body), 'entry').map(e => {
      const id = textOf(e, 'id');
      const rel = attr(first(e, 'release') || undefined, 'value') || textOf(e, 'title');
      return rel && id ? `${id} ${rel}` : id || rel;
    }).filter(Boolean);
  }

  // ------------------------------------------------------------------ repository
  async nodeStructure(pkg: string): Promise<ObjRef[]> {
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/repository/nodestructure',
      query: { parent_type: 'DEVC/K', parent_name: pkg, withShortDescriptions: 'true' },
      accept: 'application/vnd.sap.as+xml', contentType: 'application/vnd.sap.as+xml',
    });
    return parseNodeStructure(r.body, pkg);
  }

  async quickSearch(query: string, max = 50): Promise<ObjRef[]> {
    const q = query.includes('*') ? query : query + '*';
    const r = await this.req({
      method: 'GET', path: '/sap/bc/adt/repository/informationsystem/search',
      query: { operation: 'quickSearch', query: q.toUpperCase(), maxResults: String(max) }, accept: 'application/xml',
    });
    return parseObjectReferences(r.body);
  }

  /** Repository search with an ADT object type filter (TABL, DDLS, DTEL, CLAS, INTF, FUGR/FF, …). */
  async searchObjects(query: string, objectType: string, max = 50): Promise<{ uri: string; name: string; type: string; desc: string; pkg: string }[]> {
    const r = await this.req({
      method: 'GET', path: '/sap/bc/adt/repository/informationsystem/search',
      query: { operation: 'quickSearch', query: query.toUpperCase(), maxResults: String(max), objectType }, accept: 'application/xml',
    });
    return all(parseXml(r.body), 'objectReference').map(o => ({
      uri: attr(o, 'uri') || '', name: attr(o, 'name') || '', type: attr(o, 'type') || '', desc: attr(o, 'description') || '', pkg: attr(o, 'packageName') || '',
    }));
  }

  async objectMeta(uri: string): Promise<{ inactive: boolean; pkg: string; desc: string; name: string; type?: ObjType; lockedBy?: string }> {
    const r = await this.req({ method: 'GET', path: uri, accept: 'application/*' });
    const root = parseXml(r.body).children[0];
    return {
      inactive: attr(root, 'version') === 'inactive',
      pkg: attr(first(root, 'packageRef'), 'name') || '',
      desc: attr(root, 'description') || '',
      name: attr(root, 'name') || '',
      type: ADT_TYPE[attr(root, 'type') || ''],
      lockedBy: attr(root, 'lockedBy') || undefined,
    };
  }

  /** URIs of the user's inactive objects. */
  async inactiveObjects(): Promise<string[]> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/activation/inactiveobjects', accept: 'application/vnd.sap.adt.inactivectsobjects.v1+xml, application/xml;q=0.8' });
    return all(parseXml(r.body), 'objectReference').map(o => attr(o, 'uri') || '').filter(Boolean);
  }

  async source(url: string, version: 'active' | 'inactive' = 'inactive'): Promise<string> {
    const r = await this.req({ method: 'GET', path: url, query: { version: version === 'active' ? 'active' : 'workingArea' }, accept: 'text/plain' });
    return r.body;
  }

  async lock(uri: string): Promise<LockInfo> {
    const r = await this.req({
      method: 'POST', path: uri, query: { _action: 'LOCK', accessMode: 'MODIFY' }, stateful: true,
      accept: 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result',
    });
    const x = parseXml(r.body);
    return { handle: textOf(x, 'LOCK_HANDLE'), transport: textOf(x, 'CORRNR') || undefined, isLocal: textOf(x, 'IS_LOCAL') === 'X' };
  }

  async unlock(uri: string, handle: string): Promise<void> {
    await this.req({ method: 'POST', path: uri, query: { _action: 'UNLOCK', lockHandle: handle }, stateful: true });
  }

  async setSource(url: string, source: string, handle: string, transport?: string): Promise<void> {
    await this.req({
      method: 'PUT', path: url, query: { lockHandle: handle, corrNr: transport }, stateful: true,
      contentType: 'text/plain; charset=utf-8', accept: 'text/plain', body: source,
    });
  }

  /** Test classes include does not exist until created. */
  async createInclude(uri: string, include: Include, handle: string, transport?: string): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><class:abapClassInclude xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="dummy" class:includeType="${include}"/>`;
    await this.req({ method: 'POST', path: `${uri}/includes`, query: { lockHandle: handle, corrNr: transport }, stateful: true, contentType: 'application/*', body });
  }

  async createObject(type: ObjType, name: string, desc: string, pkg: string, user: string, transport?: string): Promise<string> {
    const n = encode(name.toUpperCase()), d = encode(desc), p = encode(pkg), u = encode(user);
    const core = 'xmlns:adtcore="http://www.sap.com/adt/core"';
    const common = `adtcore:description="${d}" adtcore:name="${n}" adtcore:type="${ADT_TYPE_OF[type]}" adtcore:responsible="${u}"`;
    const pkgRef = `<adtcore:packageRef adtcore:name="${p}"/>`;
    const bodies: Record<ObjType, [string, string]> = {
      CLAS: ['/sap/bc/adt/oo/classes', `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" ${core} ${common} class:final="true" class:visibility="public">${pkgRef}<class:include adtcore:name="CLAS/OC" adtcore:type="CLAS/OC" class:includeType="testclasses"/><class:superClassRef/></class:abapClass>`],
      INTF: ['/sap/bc/adt/oo/interfaces', `<intf:abapInterface xmlns:intf="http://www.sap.com/adt/oo/interfaces" ${core} ${common}>${pkgRef}</intf:abapInterface>`],
      PROG: ['/sap/bc/adt/programs/programs', `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ${core} ${common}>${pkgRef}</program:abapProgram>`],
      DDLS: ['/sap/bc/adt/ddic/ddl/sources', `<ddl:ddlSource xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources" ${core} ${common}>${pkgRef}</ddl:ddlSource>`],
    };
    const [path, xml] = bodies[type];
    await this.req({ method: 'POST', path, query: { corrNr: transport }, contentType: 'application/*', body: `<?xml version="1.0" encoding="UTF-8"?>${xml}` });
    return TYPE_INFO[type].adt + encodeURIComponent(name.toLowerCase());
  }

  // ------------------------------------------------------------------ transports
  async transportCheck(uri: string, pkg: string): Promise<TransportCheck> {
    const ct = 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData';
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/cts/transportchecks', accept: ct, contentType: ct,
      body: asxValues({ PGMID: '', OBJECT: '', OBJECTNAME: '', DEVCLASS: pkg, SUPER_PACKAGE: '', OPERATION: 'I', URI: uri }),
    });
    return parseTransportCheck(r.body);
  }

  async createTransport(uri: string, pkg: string, desc: string): Promise<string> {
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/cts/transports', accept: 'text/plain',
      contentType: 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest',
      body: asxValues({ OPERATION: 'I', DEVCLASS: pkg, REQUEST_TEXT: desc, REF: uri }),
    });
    const id = r.body.trim().split('/').pop() || '';
    if (!/^[A-Z0-9]{3}K\d{6}$/.test(id)) throw new AdtError(`Unexpected answer creating a request: ${r.body.slice(0, 120)}`, r.status);
    return id;
  }

  async userTransports(user: string): Promise<Transport[]> {
    const r = await this.req({
      method: 'GET', path: '/sap/bc/adt/cts/transportrequests', query: { user, targets: 'true' },
      accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml',
    });
    return parseTransportTree(r.body);
  }

  async releaseTransport(id: string, tasks: string[]): Promise<void> {
    for (const n of [...tasks, id]) {
      const r = await this.req({ method: 'POST', path: `/sap/bc/adt/cts/transportrequests/${n}/newreleasejobs`, accept: 'application/*' });
      const errs = all(parseXml(r.body), 'checkMessage').filter(m => /^[EA]$/.test(attr(m, 'type') || ''));
      if (errs.length) throw new AdtError(`${n}: ${attr(errs[0], 'shortText')}`, 400);
    }
  }

  // ------------------------------------------------------------------ checks and activation
  async activate(refs: { uri: string; name: string }[]): Promise<{ ok: boolean; messages: AdtMessage[] }> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs.map(r =>
      `<adtcore:objectReference adtcore:uri="${encode(r.uri)}" adtcore:name="${encode(r.name.toUpperCase())}"/>`).join('')}</adtcore:objectReferences>`;
    const r = await this.req({ method: 'POST', path: '/sap/bc/adt/activation', query: { method: 'activate', preauditRequested: 'true' }, contentType: 'application/xml', accept: 'application/xml', body });
    return parseActivation(r.body);
  }

  async syntaxCheck(uri: string, url: string, source: string): Promise<AdtMessage[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
<chkrun:checkObject adtcore:uri="${encode(uri)}" chkrun:version="inactive"><chkrun:artifacts><chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${encode(url)}"><chkrun:content>${base64Utf8(source)}</chkrun:content></chkrun:artifact></chkrun:artifacts></chkrun:checkObject></chkrun:checkObjectList>`;
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/checkruns', query: { reporters: 'abapCheckRun' },
      contentType: 'application/vnd.sap.adt.checkobjects+xml', accept: 'application/vnd.sap.adt.checkmessages+xml', body,
    });
    return parseCheckRun(r.body);
  }

  async prettyPrint(source: string): Promise<string> {
    const r = await this.req({ method: 'POST', path: '/sap/bc/adt/abapsource/prettyprinter', contentType: 'text/plain; charset=utf-8', accept: 'text/plain', body: source });
    return r.body;
  }

  // ------------------------------------------------------------------ code intelligence
  async completion(url: string, source: string, line: number, col: number): Promise<{ id: string; kind: string; prefix: number }[]> {
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/abapsource/codecompletion/proposal',
      query: { uri: `${url}#start=${line + 1},${col}`, signalCompleteness: 'true' },
      contentType: 'application/*', accept: 'application/*', body: source,
    });
    return all(parseXml(r.body), 'SCC_COMPLETION').map(e => ({ id: textOf(e, 'IDENTIFIER'), kind: textOf(e, 'KIND'), prefix: +textOf(e, 'PREFIXLENGTH') || 0 }))
      .filter(p => p.id && p.id !== '@end');
  }

  async findDefinition(url: string, source: string, line: number, col: number): Promise<{ uri: string; include: Include; line: number; col: number } | null> {
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/navigation/target',
      query: { uri: `${url}#start=${line + 1},${col}`, filter: 'definition' },
      contentType: 'text/plain', accept: 'application/xml', body: source,
    });
    const ref = first(parseXml(r.body), 'objectReference');
    const u = attr(ref, 'uri');
    if (!u) return null;
    const s = parseStart(u);
    const split = splitSourceUrl(s.path);
    return { ...split, line: s.line, col: s.col };
  }

  async usageReferences(url: string, line: number, col: number): Promise<{ uri: string; name: string; type: ObjType; text: string }[]> {
    const body = '<?xml version="1.0" encoding="ASCII"?><usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>';
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/repository/informationsystem/usageReferences',
      query: { uri: `${url}#start=${line + 1},${col}` },
      contentType: 'application/vnd.sap.adt.repository.usagereferences.request.v1+xml',
      accept: 'application/vnd.sap.adt.repository.usagereferences.result.v1+xml', body,
    });
    return parseUsages(r.body);
  }

  // ------------------------------------------------------------------ tests, ATC, run
  async unitRun(uri: string): Promise<UnitRaw[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
<external><coverage active="false"/></external>
<options><uriType value="semantic"/><testDeterminationStrategy sameProgram="true" assignedTests="false"/><testRiskLevels harmless="true" dangerous="true" critical="true"/><testDurations short="true" medium="true" long="true"/><withNavigationUri enabled="true"/></options>
<adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="${encode(uri)}"/></adtcore:objectReferences></objectSet></adtcore:objectSets>
</aunit:runConfiguration>`;
    const r = await this.req({ method: 'POST', path: '/sap/bc/adt/abapunit/testruns', contentType: 'application/*', accept: 'application/*', body });
    return parseUnit(r.body);
  }

  async atcRun(uri: string): Promise<AtcRaw[]> {
    const cust = await this.req({ method: 'GET', path: '/sap/bc/adt/atc/customizing', accept: 'application/xml, application/vnd.sap.atc.customizing-v1+xml' });
    const variant = attr(all(parseXml(cust.body), 'property').find(p => attr(p, 'name') === 'systemCheckVariant'), 'value') || 'DEFAULT';
    const wl = await this.req({ method: 'POST', path: '/sap/bc/adt/atc/worklists', query: { checkVariant: variant }, accept: 'text/plain' });
    const id = wl.body.trim();
    const body = `<?xml version="1.0" encoding="UTF-8"?><atc:run maximumVerdicts="100" xmlns:atc="http://www.sap.com/adt/atc"><objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="${encode(uri)}"/></adtcore:objectReferences></objectSet></objectSets></atc:run>`;
    await this.req({ method: 'POST', path: '/sap/bc/adt/atc/runs', query: { worklistId: id }, contentType: 'application/xml', accept: 'application/xml', body });
    const res = await this.req({ method: 'GET', path: `/sap/bc/adt/atc/worklists/${encodeURIComponent(id)}`, query: { includeExemptedFindings: 'false' }, accept: 'application/atc.worklist.v1+xml' });
    return parseAtc(res.body);
  }

  async classRun(name: string): Promise<string> {
    const r = await this.req({ method: 'POST', path: `/sap/bc/adt/oo/classrun/${encodeURIComponent(name.toUpperCase())}`, accept: 'text/plain' });
    return r.body;
  }
}

// ==================================================================== response parsers (exported for tests)

export function parseNodeStructure(body: string, pkg: string): ObjRef[] {
  const out: ObjRef[] = [];
  for (const n of all(parseXml(body), 'SEU_ADT_REPOSITORY_OBJ_NODE')) {
    const type = ADT_TYPE[textOf(n, 'OBJECT_TYPE')];
    if (!type) continue;
    out.push({ uri: textOf(n, 'OBJECT_URI'), name: textOf(n, 'OBJECT_NAME'), type, pkg, desc: textOf(n, 'DESCRIPTION') });
  }
  return out;
}

export function parseObjectReferences(body: string): ObjRef[] {
  return all(parseXml(body), 'objectReference').map(r => ({
    uri: attr(r, 'uri') || '', name: attr(r, 'name') || '', type: ADT_TYPE[attr(r, 'type') || ''],
    pkg: attr(r, 'packageName') || '', desc: attr(r, 'description') || '',
  })).filter(r => r.type && r.uri) as ObjRef[];
}

export function parseTransportCheck(body: string): TransportCheck {
  const x = parseXml(body);
  const requests = all(x, 'CTS_REQUEST').map(r => {
    const h = kid(r, 'REQ_HEADER');
    return { id: textOf(h, 'TRKORR'), desc: textOf(h, 'AS4TEXT'), owner: textOf(h, 'AS4USER') };
  }).filter(r => r.id);
  const lock = first(first(x, 'LOCKS'), 'TRKORR');
  return { recording: textOf(x, 'RECORDING') === 'X', lockedIn: lock ? lock.text.trim() : undefined, requests };
}

export function parseTransportTree(body: string): Transport[] {
  const out: Transport[] = [];
  const walk = (el: XEl, status: Transport['status'] | null) => {
    for (const c of el.children) {
      let st = status;
      if (c.local === 'modifiable') st = 'modifiable';
      if (c.local === 'released' || c.local === 'relstarted') st = 'released';
      if (c.local === 'request' && st) {
        const objects = new Set<string>();
        for (const o of all(c, 'abap_object')) objects.add(`${attr(o, 'pgmid') || 'R3TR'} ${attr(o, 'type')} ${attr(o, 'name')}`);
        const task = kids(c, 'task')[0];
        out.push({ id: attr(c, 'number') || '', desc: attr(c, 'desc') || '', owner: attr(c, 'owner') || '', status: st, task: attr(task, 'number'), objects: [...objects] });
        continue;
      }
      walk(c, st);
    }
  };
  walk(parseXml(body), null);
  return out;
}

export function parseActivation(body: string): { ok: boolean; messages: AdtMessage[] } {
  if (!body.trim()) return { ok: true, messages: [] };
  const x = parseXml(body);
  const messages = all(x, 'msg').map(m => {
    const s = parseStart(attr(m, 'href') || '');
    return { type: attr(m, 'type') || 'E', text: textOf(m, 'txt') || textOf(m, 'shortText'), uri: s.path, line: s.line, col: s.col };
  });
  const stillInactive = all(x, 'inactiveObjects').length > 0 && all(x, 'entry').length > 0;
  return { ok: !messages.some(m => /^[EA]$/.test(m.type)) && !stillInactive, messages };
}

export function parseCheckRun(body: string): AdtMessage[] {
  return all(parseXml(body), 'checkMessage').map(m => {
    const s = parseStart(attr(m, 'uri') || '');
    return { type: attr(m, 'type') || 'E', text: attr(m, 'shortText') || '', uri: s.path, line: s.line, col: s.col };
  });
}

export function parseUsages(body: string): { uri: string; name: string; type: ObjType; text: string }[] {
  return all(parseXml(body), 'referencedObject').map(o => {
    const a = first(o, 'adtObject');
    const type = ADT_TYPE[(attr(a, 'type') || '').split('/').slice(0, 2).join('/')] || 'CLAS';
    return { uri: attr(o, 'uri') || attr(a, 'uri') || '', name: attr(a, 'name') || '', type, text: attr(a, 'description') || attr(o, 'usageInformation') || '' };
  }).filter(h => h.uri && h.name);
}

export interface UnitRaw { cls: string; method: string; seconds: number; alerts: { kind: string; severity: string; title: string; uri?: string }[]; nav?: string }
export function parseUnit(body: string): UnitRaw[] {
  const out: UnitRaw[] = [];
  for (const c of all(parseXml(body), 'testClass')) {
    for (const m of all(c, 'testMethod')) {
      out.push({
        cls: attr(c, 'name') || '', method: attr(m, 'name') || '', seconds: parseFloat(attr(m, 'executionTime') || '0') || 0,
        nav: attr(m, 'navigationUri') || attr(m, 'uri'),
        alerts: all(m, 'alert').map(a => ({ kind: attr(a, 'kind') || '', severity: attr(a, 'severity') || '', title: textOf(a, 'title'), uri: attr(first(a, 'stackEntry'), 'uri') })),
      });
    }
  }
  return out;
}

export interface AtcRaw { prio: number; check: string; msg: string; location: string }
export function parseAtc(body: string): AtcRaw[] {
  return all(parseXml(body), 'finding').map(f => ({
    prio: +(attr(f, 'priority') || 3), check: attr(f, 'checkTitle') || '', msg: attr(f, 'messageTitle') || '', location: attr(f, 'location') || '',
  }));
}
