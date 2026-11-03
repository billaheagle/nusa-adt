// In-browser simulation of an ABAP system, used by the prototype and by tests.
// It behaves like the real backends from the UI's point of view: inactive/active
// versions, locks, transports, activation with syntax errors, ABAP Unit, ATC and a
// scripted debugger session for the sample program.

import { analyze, declaredMethods, implementedMethods, lineOf, prettyPrint, statements } from '../core/abap';
import { Catalog, StdCatalog, WorkspaceCatalog } from '../core/catalog';
import { completeAbap, completeCds } from '../core/complete';
import {
  AtcFinding, Backend, Breakpoint, Connection, DebugState, DebugVar, Hit, Include, Location, ObjRef, ObjState,
  ObjType, Problem, Proposal, RunResult, StepKind, SystemInfo, Transport, TransportNeed, UnitResult, uriFor,
} from '../core/types';

const wait = (ms = 90) => new Promise(r => setTimeout(r, ms));

const FLIGHTS = [
  { carrier_id: 'GA', connection_id: '0401', flight_date: '2026-11-10', price: '1850000.00', currency_code: 'IDR', plane_type_id: '737-800', seats_max: 162, seats_occupied: 146 },
  { carrier_id: 'GA', connection_id: '0402', flight_date: '2026-11-10', price: '1790000.00', currency_code: 'IDR', plane_type_id: '737-800', seats_max: 162, seats_occupied: 118 },
  { carrier_id: 'GA', connection_id: '0880', flight_date: '2026-11-12', price: '9450000.00', currency_code: 'IDR', plane_type_id: 'A330-300', seats_max: 393, seats_occupied: 350 },
];
export const FLIGHT_FIELDS = ['client', 'carrier_id', 'connection_id', 'flight_date', 'price', 'currency_code', 'plane_type_id', 'seats_max', 'seats_occupied'];

const SRC: Record<string, Partial<Record<Include, string>>> = {
  ZCL_NUSA_FLIGHT_SERVICE: {
    main: `CLASS zcl_nusa_flight_service DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES tt_flights TYPE STANDARD TABLE OF /dmo/flight WITH EMPTY KEY.

    METHODS get_flights
      IMPORTING iv_carrier_id     TYPE /dmo/carrier_id
      RETURNING VALUE(rt_flights) TYPE tt_flights.

    METHODS calc_load_factor
      IMPORTING iv_seats_max      TYPE /dmo/plane_seats_max
                iv_seats_occupied TYPE /dmo/plane_seats_occupied
      RETURNING VALUE(rv_percent) TYPE decfloat16.
ENDCLASS.


CLASS zcl_nusa_flight_service IMPLEMENTATION.

  METHOD get_flights.
    SELECT * FROM /dmo/flight
      WHERE carrier_id = @iv_carrier_id
      ORDER BY flight_date, connection_id
      INTO TABLE @rt_flights.
  ENDMETHOD.

  METHOD calc_load_factor.
    rv_percent = round( val = iv_seats_occupied * 100 / iv_seats_max dec = 2 ).
  ENDMETHOD.

ENDCLASS.
`,
    definitions: `*"* use this source file for any type of declarations (class
*"* definitions, interfaces or type declarations) you need for
*"* components in the private section
`,
    implementations: `*"* use this source file for the definition and implementation of
*"* local helper classes, interface definitions and type
*"* declarations
`,
    testclasses: `CLASS ltc_load_factor DEFINITION FINAL FOR TESTING
  DURATION SHORT RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    DATA cut TYPE REF TO zcl_nusa_flight_service.
    METHODS setup.
    METHODS full_flight FOR TESTING.
    METHODS rounds_to_two_decimals FOR TESTING.
    METHODS zero_seats_returns_zero FOR TESTING.
ENDCLASS.


CLASS ltc_load_factor IMPLEMENTATION.

  METHOD setup.
    cut = NEW #( ).
  ENDMETHOD.

  METHOD full_flight.
    cl_abap_unit_assert=>assert_equals(
      act = cut->calc_load_factor( iv_seats_max = 180 iv_seats_occupied = 180 )
      exp = 100 ).
  ENDMETHOD.

  METHOD rounds_to_two_decimals.
    cl_abap_unit_assert=>assert_equals(
      act = cut->calc_load_factor( iv_seats_max = 180 iv_seats_occupied = 131 )
      exp = '72.78' ).
  ENDMETHOD.

  METHOD zero_seats_returns_zero.
    cl_abap_unit_assert=>assert_equals(
      act = cut->calc_load_factor( iv_seats_max = 0 iv_seats_occupied = 0 )
      exp = 0 ).
  ENDMETHOD.

ENDCLASS.
`,
  },
  ZCL_NUSA_CONSOLE: {
    main: `CLASS zcl_nusa_console DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.


CLASS zcl_nusa_console IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
    DATA(lo_service) = NEW zcl_nusa_flight_service( ).
    DATA(lt_flights) = lo_service->get_flights( iv_carrier_id = 'GA' ).

    out->write( |{ lines( lt_flights ) } flights for carrier GA| ).
    out->write( lt_flights ).
  ENDMETHOD.

ENDCLASS.
`,
    definitions: '', implementations: '', testclasses: '',
  },
  ZIF_NUSA_LOGGER: {
    main: `INTERFACE zif_nusa_logger
  PUBLIC.

  METHODS log
    IMPORTING iv_text TYPE string.

  METHODS flush.
ENDINTERFACE.
`,
  },
  ZR_NUSA_FLIGHTS: {
    main: `REPORT zr_nusa_flights.

PARAMETERS p_carr TYPE /dmo/carrier_id DEFAULT 'GA'.

START-OF-SELECTION.
  DATA(lo_service) = NEW zcl_nusa_flight_service( ).
  DATA(lt_flights) = lo_service->get_flights( iv_carrier_id = p_carr ).

  LOOP AT lt_flights INTO DATA(ls_flight).
    DATA(lv_load) = lo_service->calc_load_factor(
                      iv_seats_max      = ls_flight-seats_max
                      iv_seats_occupied = ls_flight-seats_occupied ).
    WRITE: / ls_flight-connection_id, ls_flight-flight_date, lv_load.
  ENDLOOP.
`,
  },
  ZI_NUSA_FLIGHT: {
    main: `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Nusa: flight with load factor'
define view entity ZI_NUSA_FLIGHT
  as select from /dmo/flight
  association [1] to /dmo/carrier as _Carrier
    on $projection.CarrierId = _Carrier.carrier_id
{
  key carrier_id     as CarrierId,
  key connection_id  as ConnectionId,
  key flight_date    as FlightDate,
      seats_max      as SeatsMax,
      seats_occupied as SeatsOccupied,
      cast( division( seats_occupied * 100, seats_max, 2 )
            as abap.dec( 5, 2 ) ) as LoadFactor,
      _Carrier
}
`,
  },
};

