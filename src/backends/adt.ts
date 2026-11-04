// Backend for real systems: S/4HANA / NetWeaver on-premise, BTP ABAP Environment and the
// local ABAP runner (which serves a subset of the same ADT endpoints, see docs/RUNNER-PROTOCOL.md).

import { AdtClient, AdtError, HttpTransport, sourceUrl, splitSourceUrl } from '../adt/client';
import { AdtDebugger, StackFrame } from '../adt/debugger';
import * as R from '../adt/refactor';
import { KWSET, prettyPrint as localPretty } from '../core/abap';
import { completeAbap, completeCds } from '../core/complete';
import { RemoteCatalog } from '../adt/catalog';
import {
  AtcFinding, Backend, BindingInfo, Breakpoint, Connection, CreateExtra, DebugFrame, DebugState, DebugVar, ExtractStart, GitRepo, QuickFix,
  RefactorPreview, RenameStart, TextEdit, Hit, Include, isCdsLike, Location,
  NewPackage, ObjRef, ObjState, ObjType, PkgRef, PreviewResult, Problem, Proposal, RunResult, StepKind, SystemInfo, Transport,
  TransportNeed, TYPE_INFO, isSourceType, UnitResult, ValueHelpItem,
} from '../core/types';

export interface ConnStore {
  list(): Promise<Connection[]>;
  save(c: Connection, secret?: string): Promise<void>;
  remove(id: string): Promise<void>;
  resetSession(id: string): Promise<void>;
}

const sev = (t: string): Problem['sev'] => (/^[EA]$/.test(t) ? 'error' : t === 'W' ? 'warning' : 'info');

export class AdtBackend implements Backend {
  readonly id = 'adt';
  private clients = new Map<string, AdtClient>();
  private conns: Connection[] = [];
  private transportOf = new Map<string, string>();       // conn|uri -> request
  private trCache = new Map<string, Transport[]>();
  private inactive = new Map<string, Set<string>>();     // conn -> uris
  private dbg: { conn: string; d: AdtDebugger; run?: Promise<string>; obj?: ObjRef } | null = null;

  constructor(private http: HttpTransport, private store: ConnStore) {}

  private c(conn: string): AdtClient {
    let cl = this.clients.get(conn);
    if (!cl) { cl = new AdtClient(this.http, conn); this.clients.set(conn, cl); }
    return cl;
  }
  private info(conn: string): Connection {
    const c = this.conns.find(x => x.id === conn);
    if (!c) throw new Error(`Unknown system ${conn}`);
    return c;
  }

  includesOf(type: ObjType): Include[] {
    return type === 'CLAS' ? ['main', 'definitions', 'implementations', 'testclasses'] : ['main'];
  }

  async connections() { this.conns = await this.store.list(); return this.conns; }
  async saveConnection(c: Connection, secret?: string) { await this.store.save(c, secret); this.conns = await this.store.list(); }

  /** user IDs learned from the system, for browser logons where the user typed none */
  private users = new Map<string, string>();
  private userOf(conn: string) { return (this.info(conn).user || this.users.get(conn) || '').toUpperCase(); }

  async connect(conn: string): Promise<SystemInfo> {
    const cl = this.c(conn);
    await cl.discovery();
    const components = await cl.components().catch(() => [] as string[]);
    const basis = components.find(x => /^SAP_BASIS|^SAP_CLOUD/.test(x));
    const ci = this.info(conn);
    if (!ci.user && ci.kind !== 'runner') {
      const si = await cl.systemInformation().catch(() => ({} as { userName?: string }));
      if (si.userName) {
        this.users.set(conn, si.userName);
        // remember it, so the transport list and new objects carry the right owner next time
        await this.store.save({ ...ci, user: si.userName.toUpperCase() }).catch(() => undefined);
        this.conns = await this.store.list().catch(() => this.conns);
      }
    }
    await this.refreshInactive(conn);
    return { release: basis ? prettyRelease(basis) : (ci.kind === 'runner' ? 'Local ABAP runner' : 'Connected'), components };
  }

  private async refreshInactive(conn: string) {
    try { this.inactive.set(conn, new Set(await this.c(conn).inactiveObjects())); } catch { this.inactive.set(conn, new Set()); }
  }

