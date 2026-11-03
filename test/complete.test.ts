// Completion contexts. Each case puts the cursor at "|".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeAbap, completeCds } from '../src/core/complete';
import { StdCatalog, WorkspaceCatalog, parseClassSource, parseCdsSource, parseFmSource, parseTableSource } from '../src/core/catalog';
import { MockBackend } from '../src/backends/mock';
import { uriFor } from '../src/core/types';

const SVC = `CLASS zcl_svc DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES tt_flights TYPE STANDARD TABLE OF /dmo/flight WITH EMPTY KEY.
    METHODS get_flights IMPORTING iv_carrier_id TYPE /dmo/carrier_id RETURNING VALUE(rt_flights) TYPE tt_flights.
    METHODS calc IMPORTING iv_max TYPE i iv_occ TYPE i RETURNING VALUE(rv) TYPE decfloat16.
    CLASS-METHODS create RETURNING VALUE(ro) TYPE REF TO zcl_svc.
    CONSTANTS c_version TYPE string VALUE '1'.
  PRIVATE SECTION.
    DATA mv_secret TYPE string.
ENDCLASS.
CLASS zcl_svc IMPLEMENTATION.
  METHOD get_flights. ENDMETHOD.
  METHOD calc. ENDMETHOD.
  METHOD create. ENDMETHOD.
ENDCLASS.`;
const cat = new WorkspaceCatalog(new StdCatalog(false), () => [{ name: 'ZCL_SVC', type: 'CLAS', desc: 'svc', source: SVC }, { name: 'ZI_FLT', type: 'DDLS', desc: 'cds', source: 'define view entity ZI_FLT as select from /dmo/flight { key carrier_id as Carrier, seats_max as Seats }' }]);

async function at(src: string, cloud = false) {
  const lines = src.split('\n');
  const line = lines.findIndex(l => l.includes('|'));
  const col = lines[line].indexOf('|');
  lines[line] = lines[line].replace('|', '');
  return completeAbap({ source: lines.join('\n'), line, col, catalog: new WorkspaceCatalog(new StdCatalog(cloud), () => [{ name: 'ZCL_SVC', type: 'CLAS', desc: 'svc', source: SVC }]), cloud });
}
async function cds(src: string) {
  const lines = src.split('\n');
  const line = lines.findIndex(l => l.includes('|'));
  const col = lines[line].indexOf('|');
  lines[line] = lines[line].replace('|', '');
  return completeCds({ source: lines.join('\n'), line, col, catalog: cat });
}
const labels = (ps: { label: string }[]) => ps.map(p => p.label);

test('parsers: class members, CDS elements, table and FM sources', () => {
  const c = parseClassSource(SVC, 'zcl_svc');
  assert.deepEqual(c.members.map(m => `${m.visibility}:${m.kind}:${m.name}`), ['public:type:tt_flights', 'public:method:get_flights', 'public:method:calc', 'public:method:create', 'public:constant:c_version', 'private:attribute:mv_secret']);
  assert.deepEqual(c.members[1].params, [{ name: 'iv_carrier_id', kind: 'importing', type: '/dmo/carrier_id', optional: false }, { name: 'rt_flights', kind: 'returning', type: 'tt_flights', optional: false }]);
  assert.deepEqual(parseCdsSource('@A.b: true\ndefine view entity X as select from t { key a as A, @UI.hidden: true b, cast( c as abap.char( 3 ) ) as C, _Assoc }').map(f => f.name), ['A', 'b', 'C', '_Assoc']);
  assert.deepEqual(parseTableSource("@EndUserText.label : 'x'\ndefine table zt { key mandt : mandt not null; key id : sysuuid_x16 not null; name : abap.char(30); include zs_admin; }").map(f => f.name), ['mandt', 'id', 'name', '.include']);
  const fm = parseFmSource('FUNCTION z_get\n  IMPORTING\n    VALUE(iv_id) TYPE i\n    VALUE(iv_flag) TYPE abap_bool OPTIONAL\n  EXPORTING\n    VALUE(ev_text) TYPE string\n  TABLES\n    et_lines STRUCTURE tline\n  EXCEPTIONS\n    not_found.\nENDFUNCTION.', 'Z_GET');
  assert.deepEqual(fm.params.map(p => `${p.kind}:${p.name}:${p.optional}`), ['importing:iv_id:false', 'importing:iv_flag:true', 'exporting:ev_text:true', 'tables:et_lines:false']);
  assert.deepEqual(fm.exceptions, ['not_found']);
});

