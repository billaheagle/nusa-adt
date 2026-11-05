import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAbap } from '../src/core/cleaner';
import { planRap, rapNames, validateRap } from '../src/core/rapgen';
import { keywordDocUrl } from '../src/core/docs';
import { outline } from '../src/core/outline';
import { parseTableSource } from '../src/core/catalog';
import { template, aliasOf } from '../src/core/templates';
import { parseBinding, parseDataPreview, parseGitRepos, parseNamedItems, parseNodeStructure } from '../src/adt/client';
import { MockBackend } from '../src/backends/mock';

test('cleaner rewrites obsolete statements and keeps comments', () => {
  const src = [
    'METHOD run.',
    '  MOVE lv_a TO lv_b.',
    '  CREATE OBJECT lo_log TYPE zcl_log EXPORTING iv_name = lv_b.',
    '  CREATE OBJECT lo_x.',
    '  CALL METHOD lo_log->add EXPORTING iv_text = lv_b.',
    '  CALL METHOD lo_log->flush.',
    '  CALL METHOD lo_log->get EXPORTING iv_id = 1 IMPORTING ev_text = lv_t.',
    '  IF NOT lv_a IS INITIAL AND lv_b NE 3.',
    '    TRANSLATE lv_b TO UPPER CASE.',
    '  ENDIF.',
    '  MOVE lv_a TO lv_b. " keep this one',
    '  DATA: lv_c TYPE i, lv_long_name TYPE string.',
    '',
    '',
    'ENDMETHOD.   ',
  ].join('\n');
  const r = cleanAbap(src);
  const out = r.text.split('\n');
  assert.equal(out[1], '  lv_b = lv_a.');
  assert.equal(out[2], '  lo_log = NEW zcl_log( iv_name = lv_b ).');
  assert.equal(out[3], '  lo_x = NEW #( ).');
  assert.equal(out[4], '  lo_log->add( iv_text = lv_b ).');
  assert.equal(out[5], '  lo_log->flush( ).');
  assert.equal(out[6], '  lo_log->get( EXPORTING iv_id = 1 IMPORTING ev_text = lv_t ).');
  assert.equal(out[7], '  IF lv_a IS NOT INITIAL AND lv_b <> 3.');
  assert.equal(out[8], '    lv_b = to_upper( lv_b ).');
  assert.equal(out[10], '  MOVE lv_a TO lv_b. " keep this one');
  assert.equal(out[11], '  DATA lv_c         TYPE i.');
  assert.equal(out[12], '  DATA lv_long_name TYPE string.');
  assert.equal(out.length, 15);
  assert.equal(out[14], 'ENDMETHOD.');
  assert.ok(r.changes.find(c => c.rule === 'createObjectToNew')?.count === 2);
});

test('cleaner leaves two blank lines after ENDCLASS', () => {
  const r = cleanAbap('CLASS a DEFINITION.\nENDCLASS.\n\n\nCLASS a IMPLEMENTATION.\nENDCLASS.', ['blankLines']);
  assert.equal(r.changes.length, 0);
});

test('RAP generator plans a complete stack from a table', () => {
  const fields = parseTableSource(new MockBackendSource().travel);
  const plan = planRap({ table: 'ZNUSA_TRAVEL', fields, base: 'NUSA_TRAVEL', label: 'Nusa: travel' });
  assert.deepEqual(plan.map(p => `${p.type} ${p.name}`), ['DDLS ZR_NUSA_TRAVEL', 'DDLS ZC_NUSA_TRAVEL', 'DDLX ZC_NUSA_TRAVEL', 'BDEF ZR_NUSA_TRAVEL', 'BDEF ZC_NUSA_TRAVEL', 'SRVD ZUI_NUSA_TRAVEL', 'SRVB ZUI_NUSA_TRAVEL_O4']);
  assert.match(plan[0].source, /define root view entity ZR_NUSA_TRAVEL\n  as select from znusa_travel/);
  assert.match(plan[0].source, /@Semantics.amount.currencyCode: 'CurrencyCode'\n {6}total_price\s+as TotalPrice/);
  assert.doesNotMatch(plan[0].source, /client/);
  assert.match(plan[3].source, /field \( mandatory : create, readonly : update \) TravelId;/);
  assert.match(plan[3].source, /etag master LastChangedAt/);
  assert.match(plan[3].source, /TravelId\s+= travel_id;/);
  assert.equal(plan[6].extra?.serviceDefinition, 'ZUI_NUSA_TRAVEL');
  assert.equal(rapNames('NUSA_TRAVEL').alias, 'Travel');
  assert.match(validateRap('A_VERY_LONG_BUSINESS_OBJECT_NAME') || '', /longer than/);
});

