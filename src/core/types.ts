// The contract between the IDE UI and whatever answers it: the mock (prototype),
// a real SAP system over ADT REST, or the local ABAP runner.

export type ObjType = 'CLAS' | 'INTF' | 'PROG' | 'TABL' | 'DDLS' | 'DDLX' | 'DCLS' | 'BDEF' | 'SRVD' | 'SRVB';
export type Include = 'main' | 'definitions' | 'implementations' | 'testclasses' | 'macros';
export type Severity = 'error' | 'warning' | 'info';
/** s4: S/4HANA or NetWeaver on-premise · s4cloud: S/4HANA Cloud Public Edition · btp: BTP ABAP Environment */
export type ConnKind = 's4' | 's4cloud' | 'btp' | 'runner';

export interface Connection {
  id: string;
  kind: ConnKind;
  sid: string;
  client: string;
  user: string;
  url: string;
  language: string;          // e.g. EN
  /** basic: user + password · sso: browser logon (reentrance ticket) · oauth: BTP service key */
  auth: 'basic' | 'oauth' | 'sso' | 'none';
  /** Language version shown in the status bar: Standard ABAP or ABAP for Cloud Development */
  abapVersion: 'standard' | 'cloud' | 'runner';
  favoritePackages: string[];
  transports: boolean;
  label?: string;
  /** Development systems with self-signed TLS certificates */
  allowSelfSigned?: boolean;
  /** Reports with list output can run here (runner, DEMO). */
  runReports?: boolean;
  /** Built into the app (DEMO): cannot be edited or removed. */
  builtin?: boolean;
}

export interface PkgRef { name: string; desc: string }
/** Extra input some object types need on creation. */
export interface CreateExtra { serviceDefinition?: string; bindingType?: 'V2' | 'V4'; category?: 'UI' | 'Web API'; referencedObject?: string }
export interface NewPackage {
  name: string; desc: string; superPackage: string; softwareComponent: string; transportLayer: string;
  packageType: 'development' | 'structure' | 'main';
}
export interface ValueHelpItem { name: string; desc: string }

export interface BindingService { name: string; version: string; serviceDefinition: string; published: boolean }
export interface BindingInfo {
  name: string; desc: string;
  bindingType: 'ODATA' | 'INA' | 'SQL';
  odataVersion: 'V2' | 'V4' | '';
  category: 'UI' | 'Web API';
  services: BindingService[];
  published: boolean;
  /** Relative service URL once published, e.g. /sap/opu/odata4/sap/zui_x/srvd/sap/zui_x/0001/ */
  serviceUrl?: string;
}

export interface PreviewColumn { name: string; type: string; desc: string; key?: boolean }
export interface PreviewResult { columns: PreviewColumn[]; rows: string[][]; totalRows: number; sql: string; ms: number }

export interface GitRepo {
  key: string; pkg: string; url: string; branch: string; createdBy: string; status: string; statusText: string;
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
  /** Subpackages and objects of a package, for the lazily expanded explorer. */
  packageContents(conn: string, pkg: string): Promise<{ packages: PkgRef[]; objects: ObjState[] }>;
  searchPackages(conn: string, query: string): Promise<PkgRef[]>;
  valueHelp(conn: string, kind: 'softwarecomponents' | 'transportlayers'): Promise<ValueHelpItem[]>;
  createPackage(conn: string, p: NewPackage, transport?: string): Promise<PkgRef>;
  deleteObject(conn: string, obj: ObjRef, transport?: string): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  /** Forget the login so the next call logs in again. */
  resetSession(conn: string): Promise<void>;
  bindingInfo(conn: string, obj: ObjRef): Promise<BindingInfo>;
  publishBinding(conn: string, obj: ObjRef, publish: boolean): Promise<string>;
  dataPreview(conn: string, req: { entity?: string; sql?: string; rows: number }): Promise<PreviewResult>;
  gitRepos(conn: string): Promise<GitRepo[]>;
  gitLink(conn: string, r: { pkg: string; url: string; branch: string; transport?: string; user?: string; password?: string }): Promise<void>;
  gitPull(conn: string, key: string, transport?: string, user?: string, password?: string): Promise<string>;
  gitUnlink(conn: string, key: string): Promise<void>;
  search(conn: string, query: string): Promise<ObjRef[]>;
  includesOf(type: ObjType): Include[];