test('-> offers instance methods with signature snippets, hides private outside the class', async () => {
  const r = await at('DATA(lo) = NEW zcl_svc( ).\nlo->|');
  assert.deepEqual(labels(r).slice(0, 2), ['get_flights', 'calc']);
  assert.ok(!labels(r).includes('mv_secret'));
  assert.equal(r.find(p => p.label === 'calc')?.insert, 'calc( iv_max = $0 iv_occ = )');
  assert.equal(r.find(p => p.label === 'get_flights')?.insert, 'get_flights( $0 )');
});

test('=> offers static members and constants', async () => {
  const r = await at('zcl_svc=>|');
  assert.deepEqual(labels(r).sort(), ['c_version', 'create', 'tt_flights']);
  const u = await at('cl_abap_unit_assert=>assert_e|');
  assert.equal(u[0].insert, 'assert_equals( act = $0 exp = )');
});

test('type inference through method returning types and LOOP INTO', async () => {
  const r = await at('DATA(lo) = NEW zcl_svc( ).\nDATA(lt) = lo->get_flights( iv_carrier_id = \'GA\' ).\nLOOP AT lt INTO DATA(ls).\n  ls-|');
  assert.ok(labels(r).includes('seats_max') && labels(r).includes('carrier_id'));
  const chain = await at('DATA(lv) = zcl_svc=>create( )->|');
  assert.ok(labels(chain).includes('calc'));
});

test('sy- and structures from local TYPES', async () => {
  assert.ok(labels(await at('IF sy-sub|')).includes('subrc'));
  const r = await at('TYPES: BEGIN OF ty_row,\n  id TYPE i,\n  name TYPE string,\nEND OF ty_row.\nDATA ls TYPE ty_row.\nls-|');
  assert.deepEqual(labels(r), ['id', 'name']);
});

test('TYPE slot lists built-ins, DDIC types and local types', async () => {
  const r = await at('TYPES tt_x TYPE STANDARD TABLE OF i.\nDATA lv TYPE |');
  const l = labels(r);
  assert.ok(l.includes('tt_x') && l.includes('string') && l.includes('REF TO'));
  assert.ok(labels(await at('DATA lv TYPE matn|')).includes('matnr'));
  assert.ok(labels(await at('DATA lo TYPE REF TO cl_abap_r|')).includes('cl_abap_random_int'));
});

test('ABAP Cloud hides non-released objects', async () => {
  assert.ok(!labels(await at('SELECT * FROM mar|', true)).includes('mara'));
  assert.ok(labels(await at('SELECT * FROM mar|', false)).includes('mara'));
  assert.ok(labels(await at('SELECT * FROM i_curr|', true)).includes('i_currency'));
});

test('SQL: sources, fields before FROM, alias~field, host variables', async () => {
  assert.ok(labels(await at('SELECT FROM /dmo/fl|')).includes('/dmo/flight'));
  const fields = await at('SELECT carrier_id, | FROM /dmo/flight INTO TABLE @DATA(lt).');
  assert.ok(labels(fields).includes('seats_occupied'));
  const where = await at('DATA lv_c TYPE /dmo/carrier_id.\nSELECT * FROM /dmo/flight WHERE carrier_id = |');
  assert.ok(labels(where).includes('@lv_c'));
  const join = await at('SELECT f~|, c~name FROM /dmo/flight AS f INNER JOIN /dmo/carrier AS c ON c~carrier_id = f~carrier_id INTO TABLE @DATA(lt).');
  assert.ok(labels(join).includes('seats_max'));
});

test('call parameters, CALL FUNCTION patterns and exceptions', async () => {
  const p = await at('DATA(lo) = NEW zcl_svc( ).\nDATA(x) = lo->calc( iv_max = 1 |');
  assert.deepEqual(labels(p).slice(0, 1), ['iv_occ']);
  const fm = await at("CALL FUNCTION 'CONVERSION_EXIT_ALPHA_IN|");
  assert.equal(fm[0].insert, "CONVERSION_EXIT_ALPHA_INPUT'\n  EXPORTING\n    input  = $0\n  IMPORTING\n    output = .");
  const popup = await at("CALL FUNCTION 'POPUP_TO_CONF|");
  assert.match(popup[0].insert, /\*   titlebar\s+= \n/);
  assert.match(popup[0].insert, /    others\s+= 2\.$/);
  const fmp = await at("CALL FUNCTION 'POPUP_TO_CONFIRM'\n  EXPORTING\n    |");
  assert.ok(labels(fmp).includes('text_question'));
  assert.ok(labels(await at('TRY.\n  CATCH cx_sy_z|')).includes('cx_sy_zerodivide'));
});