  private withState(conn: string, o: ObjRef): ObjState {
    return { ...o, inactive: this.inactive.get(conn)?.has(o.uri) ?? false, transport: this.transportOf.get(conn + '|' + o.uri) };
  }

  async packageObjects(conn: string, pkg: string): Promise<ObjState[]> {
    return (await this.packageContents(conn, pkg)).objects;
  }

  async packageContents(conn: string, pkg: string): Promise<{ packages: PkgRef[]; objects: ObjState[] }> {
    const r = await this.c(conn).nodeStructure(pkg);
    return { packages: r.packages, objects: r.objects.map(o => this.withState(conn, o)) };
  }

  searchPackages(conn: string, query: string): Promise<PkgRef[]> { return this.c(conn).searchPackages(query); }
  async valueHelpObjects(conn: string, query: string, types: string[]) {
    const q = query.trim() ? (query.includes('*') ? query : query + '*') : '*';
    const lists = await Promise.all(types.map(t => this.c(conn).searchObjects(q, t, 50).catch(() => [])));
    return lists.flat().map(o => ({ name: o.name, desc: o.desc, type: o.type.split('/')[0], pkg: o.pkg }));
  }

  async valueHelp(conn: string, kind: 'softwarecomponents' | 'transportlayers'): Promise<ValueHelpItem[]> {
    try { return await this.c(conn).packageValueHelp(kind); } catch { return []; }
  }

  async createPackage(conn: string, p: NewPackage, transport?: string): Promise<PkgRef> {
    await this.c(conn).createPackage(p, this.userOf(conn), transport);
    return { name: p.name.toUpperCase(), desc: p.desc };
  }

  async deleteObject(conn: string, obj: ObjRef, transport?: string): Promise<void> {
    const cl = this.c(conn);
    const l = await cl.lock(obj.uri);
    try {
      await cl.deleteObject(obj.uri, l.handle, transport || l.transport);
    } catch (e) {
      await cl.unlock(obj.uri, l.handle).catch(() => undefined);
      throw e;
    }
    this.inactive.get(conn)?.delete(obj.uri);
    this.transportOf.delete(conn + '|' + obj.uri);
  }

  deleteConnection(id: string) { this.clients.delete(id); return this.store.remove(id); }
  resetSession(conn: string) { this.clients.delete(conn); return this.store.resetSession(conn); }

  bindingInfo(conn: string, obj: ObjRef): Promise<BindingInfo> { return this.c(conn).bindingInfo(obj.uri); }
  async publishBinding(conn: string, obj: ObjRef, publish: boolean): Promise<string> {
    const b = await this.c(conn).bindingInfo(obj.uri);
    return this.c(conn).publishBinding(b, publish);
  }

  dataPreview(conn: string, req: { entity?: string; sql?: string; rows: number }): Promise<PreviewResult> {
    return this.c(conn).dataPreview(req);
  }

  gitRepos(conn: string): Promise<GitRepo[]> { return this.c(conn).gitRepos(); }
  gitLink(conn: string, r: { pkg: string; url: string; branch: string; transport?: string; user?: string; password?: string }) { return this.c(conn).gitLink(r); }
  async gitPull(conn: string, key: string, transport?: string, user?: string, password?: string): Promise<string> {
    const repo = (await this.gitRepos(conn)).find(r => r.key === key);
    await this.c(conn).gitPull(key, { branch: repo?.branch, transport, user, password });
    return 'Pull started. abapGit imports the objects in the background; refresh the package to see them.';
  }
  gitUnlink(conn: string, key: string) { return this.c(conn).gitUnlink(key); }

  async search(conn: string, query: string): Promise<ObjRef[]> {
    if (!query.trim()) return [];
    return this.c(conn).quickSearch(query.trim());
  }

  /** media type of each form-based object's XML, sent back on save */
  private xmlType = new Map<string, string>();