const DESC: Record<string, [ObjType, string]> = {
  ZCL_NUSA_FLIGHT_SERVICE: ['CLAS', 'Nusa: flight service with load factor'],
  ZCL_NUSA_CONSOLE: ['CLAS', 'Nusa: console runner for the flight service'],
  ZIF_NUSA_LOGGER: ['INTF', 'Nusa: application log'],
  ZR_NUSA_FLIGHTS: ['PROG', 'Nusa: flight load factor list'],
  ZI_NUSA_FLIGHT: ['DDLS', 'Nusa: flight with load factor'],
};

const CONNS: Connection[] = [
  { id: 's4d', kind: 's4', sid: 'S4D', client: '100', user: 'DEVELOPER', url: 'https://s4d.nusa.internal:44300', language: 'EN', auth: 'basic', abapVersion: 'standard', favoritePackages: ['ZNUSA_FLIGHT'], transports: true, label: 'S/4HANA 2023 on-premise' },
  { id: 'trl', kind: 'btp', sid: 'TRL', client: '100', user: 'CB9980000123', url: 'https://nusa-dev.abap.ap21.hana.ondemand.com', language: 'EN', auth: 'oauth', abapVersion: 'cloud', favoritePackages: ['ZNUSA_FLIGHT'], transports: true, label: 'BTP ABAP Environment' },
  { id: 'loc', kind: 'runner', sid: 'LOCAL', client: '000', user: 'NUSA', url: 'http://localhost:7777', language: 'EN', auth: 'none', abapVersion: 'runner', favoritePackages: ['$TMP'], transports: false, label: 'ABAP runner on this laptop' },
];
const CONN_OBJECTS: Record<string, string[]> = {
  s4d: ['ZCL_NUSA_FLIGHT_SERVICE', 'ZIF_NUSA_LOGGER', 'ZR_NUSA_FLIGHTS', 'ZI_NUSA_FLIGHT'],
  trl: ['ZCL_NUSA_FLIGHT_SERVICE', 'ZCL_NUSA_CONSOLE', 'ZIF_NUSA_LOGGER', 'ZI_NUSA_FLIGHT'],
  loc: ['ZCL_NUSA_FLIGHT_SERVICE', 'ZR_NUSA_FLIGHTS'],
};
const SEED_TR: Record<string, Transport[]> = {
  s4d: [
    { id: 'S4DK900123', desc: 'Nusa: flight load factor', owner: 'DEVELOPER', status: 'modifiable', task: 'S4DK900124', objects: ['R3TR CLAS ZCL_NUSA_FLIGHT_SERVICE', 'R3TR PROG ZR_NUSA_FLIGHTS'] },
    { id: 'S4DK900130', desc: 'Nusa: CDS flight model', owner: 'DEVELOPER', status: 'modifiable', task: 'S4DK900131', objects: ['R3TR DDLS ZI_NUSA_FLIGHT'] },
    { id: 'S4DK900098', desc: 'Nusa: logger interface', owner: 'DEVELOPER', status: 'released', task: 'S4DK900099', objects: ['R3TR INTF ZIF_NUSA_LOGGER'] },
  ],
  trl: [
    { id: 'TRLK900012', desc: 'Nusa: flight service on BTP', owner: 'CB9980000123', status: 'modifiable', task: 'TRLK900013', objects: ['R3TR CLAS ZCL_NUSA_FLIGHT_SERVICE', 'R3TR CLAS ZCL_NUSA_CONSOLE', 'R3TR INTF ZIF_NUSA_LOGGER', 'R3TR DDLS ZI_NUSA_FLIGHT'] },
  ],
  loc: [],
};

