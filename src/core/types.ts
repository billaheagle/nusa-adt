// The contract between the IDE UI and whatever answers it: the mock (prototype),
// a real SAP system over ADT REST, or the local ABAP runner.

export type ObjType = 'CLAS' | 'INTF' | 'PROG' | 'INCL' | 'FUGR' | 'FUNC' | 'TABL' | 'DDLS' | 'DDLX' | 'DCLS' | 'BDEF' | 'SRVD' | 'SRVB'
  // form-based objects (edited as an XML document, like the form editors in Eclipse)
  | 'DTEL' | 'DOMA' | 'TTYP' | 'MSAG'
  | 'AUTH' | 'SUSO' | 'SUSH' | 'SUCO'
  | 'SIA1' | 'SIA2' | 'SIA3' | 'SIA5' | 'SIA6' | 'SIA7' | 'SIA8' | 'SIA9'
  | 'SCO1' | 'SCO2' | 'SCO3' | 'COTA'
  | 'SMBC' | 'SAJC' | 'SAJT' | 'NROB' | 'APLO' | 'HTTP' | 'EVTB'
  /** any other repository object: shown with the label the system gives it, read-only XML */
  | 'XOBJ';
export type Include = 'main' | 'definitions' | 'implementations' | 'testclasses' | 'macros'
  // text elements of a program, edited as "001=Text" lines like in Eclipse
  | 'symbols' | 'selections' | 'headings';
export const TEXT_INCLUDES: Include[] = ['symbols', 'selections', 'headings'];
export const isTextInclude = (i: Include) => TEXT_INCLUDES.includes(i);
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
  /** basic: user + password · sso: browser logon (reentrance ticket) · oauth: BTP service key
   *  · rfc: SAP GUI style logon over RFC (application server, instance, SAProuter), like Eclipse */
  auth: 'basic' | 'oauth' | 'sso' | 'rfc' | 'none';
  /** Language version shown in the status bar: Standard ABAP or ABAP for Cloud Development */
  abapVersion: 'standard' | 'cloud' | 'runner';
  favoritePackages: string[];
  transports: boolean;
  label?: string;
  /** Development systems with self-signed TLS certificates */
  allowSelfSigned?: boolean;
  /** RFC logon (auth 'rfc'): the SAP GUI logon pad values and the NW RFC SDK folder */
  ashost?: string;
  sysnr?: string;
  saprouter?: string;
  rfcSdk?: string;
  /** Reports with list output can run here (runner, DEMO). */
  runReports?: boolean;
  /** Built into the app (DEMO): cannot be edited or removed. */
  builtin?: boolean;
}

export interface PkgRef { name: string; desc: string }
export interface SearchFilter { type?: ObjType; pkg?: string }
/** "ZNUSA*" matches ZNUSA_FLIGHT; without * the name must match exactly. */
export function pkgMatches(pattern: string | undefined, pkg: string): boolean {
  const p = (pattern || '').trim().toUpperCase();
  if (!p) return true;
  const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test((pkg || '').toUpperCase());
}
/** Extra input some object types need on creation. */
export interface CreateExtra { serviceDefinition?: string; bindingType?: 'V2' | 'V4'; category?: 'UI' | 'Web API'; referencedObject?: string; /** function modules: their function group */ functionGroup?: string; /** package, for templates that record it */ pkg?: string }
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
  /** For XOBJ: the system's type id (FUGR/F) and label (Function Groups). */
  adtType?: string;
  typeLabel?: string;
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
  /** SE09/SE10 request type: workbench (K), customizing (W), transport of copies (T) */
  category?: 'workbench' | 'customizing' | 'copies';
}

export interface TransportNeed { needed: boolean; current?: string; requests: Transport[]; reason?: string }

export interface UnitMethod { cls: string; method: string; status: 'ok' | 'fail' | 'error'; ms: number; msg?: string; at?: Location }
export interface UnitResult { uri: string; methods: UnitMethod[]; note?: string }

export interface AtcFinding { prio: 1 | 2 | 3; check: string; msg: string; at: Location }

