// Parsers checked against payloads shaped like real ADT responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AdtClient, parseActivation, parseAtc, parseCheckRun, parseNodeStructure, parseObjectReferences, parseTransportCheck,
  parseTransportTree, parseUnit, splitSourceUrl,
} from '../src/adt/client';
import { parseXml, parseStart, textOf, base64Utf8 } from '../src/adt/xml';

test('xml parser: entities, CDATA, namespaces, self-closing', () => {
  const x = parseXml(`<?xml version="1.0"?><!-- c --><a:root xmlns:a="u" a:k="x &amp; y"><b>1 &lt; 2</b><c/><d><![CDATA[<raw>]]></d></a:root>`);
  const root = x.children[0];
  assert.equal(root.local, 'root');
  assert.equal(root.attrs['a:k'], 'x & y');
  assert.equal(textOf(root, 'b'), '1 < 2');
  assert.equal(textOf(root, 'd'), '<raw>');
  assert.equal(root.children.length, 3);
});

test('source URLs round-trip', () => {
  assert.deepEqual(splitSourceUrl('/sap/bc/adt/oo/classes/zcl_x/includes/testclasses#start=4,2'), { uri: '/sap/bc/adt/oo/classes/zcl_x', include: 'testclasses' });
  assert.deepEqual(splitSourceUrl('/sap/bc/adt/programs/programs/zr_x/source/main'), { uri: '/sap/bc/adt/programs/programs/zr_x', include: 'main' });
  assert.deepEqual(parseStart('/x#start=12,4'), { path: '/x', line: 11, col: 4 });
  assert.equal(base64Utf8('Ä'), 'w4Q=');
});

test('node structure keeps supported object types', () => {
  const body = `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><TREE_CONTENT>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>CLAS/OC</OBJECT_TYPE><OBJECT_NAME>ZCL_NUSA_FLIGHT_SERVICE</OBJECT_NAME><TECH_NAME>ZCL_NUSA_FLIGHT_SERVICE</TECH_NAME><OBJECT_URI>/sap/bc/adt/oo/classes/zcl_nusa_flight_service</OBJECT_URI><DESCRIPTION>Flight service</DESCRIPTION><EXPANDABLE>X</EXPANDABLE></SEU_ADT_REPOSITORY_OBJ_NODE>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>DEVC/K</OBJECT_TYPE><OBJECT_NAME>ZNUSA_SUB</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/packages/znusa_sub</OBJECT_URI></SEU_ADT_REPOSITORY_OBJ_NODE>
<SEU_ADT_REPOSITORY_OBJ_NODE><OBJECT_TYPE>DDLS/DF</OBJECT_TYPE><OBJECT_NAME>ZI_NUSA_FLIGHT</OBJECT_NAME><OBJECT_URI>/sap/bc/adt/ddic/ddl/sources/zi_nusa_flight</OBJECT_URI><DESCRIPTION>CDS</DESCRIPTION></SEU_ADT_REPOSITORY_OBJ_NODE>
</TREE_CONTENT></DATA></asx:values></asx:abap>`;
  const r = parseNodeStructure(body, 'ZNUSA_FLIGHT');
  assert.deepEqual(r.objects.map(o => o.type), ['CLAS', 'DDLS']);
  assert.equal(r.objects[0].desc, 'Flight service');
  assert.deepEqual(r.packages, [{ name: 'ZNUSA_SUB', desc: '' }]);
});

test('quick search object references', () => {
  const body = `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/interfaces/zif_nusa_logger" adtcore:type="INTF/OI" adtcore:name="ZIF_NUSA_LOGGER" adtcore:packageName="ZNUSA_FLIGHT" adtcore:description="Logger"/></adtcore:objectReferences>`;
  assert.deepEqual(parseObjectReferences(body)[0], { uri: '/sap/bc/adt/oo/interfaces/zif_nusa_logger', name: 'ZIF_NUSA_LOGGER', type: 'INTF', pkg: 'ZNUSA_FLIGHT', desc: 'Logger' });
});

