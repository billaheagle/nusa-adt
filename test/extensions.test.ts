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
  assert.deepEqual(top.packages.map(p => p.name), ['ZNUSA_FLIGHT_SRV']);
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