interface MObj { ref: ObjState; saved: Partial<Record<Include, string>>; active: Partial<Record<Include, string>>; lock?: string }
interface Persisted { objs: Record<string, { ref: ObjState; saved: MObj['saved']; active: MObj['active'] }>; tr: Record<string, Transport[]>; seq: number }

const STORE_KEY = 'nusa-adt-mock-v1';

export class MockBackend implements Backend {
  readonly id = 'mock';
  private objs = new Map<string, MObj>();            // key: conn|URI
  private tr: Record<string, Transport[]> = {};
  private seq = 140;
  private dbg: { conn: string; steps: Step[]; i: number; inner: number; out: string[]; prog: ObjRef; cls: ObjRef } | null = null;

  constructor(private storage: Storage | null = null) {
    this.seed();
    this.restore();
  }

  private key(conn: string, uri: string) { return conn + '|' + uri; }

  private seed() {
    for (const c of CONNS) {
      for (const name of CONN_OBJECTS[c.id]) {
        const [type, desc] = DESC[name];
        const pkg = c.id === 'loc' ? '$TMP' : 'ZNUSA_FLIGHT';
        const uri = uriFor(type, name);
        const tr = (SEED_TR[c.id] || []).find(t => t.status === 'modifiable' && t.objects.includes(`R3TR ${type} ${name}`));
        const src = { ...SRC[name] };
        this.objs.set(this.key(c.id, uri), {
          ref: { uri, name, type, pkg, desc, inactive: false, transport: tr?.id },
          saved: { ...src }, active: { ...src },
        });
      }
      this.tr[c.id] = JSON.parse(JSON.stringify(SEED_TR[c.id] || []));
    }
  }