class MockBackendSource { travel = '@EndUserText.label : \'x\'\ndefine table znusa_travel {\n  key client : abap.clnt not null;\n  key travel_id : abap.numc(8) not null;\n  description : abap.char(60);\n  @Semantics.amount.currencyCode : \'znusa_travel.currency_code\'\n  total_price : abap.curr(16,2);\n  currency_code : abap.cuky;\n  last_changed_at : abp_lastchange_tstmpl;\n}'; }

test('F1 maps statements to the keyword documentation', () => {
  assert.match(keywordDocUrl('LOOP AT lt INTO DATA(ls).', 0, 2).url, /file=abaploop_at_itab\.htm$/);
  assert.match(keywordDocUrl('DATA(x) = VALUE #( ).', 0, 13).url, /abenconstructor_expression_value\.htm$/);
  assert.match(keywordDocUrl('SELECT * FROM t\n  INTO TABLE @DATA(r).', 1, 4).url, /abapselect\.htm$/);
  assert.match(keywordDocUrl('x', 0, 0, { cloud: true }).url, /abapdocu_cp_index_htm\/CLOUD/);
  assert.match(keywordDocUrl('define root view entity X as select from t {}', 0, 3, { cds: true }).url, /abencds_define_view_entity/);
});

test('outline lists class parts and CDS elements', () => {
  const o = outline('CLASS zcl_a DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\n    DATA mv_x TYPE i.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS.', false);
  assert.deepEqual(o.map(i => `${i.kind}:${i.name}:${i.line}`), ['class:zcl_a:0', 'section:public section:1', 'method:run:2', 'attribute:mv_x:3', 'class:zcl_a:5', 'method:run:6']);
  const c = outline('define view entity X as select from t\n{\n  key a as A,\n  b as B\n}', true);
  assert.deepEqual(c.map(i => i.name), ['X', 'A', 'B']);
});

test('templates and aliases', () => {
  assert.match(template('SRVD', 'ZUI_X', 'x', { referencedObject: 'ZC_X' }), /expose ZC_X;/);
  assert.match(template('TABL', 'ZTAB', "it's"), /label : 'it''s'/);
  assert.equal(aliasOf('ZR_NUSA_TRAVEL'), 'NusaTravel');
});