  read(conn: string, obj: ObjRef, include: Include, version: 'active' | 'inactive'): Promise<string>;
  state(conn: string, obj: ObjRef): Promise<ObjState>;
  lock(conn: string, obj: ObjRef): Promise<string>;
  unlock(conn: string, obj: ObjRef, handle: string): Promise<void>;
  transportNeed(conn: string, obj: ObjRef): Promise<TransportNeed>;
  createTransport(conn: string, desc: string, obj: ObjRef): Promise<string>;
  write(conn: string, obj: ObjRef, include: Include, source: string, lock: string, transport?: string): Promise<void>;
  createObject(conn: string, type: ObjType, name: string, desc: string, pkg: string, transport?: string, extra?: CreateExtra): Promise<ObjRef>;

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

export type ObjGroup = 'srv' | 'cds' | 'ddic' | 'src';
export interface TypeInfo {
  label: string; folder: string; group: ObjGroup; glyph: string; adt: string; adtType: string;
  /** abap: ABAP source · cds: CDS-like source (DDL, BDL, DCL, SRVD, table) · form: no source, a form (service binding) */
  editor: 'abap' | 'cds' | 'form';
  prefix: string;
  maxLen: number;
}
export const TYPE_INFO: Record<ObjType, TypeInfo> = {
  CLAS: { label: 'Class', folder: 'Classes', group: 'src', glyph: 'C', adt: '/sap/bc/adt/oo/classes/', adtType: 'CLAS/OC', editor: 'abap', prefix: 'ZCL_', maxLen: 30 },
  INTF: { label: 'Interface', folder: 'Interfaces', group: 'src', glyph: 'I', adt: '/sap/bc/adt/oo/interfaces/', adtType: 'INTF/OI', editor: 'abap', prefix: 'ZIF_', maxLen: 30 },
  PROG: { label: 'Program', folder: 'Programs', group: 'src', glyph: 'P', adt: '/sap/bc/adt/programs/programs/', adtType: 'PROG/P', editor: 'abap', prefix: 'ZR_', maxLen: 40 },
  TABL: { label: 'Database Table', folder: 'Database Tables', group: 'ddic', glyph: 'T', adt: '/sap/bc/adt/ddic/tables/', adtType: 'TABL/DT', editor: 'cds', prefix: 'Z', maxLen: 16 },
  DDLS: { label: 'Data Definition', folder: 'Data Definitions', group: 'cds', glyph: 'D', adt: '/sap/bc/adt/ddic/ddl/sources/', adtType: 'DDLS/DF', editor: 'cds', prefix: 'ZI_', maxLen: 30 },
  DDLX: { label: 'Metadata Extension', folder: 'Metadata Extensions', group: 'cds', glyph: 'M', adt: '/sap/bc/adt/ddic/ddlx/sources/', adtType: 'DDLX/EX', editor: 'cds', prefix: 'ZC_', maxLen: 30 },
  DCLS: { label: 'Access Control', folder: 'Access Controls', group: 'cds', glyph: 'A', adt: '/sap/bc/adt/acm/dcl/sources/', adtType: 'DCLS/DL', editor: 'cds', prefix: 'ZI_', maxLen: 30 },
  BDEF: { label: 'Behavior Definition', folder: 'Behavior Definitions', group: 'cds', glyph: 'B', adt: '/sap/bc/adt/bo/behaviordefinitions/', adtType: 'BDEF/BDO', editor: 'cds', prefix: 'ZR_', maxLen: 30 },
  SRVD: { label: 'Service Definition', folder: 'Service Definitions', group: 'srv', glyph: 'S', adt: '/sap/bc/adt/ddic/srvd/sources/', adtType: 'SRVD/SRV', editor: 'cds', prefix: 'ZUI_', maxLen: 30 },
  SRVB: { label: 'Service Binding', folder: 'Service Bindings', group: 'srv', glyph: 'O', adt: '/sap/bc/adt/businessservices/bindings/', adtType: 'SRVB/SVB', editor: 'form', prefix: 'ZUI_', maxLen: 26 },
};
export const GROUPS: { id: ObjGroup; label: string; types: ObjType[] }[] = [
  { id: 'srv', label: 'Business Services', types: ['SRVD', 'SRVB'] },
  { id: 'cds', label: 'Core Data Services', types: ['DDLS', 'BDEF', 'DDLX', 'DCLS'] },
  { id: 'ddic', label: 'Dictionary', types: ['TABL'] },
  { id: 'src', label: 'Source Code Library', types: ['CLAS', 'INTF', 'PROG'] },
];
/** ADT type id (CLAS/OC) to our type */
export const ADT_TYPE: Record<string, ObjType> = Object.fromEntries(Object.entries(TYPE_INFO).map(([k, v]) => [v.adtType, k as ObjType]));
export const isCdsLike = (t: ObjType) => TYPE_INFO[t].editor === 'cds';

export const INCLUDE_LABEL: Record<Include, string> = {
  main: 'Global Class', definitions: 'Class-relevant Local Types', implementations: 'Local Types',
  testclasses: 'Test Classes', macros: 'Macros',
};

export function uriFor(type: ObjType, name: string): string {
  return TYPE_INFO[type].adt + encodeURIComponent(name.toLowerCase());
}