test('statement start depends on scope', async () => {
  const def = labels(await at('CLASS zcl_a DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    |'));
  assert.ok(def.includes('METHODS') && !def.includes('LOOP AT'));
  const meth = labels(await at('CLASS zcl_a IMPLEMENTATION.\n  METHOD run.\n    |'));
  assert.ok(meth.includes('LOOP AT') && meth.includes('loop'));
  const cloud = labels(await at('CLASS zcl_a IMPLEMENTATION.\n  METHOD run.\n    WRI|', true));
  assert.ok(!cloud.includes('WRITE'));
});

test('METHOD offers declared but unimplemented methods including interface methods', async () => {
  const r = await at('CLASS zcl_a DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES if_oo_adt_classrun.\n    METHODS one.\n    METHODS two.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD one.\n  ENDMETHOD.\n  METHOD |');
  assert.deepEqual(labels(r), ['if_oo_adt_classrun~main', 'two']);
});

test('field symbols and pragmas', async () => {
  assert.ok(labels(await at('FIELD-SYMBOLS <ls_row> TYPE any.\nASSIGN x TO <ls|')).includes('<ls_row>'));
  assert.ok(labels(await at('DATA lv TYPE i ##NEE|')).includes('##NEEDED'));
});

test('CDS: annotations, enum values, sources, elements, alias fields, abap types', async () => {
  const a = await cds('@AccessControl.auth|');
  assert.equal(a[0].insert, 'AccessControl.authorizationCheck: #');
  const e = await cds('@AccessControl.authorizationCheck: #NOT|');
  assert.deepEqual(labels(e).sort(), ['NOT_ALLOWED', 'NOT_REQUIRED']);
  assert.ok(labels(await cds('define view entity ZI_X as select from /dmo/fl|')).includes('/dmo/flight'));
  const el = await cds('define view entity ZI_X as select from /dmo/flight as f\n  association [1] to /dmo/carrier as _Carrier on $projection.carrier_id = _Carrier.carrier_id\n{\n  key |\n}');
  assert.ok(labels(el).includes('carrier_id') && labels(el).includes('_Carrier') && labels(el).includes('concat'));
  const q = await cds('define view entity ZI_X as select from /dmo/flight\n  association [1] to /dmo/carrier as _Carrier on $projection.carrier_id = _Carrier.|');
  assert.ok(labels(q).includes('name'));
  const t = await cds('define view entity ZI_X as select from /dmo/flight {\n  cast( price as abap.|');
  assert.ok(labels(t).includes('dec'));
  const ws = await cds('define view entity ZC_X as projection on ZI_FLT {\n  |\n}');
  assert.ok(labels(ws).includes('Carrier'));
});

test('mock backend uses the workspace: objects, members and the sample program', async () => {
  const b = new MockBackend();
  const prog = { uri: uriFor('PROG', 'ZR_NUSA_FLIGHTS'), name: 'ZR_NUSA_FLIGHTS', type: 'PROG' as const, pkg: '', desc: '' };
  const src = await b.read('s4d', prog, 'main', 'active');
  const lines = src.split('\n');
  const l = lines.findIndex(x => /WRITE:/.test(x));
  lines.splice(l, 0, '    ls_flight-');
  const r = await b.complete('s4d', prog, 'main', lines.join('\n'), l, 14);
  assert.ok(labels(r).includes('seats_max'));
  const cls = { uri: uriFor('CLAS', 'ZCL_NUSA_FLIGHT_SERVICE'), name: 'ZCL_NUSA_FLIGHT_SERVICE', type: 'CLAS' as const, pkg: '', desc: '' };
  const tc = await b.read('s4d', cls, 'testclasses', 'active');
  const tl = tc.split('\n');
  const i = tl.findIndex(x => /METHOD full_flight/.test(x));
  tl.splice(i + 1, 0, '    cut->');
  const r2 = await b.complete('s4d', cls, 'testclasses', tl.join('\n'), i + 1, 9);
  assert.ok(labels(r2).includes('calc_load_factor'));
});
