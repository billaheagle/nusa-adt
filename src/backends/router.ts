// Desktop backend: the built-in DEMO system runs in the app (sample data, no SAP needed);
// every other system goes through the ADT backend and the Rust core.

import { Backend, Breakpoint, Connection, ObjType, StepKind } from '../core/types';
import { MockBackend } from './mock';

export const DEMO_ID = 'demo';
const MOCK_ID = 's4d';

type Conn1<K extends keyof Backend> = Backend[K] extends (conn: string, ...rest: infer A) => infer R ? (conn: string, ...rest: A) => R : never;

export class RoutingBackend implements Backend {
  readonly id = 'router';
  private dbgTarget: Backend | null = null;

  constructor(private real: Backend, private demo: MockBackend) {}

  static withDemo(real: Backend, storage: Storage | null): RoutingBackend {
    const mock = new MockBackend(storage, {
      connections: all => all.filter(c => c.id === MOCK_ID).map(c => ({
        ...c, sid: 'DEMO', url: 'built-in', auth: 'none' as const, builtin: true, runReports: true,
        label: 'Sample system with example objects. No SAP needed, changes stay on this computer.',
      })),
    });
    return new RoutingBackend(real, mock);
  }

  private pick(conn: string): [Backend, string] {
    return conn === DEMO_ID ? [this.demo, MOCK_ID] : [this.real, conn];
  }
  private route<K extends keyof Backend>(name: K): Conn1<K> {
    return ((conn: string, ...rest: unknown[]) => {
      const [b, id] = this.pick(conn);
      return (b[name] as unknown as (...a: unknown[]) => unknown).call(b, id, ...rest);
    }) as Conn1<K>;
  }

  async connections(): Promise<Connection[]> {
    const demo = (await this.demo.connections()).map(c => ({ ...c, id: DEMO_ID }));
    let real: Connection[] = [];
    try { real = await this.real.connections(); } catch { /* keep the demo usable */ }
    return [...demo, ...real];
  }
  saveConnection(c: Connection, secret?: string) {
    // DEMO keeps its settings except the favorite packages
    if (c.id === DEMO_ID) return this.demo.saveConnection({ ...c, id: MOCK_ID });
    return this.real.saveConnection(c, secret);
  }
  deleteConnection(id: string) {
    if (id === DEMO_ID) return Promise.reject(new Error('The DEMO system cannot be removed'));
    return this.real.deleteConnection(id);
  }
  includesOf(type: ObjType) { return this.real.includesOf(type); }

  /** Restores the DEMO system's sample objects. */
  reset() { this.demo.reset(); }

  connect = this.route('connect');
  packageObjects = this.route('packageObjects');
  search = this.route('search');
  read = this.route('read');
  state = this.route('state');
  lock = this.route('lock');
  unlock = this.route('unlock');
  transportNeed = this.route('transportNeed');
  createTransport = this.route('createTransport');
  write = this.route('write');
  createObject = this.route('createObject');
  syntaxCheck = this.route('syntaxCheck');
  activate = this.route('activate');
  prettyPrint = this.route('prettyPrint');
  complete = this.route('complete');
  navigate = this.route('navigate');
  whereUsed = this.route('whereUsed');
  transports = this.route('transports');
  releaseTransport = this.route('releaseTransport');
  runUnit = this.route('runUnit');
  runAtc = this.route('runAtc');
  run = this.route('run');
  packageContents = this.route('packageContents');
  searchPackages = this.route('searchPackages');
  valueHelpObjects = this.route('valueHelpObjects');
  valueHelp = this.route('valueHelp');
  createPackage = this.route('createPackage');
  deleteObject = this.route('deleteObject');
  resetSession = this.route('resetSession');
  bindingInfo = this.route('bindingInfo');
  publishBinding = this.route('publishBinding');
  dataPreview = this.route('dataPreview');
  gitRepos = this.route('gitRepos');
  gitLink = this.route('gitLink');
  gitPull = this.route('gitPull');
  gitUnlink = this.route('gitUnlink');

  async debugStart(conn: string, obj: Parameters<Backend['debugStart']>[1], bps: Breakpoint[]) {
    const [b, id] = this.pick(conn);
    this.dbgTarget = b;
    return b.debugStart(id, obj, bps);
  }
  debugStep(kind: StepKind, bps: Breakpoint[]) {
    return (this.dbgTarget ?? this.real).debugStep(kind, bps);
  }
  async debugStop() {
    await (this.dbgTarget ?? this.real).debugStop();
    this.dbgTarget = null;
  }
}