  async read(conn: string, obj: ObjRef, include: Include, version: 'active' | 'inactive') {
    if (TYPE_INFO[obj.type].editor === 'xml') {
      const r = await this.c(conn).objectXml(version === 'active' ? `${obj.uri}?version=active` : obj.uri);
      this.xmlType.set(conn + '|' + obj.uri, r.contentType);
      return r.xml;
    }
    try {
      return await this.c(conn).source(sourceUrl(obj.uri, include), version);
    } catch (e) {
      if (e instanceof AdtError && e.status === 404 && include !== 'main') return '';
      throw e;
    }
  }

  async state(conn: string, obj: ObjRef): Promise<ObjState> {
    const m = await this.c(conn).objectMeta(obj.uri);
    const set = this.inactive.get(conn) || new Set<string>();
    if (m.inactive) set.add(obj.uri); else set.delete(obj.uri);
    this.inactive.set(conn, set);
    return { ...obj, pkg: m.pkg || obj.pkg, desc: m.desc || obj.desc, inactive: m.inactive, transport: this.transportOf.get(conn + '|' + obj.uri), lockedBy: m.lockedBy };
  }

  async lock(conn: string, obj: ObjRef) {
    const l = await this.c(conn).lock(obj.uri);
    if (l.transport) this.transportOf.set(conn + '|' + obj.uri, l.transport);
    return l.handle;
  }
  async unlock(conn: string, obj: ObjRef, handle: string) { await this.c(conn).unlock(obj.uri, handle); }

  async transportNeed(conn: string, obj: ObjRef): Promise<TransportNeed> {
    const ci = this.info(conn);
    if (!ci.transports || obj.pkg.startsWith('$')) return { needed: false, requests: [], reason: 'Local object' };
    const known = this.transportOf.get(conn + '|' + obj.uri);
    if (known) return { needed: false, current: known, requests: [] };
    const chk = await this.c(conn).transportCheck(obj.uri, obj.pkg);
    if (!chk.recording) return { needed: false, requests: [] };
    if (chk.lockedIn) { this.transportOf.set(conn + '|' + obj.uri, chk.lockedIn); return { needed: false, current: chk.lockedIn, requests: [] }; }
    return { needed: true, requests: chk.requests.map(r => ({ id: r.id, desc: r.desc, owner: r.owner, status: 'modifiable' as const, objects: [] })) };
  }

  async createTransport(conn: string, desc: string, obj: ObjRef) {
    return this.c(conn).createTransport(obj.uri || '/sap/bc/adt/packages/' + encodeURIComponent((obj.pkg || '').toLowerCase()), obj.pkg, desc);
  }

  async write(conn: string, obj: ObjRef, include: Include, source: string, lock: string, transport?: string) {
    const cl = this.c(conn);
    if (TYPE_INFO[obj.type].editor === 'xml') {
      if (TYPE_INFO[obj.type].readOnly) throw new Error('Nusa Studio shows this object type read-only. Change it in Eclipse ADT or SAP GUI.');
      const ct = this.xmlType.get(conn + '|' + obj.uri) || (await cl.objectXml(obj.uri)).contentType;
      await cl.putObjectXml(obj.uri, source, ct, lock, transport);
      if (transport) this.transportOf.set(conn + '|' + obj.uri, transport);
      this.inactive.get(conn)?.add(obj.uri);
      return;
    }
    const url = sourceUrl(obj.uri, include);
    try {
      await cl.setSource(url, source, lock, transport);
    } catch (e) {
      if (!(e instanceof AdtError && e.status === 404 && include !== 'main')) throw e;
      await cl.createInclude(obj.uri, include, lock, transport);
      await cl.setSource(url, source, lock, transport);
    }
    if (transport) this.transportOf.set(conn + '|' + obj.uri, transport);
    this.inactive.get(conn)?.add(obj.uri);
  }

  async createObject(conn: string, type: ObjType, name: string, desc: string, pkg: string, transport?: string, extra: CreateExtra = {}): Promise<ObjRef> {
    const uri = await this.c(conn).createObject(type, name, desc, pkg, this.userOf(conn), transport, extra);
    if (transport) this.transportOf.set(conn + '|' + uri, transport);
    this.inactive.get(conn)?.add(uri);
    return { uri, name: name.toUpperCase(), type, pkg, desc };
  }