test('ADT parsers: packages, value helps, bindings, data preview, abapGit', () => {
  const ns = parseNodeStructure(`<asx:abap xmlns:asx="x"><asx:values><DATA><TREE_CONTENT>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>DEVC/K</OBJECT_TYPE><OBJECT_NAME>ZPKG_SUB</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/packages/zpkg_sub</OBJECT_URI><DESCRIPTION>Sub</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>SRVB/SVB</OBJECT_TYPE><OBJECT_NAME>ZUI_X_O4</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/businessservices/bindings/zui_x_o4</OBJECT_URI><DESCRIPTION>B</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>TABL/DT</OBJECT_TYPE><OBJECT_NAME>ZTAB</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/ddic/tables/ztab</OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>
</TREE_CONTENT></DATA></asx:values></asx:abap>`, 'ZPKG');
  assert.deepEqual(ns.packages, [{ name: 'ZPKG_SUB', desc: 'Sub' }]);
  assert.deepEqual(ns.objects.map(o => o.type), ['SRVB', 'TABL']);
  assert.deepEqual(parseNamedItems('<nameditem:namedItemList xmlns:nameditem="x"><nameditem:namedItem><nameditem:name>HOME</nameditem:name><nameditem:description>Customer</nameditem:description></nameditem:namedItem></nameditem:namedItemList>'), [{ name: 'HOME', desc: 'Customer' }]);
  const b = parseBinding(`<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" xmlns:adtcore="http://www.sap.com/adt/core" srvb:published="true" adtcore:name="ZUI_X_O4" adtcore:description="X">
<srvb:services srvb:name="ZUI_X_O4"><srvb:content srvb:version="0001"><srvb:serviceDefinition adtcore:name="ZUI_X"/></srvb:content></srvb:services>
<srvb:binding srvb:type="ODATA" srvb:version="V4" srvb:category="0"/></srvb:serviceBinding>`);
  assert.deepEqual([b.name, b.odataVersion, b.category, b.published, b.services[0].serviceDefinition], ['ZUI_X_O4', 'V4', 'UI', true, 'ZUI_X']);
  const d = parseDataPreview(`<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><dataPreview:totalRows>2</dataPreview:totalRows>
<dataPreview:columns><dataPreview:metadata dataPreview:name="CARRID" dataPreview:type="C" dataPreview:description="Airline" dataPreview:keyAttribute="true"/><dataPreview:dataSet><dataPreview:data>GA</dataPreview:data><dataPreview:data>QZ</dataPreview:data></dataPreview:dataSet></dataPreview:columns>
<dataPreview:columns><dataPreview:metadata dataPreview:name="NAME" dataPreview:type="C" dataPreview:description="Name"/><dataPreview:dataSet><dataPreview:data>Garuda</dataPreview:data><dataPreview:data>AirAsia</dataPreview:data></dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>`);
  assert.deepEqual(d.rows, [['GA', 'Garuda'], ['QZ', 'AirAsia']]);
  assert.equal(d.columns[0].key, true);
  assert.deepEqual(parseGitRepos('<abapgitrepo:repositories xmlns:abapgitrepo="x"><abapgitrepo:repository><abapgitrepo:key>01</abapgitrepo:key><abapgitrepo:package>ZPKG</abapgitrepo:package><abapgitrepo:url>https://github.com/a/b.git</abapgitrepo:url><abapgitrepo:branchName>refs/heads/main</abapgitrepo:branchName></abapgitrepo:repository></abapgitrepo:repositories>')[0].pkg, 'ZPKG');
});

test('DEMO backend: packages, new types, publish, data preview, abapGit, delete', async () => {
  const b = new MockBackend();
  const top = await b.packageContents('s4d', 'ZNUSA_FLIGHT');
  assert.deepEqual(top.packages.map(p => p.name), ['ZNUSA_FLIGHT_SRV', 'ZNUSA_FLIGHT_IAM']);
  assert.ok(top.objects.some(o => o.type === 'TABL'));
  const srv = await b.packageContents('s4d', 'ZNUSA_FLIGHT_SRV');
  const srvb = srv.objects.find(o => o.type === 'SRVB')!;
  assert.equal((await b.bindingInfo('s4d', srvb)).published, false);
  await b.publishBinding('s4d', srvb, true);
  const info = await b.bindingInfo('s4d', srvb);
  assert.equal(info.published, true);
  assert.match(info.serviceUrl || '', /odata4/);
  await assert.rejects(b.deleteObject('s4d', srvb), /Unpublish/);
  const pk = await b.createPackage('s4d', { name: 'znusa_new', desc: 'New', superPackage: 'ZNUSA_FLIGHT', softwareComponent: 'HOME', transportLayer: 'ZS4D', packageType: 'development' }, 'S4DK900123');
  assert.equal(pk.name, 'ZNUSA_NEW');
  assert.ok((await b.packageContents('s4d', 'ZNUSA_FLIGHT')).packages.some(p => p.name === 'ZNUSA_NEW'));
  const t = await b.createObject('s4d', 'TABL', 'ZNUSA_T2', 'T2', 'ZNUSA_NEW', 'S4DK900123');
  assert.match(await b.read('s4d', t, 'main', 'inactive'), /define table znusa_t2/);
  const p1 = await b.dataPreview('s4d', { entity: '/dmo/flight', rows: 100 });
  assert.equal(p1.rows.length, 5);
  const p2 = await b.dataPreview('s4d', { sql: "SELECT carrier_id, seats_max FROM /DMO/FLIGHT WHERE carrier_id = 'GA' ORDER BY seats_max DESC UP TO 2 ROWS", rows: 100 });
  assert.deepEqual(p2.rows, [['GA', '393'], ['GA', '162']]);
  assert.equal(p2.totalRows, 3);
  await assert.rejects(b.dataPreview('s4d', { sql: 'SELECT * FROM NOPE', rows: 10 }), /not a database table/);
  const repos = await b.gitRepos('s4d');
  assert.equal(repos.length, 1);
  await b.gitLink('s4d', { pkg: 'ZNUSA_NEW', url: 'https://github.com/x/y.git', branch: 'refs/heads/main' });
  assert.match(await b.gitPull('s4d', (await b.gitRepos('s4d'))[1].key), /Pulled/);
  await b.deleteObject('s4d', t, 'S4DK900123');
  assert.ok(!(await b.packageContents('s4d', 'ZNUSA_NEW')).objects.length);
});

