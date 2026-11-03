// The contract between the IDE UI and whatever answers it: the mock (prototype),
// a real SAP system over ADT REST, or the local ABAP runner.

export type ObjType = 'CLAS' | 'INTF' | 'PROG' | 'DDLS';
export type Include = 'main' | 'definitions' | 'implementations' | 'testclasses' | 'macros';
export type Severity = 'error' | 'warning' | 'info';
export type ConnKind = 's4' | 'btp' | 'runner';

export interface Connection {
  id: string;
  kind: ConnKind;
  sid: string;
  client: string;
  user: string;
  url: string;
  language: string;          // e.g. EN
  auth: 'basic' | 'oauth' | 'none';
  /** Language version shown in the status bar: Standard ABAP or ABAP for Cloud Development */
  abapVersion: 'standard' | 'cloud' | 'runner';
  favoritePackages: string[];
  transports: boolean;
  label?: string;
  /** Development systems with self-signed TLS certificates */
  allowSelfSigned?: boolean;
}

export interface ObjRef {
  uri: string;               // ADT URI, e.g. /sap/bc/adt/oo/classes/zcl_x
  name: string;              // upper case
  type: ObjType;
  pkg: string;
  desc: string;
}

export interface ObjState extends ObjRef {
  inactive: boolean;         // saved version differs from the active one
  transport?: string;        // request the object is recorded in
  lockedBy?: string;
}

export interface Problem {
  sev: Severity;
  msg: string;
  uri: string;
  include: Include;
  line: number;              // 0-based
  col?: number;
  source: 'syntax' | 'activation' | 'atc';
}

export interface Proposal {
  label: string;
  insert: string;            // may contain $0 for the caret position
  kind: 'keyword' | 'method' | 'field' | 'variable' | 'type' | 'snippet' | 'object' | 'function' | 'parameter' | 'constant'
    | 'class' | 'interface' | 'exception' | 'table' | 'fm' | 'pragma' | 'operator' | 'annotation' | 'enum';
  detail?: string;
  /** Longer text shown for the selected entry, e.g. a method signature. */
  doc?: string;
  /** Column where the replaced text starts, when it is not the word before the cursor. */
  replaceFrom?: number;
  sort?: number;
}

export interface Location { uri: string; include: Include; line: number; col?: number }
export interface Hit extends Location { name: string; type: ObjType; text: string }

export interface Transport {
  id: string;
  desc: string;
  owner: string;
  status: 'modifiable' | 'released';
  task?: string;
  objects: string[];         // "R3TR CLAS ZCL_X"
}

export interface TransportNeed { needed: boolean; current?: string; requests: Transport[]; reason?: string }

export interface UnitMethod { cls: string; method: string; status: 'ok' | 'fail' | 'error'; ms: number; msg?: string; at?: Location }
export interface UnitResult { uri: string; methods: UnitMethod[]; note?: string }

export interface AtcFinding { prio: 1 | 2 | 3; check: string; msg: string; at: Location }

export interface RunResult { output: string; kind: 'list' | 'console'; note?: string }

export interface DebugVar { name: string; type: string; value: string; children?: DebugVar[] }
export interface DebugFrame { name: string; uri: string; include: Include; line: number }
export interface DebugState {
  done: boolean;
  frames: DebugFrame[];      // top first
  vars: DebugVar[];
  outputSoFar: string;
}
export type StepKind = 'into' | 'over' | 'return' | 'continue';
export interface Breakpoint { uri: string; include: Include; line: number }

export interface SystemInfo { release: string; components: string[] }

export interface Backend {
  readonly id: string;
  connections(): Promise<Connection[]>;
  saveConnection(c: Connection, secret?: string): Promise<void>;
  connect(conn: string): Promise<SystemInfo>;

  /** Objects of one package (the explorer shows them grouped by type). */
  packageObjects(conn: string, pkg: string): Promise<ObjState[]>;
  search(conn: string, query: string): Promise<ObjRef[]>;
  includesOf(type: ObjType): Include[];

  read(conn: string, obj: ObjRef, include: Include, version: 'active' | 'inactive'): Promise<string>;
  state(conn: string, obj: ObjRef): Promise<ObjState>;
  lock(conn: string, obj: ObjRef): Promise<string>;
  unlock(conn: string, obj: ObjRef, handle: string): Promise<void>;
  transportNeed(conn: string, obj: ObjRef): Promise<TransportNeed>;
  createTransport(conn: string, desc: string, obj: ObjRef): Promise<string>;
  write(conn: string, obj: ObjRef, include: Include, source: string, lock: string, transport?: string): Promise<void>;
  createObject(conn: string, type: ObjType, name: string, desc: string, pkg: string, transport?: string): Promise<ObjRef>;

  syntaxCheck(conn: string, obj: ObjRef, include: Include, source: string): Promise<Problem[]>;
  activate(conn: string, objs: ObjRef[]): Promise<{ ok: boolean; problems: Problem[] }>;
  prettyPrint(conn: string, source: string): Promise<string>;
  complete(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Proposal[]>;
  navigate(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Location | null>;
  whereUsed(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Hit[]>;

  transports(conn: string): Promise<Transport[]>;
  releaseTransport(conn: string, id: string): Promise<void>;

  runUnit(conn: string, obj: ObjRef): Promise<UnitResult>;
  runAtc(conn: string, obj: ObjRef): Promise<AtcFinding[]>;
  run(conn: string, obj: ObjRef): Promise<RunResult>;

  debugStart(conn: string, obj: ObjRef, bps: Breakpoint[]): Promise<DebugState | null>;
  debugStep(kind: StepKind, bps: Breakpoint[]): Promise<DebugState>;
  debugStop(): Promise<void>;
}

export const TYPE_INFO: Record<ObjType, { label: string; folder: string; group: 'src' | 'cds'; glyph: string; adt: string }> = {
  CLAS: { label: 'Class', folder: 'Classes', group: 'src', glyph: 'C', adt: '/sap/bc/adt/oo/classes/' },
  INTF: { label: 'Interface', folder: 'Interfaces', group: 'src', glyph: 'I', adt: '/sap/bc/adt/oo/interfaces/' },
  PROG: { label: 'Program', folder: 'Programs', group: 'src', glyph: 'P', adt: '/sap/bc/adt/programs/programs/' },
  DDLS: { label: 'Data Definition', folder: 'Data Definitions', group: 'cds', glyph: 'D', adt: '/sap/bc/adt/ddic/ddl/sources/' },
};

export const INCLUDE_LABEL: Record<Include, string> = {
  main: 'Global Class', definitions: 'Class-relevant Local Types', implementations: 'Local Types',
  testclasses: 'Test Classes', macros: 'Macros',
};

export function uriFor(type: ObjType, name: string): string {
  return TYPE_INFO[type].adt + encodeURIComponent(name.toLowerCase());
}