export interface RunResult { output: string; kind: 'list' | 'console'; note?: string }

export interface DebugVar {
  name: string; type: string; value: string; children?: DebugVar[];
  /** Server id for loading children on demand (structures, tables, objects) */
  id?: string;
  expandable?: boolean;
  /** Section heading such as Locals or Parameters (top level only) */
  group?: boolean;
}
export interface DebugFrame { name: string; uri: string; include: Include; line: number }
export interface DebugState {
  done: boolean;
  frames: DebugFrame[];      // top first
  vars: DebugVar[];
  outputSoFar: string;
  /** Frame whose variables are shown (0 = where the program stopped) */
  frame?: number;
  /** For example breakpoints the system could not set */
  note?: string;
}
export type StepKind = 'into' | 'over' | 'return' | 'continue';
export interface Breakpoint { uri: string; include: Include; line: number }

/** A text change the system proposes: a quick fix or one step of a refactoring. Lines and columns are 0-based. */
export interface TextEdit {
  uri: string; include: Include; name: string; type: ObjType;
  from: { line: number; ch: number }; to: { line: number; ch: number };
  oldText: string; newText: string;
}
/** ABAP runtime traces (SAT / Eclipse ABAP Profiling). Times in microseconds. */
export interface TraceRun { id: string; title: string; at: string; objectName?: string; runtime?: number; abap?: number; db?: number; system?: number }
export interface TraceHit { name: string; program: string; hits: number; gross: number; net: number; grossPct: number; netPct: number; at?: Location }

/** A runtime error (ST22). */
export interface Dump {
  id: string; error: string; program: string; user: string; at: string; title: string;
  /** where it stopped, when the system says */
  where?: Location;
  /** the full description (HTML) when the feed carries it */
  html?: string;
}
/** A version of a source in the system (version history, like Eclipse "Compare With > Revision"). */
export interface Revision { uri: string; version: string; title: string; author: string; date: string; transport?: string }

export interface QuickFix { title: string; desc?: string; /** backend data to apply it */ token: string }
export interface RefactorPreview {
  title: string; edits: TextEdit[]; objects: ObjRef[];
  /** backend data to execute it */ token: string;
}
export interface RenameStart { oldName: string; token: string }
export interface ExtractParam { id: string; name: string; direction: string; type: string }
export interface ExtractStart {
  name: string; visibility: string; isStatic: boolean; className: string; params: ExtractParam[];
  token: string;
}

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
  /** Parts shown under an object in the explorer: function modules and includes of a function group. */
  groupContents(conn: string, obj: ObjRef): Promise<ObjRef[]>;
  /** Value help: repository objects of the given types (DOMA, DTEL, SHLP, …) matching a pattern. */
  valueHelpObjects(conn: string, query: string, types: string[]): Promise<{ name: string; desc: string; type: string; pkg?: string }[]>;
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
  /** Repository search; filter by object type and package (a package name may end with *). */
  search(conn: string, query: string, filter?: SearchFilter): Promise<ObjRef[]>;
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

  // Quick fixes and refactorings, the same services Eclipse ADT uses
  quickFixes(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<QuickFix[]>;
  applyQuickFix(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number, fix: QuickFix): Promise<TextEdit[]>;
  renameStart(conn: string, obj: ObjRef, include: Include, line: number, from: number, to: number): Promise<RenameStart>;
  renamePreview(conn: string, start: RenameStart, newName: string, transport?: string): Promise<RefactorPreview>;
  extractStart(conn: string, obj: ObjRef, include: Include, from: { line: number; ch: number }, to: { line: number; ch: number }): Promise<ExtractStart>;
  extractPreview(conn: string, start: ExtractStart, transport?: string): Promise<RefactorPreview>;
  refactorExecute(conn: string, preview: RefactorPreview): Promise<void>;
  deleteTransport(conn: string, id: string): Promise<void>;
  /** Object entries such as "R3TR CLAS ZCL_X": out of a request (the objects stay), or into another one. */
  removeFromTransport(conn: string, id: string, entries: string[]): Promise<void>;
  moveToTransport(conn: string, from: string, to: string, entries: string[]): Promise<void>;
  changeTransportDesc(conn: string, id: string, desc: string): Promise<void>;

  // Profiler (ABAP runtime traces of the user)
  traces(conn: string): Promise<TraceRun[]>;
  traceHitList(conn: string, id: string): Promise<TraceHit[]>;
  /** Traces the next run of the user in any process (a console class, a Fiori app, a report in SAP GUI). */
  traceRequest(conn: string, description: string): Promise<void>;
  traceDelete(conn: string, id: string): Promise<void>;

  // Runtime errors (ST22) and the version history of sources
  dumps(conn: string): Promise<Dump[]>;
  /** The full description of a runtime error: HTML when the system has it, otherwise plain text. */
  dumpDetail(conn: string, dump: Dump): Promise<{ html?: string; text?: string }>;
  revisions(conn: string, obj: ObjRef, include: Include): Promise<Revision[]>;
  revisionSource(conn: string, rev: Revision): Promise<string>;

  /** Runs obj and stops at the first breakpoint it reaches (null: it finished without stopping). */
  debugStart(conn: string, obj: ObjRef, bps: Breakpoint[]): Promise<DebugState | null>;
  /** Waits, like Eclipse, for any process of the user (a Fiori app, an OData call, a job) to reach a breakpoint. Null when cancelled. */
  debugListen(conn: string, bps: Breakpoint[]): Promise<DebugState | null>;
  /** target: Run to Line (Eclipse Ctrl+R) */
  debugStep(kind: StepKind, bps: Breakpoint[], target?: Breakpoint): Promise<DebugState>;
  debugChildren(id: string): Promise<DebugVar[]>;
  /** Shows the variables of another stack frame. */
  debugFrame(index: number): Promise<DebugState>;
  debugSetValue(name: string, value: string): Promise<DebugState>;
  debugStop(): Promise<void>;
}