  async syntaxCheck(conn: string, obj: ObjRef, include: Include, source: string): Promise<Problem[]> {
    if (!isSourceType(obj.type)) return [];
    const msgs = await this.c(conn).syntaxCheck(obj.uri, sourceUrl(obj.uri, include), source);
    return msgs.map(m => {
      const s = m.uri ? splitSourceUrl(m.uri) : { uri: obj.uri, include };
      return { sev: sev(m.type), msg: m.text, uri: s.uri || obj.uri, include: s.include, line: m.line, col: m.col, source: 'syntax' as const };
    });
  }

  async activate(conn: string, objs: ObjRef[]) {
    const r = await this.c(conn).activate(objs);
    await this.refreshInactive(conn);
    const problems = r.messages.map(m => {
      const s = m.uri ? splitSourceUrl(m.uri) : { uri: objs[0]?.uri || '', include: 'main' as Include };
      return { sev: sev(m.type), msg: m.text, uri: s.uri, include: s.include, line: m.line, col: m.col, source: 'activation' as const };
    });
    return { ok: r.ok, problems };
  }

  async prettyPrint(conn: string, source: string) {
    try { return await this.c(conn).prettyPrint(source); } catch (e) {
      if (this.info(conn).kind === 'runner') return localPretty(source);
      throw e;
    }
  }

  private catalogs = new Map<string, RemoteCatalog>();
  private relatedCache = new Map<string, { at: number; src: string[] }>();

