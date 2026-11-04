// ADT REST client. One instance per connection. The transport underneath (Rust in the
// desktop app) owns cookies, CSRF tokens, sap-client/sap-language, auth and the stateful
// session; this file only knows ADT URLs, payloads and responses.

import { asxValues, attr, all, base64Utf8, decode, encode, first, kid, kids, parseStart, parseXml, textOf, XEl } from './xml';
import {
  ADT_TYPE, adtTypeOf, BindingInfo, GitRepo, Include, NewPackage, ObjRef, ObjType, PkgRef, PreviewResult, Transport, TYPE_INFO, ValueHelpItem,
} from '../core/types';

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

export { ADT_TYPE };

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
  async nodeStructure(pkg: string): Promise<{ packages: PkgRef[]; objects: ObjRef[] }> {
    const r = await this.req({
      method: 'POST', path: '/sap/bc/adt/repository/nodestructure',
      query: { parent_type: 'DEVC/K', parent_name: pkg, withShortDescriptions: 'true' },
      accept: 'application/vnd.sap.as+xml', contentType: 'application/vnd.sap.as+xml',
    });
    return parseNodeStructure(r.body, pkg);
  }

  async searchPackages(query: string, max = 50): Promise<PkgRef[]> {
    const list = await this.searchObjects(query.includes('*') ? query : query + '*', 'DEVC/K', max);
    return list.map(o => ({ name: o.name, desc: o.desc }));
  }

  async packageValueHelp(kind: 'softwarecomponents' | 'transportlayers'): Promise<ValueHelpItem[]> {
    const r = await this.req({ method: 'GET', path: `/sap/bc/adt/packages/valuehelps/${kind}`, accept: 'application/*' });
    return parseNamedItems(r.body);
  }

  async createPackage(p: NewPackage, user: string, transport?: string): Promise<void> {
    const n = encode(p.name.toUpperCase());
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<pak:package xmlns:pak="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:description="${encode(p.desc)}" adtcore:name="${n}" adtcore:type="DEVC/K" adtcore:version="active" adtcore:responsible="${encode(user.toUpperCase())}">
  <adtcore:packageRef adtcore:name="${n}"/>
  <pak:attributes pak:packageType="${p.packageType}"/>
  <pak:superPackage adtcore:name="${encode(p.superPackage.toUpperCase())}"/>
  <pak:applicationComponent/>
  <pak:transport>
    <pak:softwareComponent pak:name="${encode(p.softwareComponent)}"/>
    <pak:transportLayer pak:name="${encode(p.transportLayer)}"/>
  </pak:transport>
  <pak:translation/>
  <pak:useAccesses/>
  <pak:packageInterfaces/>
  <pak:subPackages/>
</pak:package>`;
    await this.req({ method: 'POST', path: '/sap/bc/adt/packages', query: { corrNr: transport }, contentType: 'application/*', accept: 'application/*', body });
  }

  async deleteObject(uri: string, handle: string, transport?: string): Promise<void> {
    await this.req({ method: 'DELETE', path: uri, query: { lockHandle: handle, corrNr: transport }, stateful: true });
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
      type: adtTypeOf(attr(root, 'type') || ''),
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

  async createObject(type: ObjType, name: string, desc: string, pkg: string, user: string, transport?: string, extra: { serviceDefinition?: string; bindingType?: 'V2' | 'V4'; category?: 'UI' | 'Web API' } = {}): Promise<string> {
    const n = encode(name.toUpperCase()), d = encode(desc), p = encode(pkg), u = encode(user.toUpperCase());
    const core = 'xmlns:adtcore="http://www.sap.com/adt/core"';
    const common = `adtcore:description="${d}" adtcore:name="${n}" adtcore:type="${TYPE_INFO[type].adtType}" adtcore:responsible="${u}" adtcore:masterLanguage="EN"`;
    const pkgRef = `<adtcore:packageRef adtcore:name="${p}"/>`;
    const blue = (t: string) => `<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" ${core} ${common.replace(TYPE_INFO[type].adtType, t)}>${pkgRef}</blue:blueSource>`;
    const v4 = (extra.bindingType ?? 'V4') === 'V4';
    if (TYPE_INFO[type].editor === 'xml') return this.createByExample(type, name, desc, pkg, user, transport);
    const bodies: Partial<Record<ObjType, [string, string]>> = {
      CLAS: ['/sap/bc/adt/oo/classes', `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" ${core} ${common} class:final="true" class:visibility="public">${pkgRef}<class:include adtcore:name="CLAS/OC" adtcore:type="CLAS/OC" class:includeType="testclasses"/><class:superClassRef/></class:abapClass>`],
      INTF: ['/sap/bc/adt/oo/interfaces', `<intf:abapInterface xmlns:intf="http://www.sap.com/adt/oo/interfaces" ${core} ${common}>${pkgRef}</intf:abapInterface>`],
      PROG: ['/sap/bc/adt/programs/programs', `<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" ${core} ${common}>${pkgRef}</program:abapProgram>`],
      TABL: ['/sap/bc/adt/ddic/tables', blue('TABL/DT')],
      DDLS: ['/sap/bc/adt/ddic/ddl/sources', `<ddl:ddlSource xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources" ${core} ${common}>${pkgRef}</ddl:ddlSource>`],
      DDLX: ['/sap/bc/adt/ddic/ddlx/sources', `<ddlxsources:ddlxSource xmlns:ddlxsources="http://www.sap.com/adt/ddic/ddlxsources" ${core} ${common}>${pkgRef}</ddlxsources:ddlxSource>`],
      DCLS: ['/sap/bc/adt/acm/dcl/sources', `<dclSource:dclSource xmlns:dclSource="http://www.sap.com/adt/acm/dclsources" ${core} ${common}>${pkgRef}</dclSource:dclSource>`],
      BDEF: ['/sap/bc/adt/bo/behaviordefinitions', blue('BDEF/BDO')],
      SRVD: ['/sap/bc/adt/ddic/srvd/sources', `<srvd:srvdSource xmlns:srvd="http://www.sap.com/adt/ddic/srvdsources" ${core} ${common} srvd:srvdSourceType="S">${pkgRef}</srvd:srvdSource>`],
      SRVB: ['/sap/bc/adt/businessservices/bindings', `<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ${core} ${common} srvb:releaseSupported="false" srvb:published="false" srvb:bindingCreated="true">${pkgRef}<srvb:services srvb:name="${n}"><srvb:content srvb:version="0001"><srvb:serviceDefinition adtcore:name="${encode((extra.serviceDefinition || '').toUpperCase())}"/></srvb:content></srvb:services><srvb:binding srvb:type="ODATA" srvb:version="${v4 ? 'V4' : 'V2'}" srvb:category="${extra.category === 'Web API' ? '1' : '0'}"><srvb:implementation adtcore:name=""/></srvb:binding></srvb:serviceBinding>`],
    };
    const [path, xml] = bodies[type] as [string, string];
    await this.req({ method: 'POST', path, query: { corrNr: transport }, contentType: 'application/*', body: `<?xml version="1.0" encoding="UTF-8"?>${xml}` });
    return TYPE_INFO[type].adt + encodeURIComponent(name.toLowerCase());
  }

  // ------------------------------------------------------------------ form-based objects (XML documents)
  /** The object's XML document and its media type, which a later PUT must send back. */
  async objectXml(uri: string): Promise<{ xml: string; contentType: string }> {
    const r = await this.req({ method: 'GET', path: uri, accept: 'application/*' });
    return { xml: r.body, contentType: (r.headers['content-type'] || 'application/xml').split(';')[0].trim() };
  }

  async putObjectXml(uri: string, xml: string, contentType: string, lock: string, transport?: string): Promise<void> {
    await this.req({ method: 'PUT', path: uri, query: { lockHandle: lock, corrNr: transport }, stateful: true, contentType: `${contentType}; charset=utf-8`, body: xml });
  }

  /**
   * Creates a form-based object (IAM app, communication scenario, authorization object, …).
   * Their XML formats differ per type and release, so the format is taken from an existing
   * object of the same type in the system: same root element, namespaces and media type,
   * posted to the same collection with the new name, description and package.
   */
  async createByExample(type: ObjType, name: string, desc: string, pkg: string, user: string, transport?: string): Promise<string> {
    const code = TYPE_INFO[type].adtType || type;
    const examples = await this.searchObjects('*', code, 5).catch(() => []);
    const ex = examples.find(e => e.uri && e.uri.includes('/sap/bc/adt/') && !e.uri.includes('/vit/'));
    if (!ex) throw new AdtError(`This system has no ${TYPE_INFO[type].label} that Nusa Studio can use as a model for the format, so it cannot create one yet. Create the first one in Eclipse ADT; after that Nusa Studio can create and edit more.`, 400);
    const { xml, contentType } = await this.objectXml(ex.uri);
    const body = newObjectXml(xml, { name, desc, pkg, user });
    const collection = ex.uri.replace(/\/[^/]+$/, '');
    const r = await this.req({ method: 'POST', path: collection, query: { corrNr: transport }, contentType, accept: 'application/*', body });
    const loc = r.headers.location || r.headers['content-location'] || '';
    return loc ? loc.replace(/^https?:\/\/[^/]+/, '') : `${collection}/${encodeURIComponent(name.toLowerCase())}`;
  }

  // ------------------------------------------------------------------ business services
  async bindingInfo(uri: string): Promise<BindingInfo> {
    const r = await this.req({ method: 'GET', path: uri, accept: 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml, application/*' });
    return parseBinding(r.body);
  }

  async publishBinding(b: BindingInfo, publish: boolean): Promise<string> {
    const svc = b.services[0];
    const ver = b.odataVersion === 'V2' ? 'odatav2' : 'odatav4';
    const r = await this.req({
      method: 'POST', path: `/sap/bc/adt/businessservices/${ver}/${publish ? 'publishjobs' : 'unpublishjobs'}`,
      query: { servicename: b.name, serviceversion: svc?.version || '0001' },
      contentType: 'application/xml', accept: 'application/*',
      body: `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:type="SCGR" adtcore:name="${encode(b.name)}"/></adtcore:objectReferences>`,
    });
    const x = parseXml(r.body);
    const sev = textOf(x, 'SEVERITY'), text = textOf(x, 'SHORT_TEXT') || textOf(x, 'LONG_TEXT');
    if (/^(ERROR|E|A)$/i.test(sev)) throw new AdtError(text || 'Publishing failed', 400);
    return text || (publish ? 'Service published' : 'Service unpublished');
  }

  // ------------------------------------------------------------------ data preview
  async dataPreview(req: { entity?: string; sql?: string; rows: number }): Promise<PreviewResult> {
    const started = Date.now();
    const sql = req.sql || (req.entity ? `SELECT * FROM ${req.entity.toUpperCase()}` : '');
    const r = await this.req({
      method: 'POST',
      path: req.entity && !req.sql ? '/sap/bc/adt/datapreview/ddic' : '/sap/bc/adt/datapreview/freestyle',
      query: req.entity && !req.sql ? { rowNumber: String(req.rows), ddicEntityName: req.entity.toUpperCase() } : { rowNumber: String(req.rows) },
      contentType: 'text/plain', accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml', body: sql,
    });
    return { ...parseDataPreview(r.body), sql, ms: Date.now() - started };
  }

  // ------------------------------------------------------------------ abapGit (ADT abapGit service, BTP / S/4HANA Cloud / recent on-premise)
  async gitRepos(): Promise<GitRepo[]> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/abapgit/repos', accept: 'application/abapgit.adt.repos.v2+xml' });
    return parseGitRepos(r.body);
  }
  private gitBody(x: { pkg?: string; url?: string; branch?: string; transport?: string; user?: string; password?: string }) {
    const t = (k: string, v?: string) => v ? `<abapgitrepo:${k}>${encode(v)}</abapgitrepo:${k}>` : `<abapgitrepo:${k}/>`;
    return `<?xml version="1.0" encoding="UTF-8"?><abapgitrepo:repository xmlns:abapgitrepo="http://www.sap.com/adt/abapgit/repositories">${t('branchName', x.branch)}${t('transportRequest', x.transport)}${t('package', x.pkg?.toUpperCase())}${t('url', x.url)}${t('remoteUser', x.user)}${t('remotePassword', x.password)}</abapgitrepo:repository>`;
  }
  async gitLink(x: { pkg: string; url: string; branch: string; transport?: string; user?: string; password?: string }): Promise<void> {
    await this.req({ method: 'POST', path: '/sap/bc/adt/abapgit/repos', contentType: 'application/abapgit.adt.repo.v3+xml', accept: 'application/*', body: this.gitBody(x) });
  }
  async gitPull(key: string, x: { branch?: string; transport?: string; user?: string; password?: string }): Promise<void> {
    await this.req({ method: 'POST', path: `/sap/bc/adt/abapgit/repos/${encodeURIComponent(key)}/pull`, contentType: 'application/abapgit.adt.repo.v3+xml', accept: 'application/*', body: this.gitBody(x), timeoutMs: 600_000 });
  }
  async gitUnlink(key: string): Promise<void> {
    await this.req({ method: 'DELETE', path: `/sap/bc/adt/abapgit/repos/${encodeURIComponent(key)}` });
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

  /** Who is logged on, as the system sees it (browser logon does not tell us the user ID). */
  async systemInformation(): Promise<{ userName?: string; systemID?: string; client?: string }> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/core/http/systeminformation', accept: 'application/vnd.sap.adt.core.http.systeminformation.v1+json, application/json' });
    try { return JSON.parse(r.body); } catch { return {}; }
  }

  /**
   * Requests of the user. Older systems answer the user query; newer ones (S/4HANA Cloud,
   * recent BTP) list requests through the Transport Organizer search configuration that
   * Eclipse keeps per user, so that is tried when the user query brings nothing.
   */
  async userTransports(user: string): Promise<Transport[]> {
    let first: unknown;
    const byUser = await this.transportTree({ user: user || undefined, targets: 'true' }).catch(e => { first = e; return [] as Transport[]; });
    if (byUser.length) return byUser;
    let configs = await this.transportConfigurations().catch(() => [] as string[]);
    if (!configs.length && user) configs = await this.createTransportConfiguration(user).catch(() => [] as string[]);
    for (const configUri of configs) {
      const list = await this.transportTree({ targets: 'true', configUri }).catch(() => [] as Transport[]);
      if (list.length) return list;
    }
    if (first && !configs.length) throw first;
    return byUser;
  }

  private async transportTree(query: Record<string, string | undefined>): Promise<Transport[]> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/cts/transportrequests', query, accept: 'application/vnd.sap.adt.transportorganizertree.v1+xml' });
    return parseTransportTree(r.body);
  }

  /** Links of the user's Transport Organizer search configurations (made by Eclipse ADT). */
  async transportConfigurations(): Promise<string[]> {
    const r = await this.req({ method: 'GET', path: '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations', accept: 'application/vnd.sap.adt.configurations.v1+xml' });
    return parseConfigLinks(r.body);
  }

  /**
   * What Eclipse does the first time its Transport Organizer opens: create a search
   * configuration (POST without a body), then make sure it lists the user's modifiable
   * workbench requests. Only the properties it needs are changed; the rest keep SAP's defaults.
   */
  async createTransportConfiguration(user: string): Promise<string[]> {
    const CFG = 'application/vnd.sap.adt.configuration.v1+xml';
    await this.req({ method: 'POST', path: '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations', accept: CFG });
    const links = await this.transportConfigurations();
    for (const uri of links) {
      const r = await this.req({ method: 'GET', path: uri, accept: CFG });
      const xml = withConfigProperties(r.body, { User: user, WorkbenchRequests: 'true', Modifiable: 'true' });
      const etag = r.headers?.etag || r.headers?.ETag;
      if (xml !== r.body) {
        await this.req({ method: 'PUT', path: uri, accept: CFG, contentType: CFG, body: xml, headers: etag ? { 'If-Match': etag } : undefined }).catch(() => undefined);
      }
    }
    return links;
  }

  /** Deletes a request (its tasks go with it), as in Eclipse's Transport Organizer. */
  async deleteTransport(id: string): Promise<void> {
    await this.req({ method: 'DELETE', path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}`, accept: 'application/*' });
  }

  /**
   * New short description: the request document is read, its description changed and written
   * back (the transport request editor of ADT). Older releases only know user actions on
   * tm:root, so that form is tried when the first is refused.
   */
  async changeTransportDesc(id: string, desc: string): Promise<void> {
    const TM = 'application/vnd.sap.adt.transportorganizer.v1+xml';
    const path = `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}`;
    let first: unknown;
    try {
      const r = await this.req({ method: 'GET', path, accept: TM });
      const doc = setTransportDesc(r.body, id, desc);
      if (doc) { await this.req({ method: 'PUT', path, accept: TM, contentType: TM, body: doc }); return; }
    } catch (e) { first = e; }
    const body = `<?xml version="1.0" encoding="UTF-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${encode(id)}" tm:desc="${encode(desc)}" tm:useraction="changeattributes"/>`;
    try { await this.req({ method: 'PUT', path, accept: 'application/*', contentType: 'application/*', body }); }
    catch (e) { throw first instanceof AdtError ? first : e; }
  }

  private async transportDocument(id: string): Promise<string> {
    return (await this.req({ method: 'GET', path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}`, accept: TM_DOC })).body;
  }
  private async putTransportDocument(id: string, xml: string): Promise<void> {
    await this.req({ method: 'PUT', path: `/sap/bc/adt/cts/transportrequests/${encodeURIComponent(id)}`, accept: TM_DOC, contentType: TM_DOC, body: xml });
  }

  /**
   * Removes object entries ("R3TR CLAS ZCL_X") from a request and its tasks, the way the
   * request editor saves its object list. The objects themselves stay. Checked afterwards,
   * because a release that ignores the change answers without an error.
   */
  async removeFromTransport(id: string, entries: string[]): Promise<void> {
    const doc = await this.transportDocument(id);
    const r = removeTransportEntries(doc, entries);
    if (!r.removed) throw new AdtError(`${entries.join(', ')} ${entries.length === 1 ? 'is' : 'are'} not in ${id}`, 400);
    await this.putTransportDocument(id, r.xml);
    const after = await this.transportDocument(id);
    const still = entries.filter(e => hasTransportEntry(after, e));
    if (still.length) throw new AdtError(`${id} still holds ${still.join(', ')}: this system does not accept changes to the object list from ADT. Use SE09 for it.`, 400);
  }

  /** Adds object entries to a request (into its task when it has one) and checks the result. */
  async addToTransport(id: string, task: string | undefined, entries: string[]): Promise<void> {
    const doc = await this.transportDocument(id);
    const xml = addTransportEntries(doc, task || id, entries) ?? addTransportEntries(doc, id, entries);
    if (!xml) throw new AdtError(`${id} was not found in the answer of the system`, 400);
    await this.putTransportDocument(id, xml);
    const after = await this.transportDocument(id);
    const missing = entries.filter(e => !hasTransportEntry(after, e));
    if (missing.length) throw new AdtError(`${id} did not take ${missing.join(', ')}: this system does not accept changes to the object list from ADT. Use SE09 for it.`, 400);
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

export function parseNodeStructure(body: string, pkg: string): { packages: PkgRef[]; objects: ObjRef[] } {
  const objects: ObjRef[] = [];
  const packages: PkgRef[] = [];
  const x = parseXml(body);
  // folder names the system uses for each type ("Function Groups", "Message Classes", …)
  const labels = new Map(all(x, 'SEU_ADT_OBJECT_TYPE_INFO').map(t => [textOf(t, 'OBJECT_TYPE'), textOf(t, 'OBJECT_TYPE_LABEL')] as [string, string]));
  for (const n of all(x, 'SEU_ADT_REPOSITORY_OBJ_NODE')) {
    const raw = textOf(n, 'OBJECT_TYPE');
    const name = textOf(n, 'OBJECT_NAME');
    if (raw === 'DEVC/K') {
      if (name && name.toUpperCase() !== pkg.toUpperCase() && !packages.some(p => p.name === name)) packages.push({ name, desc: textOf(n, 'DESCRIPTION') });
      continue;
    }
    if (!raw || !textOf(n, 'OBJECT_URI') || !name) continue;
    const type = adtTypeOf(raw);
    const o: ObjRef = { uri: textOf(n, 'OBJECT_URI'), name, type, pkg, desc: textOf(n, 'DESCRIPTION') };
    if (type === 'XOBJ') { o.adtType = raw; o.typeLabel = labels.get(raw) || raw.split('/')[0]; }
    objects.push(o);
  }
  return { packages, objects };
}

export function parseNamedItems(body: string): ValueHelpItem[] {
  return all(parseXml(body), 'namedItem').map(i => ({ name: textOf(i, 'name'), desc: textOf(i, 'description') })).filter(i => i.name);
}

export function parseBinding(body: string): BindingInfo {
  const x = parseXml(body);
  const root = x.children.find(c => c.local === 'serviceBinding') || x.children[0];
  const binding = first(root, 'binding');
  const ver = (attr(binding, 'version') || '').toUpperCase();
  const cat = attr(binding, 'category');
  const services = all(root, 'services').flatMap(s => all(s, 'content').map(c => ({
    name: attr(s, 'name') || '', version: attr(c, 'version') || '0001',
    serviceDefinition: attr(first(c, 'serviceDefinition'), 'name') || '',
    published: (attr(c, 'releaseState') || attr(root, 'published') || '').toLowerCase() === 'true' || attr(c, 'published') === 'true',
  })));
  const published = attr(root, 'published') === 'true' || services.some(s => s.published);
  return {
    name: attr(root, 'name') || '', desc: attr(root, 'description') || '',
    bindingType: ((attr(binding, 'type') || 'ODATA').toUpperCase() as BindingInfo['bindingType']),
    odataVersion: ver === 'V2' || ver === 'V4' ? ver : '',
    category: cat === '1' ? 'Web API' : 'UI',
    services: services.map(s => ({ ...s, published: s.published || published })), published,
  };
}

export function parseDataPreview(body: string): { columns: { name: string; type: string; desc: string; key?: boolean }[]; rows: string[][]; totalRows: number } {
  const x = parseXml(body);
  const cols = all(x, 'columns');
  const columns = cols.map(c => {
    const m = first(c, 'metadata');
    return { name: attr(m, 'name') || '', type: attr(m, 'type') || '', desc: attr(m, 'description') || '', key: attr(m, 'keyAttribute') === 'true' };
  });
  const data = cols.map(c => all(first(c, 'dataSet'), 'data').map(d => d.text));
  const n = Math.max(0, ...data.map(d => d.length));
  const rows = Array.from({ length: n }, (_, i) => data.map(col => col[i] ?? ''));
  return { columns, rows, totalRows: +textOf(x, 'totalRows') || n };
}

export function parseGitRepos(body: string): GitRepo[] {
  return all(parseXml(body), 'repository').map(r => ({
    key: textOf(r, 'key'), pkg: textOf(r, 'package'), url: textOf(r, 'url'), branch: textOf(r, 'branchName'),
    createdBy: textOf(r, 'createdBy'), status: textOf(r, 'status'), statusText: textOf(r, 'statusText'),
  })).filter(r => r.key);
}

export function parseObjectReferences(body: string): ObjRef[] {
  return all(parseXml(body), 'objectReference').map(r => ({
    uri: attr(r, 'uri') || '', name: attr(r, 'name') || '', type: adtTypeOf(attr(r, 'type') || ''),
    pkg: attr(r, 'packageName') || '', desc: attr(r, 'description') || '',
    ...(adtTypeOf(attr(r, 'type') || '') === 'XOBJ' ? { adtType: attr(r, 'type') || '', typeLabel: (attr(r, 'type') || '').split('/')[0] } : {}),
  })).filter(r => r.uri) as ObjRef[];
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

const TM_DOC = 'application/vnd.sap.adt.transportorganizer.v1+xml';
/** "R3TR CLAS ZCL_X"; the name is kept as it is (LIMU names contain blanks) */
const entryParts = (e: string) => { const m = /^\s*(\S+)\s+(\S+)\s+(.*?)\s*$/.exec(e) || ['', 'R3TR', '', e]; return { pgmid: m[1].toUpperCase(), type: m[2].toUpperCase(), name: m[3].toUpperCase() }; };
const OBJ_RE = /<((?:[\w.-]+:)?)abap_object\b([^>]*?)(?:\/>|>[\s\S]*?<\/\1abap_object>)/g;
function objAttrs(attrs: string) {
  const v = (k: string) => decode(new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${k}="([^"]*)"`).exec(attrs)?.[1] ?? '').toUpperCase();
  return { pgmid: v('pgmid') || 'R3TR', type: v('type'), name: v('name') };
}
const sameEntry = (a: { pgmid: string; type: string; name: string }, b: { pgmid: string; type: string; name: string }) => a.pgmid === b.pgmid && a.type === b.type && a.name === b.name;

/** The request document without the given object entries ("R3TR CLAS ZCL_X"), wherever they sit. */
export function removeTransportEntries(xml: string, entries: string[]): { xml: string; removed: number } {
  const want = entries.map(entryParts);
  let removed = 0;
  const out = xml.replace(OBJ_RE, (m, _p: string, attrs: string) => {
    const a = objAttrs(attrs);
    if (!want.some(w => sameEntry(w, a))) return m;
    removed++;
    return '';
  });
  return { xml: out, removed };
}

export function hasTransportEntry(xml: string, entry: string): boolean {
  const w = entryParts(entry);
  for (const m of xml.matchAll(OBJ_RE)) if (sameEntry(w, objAttrs(m[2]))) return true;
  return false;
}

/** Adds entries under the task or request with this number; null when it is not in the document. */
export function addTransportEntries(xml: string, number: string, entries: string[]): string | null {
  const re = new RegExp(`<((?:[\\w.-]+:)?)(task|request)\\b([^>]*\\bnumber="${number}"[^>]*?)(/?)>`);
  const m = re.exec(xml);
  if (!m) return null;
  const [all_, p, el, attrs, self] = m;
  const add = [...new Set(entries.map(e => JSON.stringify(entryParts(e))))].map(j => JSON.parse(j) as ReturnType<typeof entryParts>)
    .filter(e => !hasTransportEntry(xml, `${e.pgmid} ${e.type} ${e.name}`))
    .map(e => `<${p}abap_object ${p}pgmid="${encode(e.pgmid)}" ${p}type="${encode(e.type)}" ${p}name="${encode(e.name)}"/>`).join('');
  const open = `<${p}${el}${attrs}>`;
  return xml.replace(all_, self ? `${open}${add}</${p}${el}>` : `${open}${add}`);
}

/** The request document with a new description on the request itself (not on its tasks); root as a fallback. */
export function setTransportDesc(xml: string, id: string, desc: string): string | null {
  for (const el of ['request', 'root']) {
    let done = false;
    const re = new RegExp(`<([\\w.-]+:)?${el}\\b([^>]*)>`, 'g');
    const out = xml.replace(re, (m, p = '', attrs: string) => {
      if (done || !new RegExp(`\\bnumber="${id}"`).test(attrs)) return m;
      done = true;
      const value = `="${encode(desc)}"`;
      return /\b([\w.-]+:)?desc="[^"]*"/.test(attrs)
        ? m.replace(/\b(([\w.-]+:)?desc)="[^"]*"/, `$1${value}`)
        : m.replace(/(\/?>)$/, ` ${p}desc${value}$1`);
    });
    if (done) return out;
  }
  return null;
}