export type ObjGroup = 'srv' | 'cds' | 'ddic' | 'src' | 'texts' | 'auth' | 'iam' | 'com' | 'bc' | 'jobs' | 'other';
export interface TypeInfo {
  label: string; folder: string; group: ObjGroup; glyph: string; adt: string; adtType: string;
  /** abap: ABAP source · cds: CDS-like source (DDL, BDL, DCL, SRVD, table) · form: service binding page ·
   *  xml: form editor over the object's XML document (authorizations, IAM, communication, …) */
  editor: 'abap' | 'cds' | 'form' | 'xml';
  /** xml objects that cannot be changed from Nusa Studio */
  readOnly?: boolean;
  prefix: string;
  maxLen: number;
}
export const TYPE_INFO: Record<ObjType, TypeInfo> = {
  CLAS: { label: 'Class', folder: 'Classes', group: 'src', glyph: 'C', adt: '/sap/bc/adt/oo/classes/', adtType: 'CLAS/OC', editor: 'abap', prefix: 'ZCL_', maxLen: 30 },
  INTF: { label: 'Interface', folder: 'Interfaces', group: 'src', glyph: 'I', adt: '/sap/bc/adt/oo/interfaces/', adtType: 'INTF/OI', editor: 'abap', prefix: 'ZIF_', maxLen: 30 },
  PROG: { label: 'Program', folder: 'Programs', group: 'src', glyph: 'P', adt: '/sap/bc/adt/programs/programs/', adtType: 'PROG/P', editor: 'abap', prefix: 'ZR_', maxLen: 40 },
  INCL: { label: 'Include', folder: 'Includes', group: 'src', glyph: 'I', adt: '/sap/bc/adt/programs/includes/', adtType: 'PROG/I', editor: 'abap', prefix: 'Z', maxLen: 40 },
  FUGR: { label: 'Function Group', folder: 'Function Groups', group: 'src', glyph: 'G', adt: '/sap/bc/adt/functions/groups/', adtType: 'FUGR/F', editor: 'abap', prefix: 'Z', maxLen: 26 },
  FUNC: { label: 'Function Module', folder: 'Function Modules', group: 'src', glyph: 'F', adt: '', adtType: 'FUGR/FF', editor: 'abap', prefix: 'Z_', maxLen: 30 },
  TABL: { label: 'Database Table', folder: 'Database Tables', group: 'ddic', glyph: 'T', adt: '/sap/bc/adt/ddic/tables/', adtType: 'TABL/DT', editor: 'cds', prefix: 'Z', maxLen: 16 },
  DDLS: { label: 'Data Definition', folder: 'Data Definitions', group: 'cds', glyph: 'D', adt: '/sap/bc/adt/ddic/ddl/sources/', adtType: 'DDLS/DF', editor: 'cds', prefix: 'ZI_', maxLen: 30 },
  DDLX: { label: 'Metadata Extension', folder: 'Metadata Extensions', group: 'cds', glyph: 'M', adt: '/sap/bc/adt/ddic/ddlx/sources/', adtType: 'DDLX/EX', editor: 'cds', prefix: 'ZC_', maxLen: 30 },
  DCLS: { label: 'Access Control', folder: 'Access Controls', group: 'cds', glyph: 'A', adt: '/sap/bc/adt/acm/dcl/sources/', adtType: 'DCLS/DL', editor: 'cds', prefix: 'ZI_', maxLen: 30 },
  BDEF: { label: 'Behavior Definition', folder: 'Behavior Definitions', group: 'cds', glyph: 'B', adt: '/sap/bc/adt/bo/behaviordefinitions/', adtType: 'BDEF/BDO', editor: 'cds', prefix: 'ZR_', maxLen: 30 },
  SRVD: { label: 'Service Definition', folder: 'Service Definitions', group: 'srv', glyph: 'S', adt: '/sap/bc/adt/ddic/srvd/sources/', adtType: 'SRVD/SRV', editor: 'cds', prefix: 'ZUI_', maxLen: 30 },
  SRVB: { label: 'Service Binding', folder: 'Service Bindings', group: 'srv', glyph: 'O', adt: '/sap/bc/adt/businessservices/bindings/', adtType: 'SRVB/SVB', editor: 'form', prefix: 'ZUI_', maxLen: 26 },
  DTEL: { label: 'Data Element', folder: 'Data Elements', group: 'ddic', glyph: 'E', adt: '/sap/bc/adt/ddic/dataelements/', adtType: 'DTEL/DE', editor: 'xml', prefix: 'Z', maxLen: 30 },
  DOMA: { label: 'Domain', folder: 'Domains', group: 'ddic', glyph: 'D', adt: '/sap/bc/adt/ddic/domains/', adtType: 'DOMA/DD', editor: 'xml', prefix: 'Z', maxLen: 30 },
  TTYP: { label: 'Table Type', folder: 'Table Types', group: 'ddic', glyph: 'Y', adt: '/sap/bc/adt/ddic/tabletypes/', adtType: 'TTYP/DA', editor: 'xml', prefix: 'ZTT_', maxLen: 30 },
  MSAG: { label: 'Message Class', folder: 'Message Classes', group: 'texts', glyph: 'G', adt: '/sap/bc/adt/messageclass/', adtType: 'MSAG/N', editor: 'xml', prefix: 'Z', maxLen: 20 },
  AUTH: { label: 'Authorization Field', folder: 'Authorization Fields', group: 'auth', glyph: 'F', adt: '', adtType: 'AUTH', editor: 'xml', prefix: 'Z', maxLen: 10 },
  SUSO: { label: 'Authorization Object', folder: 'Authorization Objects', group: 'auth', glyph: 'A', adt: '', adtType: 'SUSO', editor: 'xml', prefix: 'Z', maxLen: 10 },
  SUSH: { label: 'Authorization Default Values', folder: 'Authorization Default Values', group: 'auth', glyph: 'H', adt: '', adtType: 'SUSH', editor: 'xml', prefix: 'Z', maxLen: 40 },
  SUCO: { label: 'Authorization Default Variant', folder: 'Authorization Default Variants', group: 'auth', glyph: 'V', adt: '', adtType: 'SUCO', editor: 'xml', prefix: 'Z', maxLen: 40 },
  SIA1: { label: 'Business Catalog', folder: 'Business Catalogs', group: 'iam', glyph: 'C', adt: '', adtType: 'SIA1', editor: 'xml', prefix: 'Z', maxLen: 35 },
  SIA2: { label: 'Restriction Type', folder: 'Restriction Types', group: 'iam', glyph: 'R', adt: '', adtType: 'SIA2', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SIA3: { label: 'Authorization Object Extension', folder: 'Authorization Object Extensions', group: 'iam', glyph: 'X', adt: '', adtType: 'SIA3', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SIA5: { label: 'Restriction Field', folder: 'Restriction Fields', group: 'iam', glyph: 'F', adt: '', adtType: 'SIA5', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SIA6: { label: 'IAM App', folder: 'IAM Apps', group: 'iam', glyph: 'A', adt: '', adtType: 'SIA6', editor: 'xml', prefix: 'Z', maxLen: 36 },
  SIA7: { label: 'Business Catalog App Assignment', folder: 'Business Catalog App Assignments', group: 'iam', glyph: 'L', adt: '', adtType: 'SIA7', editor: 'xml', prefix: 'Z', maxLen: 40 },
  SIA8: { label: 'Business Role Template', folder: 'Business Role Templates', group: 'iam', glyph: 'T', adt: '', adtType: 'SIA8', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SIA9: { label: 'Role Template Catalog Assignment', folder: 'Role Template Catalog Assignments', group: 'iam', glyph: 'L', adt: '', adtType: 'SIA9', editor: 'xml', prefix: 'Z', maxLen: 40 },
  SCO1: { label: 'Communication Scenario', folder: 'Communication Scenarios', group: 'com', glyph: 'S', adt: '', adtType: 'SCO1', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SCO2: { label: 'Inbound Service', folder: 'Inbound Services', group: 'com', glyph: 'I', adt: '', adtType: 'SCO2', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SCO3: { label: 'Outbound Service', folder: 'Outbound Services', group: 'com', glyph: 'O', adt: '', adtType: 'SCO3', editor: 'xml', prefix: 'Z', maxLen: 30 },
  COTA: { label: 'Connection Target', folder: 'Connection Targets', group: 'com', glyph: 'T', adt: '', adtType: 'COTA', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SMBC: { label: 'Business Configuration Object', folder: 'Business Configuration Objects', group: 'bc', glyph: 'B', adt: '', adtType: 'SMBC', editor: 'xml', prefix: 'Z', maxLen: 30 },
  SAJC: { label: 'Application Job Catalog Entry', folder: 'Job Catalog Entries', group: 'jobs', glyph: 'J', adt: '', adtType: 'SAJC', editor: 'xml', prefix: 'Z', maxLen: 40 },
  SAJT: { label: 'Application Job Template', folder: 'Job Templates', group: 'jobs', glyph: 'J', adt: '', adtType: 'SAJT', editor: 'xml', prefix: 'Z', maxLen: 40 },
  NROB: { label: 'Number Range Object', folder: 'Number Range Objects', group: 'other', glyph: 'N', adt: '', adtType: 'NROB', editor: 'xml', prefix: 'Z', maxLen: 10 },
  APLO: { label: 'Application Log Object', folder: 'Application Log Objects', group: 'other', glyph: 'L', adt: '', adtType: 'APLO', editor: 'xml', prefix: 'Z', maxLen: 20 },
  HTTP: { label: 'HTTP Service', folder: 'HTTP Services', group: 'srv', glyph: 'H', adt: '', adtType: 'HTTP', editor: 'xml', prefix: 'Z', maxLen: 30 },
  EVTB: { label: 'Event Binding', folder: 'Event Bindings', group: 'srv', glyph: 'E', adt: '', adtType: 'EVTB', editor: 'xml', prefix: 'Z', maxLen: 30 },
  XOBJ: { label: 'Object', folder: 'Other Objects', group: 'other', glyph: '•', adt: '', adtType: '', editor: 'xml', readOnly: true, prefix: 'Z', maxLen: 40 },
};
export const GROUPS: { id: ObjGroup; label: string; types: ObjType[] }[] = [
  { id: 'srv', label: 'Business Services', types: ['SRVD', 'SRVB', 'HTTP', 'EVTB'] },
  { id: 'cds', label: 'Core Data Services', types: ['DDLS', 'BDEF', 'DDLX', 'DCLS'] },
  { id: 'ddic', label: 'Dictionary', types: ['TABL', 'DTEL', 'DOMA', 'TTYP'] },
  { id: 'src', label: 'Source Code Library', types: ['CLAS', 'INTF', 'PROG', 'FUGR', 'INCL', 'FUNC'] },
  { id: 'texts', label: 'Texts', types: ['MSAG'] },
  { id: 'auth', label: 'Authorizations', types: ['AUTH', 'SUSO', 'SUSH', 'SUCO'] },
  { id: 'iam', label: 'Identity and Access Management', types: ['SIA6', 'SIA1', 'SIA7', 'SIA8', 'SIA9', 'SIA2', 'SIA5', 'SIA3'] },
  { id: 'com', label: 'Cloud Communication Management', types: ['SCO1', 'SCO2', 'SCO3', 'COTA'] },
  { id: 'bc', label: 'Business Configuration Management', types: ['SMBC'] },
  { id: 'jobs', label: 'Application Jobs', types: ['SAJC', 'SAJT'] },
  { id: 'other', label: 'Others', types: ['NROB', 'APLO', 'XOBJ'] },
];
/** ADT type id (CLAS/OC) to our type */
export const ADT_TYPE: Record<string, ObjType> = Object.fromEntries(Object.entries(TYPE_INFO).filter(([, v]) => v.adtType).map(([k, v]) => [v.adtType, k as ObjType]));
/** Our type for an ADT type id: exact (CLAS/OC), then by its main type (SIA6/…), else XOBJ. */
export function adtTypeOf(raw: string): ObjType {
  if (!raw) return 'XOBJ';
  if (raw === 'FUGR/I') return 'INCL';                  // function group includes are includes
  if (ADT_TYPE[raw]) return ADT_TYPE[raw];
  const main = raw.split('/')[0].toUpperCase();
  if (main !== 'XOBJ' && main in TYPE_INFO) return main as ObjType;
  return 'XOBJ';
}
/** Types that are edited as source text (all others are forms). */
export const isSourceType = (t: ObjType) => TYPE_INFO[t].editor === 'abap' || TYPE_INFO[t].editor === 'cds';
export const isCdsLike = (t: ObjType) => TYPE_INFO[t].editor === 'cds';

export const INCLUDE_LABEL: Record<Include, string> = {
  main: 'Global Class', definitions: 'Class-relevant Local Types', implementations: 'Local Types',
  testclasses: 'Test Classes', macros: 'Macros',
  symbols: 'Text Symbols', selections: 'Selection Texts', headings: 'List Headings',
};

/** URI of a function module (it lives in its function group). */
export const fmUri = (group: string, fm: string) => `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}/fmodules/${encodeURIComponent(fm.toLowerCase())}`;
export const fgIncludeUri = (group: string, inc: string) => `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}/includes/${encodeURIComponent(inc.toLowerCase())}`;

/** URI of an object about to be created (function modules live under their group). */
export const newObjectUri = (type: ObjType, name: string, extra: CreateExtra = {}) =>
  type === 'FUNC' ? fmUri(extra.functionGroup || '', name) : uriFor(type, name);

export function uriFor(type: ObjType, name: string): string {
  if (!TYPE_INFO[type].adt) return `/sap/bc/adt/vit/wb/object_type/${type.toLowerCase()}/object_name/${encodeURIComponent(name.toLowerCase())}`;
  return TYPE_INFO[type].adt + encodeURIComponent(name.toLowerCase());
}