  async complete(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Proposal[]> {
    if (!isSourceType(obj.type)) return [];
    let cat = this.catalogs.get(conn);
    if (!cat) { cat = new RemoteCatalog(this.c(conn)); this.catalogs.set(conn, cat); }
    const related = include === 'main' ? [] : await this.related(conn, obj);
    const req = { source, line, col, catalog: cat, cloud: this.info(conn).abapVersion === 'cloud', related };
    const local = await (isCdsLike(obj.type) ? completeCds(req) : completeAbap(req)).catch(() => [] as Proposal[]);
    if (isCdsLike(obj.type)) return local;
    // The server knows every context on its release; add what the local engine did not offer.
    let server: Proposal[] = [];
    try {
      const list = await this.c(conn).completion(sourceUrl(obj.uri, include), source, line, col);
      server = list.map(p => {
        const kw = KWSET.has(p.id.toUpperCase()) && p.id === p.id.toUpperCase();
        return { label: kw ? p.id : p.id.toLowerCase(), insert: kw ? p.id : p.id.toLowerCase(), kind: kw ? 'keyword' as const : 'variable' as const, detail: 'from system' };
      });
    } catch { /* offline or service missing: local proposals only */ }
    const seen = new Set(local.map(p => p.label.toLowerCase()));
    return [...local, ...server.filter(p => !seen.has(p.label.toLowerCase()))];
  }

  private async related(conn: string, obj: ObjRef): Promise<string[]> {
    const k = conn + '|' + obj.uri;
    const hit = this.relatedCache.get(k);
    if (hit && Date.now() - hit.at < 30_000) return hit.src;
    const src = [await this.read(conn, obj, 'main', 'inactive').catch(() => '')];
    this.relatedCache.set(k, { at: Date.now(), src });
    return src;
  }

  async navigate(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Location | null> {
    return this.c(conn).findDefinition(sourceUrl(obj.uri, include), source, line, col);
  }

  async whereUsed(conn: string, obj: ObjRef, include: Include, _source: string, line: number, col: number): Promise<Hit[]> {
    const list = await this.c(conn).usageReferences(sourceUrl(obj.uri, include), line, col);
    return list.map(h => ({ uri: h.uri, include: 'main' as Include, line: 0, name: h.name, type: h.type, text: h.text || h.name }));
  }

  async transports(conn: string): Promise<Transport[]> {
    const list = await this.c(conn).userTransports(this.userOf(conn));
    this.trCache.set(conn, list);
    return list;
  }

  async releaseTransport(conn: string, id: string) {
    const t = (this.trCache.get(conn) || []).find(x => x.id === id);
    await this.c(conn).releaseTransport(id, t?.task ? [t.task] : []);
    for (const [k, v] of this.transportOf) if (k.startsWith(conn + '|') && v === id) this.transportOf.delete(k);
  }

  async runUnit(conn: string, obj: ObjRef): Promise<UnitResult> {
    const raw = await this.c(conn).unitRun(obj.uri);
    const loc = (u?: string): Location | undefined => {
      if (!u) return undefined;
      const [path, frag = ''] = u.split('#');
      const m = frag.match(/start=(\d+)/);
      const s = splitSourceUrl(path);
      return { uri: s.uri, include: s.include, line: m ? +m[1] - 1 : 0 };
    };
    return {
      uri: obj.uri,
      methods: raw.map(m => {
        const fail = m.alerts.find(a => /critical|fatal|error/i.test(a.severity) || /failedAssertion|exception/i.test(a.kind));
        return {
          cls: m.cls.toLowerCase(), method: m.method.toLowerCase(), ms: Math.round(m.seconds * 1000),
          status: !fail ? 'ok' as const : /exception/i.test(fail.kind) ? 'error' as const : 'fail' as const,
          msg: fail?.title, at: loc(fail?.uri) || loc(m.nav),
        };
      }),
      note: this.inactive.get(conn)?.has(obj.uri) ? 'Tests ran against the active version. Activate to include your latest changes.' : undefined,
    };
  }

  async runAtc(conn: string, obj: ObjRef): Promise<AtcFinding[]> {
    const raw = await this.c(conn).atcRun(obj.uri);
    return raw.map(f => {
      const [path, frag = ''] = f.location.split('#');
      const m = frag.match(/start=(\d+)/);
      const s = splitSourceUrl(path);
      return { prio: (Math.min(3, Math.max(1, f.prio)) as 1 | 2 | 3), check: f.check, msg: f.msg, at: { uri: s.uri || obj.uri, include: s.include, line: m ? +m[1] - 1 : 0 } };
    }).sort((a, b) => a.prio - b.prio);
  }

  async run(conn: string, obj: ObjRef): Promise<RunResult> {
    const ci = this.info(conn);
    if (obj.type === 'CLAS') return { kind: 'console', output: await this.c(conn).classRun(obj.name) };
    if (obj.type === 'PROG' && ci.kind === 'runner') {
      const r = await this.c(conn).req({ method: 'POST', path: `/nusa/run/programs/${encodeURIComponent(obj.name.toLowerCase())}`, accept: 'text/plain' });
      return { kind: 'list', output: r.body };
    }
    if (obj.type === 'PROG') throw new Error('Programs with list output run in SAP GUI on this system. To run from here, use a console class that implements IF_OO_ADT_CLASSRUN (F9).');
    throw new Error(`${obj.name} cannot be executed`);
  }

  // ------------------------------------------------------------------ quick fixes and refactorings
  async quickFixes(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<QuickFix[]> {
    if (!isSourceType(obj.type)) return [];
    return R.quickFixes(this.c(conn), sourceUrl(obj.uri, include), source, line, col);
  }
  async applyQuickFix(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number, fix: QuickFix): Promise<TextEdit[]> {
    return R.applyQuickFix(this.c(conn), sourceUrl(obj.uri, include), source, line, col, JSON.parse(fix.token));
  }
  async renameStart(conn: string, obj: ObjRef, include: Include, line: number, from: number, to: number): Promise<RenameStart> {
    return R.renameEvaluate(this.c(conn), sourceUrl(obj.uri, include), line, from, to);
  }
  async renamePreview(conn: string, start: RenameStart, newName: string, transport?: string): Promise<RefactorPreview> {
    return R.renamePreview(this.c(conn), start.token, newName, transport);
  }
  async extractStart(conn: string, obj: ObjRef, include: Include, from: { line: number; ch: number }, to: { line: number; ch: number }): Promise<ExtractStart> {
    return R.extractEvaluate(this.c(conn), sourceUrl(obj.uri, include), from, to);
  }
  async extractPreview(conn: string, start: ExtractStart, transport?: string): Promise<RefactorPreview> {
    return R.extractPreview(this.c(conn), start, transport);
  }
  async refactorExecute(conn: string, preview: RefactorPreview): Promise<void> {
    await R.execute(this.c(conn), preview);
    const set = this.inactive.get(conn);
    for (const o of preview.objects) set?.add(o.uri);
  }
  async deleteTransport(conn: string, id: string): Promise<void> {
    await this.c(conn).deleteTransport(id);
    this.trCache.delete(conn);
  }
  async removeFromTransport(conn: string, id: string, entries: string[]): Promise<void> {
    await this.c(conn).removeFromTransport(id, entries);
    this.forgetTransport(conn, id);
  }
  async moveToTransport(conn: string, from: string, to: string, entries: string[]): Promise<void> {
    const list = this.trCache.get(conn) || await this.transports(conn);
    const target = list.find(t => t.id === to);
    if (!target) throw new Error(`Request ${to} is not one of your modifiable requests`);
    if (target.status !== 'modifiable') throw new Error(`Request ${to} is released`);
    const source = list.find(t => t.id === from);
    const cl = this.c(conn);
    await cl.removeFromTransport(from, entries);
    try {
      await cl.addToTransport(to, target.task, entries);
    } catch (e) {
      // put them back where they were rather than leave them in no request
      await cl.addToTransport(from, source?.task, entries).catch(() => undefined);
      throw e;
    }
    this.forgetTransport(conn, from);
  }
  private forgetTransport(conn: string, id: string) {
    this.trCache.delete(conn);
    for (const [k, v] of this.transportOf) if (k.startsWith(conn + '|') && v === id) this.transportOf.delete(k);
  }
  async changeTransportDesc(conn: string, id: string, desc: string): Promise<void> {
    await this.c(conn).changeTransportDesc(id, desc);
    this.trCache.delete(conn);
  }

  // ------------------------------------------------------------------ debugger
  private dbgFrames: DebugFrame[] = [];
  private dbgFrameRaw: StackFrame[] = [];
  private dbgVars = new Map<string, DebugVar>();
  private dbgNote = '';
  private listening: { cancelled: boolean } | null = null;

  private bpUrls(bps: Breakpoint[]) { return bps.map(b => ({ sourceUrl: sourceUrl(b.uri, b.include), line: b.line })); }

  /** Sets the breakpoints; lines the system refuses are reported, all refused is an error. */
  private async syncBreakpoints(d: AdtDebugger, bps: Breakpoint[]) {
    const res = await d.setBreakpoints(this.bpUrls(bps));
    const bad = res.filter(r => r.error);
    this.dbgNote = bad.length ? `${bad.length} breakpoint${bad.length > 1 ? 's' : ''} could not be set: ${bad[0].error} (line ${bad[0].line + 1})` : '';
    if (res.length && bad.length === res.length) throw new Error(`No breakpoint could be set: ${bad[0].error}`);
  }

  async debugStart(conn: string, obj: ObjRef, bps: Breakpoint[]): Promise<DebugState | null> {
    await this.debugStop();
    const d = new AdtDebugger(this.c(conn), this.userOf(conn));
    await this.syncBreakpoints(d, bps);
    this.dbg = { conn, d, obj };
    const listening = d.listen();
    if (obj.type !== 'CLAS') {
      // reports start from SAP GUI; the listener waits for them like Eclipse does
      return this.waitFor(conn, d, listening);
    }
    await new Promise(r => setTimeout(r, 400));           // listener first, then the run that may stop
    const run = this.c(conn).classRun(obj.name).then(out => ({ out }), e => ({ out: `Error: ${e instanceof Error ? e.message : String(e)}` }));
    this.dbg.run = run.then(r => r.out);
    const first = await Promise.race([listening.then(hit => ({ hit })), run]);
    if ('out' in first) {                                 // finished without stopping
      await d.stopListening(); await listening.catch(() => false);
      await d.clearBreakpoints();
      this.dbg = null;
      return { done: true, frames: [], vars: [], outputSoFar: first.out, note: 'No breakpoint was reached.' };
    }
    if (!first.hit) { await this.debugStop(); return null; }
    await d.attach();
    return this.view();
  }

  async debugListen(conn: string, bps: Breakpoint[]): Promise<DebugState | null> {
    await this.debugStop();
    const d = new AdtDebugger(this.c(conn), this.userOf(conn));
    await this.syncBreakpoints(d, bps);
    this.dbg = { conn, d };
    return this.waitFor(conn, d, d.listen());
  }

  /** Keeps a listener open until a process stops or the user cancels. */
  private async waitFor(conn: string, d: AdtDebugger, first: Promise<boolean>): Promise<DebugState | null> {
    const token = { cancelled: false };
    this.listening = token;
    let next = first;
    while (!token.cancelled) {
      let hit = false;
      try { hit = await next; } catch (e) {
        if (token.cancelled) break;
        if (!/timed? ?out|timeout|aborted/i.test(String((e as Error).message))) { this.listening = null; await this.debugStop(); throw e; }
      }
      if (token.cancelled) break;
      if (hit) {
        this.listening = null;
        await d.attach();
        return this.view();
      }
      next = d.listen();                                  // listener expired: listen again
    }
    if (this.listening === token) this.listening = null;
    return null;
  }

  async debugStep(kind: StepKind, bps: Breakpoint[], target?: Breakpoint): Promise<DebugState> {
    const s = this.dbg;
    if (!s) return { done: true, frames: [], vars: [], outputSoFar: '' };
    await this.syncBreakpoints(s.d, bps).catch(() => undefined);
    const map = { into: 'stepInto', over: 'stepOver', return: 'stepReturn', continue: 'stepContinue' } as const;
    const r = target
      ? await s.d.step('stepRunToLine', `${sourceUrl(target.uri, target.include)}#start=${target.line + 1}`)
      : await s.d.step(map[kind]);
    if (r.ended) return this.finish();
    try { return await this.view(); } catch { return this.finish(); }
  }

  async debugChildren(id: string): Promise<DebugVar[]> {
    const s = this.dbg;
    const v = this.dbgVars.get(id);
    if (!s || !v) return [];
    const kids = await s.d.expand(v);
    for (const k of kids) if (k.id) this.dbgVars.set(k.id, k);
    return kids;
  }

  async debugFrame(index: number): Promise<DebugState> {
    const s = this.dbg;
    const f = this.dbgFrameRaw[index];
    if (!s || !f) return this.view();
    await s.d.gotoFrame(f);
    return this.view(index, false);
  }

  async debugSetValue(name: string, value: string): Promise<DebugState> {
    const s = this.dbg;
    if (!s) throw new Error('The debugger is not running');
    await s.d.setValue(name, value);
    return this.view();
  }

  async debugStop() {
    if (this.listening) this.listening.cancelled = true;
    const s = this.dbg;
    this.dbg = null;
    if (s) { await s.d.stop(); await s.d.clearBreakpoints(); }
    this.dbgVars.clear();
  }

  private async view(frame = 0, reloadStack = true): Promise<DebugState> {
    const d = this.dbg as NonNullable<AdtBackend['dbg']>;
    if (reloadStack) {
      this.dbgFrameRaw = await d.d.stack();
      this.dbgFrames = this.dbgFrameRaw.map(f => { const s = splitSourceUrl(f.uri); return { name: f.name, uri: s.uri, include: s.include, line: f.line }; });
    }
    if (!this.dbgFrames.length) return this.finish();
    const vars = await d.d.variables().catch(() => [] as DebugVar[]);
    this.dbgVars.clear();
    const index = (vs: DebugVar[]) => vs.forEach(v => { if (v.id) this.dbgVars.set(v.id, v); if (v.children) index(v.children); });
    index(vars);
    return { done: false, vars, outputSoFar: '', frames: this.dbgFrames, frame, note: this.dbgNote || undefined };
  }

  private async finish(): Promise<DebugState> {
    const out = this.dbg?.run ? await this.dbg.run : '';
    await this.debugStop();
    return { done: true, frames: [], vars: [], outputSoFar: out };
  }
}

/** "SAP_BASIS 920;SAPK-92005INSAPBASIS;0005;SAP Basis Component" -> "SAP_BASIS 920 SP05" */
export function prettyRelease(c: string): string {
  const m = /^(\S+)\s+([^;]+)(?:;[^;]*;(\d+))?/.exec(c);
  if (!m) return c;
  return m[3] ? `${m[1]} ${m[2]} SP${m[3].replace(/^0+(?=\d\d)/, '')}` : `${m[1]} ${m[2]}`;
}