import { rfcTarget, splitGuiRoute, systemHosts, systemUrl } from '../src/core/sysurl';
test('SAP GUI routes split into SAProuter, server and instance', () => {
  assert.deepEqual(splitGuiRoute(' /H/36.92.53.190/S/3299/W/PC/H/10.27.1.2/S/3220 '), { saprouter: '/H/36.92.53.190/S/3299/W/PC', ashost: '10.27.1.2', sysnr: '20' });
  assert.deepEqual(splitGuiRoute('/H/36.92.53.190/S/3299/W/PC'), { saprouter: '/H/36.92.53.190/S/3299/W/PC' });
  assert.deepEqual(splitGuiRoute('/H/r1/S/3299/H/r2/S/3299'), { saprouter: '/H/r1/S/3299/H/r2/S/3299' }, 'a router chain stays a router chain');
  assert.deepEqual(splitGuiRoute('/H/r1/S/3299/H/s4d/S/sapdp00'.replace('sapdp00', '3200')), { saprouter: '/H/r1/S/3299', ashost: 's4d', sysnr: '00' });
  assert.deepEqual(splitGuiRoute(''), { saprouter: '' });
  assert.equal(rfcTarget({ ashost: '10.27.1.2', sysnr: '20', saprouter: '/H/36.92.53.190/S/3299/W/PC' }), '10.27.1.2 · instance 20 via /H/36.92.53.190/S/3299/W/***');
});
test('system URLs: launchpad links and API hosts map to the ADT host', () => {
  const want = { api: 'https://my408355-api.s4hana.cloud.sap', ui: 'https://my408355.s4hana.cloud.sap' };
  assert.deepEqual(systemHosts('https://my408355.s4hana.cloud.sap/ui#Shell-home'), want);
  assert.deepEqual(systemHosts('https://my408355-api.s4hana.cloud.sap/'), want);
  assert.deepEqual(systemHosts('https://1a2b.abap-web.eu10.hana.ondemand.com/ui'), { api: 'https://1a2b.abap.eu10.hana.ondemand.com', ui: 'https://1a2b.abap-web.eu10.hana.ondemand.com' });
  assert.equal(systemUrl('s4', 'https://s4d.example.com:44300/sap/bc/gui/'), 'https://s4d.example.com:44300');
  assert.equal(systemUrl('runner', 'http://localhost:7777/'), 'http://localhost:7777');
});