test('transport check: recording with open requests', () => {
  const body = `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><PGMID/><OBJECT/><OBJECTNAME/><OPERATION>I</OPERATION><DEVCLASS>ZNUSA_FLIGHT</DEVCLASS><RECORDING>X</RECORDING><EXISTING_REQ_ONLY/><LOCKS/>
<REQUESTS><CTS_REQUEST><REQ_HEADER><TRKORR>S4DK900123</TRKORR><TRFUNCTION>K</TRFUNCTION><TRSTATUS>D</TRSTATUS><AS4USER>DEVELOPER</AS4USER><AS4TEXT>Nusa: flight load factor</AS4TEXT></REQ_HEADER></CTS_REQUEST></REQUESTS></DATA></asx:values></asx:abap>`;
  const r = parseTransportCheck(body);
  assert.equal(r.recording, true);
  assert.equal(r.lockedIn, undefined);
  assert.deepEqual(r.requests, [{ id: 'S4DK900123', desc: 'Nusa: flight load factor', owner: 'DEVELOPER' }]);
});

test('transport tree splits modifiable and released', () => {
  const body = `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:workbench tm:category="Workbench"><tm:target tm:name="/QAS/">
<tm:modifiable tm:status="Modifiable"><tm:request tm:number="S4DK900123" tm:owner="DEVELOPER" tm:desc="Nusa: flight load factor" tm:status="D">
<tm:task tm:number="S4DK900124" tm:owner="DEVELOPER" tm:desc="Task"><tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="ZCL_NUSA_FLIGHT_SERVICE"/></tm:task></tm:request></tm:modifiable>
<tm:released tm:status="Released"><tm:request tm:number="S4DK900098" tm:owner="DEVELOPER" tm:desc="Logger" tm:status="R"><tm:abap_object tm:pgmid="R3TR" tm:type="INTF" tm:name="ZIF_NUSA_LOGGER"/></tm:request></tm:released>
</tm:target></tm:workbench></tm:root>`;
  const r = parseTransportTree(body);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { id: 'S4DK900123', desc: 'Nusa: flight load factor', owner: 'DEVELOPER', status: 'modifiable', task: 'S4DK900124', objects: ['R3TR CLAS ZCL_NUSA_FLIGHT_SERVICE'] });
  assert.equal(r[1].status, 'released');
});

test('activation messages and check runs', () => {
  const act = `<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><msg objDescr="Class ZCL_X" type="E" line="1" href="/sap/bc/adt/oo/classes/zcl_x/source/main#start=30,4" forceSupported="true"><shortText><txt>"ENDMETHOD" expected, not "ENDCLASS"</txt></shortText></msg></chkl:messages>`;
  const a = parseActivation(act);
  assert.equal(a.ok, false);
  assert.deepEqual(a.messages[0], { type: 'E', text: '"ENDMETHOD" expected, not "ENDCLASS"', uri: '/sap/bc/adt/oo/classes/zcl_x/source/main', line: 29, col: 4 });
  assert.equal(parseActivation('').ok, true);
  const chk = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"><chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:status="processed"><chkrun:checkMessageList><chkrun:checkMessage chkrun:uri="/sap/bc/adt/oo/classes/zcl_x/includes/testclasses#start=5,0" chkrun:type="W" chkrun:shortText="Unused variable"/></chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`;
  assert.deepEqual(parseCheckRun(chk), [{ type: 'W', text: 'Unused variable', uri: '/sap/bc/adt/oo/classes/zcl_x/includes/testclasses', line: 4, col: 0 }]);
});

test('ABAP Unit run result', () => {
  const body = `<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core"><program adtcore:uri="/sap/bc/adt/oo/classes/zcl_x" adtcore:name="ZCL_X"><testClasses>
<testClass adtcore:name="LTC_LOAD_FACTOR"><testMethods>
<testMethod adtcore:name="FULL_FLIGHT" executionTime="0.002" navigationUri="/sap/bc/adt/oo/classes/zcl_x/includes/testclasses#start=19,2"/>
<testMethod adtcore:name="ZERO_SEATS_RETURNS_ZERO" executionTime="0.004"><alerts><alert kind="exception" severity="critical"><title>Exception Error &lt;CX_SY_ZERODIVIDE&gt;</title><stack><stackEntry adtcore:uri="/sap/bc/adt/oo/classes/zcl_x/source/main#start=28,4"/></stack></alert></alerts></testMethod>
</testMethods></testClass></testClasses></program></aunit:runResult>`;
  const r = parseUnit(body);
  assert.equal(r.length, 2);
  assert.equal(r[1].alerts[0].title, 'Exception Error <CX_SY_ZERODIVIDE>');
  assert.equal(r[1].alerts[0].uri, '/sap/bc/adt/oo/classes/zcl_x/source/main#start=28,4');
});