  private restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Persisted;
      for (const [k, v] of Object.entries(p.objs)) this.objs.set(k, { ...v });
      this.tr = p.tr;
      this.seq = p.seq;
    } catch { /* ignore broken storage */ }
  }

  private persist() {
    if (!this.storage) return;
    try {
      const objs: Persisted['objs'] = {};
      for (const [k, v] of this.objs) objs[k] = { ref: v.ref, saved: v.saved, active: v.active };
      this.storage.setItem(STORE_KEY, JSON.stringify({ objs, tr: this.tr, seq: this.seq }));
    } catch { /* storage may be unavailable */ }
  }

  reset() {
    try { this.storage?.removeItem(STORE_KEY); } catch { /* ignore */ }
    this.objs.clear(); this.tr = {}; this.seq = 140; this.seed();
  }

  private get(conn: string, uri: string): MObj {
    const o = this.objs.get(this.key(conn, uri));
    if (!o) throw new Error(`Object ${uri} does not exist in ${conn.toUpperCase()}`);
    return o;
  }
  private conn(id: string): Connection { return CONNS.find(c => c.id === id) as Connection; }
  private all(conn: string): MObj[] { return [...this.objs.entries()].filter(([k]) => k.startsWith(conn + '|')).map(([, v]) => v); }

  includesOf(type: ObjType): Include[] {
    return type === 'CLAS' ? ['main', 'definitions', 'implementations', 'testclasses'] : ['main'];
  }

  async connections() { return CONNS; }
  async saveConnection() { await wait(); }
  async connect(conn: string): Promise<SystemInfo> {
    await wait(150);
    const c = this.conn(conn);
    if (c.kind === 'runner') return { release: 'nusa-runner 0.3', components: ['ABAP subset: classes, reports, internal tables, Open SQL on SQLite'] };
    if (c.kind === 'btp') return { release: 'SAP BTP ABAP Environment 2611', components: ['SAP_BASIS 816', 'SAP_CLOUD 2611'] };
    return { release: 'S/4HANA 2023 FPS02', components: ['SAP_BASIS 758', 'S4CORE 108'] };
  }

  async packageObjects(conn: string, pkg: string): Promise<ObjState[]> {
    await wait(60);
    return this.all(conn).filter(o => o.ref.pkg === pkg).map(o => ({ ...o.ref }));
  }

  async search(conn: string, query: string): Promise<ObjRef[]> {
    const q = query.trim().toUpperCase().replace(/\*/g, '');
    return this.all(conn).filter(o => !q || o.ref.name.includes(q) || o.ref.desc.toUpperCase().includes(q)).map(o => ({ ...o.ref }));
  }

  async read(conn: string, obj: ObjRef, include: Include, version: 'active' | 'inactive') {
    await wait(40);
    const o = this.get(conn, obj.uri);
    return (version === 'active' ? o.active[include] : o.saved[include]) ?? '';
  }

  async state(conn: string, obj: ObjRef): Promise<ObjState> { return { ...this.get(conn, obj.uri).ref }; }

  async lock(conn: string, obj: ObjRef) {
    await wait(40);
    const o = this.get(conn, obj.uri);
    o.lock = o.lock || 'LOCK' + Math.random().toString(36).slice(2, 10).toUpperCase();
    o.ref.lockedBy = this.conn(conn).user;
    return o.lock;
  }
  async unlock(conn: string, obj: ObjRef) {
    const o = this.get(conn, obj.uri);
    o.lock = undefined; o.ref.lockedBy = undefined;
  }

  async transportNeed(conn: string, obj: ObjRef): Promise<TransportNeed> {
    const c = this.conn(conn);
    const o = this.get(conn, obj.uri);
    const requests = this.tr[conn].filter(t => t.status === 'modifiable');
    if (!c.transports || o.ref.pkg.startsWith('$')) return { needed: false, requests: [], reason: 'Local object' };
    if (o.ref.transport) return { needed: false, current: o.ref.transport, requests };
    return { needed: true, requests };
  }

  async createTransport(conn: string, desc: string): Promise<string> {
    await wait(120);
    const prefix = this.conn(conn).sid + 'K9';
    const id = prefix + String(++this.seq).padStart(5, '0');
    const task = prefix + String(++this.seq).padStart(5, '0');
    this.tr[conn].unshift({ id, desc, owner: this.conn(conn).user, status: 'modifiable', task, objects: [] });
    this.persist();
    return id;
  }

  private record(conn: string, o: MObj, transport?: string) {
    if (!transport) return;
    const t = this.tr[conn].find(x => x.id === transport);
    if (!t) throw new Error(`Transport request ${transport} does not exist`);
    if (t.status !== 'modifiable') throw new Error(`Request ${transport} is already released`);
    const entry = `R3TR ${o.ref.type} ${o.ref.name}`;
    if (!t.objects.includes(entry)) t.objects.push(entry);
    o.ref.transport = transport;
  }

  async write(conn: string, obj: ObjRef, include: Include, source: string, lock: string, transport?: string) {
    await wait(80);
    const o = this.get(conn, obj.uri);
    if (o.lock !== lock) throw new Error(`${obj.name} is not locked by you. Reopen the editor to lock it again.`);
    const need = await this.transportNeed(conn, obj);
    if (need.needed && !transport) throw new Error(`${obj.name} must be recorded in a transport request`);
    if (transport) this.record(conn, o, transport);
    o.saved[include] = source;
    o.ref.inactive = this.includesOf(o.ref.type).some(i => (o.saved[i] ?? '') !== (o.active[i] ?? ''));
    this.persist();
  }

  async createObject(conn: string, type: ObjType, name: string, desc: string, pkg: string, transport?: string): Promise<ObjRef> {
    await wait(150);
    const uri = uriFor(type, name);
    if (this.objs.has(this.key(conn, uri))) throw new Error(`${name} already exists`);
    const n = name.toLowerCase();
    const tpl: Record<ObjType, Partial<Record<Include, string>>> = {
      CLAS: {
        main: `CLASS ${n} DEFINITION\n  PUBLIC\n  FINAL\n  CREATE PUBLIC.\n\n  PUBLIC SECTION.\n  PROTECTED SECTION.\n  PRIVATE SECTION.\nENDCLASS.\n\n\nCLASS ${n} IMPLEMENTATION.\nENDCLASS.\n`,
        definitions: SRC.ZCL_NUSA_FLIGHT_SERVICE.definitions, implementations: SRC.ZCL_NUSA_FLIGHT_SERVICE.implementations, testclasses: '',
      },
      INTF: { main: `INTERFACE ${n}\n  PUBLIC.\n\nENDINTERFACE.\n` },
      PROG: { main: `REPORT ${n}.\n\nSTART-OF-SELECTION.\n  \n` },
      DDLS: { main: `@AccessControl.authorizationCheck: #NOT_REQUIRED\n@EndUserText.label: '${desc.replace(/'/g, '')}'\ndefine view entity ${name}\n  as select from data_source_name\n{\n  \n}\n` },
    };
    const empty: Partial<Record<Include, string>> = {};
    const o: MObj = { ref: { uri, name, type, pkg, desc, inactive: true }, saved: { ...tpl[type] }, active: empty };
    this.objs.set(this.key(conn, uri), o);
    this.record(conn, o, transport);
    this.persist();
    return { uri, name, type, pkg, desc };
  }

  // ---------------------------------------------------------------- checks

  private check(conn: string, o: MObj, include: Include, source: string): Problem[] {
    const c = this.conn(conn);
    const at = (line: number, msg: string, sev: Problem['sev'] = 'error'): Problem => ({ sev, msg, uri: o.ref.uri, include, line, source: 'syntax' });
    if (o.ref.type === 'DDLS') {
      const out: Problem[] = [];
      const opens = (source.match(/\{/g) || []).length, closes = (source.match(/\}/g) || []).length;
      if (opens !== closes) out.push(at(Math.max(0, lineOf(source, /[{}]/)), 'Unbalanced braces in the element list'));
      if (/data_source_name/.test(source)) out.push(at(lineOf(source, /data_source_name/), 'Data source DATA_SOURCE_NAME does not exist'));
      return out;
    }
    const lines = source.split('\n');
    const a = analyze(lines);
    const out = a.errors.map(e => at(e.line, e.msg));
    for (const s of a.st) {
      if (c.abapVersion === 'cloud' && ['WRITE', 'FORM', 'PERFORM', 'REPORT', 'PARAMETERS'].includes(s.kw)) {
        out.push(at(s.start, `${s.kw} is not permitted in ABAP for Cloud Development`));
      }
      if (s.kw === 'MOVE') out.push(at(s.start, 'MOVE is obsolete. Use the assignment operator "=" instead', 'warning'));
    }
    if (o.ref.type === 'CLAS' && include === 'main') {
      const decl = declaredMethods(a.st).filter(m => m.cls === o.ref.name.toLowerCase());
      const impl = implementedMethods(a.st).filter(m => m.cls === o.ref.name.toLowerCase());
      for (const m of impl) {
        if (m.name.includes('~')) continue;
        if (!decl.some(d => d.name === m.name)) out.push(at(m.line, `Method "${m.name.toUpperCase()}" is not declared or inherited in class "${o.ref.name}"`));
      }
      for (const d of decl) {
        if (!impl.some(m => m.name === d.name)) out.push(at(d.line, `Implementation missing for method "${d.name.toUpperCase()}"`));
      }
    }
    return out;
  }

  async syntaxCheck(conn: string, obj: ObjRef, include: Include, source: string) {
    await wait(70);
    return this.check(conn, this.get(conn, obj.uri), include, source);
  }

  async activate(conn: string, objs: ObjRef[]) {
    await wait(200);
    const problems: Problem[] = [];
    for (const r of objs) {
      const o = this.get(conn, r.uri);
      for (const inc of this.includesOf(o.ref.type)) {
        problems.push(...this.check(conn, o, inc, o.saved[inc] ?? '').map(p => ({ ...p, source: 'activation' as const })));
      }
    }
    const errors = problems.filter(p => p.sev === 'error');
    if (errors.length) return { ok: false, problems };
    for (const r of objs) {
      const o = this.get(conn, r.uri);
      o.active = { ...o.saved };
      o.ref.inactive = false;
    }
    this.persist();
    return { ok: true, problems };
  }

  async prettyPrint(_conn: string, source: string) { await wait(60); return prettyPrint(source); }

  // ---------------------------------------------------------------- code intelligence

  private catalogs = new Map<string, Catalog>();
  private catalog(conn: string): Catalog {
    let c = this.catalogs.get(conn);
    if (!c) {
      c = new WorkspaceCatalog(new StdCatalog(this.conn(conn).abapVersion === 'cloud'),
        () => this.all(conn).map(o => ({ name: o.ref.name, type: o.ref.type, desc: o.ref.desc, source: o.saved.main ?? '' })));
      this.catalogs.set(conn, c);
    }
    return c;
  }

  async complete(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Proposal[]> {
    const o = this.objs.get(this.key(conn, obj.uri));
    const related = o ? this.includesOf(o.ref.type).filter(i => i !== include).map(i => o.saved[i] ?? '') : [];
    const req = { source, line, col, catalog: this.catalog(conn), cloud: this.conn(conn).abapVersion === 'cloud', related };
    return obj.type === 'DDLS' ? completeCds(req) : completeAbap(req);
  }

  private wordAt(source: string, line: number, col: number): string {
    const text = source.split('\n')[line] ?? '';
    let a = col, b = col;
    while (a > 0 && /[\w/~]/.test(text[a - 1])) a--;
    while (b < text.length && /[\w/~]/.test(text[b])) b++;
    return text.slice(a, b);
  }

  async navigate(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Location | null> {
    const word = this.wordAt(source, line, col).toLowerCase();
    if (!word) return null;
    const target = this.all(conn).find(o => o.ref.name.toLowerCase() === word);
    if (target) return { uri: target.ref.uri, include: 'main', line: 0 };
    for (const o of this.all(conn)) {
      if (o.ref.type !== 'CLAS') continue;
      const src = o.saved.main ?? '';
      const l = lineOf(src, new RegExp(`^\\s*METHOD\\s+${word.replace(/[~/]/g, '\\$&')}\\s*\\.`, 'i'));
      if (l >= 0) return { uri: o.ref.uri, include: 'main', line: l };
    }
    const decl = lineOf(source, new RegExp(`(DATA\\(|DATA:?\\s+|FIELD-SYMBOL\\()${word}\\b|\\b${word}\\s+TYPE\\b`, 'i'));
    if (decl >= 0) return { uri: obj.uri, include, line: decl };
    return null;
  }

  async whereUsed(conn: string, _obj: ObjRef, _include: Include, source: string, line: number, col: number): Promise<Hit[]> {
    await wait(120);
    const word = this.wordAt(source, line, col);
    if (!word) return [];
    const re = new RegExp(`(^|[^\\w/])${word.replace(/[~/]/g, '\\$&')}(?![\\w/])`, 'i');
    const hits: Hit[] = [];
    for (const o of this.all(conn)) {
      for (const inc of this.includesOf(o.ref.type)) {
        (o.saved[inc] ?? '').split('\n').forEach((t, i) => {
          if (re.test(t) && !/^\s*\*/.test(t)) hits.push({ uri: o.ref.uri, include: inc, line: i, name: o.ref.name, type: o.ref.type, text: t.trim() });
        });
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------- transports

  async transports(conn: string) { await wait(60); return JSON.parse(JSON.stringify(this.tr[conn] || [])) as Transport[]; }

  async releaseTransport(conn: string, id: string) {
    await wait(250);
    const t = this.tr[conn].find(x => x.id === id);
    if (!t) throw new Error(`Request ${id} not found`);
    const inactive = this.all(conn).filter(o => o.ref.transport === id && o.ref.inactive);
    if (inactive.length) throw new Error(`Release not possible: ${inactive.map(o => o.ref.name).join(', ')} still inactive`);
    t.status = 'released';
    for (const o of this.all(conn)) if (o.ref.transport === id) o.ref.transport = undefined;
    this.persist();
  }

  // ---------------------------------------------------------------- tests, ATC, run

  private guardOk(conn: string): boolean {
    const svc = this.all(conn).find(o => o.ref.name === 'ZCL_NUSA_FLIGHT_SERVICE');
    const src = svc?.active.main ?? '';
    const start = lineOf(src, /^\s*METHOD\s+calc_load_factor/i);
    const body = src.split('\n').slice(start, lineOf(src, /^\s*ENDMETHOD/i, start + 1) + 1).join('\n');
    return /iv_seats_max\s*(=\s*0|IS\s+INITIAL|<=\s*0|EQ\s+0)/i.test(body);
  }

  async runUnit(conn: string, obj: ObjRef): Promise<UnitResult> {
    await wait(450);
    const o = this.get(conn, obj.uri);
    if (o.ref.type !== 'CLAS') return { uri: obj.uri, methods: [], note: 'ABAP Unit in this prototype runs on classes.' };
    const src = o.active.testclasses ?? '';
    const tests = declaredMethods(statements(src.split('\n'))).filter(m => m.testing);
    const note = o.ref.inactive ? 'Tests ran against the active version. Activate to include your latest changes.' : undefined;
    const main = o.active.main ?? '';
    const divLine = Math.max(0, lineOf(main, /round\(/i));
    const methods = tests.map((t, i) => {
      const at: Location = { uri: obj.uri, include: 'testclasses', line: Math.max(0, lineOf(src, new RegExp(`^\\s*METHOD\\s+${t.name}\\s*\\.`, 'i'))) };
      const ms = 2 + ((i * 7 + t.name.length) % 9);
      if (/zero/.test(t.name) && !this.guardOk(conn)) {
        return { cls: t.cls, method: t.name, status: 'error' as const, ms, msg: 'Exception CX_SY_ZERODIVIDE: Division by zero in CALC_LOAD_FACTOR', at: { uri: obj.uri, include: 'main' as Include, line: divLine } };
      }
      return { cls: t.cls, method: t.name, status: 'ok' as const, ms, at };
    });
    return { uri: obj.uri, methods, note };
  }

  async runAtc(conn: string, obj: ObjRef): Promise<AtcFinding[]> {
    await wait(380);
    const o = this.get(conn, obj.uri);
    const c = this.conn(conn);
    const out: AtcFinding[] = [];
    for (const inc of this.includesOf(o.ref.type)) {
      const lines = (o.saved[inc] ?? '').split('\n');
      if (o.ref.type === 'DDLS') continue;
      for (const s of statements(lines)) {
        const at: Location = { uri: o.ref.uri, include: inc, line: s.start };
        if (s.kw === 'SELECT' && /^SELECT\s+\*/i.test(s.text.trim())) out.push({ prio: 2, check: 'Performance', msg: 'SELECT * reads every column of /DMO/FLIGHT. List the fields you use.', at });
        if (/CATCH\s+CX_ROOT/i.test(s.text)) out.push({ prio: 2, check: 'Robustness', msg: 'Catching CX_ROOT also hides programming errors. Catch a specific exception class.', at });
        if (s.kw === 'MOVE') out.push({ prio: 3, check: 'Obsolete statements', msg: 'MOVE is obsolete. Use "=".', at });
        if (c.abapVersion === 'cloud' && s.kw === 'WRITE') out.push({ prio: 1, check: 'ABAP Cloud readiness', msg: 'WRITE is not released for ABAP Cloud.', at });
        if (s.kw === 'SELECT' && !/\bWHERE\b/i.test(s.text)) out.push({ prio: 3, check: 'Performance', msg: 'SELECT without WHERE reads the whole table.', at });
      }
    }
    if (o.ref.type === 'CLAS' && !/FOR\s+TESTING/i.test(o.saved.testclasses ?? '') && !/if_oo_adt_classrun/i.test(o.saved.main ?? '')) {
      out.push({ prio: 3, check: 'ABAP Unit', msg: 'The class has no unit tests.', at: { uri: o.ref.uri, include: 'testclasses', line: 0 } });
    }
    return out.sort((a, b) => a.prio - b.prio);
  }

  private carrierOf(src: string): string {
    return ((src.match(/DEFAULT\s+'(\w+)'/i) || [])[1] || 'GA').toUpperCase();
  }
  private load(f: typeof FLIGHTS[number]): string {
    if (!f.seats_max) return '0.00';
    return (Math.round(f.seats_occupied * 10000 / f.seats_max) / 100).toFixed(2);
  }
  private listLine(f: typeof FLIGHTS[number]): string {
    const d = f.flight_date.split('-').reverse().join('.');
    return `${f.connection_id} ${d}${this.load(f).padStart(24)}`;
  }

  async run(conn: string, obj: ObjRef): Promise<RunResult> {
    await wait(300);
    const o = this.get(conn, obj.uri);
    const c = this.conn(conn);
    const note = o.ref.inactive ? 'Ran the active version. Your inactive changes are not included.' : undefined;
    if (o.ref.type === 'PROG') {
      const carr = this.carrierOf(o.active.main ?? '');
      const rows = FLIGHTS.filter(f => f.carrier_id === carr);
      const head = `${o.ref.name.padEnd(40)}${c.sid} ${c.client}`;
      return { kind: 'list', note, output: [head, '-'.repeat(56), ...rows.map(f => this.listLine(f)), rows.length ? '' : '(no flights for ' + carr + ')'].join('\n') };
    }
    if (o.ref.type === 'CLAS' && /if_oo_adt_classrun/i.test(o.active.main ?? '')) {
      const cols = ['CARRIER_ID', 'CONNECTION_ID', 'FLIGHT_DATE', 'PRICE', 'CURRENCY_CODE', 'PLANE_TYPE_ID', 'SEATS_MAX', 'SEATS_OCCUPIED'];
      const vals = FLIGHTS.map(f => [f.carrier_id, f.connection_id, f.flight_date, f.price, f.currency_code, f.plane_type_id, String(f.seats_max), String(f.seats_occupied)]);
      const w = cols.map((h, i) => Math.max(h.length, ...vals.map(v => v[i].length)));
      const row = (v: string[]) => v.map((x, i) => x.padEnd(w[i])).join(' ');
      return { kind: 'console', note, output: [`${FLIGHTS.length} flights for carrier GA`, row(cols), ...vals.map(row)].join('\n') };
    }
    if (o.ref.type === 'CLAS') throw new Error(`${o.ref.name} does not implement IF_OO_ADT_CLASSRUN, so it cannot run as a console application`);
    throw new Error(`${o.ref.name} cannot be executed`);
  }

  // ---------------------------------------------------------------- debugger (scripted for the sample program)

  async debugStart(conn: string, obj: ObjRef, bps: Breakpoint[]): Promise<DebugState | null> {
    const o = this.get(conn, obj.uri);
    if (o.ref.type !== 'PROG') return null;
    const cls = this.all(conn).find(x => x.ref.name === 'ZCL_NUSA_FLIGHT_SERVICE');
    const steps = buildTrace(o.active.main ?? '', cls?.active.main ?? '', this.carrierOf(o.active.main ?? ''), (f) => this.load(f), (f) => this.listLine(f));
    if (!steps || !cls) return null;
    this.dbg = { conn, steps, i: -1, inner: -1, out: [], prog: o.ref, cls: cls.ref };
    return this.advance('continue', bps);
  }

  async debugStep(kind: StepKind, bps: Breakpoint[]) { await wait(60); return this.advance(kind, bps); }
  async debugStop() { this.dbg = null; }

  private advance(kind: StepKind, bps: Breakpoint[]): DebugState {
    const d = this.dbg;
    if (!d) return { done: true, frames: [], vars: [], outputSoFar: '' };
    const isBp = (uri: string, include: Include, line: number) => bps.some(b => b.uri === uri && b.include === include && b.line === line);
    const leave = () => { const s = d.steps[d.i]; if (s && s.out) d.out.push(s.out); };

    if (d.inner >= 0) {                                   // inside CALC_LOAD_FACTOR
      const s = d.steps[d.i];
      if (kind !== 'return' && d.inner < (s.inner?.length ?? 0) - 1) { d.inner++; return this.view(); }
      d.inner = -1;                                       // back in the caller, next statement
      if (kind === 'continue') return this.runOn(isBp, leave);
      leave(); d.i++;
      return d.i >= d.steps.length ? this.finish() : this.view();
    }
    if (kind === 'into' && d.i >= 0 && d.steps[d.i].inner) { d.inner = 0; return this.view(); }
    if (kind === 'continue') return this.runOn(isBp, leave);
    if (d.i >= 0) leave();
    d.i++;
    return d.i >= d.steps.length ? this.finish() : this.view();
  }

  private runOn(isBp: (u: string, i: Include, l: number) => boolean, leave: () => void): DebugState {
    const d = this.dbg as NonNullable<MockBackend['dbg']>;
    while (true) {
      if (d.i >= 0) leave();
      d.i++;
      if (d.i >= d.steps.length) return this.finish();
      const s = d.steps[d.i];
      if (isBp(d.prog.uri, 'main', s.line)) return this.view();
      if (s.inner && s.inner.some(x => isBp(d.cls.uri, 'main', x.line))) {
        d.inner = s.inner.findIndex(x => isBp(d.cls.uri, 'main', x.line));
        return this.view();
      }
    }
  }

  private view(): DebugState {
    const d = this.dbg as NonNullable<MockBackend['dbg']>;
    const s = d.steps[d.i];
    const progFrame = { name: `${d.prog.name} · START-OF-SELECTION`, uri: d.prog.uri, include: 'main' as Include, line: s.line };
    if (d.inner >= 0 && s.inner) {
      const x = s.inner[d.inner];
      return { done: false, frames: [{ name: 'ZCL_NUSA_FLIGHT_SERVICE→CALC_LOAD_FACTOR', uri: d.cls.uri, include: 'main', line: x.line }, progFrame], vars: x.vars, outputSoFar: d.out.join('\n') };
    }
    return { done: false, frames: [progFrame], vars: s.vars, outputSoFar: d.out.join('\n') };
  }

  private finish(): DebugState {
    const out = this.dbg?.out.join('\n') ?? '';
    this.dbg = null;
    return { done: true, frames: [], vars: [], outputSoFar: out };
  }
}

interface Step { line: number; vars: DebugVar[]; out?: string; inner?: { line: number; vars: DebugVar[] }[] }

function buildTrace(prog: string, cls: string, carr: string, load: (f: typeof FLIGHTS[number]) => string, listLine: (f: typeof FLIGHTS[number]) => string): Step[] | null {
  const L = {
    svc: lineOf(prog, /DATA\(lo_service\)/i), get: lineOf(prog, /->get_flights/i), loop: lineOf(prog, /^\s*LOOP\s+AT/i),
    calc: lineOf(prog, /->calc_load_factor/i), write: lineOf(prog, /^\s*WRITE/i),
  };
  const C = { body: lineOf(cls, /rv_percent\s*=/i), end: -1 };
  C.end = lineOf(cls, /^\s*ENDMETHOD/i, C.body);
  if (Object.values(L).some(v => v < 0) || C.body < 0) return null;
  const rows = FLIGHTS.filter(f => f.carrier_id === carr);
  const v = (name: string, type: string, value: string, children?: DebugVar[]): DebugVar => ({ name, type, value, children });
  const flightVar = (f: typeof FLIGHTS[number] | null, name = 'LS_FLIGHT') => v(name, '/DMO/FLIGHT', f ? `Structure: ${f.connection_id} ${f.flight_date}` : 'Structure: initial',
    FLIGHT_FIELDS.slice(1).map(k => v(k.toUpperCase(), 'field', f ? String((f as Record<string, unknown>)[k]) : '')));
  const table = v('LT_FLIGHTS', 'TT_FLIGHTS', `Standard Table [${rows.length}x9]`, rows.map((f, i) => flightVar(f, `[${i + 1}]`)));
  const emptyTable = v('LT_FLIGHTS', 'TT_FLIGHTS', 'Standard Table [0x9]');
  const sy = (tabix: number, subrc = 0) => v('SY', 'SYST', `SUBRC = ${subrc}, TABIX = ${tabix}`, [v('SUBRC', 'I', String(subrc)), v('TABIX', 'I', String(tabix)), v('UNAME', 'C(12)', 'DEVELOPER')]);
  const pc = v('P_CARR', '/DMO/CARRIER_ID', `'${carr}'`);
  const svc = v('LO_SERVICE', 'REF TO ZCL_NUSA_FLIGHT_SERVICE', '{O:7*\\CLASS=ZCL_NUSA_FLIGHT_SERVICE}');
  const steps: Step[] = [
    { line: L.svc, vars: [pc, v('LO_SERVICE', 'REF TO ZCL_NUSA_FLIGHT_SERVICE', 'initial'), emptyTable, sy(0)] },
    { line: L.get, vars: [pc, svc, emptyTable, sy(0)] },
  ];
  let lastLoad = '0.00';
  rows.forEach((f, i) => {
    const before = [pc, svc, table, flightVar(i ? rows[i - 1] : null), v('LV_LOAD', 'DECFLOAT16', lastLoad), sy(i)];
    steps.push({ line: L.loop, vars: before });
    const cur = [pc, svc, table, flightVar(f), v('LV_LOAD', 'DECFLOAT16', lastLoad), sy(i + 1)];
    const params = [v('IV_SEATS_MAX', '/DMO/PLANE_SEATS_MAX', String(f.seats_max)), v('IV_SEATS_OCCUPIED', '/DMO/PLANE_SEATS_OCCUPIED', String(f.seats_occupied)), v('ME', 'REF TO ZCL_NUSA_FLIGHT_SERVICE', '{O:7*\\CLASS=ZCL_NUSA_FLIGHT_SERVICE}')];
    steps.push({
      line: L.calc, vars: cur,
      inner: [
        { line: C.body, vars: [...params, v('RV_PERCENT', 'DECFLOAT16', '0')] },
        { line: C.end, vars: [...params, v('RV_PERCENT', 'DECFLOAT16', load(f))] },
      ],
    });
    lastLoad = load(f);
    steps.push({ line: L.write, vars: [pc, svc, table, flightVar(f), v('LV_LOAD', 'DECFLOAT16', lastLoad), sy(i + 1)], out: listLine(f) });
  });
  return steps;
}