export function parseConfigLinks(body: string): string[] {
  const BASE = '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations';
  const hrefs = new Set<string>();
  const add = (h: string) => {
    let p = h.trim().replace(/^https?:\/\/[^/]+/, '');
    if (!p.startsWith('/')) p = `${BASE}/${p.replace(/^\.\//, '').replace(/^configurations\//, '')}`; // relative link
    if (p.replace(/\/+$/, '') !== BASE) hrefs.add(p);
  };
  const walk = (el: XEl, inConfig: boolean) => {
    const here = inConfig || el.local === 'configuration';
    const h = attr(el, 'href');
    // any link inside a configuration entry, or anything that looks like one
    if (h && ((here && el.local === 'link') || /searchconfiguration\/configurations\/./.test(h))) add(h);
    el.children.forEach(c => walk(c, here));
  };
  walk(parseXml(body), false);
  return [...hrefs];
}

/** Sets configuration:property values in a search configuration document, adding missing ones. */
export function withConfigProperties(xml: string, props: Record<string, string>): string {
  let out = xml;
  for (const [k, v] of Object.entries(props)) {
    const re = new RegExp(`(<([\\w-]+:)?property\\b[^>]*\\bkey="${k}"[^>]*?)(/>|>([^<]*)</([\\w-]+:)?property>)`);
    const m = re.exec(out);
    if (m) {
      if ((m[4] ?? '') === v) continue;
      const tag = (m[2] || '') + 'property';
      out = out.replace(re, `${m[1]}>${encode(v)}</${tag}>`);
    } else {
      const pm = /<([\w-]+:)?properties\s*\/>|<\/([\w-]+:)?properties>/.exec(out);
      if (!pm) continue;
      const pre = pm[1] || pm[2] || '';
      const el = `<${pre}property key="${k}">${encode(v)}</${pre}property>`;
      out = pm[0].endsWith('/>') ? out.replace(pm[0], `<${pre}properties>${el}</${pre}properties>`) : out.replace(pm[0], el + pm[0]);
    }
  }
  return out;
}