test('ATC worklist findings', () => {
  const body = `<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist"><atcworklist:objects><atcobject:object xmlns:atcobject="http://www.sap.com/adt/atc/object"><atcobject:findings><atcfinding:finding xmlns:atcfinding="http://www.sap.com/adt/atc/finding" atcfinding:location="/sap/bc/adt/oo/classes/zcl_x/source/main#start=21,4" atcfinding:priority="2" atcfinding:checkTitle="Performance Checks" atcfinding:messageTitle="SELECT * used"/></atcobject:findings></atcobject:object></atcworklist:objects></atcworklist:worklist>`;
  assert.deepEqual(parseAtc(body), [{ prio: 2, check: 'Performance Checks', msg: 'SELECT * used', location: '/sap/bc/adt/oo/classes/zcl_x/source/main#start=21,4' }]);
});

test('ADT exceptions become readable errors', () => {
  const e = AdtClient.error({ status: 403, headers: {}, body: `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><namespace id="com.sap.adt"/><type id="ExceptionResourceLocked"/><message lang="EN">User DEV2 is currently editing ZCL_X</message><localizedMessage lang="EN">User DEV2 is currently editing ZCL_X</localizedMessage></exc:exception>` });
  assert.equal(e.message, 'User DEV2 is currently editing ZCL_X');
  assert.equal(e.type, 'ExceptionResourceLocked');
});

import { parseConfigLinks } from '../src/adt/client';
test('transport tree: requests without a status folder, search configurations', () => {
  const tree = `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:workbench><tm:target tm:name="/ZS3/"><tm:request tm:number="ZS3K900007" tm:owner="CB9980000000" tm:desc="Customer mapping" tm:status="D"><tm:task tm:number="ZS3K900008"><tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="ZBP_I_MAPPINGCUSTOMERZPR1_S"/></tm:task></tm:request><tm:request tm:number="ZS3K900001" tm:owner="CB9980000000" tm:desc="Old" tm:status="R"/></tm:target></tm:workbench></tm:root>`;
  const list = parseTransportTree(tree);
  assert.deepEqual(list.map(t => [t.id, t.status, t.objects.length]), [['ZS3K900007', 'modifiable', 1], ['ZS3K900001', 'released', 0]]);
  const cfg = `<configs:configurations xmlns:configs="http://www.sap.com/adt/configurations" xmlns:atom="http://www.w3.org/2005/Atom"><configs:configuration configs:createdBy="CB9980000000"><atom:link href="/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/0A1B2C" rel="self"/></configs:configuration></configs:configurations>`;
  assert.deepEqual(parseConfigLinks(cfg), ['/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/0A1B2C']);
});

import { AdtClient } from '../src/adt/client';
test('transports: falls back to the search configuration when the user query is empty', async () => {
  const seen: string[] = [];
  const http = {
    async request(_c: string, r: { path: string; query?: Record<string, string | undefined> }) {
      seen.push(r.path + (r.query?.configUri ? '?configUri' : r.query?.user ? '?user' : ''));
      if (r.path.endsWith('/configurations')) return { status: 200, headers: {}, body: '<c:configurations xmlns:c="x" xmlns:atom="http://www.w3.org/2005/Atom"><c:configuration><atom:link href="/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/42"/></c:configuration></c:configurations>' };
      if (r.query?.configUri) return { status: 200, headers: {}, body: '<tm:root xmlns:tm="t"><tm:workbench><tm:target><tm:modifiable><tm:request tm:number="ZS3K900007" tm:owner="CB9980000000" tm:desc="Mapping"/></tm:modifiable></tm:target></tm:workbench></tm:root>' };
      return { status: 200, headers: {}, body: '<tm:root xmlns:tm="t"/>' };
    },
  };
  const list = await new AdtClient(http as never, 'c').userTransports('CB9980000000');
  assert.deepEqual(list.map(t => t.id), ['ZS3K900007']);
  assert.deepEqual(seen, ['/sap/bc/adt/cts/transportrequests?user', '/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations', '/sap/bc/adt/cts/transportrequests?configUri']);
});
