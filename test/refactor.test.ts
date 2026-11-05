import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, editLines, wordRange } from '../src/core/edits';
import { extractMethodEdits, occurrences, quickFixesAt, renameEdits } from '../src/core/localrefactor';
import { elementDocument, extractRequest, parseFragment, parseGeneric, renameRequest, setElementText } from '../src/adt/refactor';
import { debugError, parseChildren, parseStack } from '../src/adt/debugger';
import { addTransportEntries, hasTransportEntry, removeTransportEntries, setTransportDesc } from '../src/adt/client';
import { parseXml, textOf } from '../src/adt/xml';

const CLS = `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.

CLASS zcl_x IMPLEMENTATION.
  METHOD run.
    lv_total = 1.
    DATA(lv_text) = 'Total'.
    WRITE: / lv_text, lv_total. " lv_total in a comment
  ENDMETHOD.
  METHOD helper.
  ENDMETHOD.
ENDCLASS.
`;

test('edits apply from the end, positions are 0-based', () => {
  const t = 'abc\ndef\nghi';
  assert.equal(applyEdits(t, [{ from: { line: 0, ch: 1 }, to: { line: 0, ch: 2 }, newText: 'X' }, { from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 }, newText: '> ' }]), 'aXc\ndef\n> ghi');
  assert.equal(applyEdits(t, [{ from: { line: 0, ch: 3 }, to: { line: 1, ch: 3 }, newText: '' }]), 'abc\nghi');
  assert.deepEqual(editLines(t, { from: { line: 1, ch: 0 }, to: { line: 1, ch: 3 }, newText: 'DEF' }), { line: 1, before: ['def'], after: ['DEF'] });
  assert.deepEqual(wordRange('  lo_x->run( ).', 4), [2, 6]);
  assert.deepEqual(wordRange('  /dmo/flight-x', 5), [2, 13]);
});

test('local quick fixes: undeclared variable, missing method declaration and implementation, string template', () => {
  const at = (needle: string, inLine?: number) => { const ls = CLS.split('\n'); const l = inLine ?? ls.findIndex(x => x.includes(needle)); return [l, ls[l].indexOf(needle) + 1] as const; };
  const [vl, vc] = at('lv_total = 1');
  const v = quickFixesAt(CLS, 'ZCL_X', vl, vc);
  assert.deepEqual(v.map(f => f.id), ['inline', 'local']);
  assert.match(applyEdits(CLS, v[0].edits), /DATA\(lv_total\) = 1\./);
  assert.match(applyEdits(CLS, v[1].edits), /    DATA lv_total TYPE string\.\n    lv_total = 1\./);

  const [hl, hc] = at('METHOD helper');
  const h = quickFixesAt(CLS, 'ZCL_X', hl, hc);
  assert.deepEqual(h.map(f => f.id), ['decl-private', 'decl-protected', 'decl-public']);
  assert.match(applyEdits(CLS, h[0].edits), /METHODS run\.\n  PRIVATE SECTION\.\n    METHODS helper\.\nENDCLASS\./);
  assert.match(applyEdits(CLS, h[2].edits), /PUBLIC SECTION\.\n    METHODS helper\.\n    METHODS run\./);
  // the fixed source has no "not declared" anymore → the fix is gone
  assert.equal(quickFixesAt(applyEdits(CLS, h[0].edits), 'ZCL_X', hl + 2, hc).filter(f => f.id.startsWith('decl')).length, 0);

  const noImpl = CLS.replace('    METHODS run.', '    METHODS run.\n    METHODS other.');
  const [ol, oc] = [2 + 1, 13];
  const o = quickFixesAt(noImpl, 'ZCL_X', ol, oc);
  assert.equal(o[0].id, 'impl');
  assert.match(applyEdits(noImpl, o[0].edits), /  METHOD other\.\n  ENDMETHOD\.\n\nENDCLASS\.\n$/);

  const [sl] = at("'Total'");
  const s = quickFixesAt(CLS, 'ZCL_X', sl, CLS.split('\n')[sl].indexOf("'Total'") + 2);
  assert.equal(s.find(f => f.id === 'template')?.edits[0].newText, '|Total|');
});