export function parseTransportTree(body: string): Transport[] {
  const out: Transport[] = [];
  // status of a request: from the folder it sits in, else from its own status attribute
  const own = (c: XEl): Transport['status'] => /^[RN]$/.test(attr(c, 'status') || '') ? 'released' : 'modifiable';
  const walk = (el: XEl, status: Transport['status'] | null) => {
    for (const c of el.children) {
      let st = status;
      if (c.local === 'modifiable') st = 'modifiable';
      if (c.local === 'released' || c.local === 'relstarted') st = 'released';
      if (c.local === 'request') {
        st = st || own(c);
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

/** XML for a new form-based object, modelled on an existing one: root element, namespaces and adtcore:type are kept. */
export function newObjectXml(example: string, o: { name: string; desc: string; pkg: string; user: string }): string {
  const m = /<([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*|[A-Za-z_][\w.-]*)(\s[^>]*?)?\/?>/.exec(example.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, ''));
  if (!m) throw new AdtError('The model object has no XML document', 400);
  const root = m[1];
  const attrs = m[2] || '';
  const ns = [...attrs.matchAll(/\sxmlns(:[\w.-]+)?="[^"]*"/g)].map(x => x[0].trim());
  if (!ns.some(n => n.startsWith('xmlns:adtcore='))) ns.push('xmlns:adtcore="http://www.sap.com/adt/core"');
  const type = /\sadtcore:type="([^"]*)"/.exec(attrs)?.[1];
  const lang = /\sadtcore:masterLanguage="([^"]*)"/.exec(attrs)?.[1] || 'EN';
  const a = [
    ...ns,
    `adtcore:name="${encode(o.name.toUpperCase())}"`,
    `adtcore:description="${encode(o.desc)}"`,
    ...(type ? [`adtcore:type="${encode(type)}"`] : []),
    `adtcore:masterLanguage="${encode(lang)}"`,
    `adtcore:responsible="${encode(o.user.toUpperCase())}"`,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><${root} ${a.join(' ')}><adtcore:packageRef adtcore:name="${encode(o.pkg.toUpperCase())}"/></${root}>`;
}