import { addSnapshot, diffLines, diffStats, hunks } from '../src/core/diff';
import { diagReport, logDiag, redact } from '../src/core/diag';
test('diff: minimal line changes, hunks with context', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const b = ['a', 'b', 'X', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  assert.equal(ops.filter(o => o.t !== 'add').map(o => o.text).join(''), a.join(''));
  assert.equal(ops.filter(o => o.t !== 'del').map(o => o.text).join(''), b.join(''));
  const h = hunks(ops, 1);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0].ops.map(o => o.t), ['same', 'del', 'add', 'same']);
});
test('local history keeps newest first without duplicates', () => {
  let l = addSnapshot([], { at: 1, text: 'v1', note: 'Saved' });
  l = addSnapshot(l, { at: 2, text: 'v1', note: 'Saved' });
  l = addSnapshot(l, { at: 3, text: 'v2', note: 'Saved' });
  assert.deepEqual(l.map(s => s.text), ['v2', 'v1']);
  for (let i = 0; i < 40; i++) l = addSnapshot(l, { at: i, text: 'x' + i, note: '' });
  assert.equal(l.length, 25);
});
test('diagnostics never contain secrets', () => {
  assert.equal(redact('GET /x?reentrance-ticket=AbC123&b=1'), 'GET /x?reentrance-ticket=***&b=1');
  assert.equal(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x'), 'Authorization: Bearer ***');
  assert.equal(redact('SAProuter: /H/36.92.53.190/S/3299/W/PC'), 'SAProuter: /H/36.92.53.190/S/3299/W/***');
  assert.equal(redact('SAProuter: /H/a/S/3299/W/x1/H/b/S/3299/W/y2'), 'SAProuter: /H/a/S/3299/W/***/H/b/S/3299/W/***');
  logDiag('s4h', 'POST /sap/bc/adt/discovery → 401 12 ms ICFLOGONREQUIRED');
  const r = diagReport({ System: 'S4H', Empty: '' }, 's4h');
  assert.match(r, /System: S4H/);
  assert.doesNotMatch(r, /Empty/);
  assert.match(r, /401 12 ms ICFLOGONREQUIRED/);
});

import { formatAbap, formatCds } from '../src/core/format';
import { readFileSync, readdirSync } from 'node:fs';
const UNFORMATTED = `class zcl_x definition public final create public.
public section.
methods run importing iv_a type i
iv_b type i optional
returning value(rv) type string.
private section.
data: mv type i,
mv2 type string.
endclass.
class zcl_x implementation.
method run.
data(lt) = value string_table( ( |a{ iv_a }| )
( |b| ) ).
if iv_a > 1. " trailing
loop at lt into data(ls).
case ls.
when 'a'.
rv = ls.
when others.
clear rv.
endcase.
endloop.
else.
select carrid from /dmo/flight
where carrid = 'AA'
into table @data(flights).
endif.
" before end
endmethod.
endclass.`;
const codeOnly = (s: string) => s.replace(/\s+/g, '').toLowerCase();
test('ABAP formatter: indents blocks, aligns declarations, never changes code', () => {
  const out = formatAbap(UNFORMATTED);
  assert.equal(codeOnly(out), codeOnly(UNFORMATTED));
  assert.equal(formatAbap(out), out, 'idempotent');
  const l = out.split('\n');
  assert.equal(l[3], '                          iv_b TYPE i OPTIONAL');
  assert.equal(l[4], '                RETURNING VALUE(rv) TYPE string.');
  assert.equal(l[7], '          mv2 TYPE string.');
  assert.equal(l[12], '                                   ( |b| ) ).');
  assert.match(out, /\n {8}CASE ls\.\n {10}WHEN 'a'\.\n {12}rv = ls\./);
  assert.match(out, /\n {4}" before end\n {2}ENDMETHOD\./);
  assert.match(out, /\|a\{ iv_a \}\|/, 'string templates untouched');
  assert.equal(formatAbap('if a = 1.\nwrite a.\nendif.', { keywordCase: 'lower' }), 'if a = 1.\n  write a.\nendif.');
});
test('formatters keep every token of the sample sources', () => {
  const dir = 'src/backends';
  const src = readFileSync(`${dir}/mock.ts`, 'utf8');
  const blocks = [...src.matchAll(/`((?:CLASS|REPORT|INTERFACE)[\s\S]*?)`/g)].map(m => m[1]).filter(b => !b.includes('${'));
  assert.ok(blocks.length > 0);
  for (const b of blocks) {
    const f = formatAbap(b);
    assert.equal(codeOnly(f), codeOnly(b));
    assert.equal(formatAbap(f), f);
  }
  void readdirSync;
});
test('CDS formatter: braces, brackets and the select header', () => {
  const out = formatCds("define view entity ZI_X as select from t\nassociation [0..1] to ZI_Y as _Y on _Y.id = id\n{\nkey id as Id,\n@UI.lineItem: [ { position: 10,\nlabel: 'a { b' } ]\nname as Name\n}");
  assert.equal(out, "define view entity ZI_X as select from t\n  association [0..1] to ZI_Y as _Y on _Y.id = id\n{\n  key id as Id,\n  @UI.lineItem: [ { position: 10,\n      label: 'a { b' } ]\n  name as Name\n}");
  assert.equal(formatCds(out), out);
});

import { adtTypeOf } from '../src/core/types';
import { newObjectXml, parseNodeStructure } from '../src/adt/client';
test('object types: Eclipse families, unknown types kept with the system label', () => {
  assert.equal(adtTypeOf('CLAS/OC'), 'CLAS');
  assert.equal(adtTypeOf('SIA6/XYZ'), 'SIA6');
  assert.equal(adtTypeOf('SCO1'), 'SCO1');
  assert.equal(adtTypeOf('FUGR/F'), 'FUGR');
  const body = `<asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA><TREE_CONTENT>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>SIA6/ABC</OBJECT_TYPE><OBJECT_NAME>ZAPP</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/x/sia6/zapp</OBJECT_URI><DESCRIPTION>App</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>FUGR/F</OBJECT_TYPE><OBJECT_NAME>ZFG</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/functions/groups/zfg</OBJECT_URI><DESCRIPTION>FG</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>
</TREE_CONTENT><OBJECT_TYPES><SEU_ADT_OBJECT_TYPE_INFO><OBJECT_TYPE>FUGR/F</OBJECT_TYPE><OBJECT_TYPE_LABEL>Function Groups</OBJECT_TYPE_LABEL></SEU_ADT_OBJECT_TYPE_INFO></OBJECT_TYPES></DATA></asx:values></asx:abap>`;
  const r = parseNodeStructure(body, 'ZP');
  assert.deepEqual(r.objects.map(o => [o.name, o.type, o.typeLabel]), [['ZAPP', 'SIA6', undefined], ['ZFG', 'FUGR', undefined]]);
});
test('new form-based objects copy the format of an existing one', () => {
  const ex = `<?xml version="1.0" encoding="utf-8"?><iam:app xmlns:iam="http://www.sap.com/iam/app" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="SAP_APP" adtcore:type="SIA6/EXT" adtcore:masterLanguage="DE" adtcore:description="x"><adtcore:packageRef adtcore:name="SAPPKG"/><iam:services/></iam:app>`;
  const x = newObjectXml(ex, { name: 'zmy_app', desc: 'Mine & yours', pkg: 'zpkg', user: 'dev' });
  assert.equal(x, '<?xml version="1.0" encoding="UTF-8"?><iam:app xmlns:iam="http://www.sap.com/iam/app" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZMY_APP" adtcore:description="Mine &amp; yours" adtcore:type="SIA6/EXT" adtcore:masterLanguage="DE" adtcore:responsible="DEV"><adtcore:packageRef adtcore:name="ZPKG"/></iam:app>');
});
test('DEMO form objects: read, change, save, activate', async () => {
  const b = new MockBackend();
  const iam = await b.packageContents('s4d', 'ZNUSA_FLIGHT_IAM');
  assert.deepEqual(iam.objects.map(o => o.type).sort(), ['AUTH', 'SCO1', 'SIA6', 'SMBC', 'SUSO']);
  const app = iam.objects.find(o => o.type === 'SIA6')!;
  const xml = await b.read('s4d', app, 'main', 'inactive');
  assert.match(xml, /ZUI_NUSA_FLIGHT_O4/);
  const lock = await b.lock('s4d', app);
  await b.write('s4d', app, 'main', xml.replace('02, 03', '03'), lock, 'S4DK900123');
  assert.equal((await b.syntaxCheck('s4d', app, 'main', '<a><b></a>')).length, 1);
  const act = await b.activate('s4d', [app]);
  assert.ok(act.ok);
  const created = await b.createObject('s4d', 'SCO2', 'ZNUSA_IN', 'Inbound', 'ZNUSA_FLIGHT_IAM', 'S4DK900123');
  assert.match(await b.read('s4d', created, 'main', 'inactive'), /adtcore:name="ZNUSA_IN"/);
});