test('local rename skips comments and literals; extract method moves whole statements', () => {
  assert.equal(occurrences(CLS, 'LV_TOTAL').length, 2, 'not in the comment');
  const renamed = applyEdits(CLS, renameEdits(CLS, 'lv_total', 'lv_sum'));
  assert.match(renamed, /lv_sum = 1\./);
  assert.match(renamed, /" lv_total in a comment/);

  const ls = CLS.split('\n');
  const from = ls.findIndex(l => l.includes("DATA(lv_text)")), to = ls.findIndex(l => l.includes('WRITE:'));
  const out = applyEdits(CLS, extractMethodEdits(CLS, 'ZCL_X', from, to, 'print'));
  assert.match(out, /PRIVATE SECTION\.\n    METHODS print\./);
  assert.match(out, /lv_total = 1\.\n    print\( \)\.\n  ENDMETHOD\./);
  assert.match(out, /  METHOD print\.\n    DATA\(lv_text\) = 'Total'\.\n    WRITE:/);
  assert.throws(() => extractMethodEdits(CLS, 'ZCL_X', 0, 1, 'x'), /inside one method/);
});

const RENAME_EVAL = `<?xml version="1.0" encoding="utf-8"?><rename:renameRefactoring xmlns:adtcore="http://www.sap.com/adt/core" xmlns:generic="http://www.sap.com/adt/refactoring/genericrefactoring" xmlns:rename="http://www.sap.com/adt/refactoring/renamerefactoring"><rename:oldName>LV_TOTAL</rename:oldName><rename:newName/><generic:genericRefactoring><generic:title>Rename Field</generic:title><generic:adtObjectUri>/sap/bc/adt/oo/classes/zcl_x/source/main#start=8,4;end=8,12</generic:adtObjectUri><generic:affectedObjects><generic:affectedObject adtcore:name="ZCL_X" adtcore:type="CLAS/OC" adtcore:uri="/sap/bc/adt/oo/classes/zcl_x/source/main" adtcore:parentUri="/sap/bc/adt/oo/classes/zcl_x"><generic:textReplaceDeltas><generic:textReplaceDelta><generic:rangeFragment>#start=8,4;end=8,12</generic:rangeFragment><generic:contentOld>lv_total</generic:contentOld><generic:contentNew>lv_sum</generic:contentNew></generic:textReplaceDelta></generic:textReplaceDeltas><generic:userContent>&lt;x a="1"/&gt;</generic:userContent></generic:affectedObject></generic:affectedObjects><generic:transport/><generic:ignoreSyntaxErrorsAllowed>false</generic:ignoreSyntaxErrorsAllowed><generic:ignoreSyntaxErrors>false</generic:ignoreSyntaxErrors><generic:userContent>keep</generic:userContent></generic:genericRefactoring><rename:userContent/></rename:renameRefactoring>`;

test('ADT refactoring XML: answers go back with only the changed fields', () => {
  assert.deepEqual(parseFragment('#start=8,4;end=8,12'), { start: { line: 7, ch: 4 }, end: { line: 7, ch: 12 } });
  assert.equal(setElementText('<a><p:newName/></a>', 'newName', 'X&Y'), '<a><p:newName>X&amp;Y</p:newName></a>');
  assert.equal(setElementText('<a><p:oldName>A</p:oldName><p:name>B</p:name></a>', 'name', 'C'), '<a><p:oldName>A</p:oldName><p:name>C</p:name></a>');

  const req = renameRequest(RENAME_EVAL, 'lv_sum', 'NPLK900001');
  assert.match(req, /<rename:newName>lv_sum<\/rename:newName>/);
  assert.match(req, /<generic:transport>NPLK900001<\/generic:transport>/);
  assert.match(req, /&lt;x a="1"\/&gt;/, 'userContent passes through untouched');
  assert.equal((req.match(/<\?xml/g) || []).length, 1);

  const g = parseGeneric(RENAME_EVAL);
  assert.equal(g.title, 'Rename Field');
  assert.deepEqual(g.edits.map(e => [e.uri, e.include, e.from.line, e.oldText, e.newText]), [['/sap/bc/adt/oo/classes/zcl_x', 'main', 7, 'lv_total', 'lv_sum']]);
  assert.deepEqual(g.objects.map(o => [o.name, o.type]), [['ZCL_X', 'CLAS']]);

  const gen = elementDocument(RENAME_EVAL, 'genericRefactoring') as string;
  assert.match(gen, /^<\?xml[^>]*\?><generic:genericRefactoring xmlns:generic="http:\/\/www\.sap\.com\/adt\/refactoring\/genericrefactoring" xmlns:adtcore="http:\/\/www\.sap\.com\/adt\/core">/);
  assert.match(gen, /<\/generic:genericRefactoring>$/);
  assert.equal(textOf(parseXml(gen), 'contentNew'), 'lv_sum');

  const bare = renameRequest(gen, 'lv_sum');
  assert.match(bare, /<rename:renameRefactoring[^>]*><rename:oldName><\/rename:oldName><rename:newName>lv_sum<\/rename:newName><generic:genericRefactoring/);
});

test('extract method request keeps the system answer and renames parameters by id', () => {
  const ev = `<extractmethod:extractMethodRefactoring xmlns:extractmethod="http://www.sap.com/adt/refactoring/extractmethodrefactoring" xmlns:generic="g"><extractmethod:name>new_method</extractmethod:name><extractmethod:isStatic>false</extractmethod:isStatic><extractmethod:visibility>PRIVATE</extractmethod:visibility><extractmethod:parameters><extractmethod:parameter><extractmethod:id>LV_TEXT&lt;1&gt;</extractmethod:id><extractmethod:name>LV_TEXT</extractmethod:name><extractmethod:direction>IMPORTING</extractmethod:direction><extractmethod:type>STRING</extractmethod:type></extractmethod:parameter></extractmethod:parameters><generic:genericRefactoring><generic:title>Extract Method</generic:title><generic:transport/></generic:genericRefactoring></extractmethod:extractMethodRefactoring>`;
  const out = extractRequest({ name: 'print', visibility: 'PROTECTED', isStatic: true, className: 'ZCL_X', params: [{ id: 'LV_TEXT<1>', name: 'IV_TEXT', direction: 'IMPORTING', type: 'STRING' }], token: ev }, 'NPLK9');
  assert.match(out, /<extractmethod:name>print<\/extractmethod:name><extractmethod:isStatic>true<\/extractmethod:isStatic><extractmethod:visibility>PROTECTED</);
  assert.match(out, /<extractmethod:id>LV_TEXT&lt;1&gt;<\/extractmethod:id><extractmethod:name>IV_TEXT<\/extractmethod:name>/);
  assert.match(out, /<generic:transport>NPLK9<\/generic:transport>/);
});

test('debugger answers: exceptions, variables, stack', () => {
  assert.equal(debugError('<exc:exception xmlns:exc="x"><properties><entry key="conflictText">Another IDE listens for DEV</entry></properties><localizedMessage>x</localizedMessage></exc:exception>'), 'Another IDE listens for DEV');
  assert.equal(debugError('<dbg:attach/>'), null);
  const vars = `<asx:abap xmlns:asx="x"><asx:values><DATA><HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@LOCALS</PARENT_ID><CHILD_ID>LT_X</CHILD_ID></STPDA_ADT_VARIABLE_HIERARCHY><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@LOCALS</PARENT_ID><CHILD_ID>LV_N</CHILD_ID></STPDA_ADT_VARIABLE_HIERARCHY></HIERARCHIES><VARIABLES><STPDA_ADT_VARIABLE><ID>LT_X</ID><NAME>LT_X</NAME><DECLARED_TYPE_NAME>STRING_TABLE</DECLARED_TYPE_NAME><META_TYPE>table</META_TYPE><TABLE_LINES>3</TABLE_LINES></STPDA_ADT_VARIABLE><STPDA_ADT_VARIABLE><ID>LV_N</ID><NAME>LV_N</NAME><DECLARED_TYPE_NAME>I</DECLARED_TYPE_NAME><META_TYPE>simple</META_TYPE><VALUE>42</VALUE></STPDA_ADT_VARIABLE></VARIABLES></DATA></asx:values></asx:abap>`;
  assert.deepEqual(parseChildren(vars, '@LOCALS').map(v => [v.name, v.value, v.expandable]), [['LT_X', '3 lines', true], ['LV_N', '42', false]]);
  const stack = parseStack('<dbg:stack xmlns:dbg="x" xmlns:adtcore="y"><stackEntry stackPosition="2" programName="ZCL_X=====CP" eventName="RUN" stackUri="/sap/bc/adt/debugger/stack/type/ABAP/position/2" adtcore:uri="/sap/bc/adt/oo/classes/zcl_x/source/main#start=8,4"/></dbg:stack>');
  assert.deepEqual(stack.map(f => [f.name, f.uri, f.line, f.position, f.stackUri]), [['ZCL_X=====CP · RUN', '/sap/bc/adt/oo/classes/zcl_x/source/main', 7, 2, '/sap/bc/adt/debugger/stack/type/ABAP/position/2']]);
});

test('transport description changes on the request, not on its tasks', () => {
  const doc = '<tm:root xmlns:tm="t" tm:number="NPLK900001"><tm:request tm:number="NPLK900001" tm:desc="Old"><tm:task tm:number="NPLK900002" tm:desc="Old"/></tm:request></tm:root>';
  const out = setTransportDesc(doc, 'NPLK900001', 'New & better') as string;
  assert.match(out, /<tm:request tm:number="NPLK900001" tm:desc="New &amp; better">/);
  assert.match(out, /<tm:task tm:number="NPLK900002" tm:desc="Old"\/>/, 'tasks keep theirs');
  assert.match(setTransportDesc('<tm:root xmlns:tm="t" tm:number="NPLK900001" tm:desc="Old"/>', 'NPLK900001', 'New') as string, /tm:desc="New"/, 'root as fallback');
  const req = setTransportDesc('<tm:root xmlns:tm="t"><tm:request tm:number="NPLK900001" tm:desc="Old"/></tm:root>', 'NPLK900001', 'New') as string;
  assert.match(req, /tm:desc="New"\/>/);
  assert.equal(setTransportDesc('<tm:root/>', 'X', 'y'), null);
});

test('transport documents: object entries come out and go in under the task', () => {
  const doc = '<tm:root xmlns:tm="t"><tm:request tm:number="NPLK900001"><tm:task tm:number="NPLK900002"><tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="ZCL_A"/><tm:abap_object tm:pgmid="R3TR" tm:type="DDLS" tm:name="ZI_B"><tm:link href="x"/></tm:abap_object><tm:abap_object tm:pgmid="LIMU" tm:type="METH" tm:name="ZCL_A                         RUN"/></tm:task></tm:request></tm:root>';
  const r = removeTransportEntries(doc, ['R3TR DDLS ZI_B', 'R3TR CLAS ZCL_A']);
  assert.equal(r.removed, 2);
  assert.ok(!hasTransportEntry(r.xml, 'R3TR CLAS ZCL_A') && hasTransportEntry(r.xml, 'LIMU METH ZCL_A                         RUN'));
  assert.match(r.xml, /<tm:task tm:number="NPLK900002"><tm:abap_object tm:pgmid="LIMU"/);
  const empty = '<tm:root xmlns:tm="t"><tm:request tm:number="NPLK900009"><tm:task tm:number="NPLK900010"/></tm:request></tm:root>';
  const added = addTransportEntries(empty, 'NPLK900010', ['R3TR CLAS ZCL_A', 'R3TR CLAS ZCL_A']) as string;
  assert.equal(added, '<tm:root xmlns:tm="t"><tm:request tm:number="NPLK900009"><tm:task tm:number="NPLK900010"><tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="ZCL_A"/><tm:abap_object tm:pgmid="R3TR" tm:type="CLAS" tm:name="ZCL_A"/></tm:task></tm:request></tm:root>'.replace(/<tm:abap_object[^>]*\/>(?=<tm:abap_object)/, ''));
  assert.equal(addTransportEntries(empty, 'NPLK999999', ['R3TR CLAS ZCL_A']), null);
});

import { parseTransportTree as ptt } from '../src/adt/client';
test('transport tree: workbench, customizing and copies like SE09/SE10', () => {
  const tree = `<tm:root xmlns:tm="t"><tm:workbench><tm:target><tm:modifiable><tm:request tm:number="A1" tm:desc="wb"/><tm:request tm:number="A3" tm:desc="toc" tm:type="T"/></tm:modifiable></tm:target></tm:workbench><tm:customizing><tm:target><tm:released><tm:request tm:number="A2" tm:desc="cust"/></tm:released></tm:target></tm:customizing></tm:root>`;
  assert.deepEqual(ptt(tree).map(t => [t.id, t.category, t.status]), [['A1', 'workbench', 'modifiable'], ['A3', 'copies', 'modifiable'], ['A2', 'customizing', 'released']]);
});

import { pkgMatches, adtTypeOf } from '../src/core/types';
test('package filter and function group object types', () => {
  assert.ok(pkgMatches('ZNUSA*', 'ZNUSA_FLIGHT') && pkgMatches('', 'X') && !pkgMatches('ZNUSA', 'ZNUSA_FLIGHT') && pkgMatches('znusa_flight', 'ZNUSA_FLIGHT'));
  assert.deepEqual(['FUGR/F', 'FUGR/FF', 'FUGR/I', 'PROG/I'].map(adtTypeOf), ['FUGR', 'FUNC', 'INCL', 'INCL']);
});
