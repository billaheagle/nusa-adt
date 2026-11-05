import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdtBackend } from '../src/backends/adt';
import { Connection } from '../src/core/types';
import { FakeAdtServer } from './fake-adt-server';

const conn: Connection = { id: 'npl', kind: 's4', sid: 'NPL', client: '001', user: 'DEV', url: 'https://npl:44300', language: 'EN', auth: 'basic', abapVersion: 'standard', favoritePackages: ['ZDEMO'], transports: true };

test('edit cycle against an ADT server: lock, transport, write test include, activate', async () => {
  const srv = new FakeAdtServer();
  const b = new AdtBackend(srv, { list: async () => [conn], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined });
  await b.connections();
  const sys = await b.connect('npl');
  assert.equal(sys.release, 'Connected');
  const [obj] = await b.packageObjects('npl', 'ZDEMO');
  assert.equal(obj.name, 'ZCL_DEMO');
  assert.equal(await b.read('npl', obj, 'testclasses', 'inactive'), '', 'missing include reads as empty');
  const lock = await b.lock('npl', obj);
  const need = await b.transportNeed('npl', obj);
  assert.equal(need.needed, true);
  const tr = await b.createTransport('npl', 'Demo change', obj);
  assert.equal(tr, 'NPLK900001');
  await b.write('npl', obj, 'testclasses', 'CLASS ltc DEFINITION FOR TESTING.\nENDCLASS.', lock, tr);
  assert.ok(srv.log.includes('POST /sap/bc/adt/oo/classes/zcl_demo/includes'), 'created test include on 404');
  assert.equal((await b.state('npl', obj)).inactive, true);
  assert.equal((await b.transportNeed('npl', obj)).current, tr);
  // SAP refuses to activate while an editor holds the lock: the workbench unlocks after saving
  await assert.rejects(b.activate('npl', [obj]), /currently editing/);
  await b.unlock('npl', obj, lock);
  const act = await b.activate('npl', [obj]);
  assert.equal(act.ok, true);
  assert.equal((await b.state('npl', obj)).inactive, false);
  const trs = await b.transports('npl');
  assert.deepEqual(trs[0].objects, ['R3TR CLAS ZCL_DEMO']);
  assert.equal((await b.run('npl', obj)).output, 'Hello from ZCL_DEMO');
});

import { prettyRelease } from '../src/backends/adt';
test('release names read like the system information in Eclipse', () => {
  assert.equal(prettyRelease('SAP_BASIS 920;SAPK-92005INSAPBASIS;0005;SAP Basis Component'), 'SAP_BASIS 920 SP05');
  assert.equal(prettyRelease('SAP_BASIS 758'), 'SAP_BASIS 758');
});

test('quick fix, rename, transport changes and a debugger session against an ADT server', async () => {
  const srv = new FakeAdtServer();
  const b = new AdtBackend(srv, { list: async () => [conn], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined });
  await b.connections();
  await b.connect('npl');
  const [obj] = await b.packageObjects('npl', 'ZDEMO');
  const src = await b.read('npl', obj, 'main', 'inactive');

  const fixes = await b.quickFixes('npl', obj, 'main', src, 3, 2);
  assert.deepEqual(fixes.map(f => f.title), ['Declare local variable LV_X']);
  assert.equal(srv.bodies.quickfix, src, 'the editor text is sent, not the saved one');
  const edits = await b.applyQuickFix('npl', obj, 'main', src, 3, 2, fixes[0]);
  assert.match(srv.bodies.fix, /<userContent>U&amp;1<\/userContent>/);
  assert.match(srv.bodies.fix, /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_demo\/source\/main#start=4,2"/);
  assert.deepEqual(edits.map(e => [e.uri, e.include, e.from.line, e.newText]), [['/sap/bc/adt/oo/classes/zcl_demo', 'main', 3, '    DATA lv_x TYPE i.\n']]);

  const start = await b.renameStart('npl', obj, 'main', 0, 6, 14);
  assert.equal(start.oldName, 'ZCL_DEMO');
  const prev = await b.renamePreview('npl', start, 'zcl_demo2', 'NPLK900001');
  assert.match(srv.bodies.preview, /<rename:newName>zcl_demo2<\/rename:newName>/);
  assert.deepEqual(prev.edits.map(e => [e.from.line, e.from.ch, e.oldText, e.newText]), [[0, 6, 'zcl_demo', 'zcl_demo2']]);
  await b.refactorExecute('npl', prev);
  assert.match(srv.bodies.execute, /^<\?xml[^>]*\?><generic:genericRefactoring xmlns:/, 'execute gets the generic part as its own document');
  assert.match(srv.bodies.execute, /<generic:transport>NPLK900001<\/generic:transport>/);
  assert.match(await b.read('npl', obj, 'main', 'inactive'), /^CLASS zcl_demo2 DEFINITION/);

  const tr = await b.createTransport('npl', 'Old text', obj);
  await b.changeTransportDesc('npl', tr, 'New text');
  assert.equal((await b.transports('npl')).find(t => t.id === tr)?.desc, 'New text');
  await b.deleteTransport('npl', tr);
  assert.equal((await b.transports('npl')).some(t => t.id === tr), false);

  const st = await b.debugStart('npl', obj, [{ uri: obj.uri, include: 'main', line: 3 }]);
  assert.ok(st && !st.done, 'stopped at the breakpoint');
  assert.equal(st!.frames[0].line, 3);
  assert.deepEqual(st!.vars.map(v => [v.name, v.group]), [['Locals', true]]);
  assert.deepEqual(st!.vars[0].children!.map(v => [v.name, v.value]), [['LV_N', '42'], ['LT_X', '2 lines']]);
  const rows = await b.debugChildren('LT_X');
  assert.deepEqual(rows.map(r => [r.name, r.value]), [['[1]', 'row 1'], ['[2]', 'row 2']]);
  await b.debugSetValue('LV_N', '7');
  assert.equal(srv.bodies.setValue, 'LV_N=7');
  const end = await b.debugStep('continue', [{ uri: obj.uri, include: 'main', line: 3 }]);
  assert.equal(end.done, true);
  assert.match(end.outputSoFar, /^Hello from ZCL_DEMO$/);
});

test('a run that never reaches a breakpoint returns its output instead of waiting', async () => {
  const srv = new FakeAdtServer();
  const b = new AdtBackend(srv, { list: async () => [conn], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined });
  await b.connections();
  const [obj] = await b.packageObjects('npl', 'ZDEMO');
  // no breakpoints accepted → the fake run does not stop
  const st = await b.debugStart('npl', obj, []);
  assert.equal(st?.done, true);
  assert.match(st?.outputSoFar || '', /^Hello from ZCL_DEMO$/);
  assert.ok(srv.log.includes('DELETE /sap/bc/adt/debugger/listeners'), 'listener closed');
});

test('transport object entries: remove some, move others, and say so when the system ignores it', async () => {
  const srv = new FakeAdtServer();
  const b = new AdtBackend(srv, { list: async () => [conn], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined });
  await b.connections();
  const [obj] = await b.packageObjects('npl', 'ZDEMO');
  const a = await b.createTransport('npl', 'Source', obj);
  const z = await b.createTransport('npl', 'Target', obj);
  srv.transports.find(t => t.id === a)!.objs = ['ZCL_A', 'ZCL_B', 'ZCL_C', 'ZCL_D', 'ZCL_E'];
  await b.transports('npl');
  await b.removeFromTransport('npl', a, ['R3TR CLAS ZCL_B', 'R3TR CLAS ZCL_D']);
  assert.deepEqual(srv.transports.find(t => t.id === a)!.objs, ['ZCL_A', 'ZCL_C', 'ZCL_E']);
  await b.moveToTransport('npl', a, z, ['R3TR CLAS ZCL_C']);
  assert.deepEqual(srv.transports.find(t => t.id === a)!.objs, ['ZCL_A', 'ZCL_E']);
  assert.deepEqual(srv.transports.find(t => t.id === z)!.objs, ['ZCL_C']);
  const list = await b.transports('npl');
  assert.deepEqual(list.find(t => t.id === z)?.objects, ['R3TR CLAS ZCL_C']);
  await assert.rejects(b.removeFromTransport('npl', a, ['R3TR CLAS ZCL_X']), /not in/);
  srv.ignoreObjectEdits = true;
  await assert.rejects(b.removeFromTransport('npl', a, ['R3TR CLAS ZCL_A']), /does not accept changes to the object list/);
});

test('function groups, text elements of a program, and the profiler against an ADT server', async () => {
  const srv = new FakeAdtServer();
  srv.objs.push({ uri: '/sap/bc/adt/programs/programs/zr_demo', name: 'ZR_DEMO', type: 'PROG/P', pkg: 'ZDEMO', desc: 'Report', src: { main: 'REPORT zr_demo.\n' }, active: { main: 'REPORT zr_demo.\n' } });
  srv.texts.ZR_DEMO = { symbols: '@MaxLength:20\n001=Hello\n' };
  const b = new AdtBackend(srv, { list: async () => [conn], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined });
  await b.connections();
  const parts = await b.groupContents('npl', { uri: '/sap/bc/adt/functions/groups/zfg', name: 'ZFG', type: 'FUGR', pkg: 'ZDEMO', desc: '' });
  assert.deepEqual(parts.map(p => [p.type, p.name, p.uri]), [['FUNC', 'Z_DEMO_FM', '/sap/bc/adt/functions/groups/zfg/fmodules/z_demo_fm'], ['INCL', 'LZFGTOP', '/sap/bc/adt/functions/groups/zfg/includes/lzfgtop']]);

  const prog = { uri: '/sap/bc/adt/programs/programs/zr_demo', name: 'ZR_DEMO', type: 'PROG' as const, pkg: 'ZDEMO', desc: '' };
  assert.deepEqual(b.includesOf('PROG'), ['main', 'symbols', 'selections', 'headings']);
  assert.equal(await b.read('npl', prog, 'symbols', 'inactive'), '@MaxLength:20\n001=Hello\n');
  assert.equal(await b.read('npl', prog, 'selections', 'inactive'), '', 'none yet');
  await b.write('npl', prog, 'selections', 'P_CARR=Airline\n', 'ignored', 'NPLK900001');
  assert.equal(srv.texts.ZR_DEMO.selections, 'P_CARR=Airline\n');
  assert.equal((await b.state('npl', prog)).inactive, true, 'saved text elements wait for activation');
  srv.log.length = 0;
  await b.activate('npl', [prog]);
  assert.ok(srv.log.includes('POST /sap/bc/adt/activation'));
  assert.deepEqual(await b.syntaxCheck('npl', prog, 'symbols', '001=x'), []);

  const runs = await b.traces('npl');
  assert.deepEqual(runs.map(r => [r.objectName, r.runtime, r.db]), [['ZCL_DEMO', 12000, 9000]]);
  const hits = await b.traceHitList('npl', runs[0].id);
  assert.deepEqual(hits.map(h => [h.name, h.hits, h.net, h.at?.uri, h.at?.line]), [['Select ZTAB', 2, 9000, '/sap/bc/adt/oo/classes/zcl_demo', 2]]);
  await b.traceRequest('npl', 'test');
  assert.deepEqual(srv.traceRequests, ['DEV|/sap/bc/adt/runtime/traces/abaptraces/processtypes/any|/sap/bc/adt/runtime/traces/abaptraces/parameters/P1']);

});

test('runtime errors, version history and function module creation against an ADT server', async () => {
  const srv = new FakeAdtServer();
  const b = new AdtBackend(srv, { list: async () => [conn], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined });
  await b.connections();
  await b.connect('npl');
  const dumps = await b.dumps('npl');
  assert.equal(srv.bodies.dumpsQuery, JSON.stringify({ $query: 'and(equals(user,DEV))' }), 'the default query of the feed list');
  assert.equal(dumps[0].error, 'ITAB_LINE_NOT_FOUND');
  assert.deepEqual(dumps[0].where, { uri: '/sap/bc/adt/oo/classes/zcl_demo', include: 'main', line: 2 });
  assert.match((await b.dumpDetail('npl', dumps[0])).text || '', /line not found/);

  const [obj] = await b.packageObjects('npl', 'ZDEMO');
  const revs = await b.revisions('npl', obj, 'main');
  assert.equal(revs.length, 1);
  assert.equal(revs[0].transport, 'NPLK900001');
  assert.equal(await b.revisionSource('npl', revs[0]), 'OLD SOURCE');
  assert.ok(srv.log.includes('GET /sap/bc/adt/oo/classes/zcl_demo/source/main/versions'), 'the versions link of the object');

  const g = await b.createObject('npl', 'FUGR', 'ZDEMO_FG', 'Demo group', 'ZDEMO');
  assert.equal(g.uri, '/sap/bc/adt/functions/groups/zdemo_fg');
  assert.match(srv.bodies.fugr, /<group:abapFunctionGroup [^>]*adtcore:type="FUGR\/F"/);
  assert.match(srv.bodies.fugr, /<adtcore:packageRef adtcore:name="ZDEMO"\/>/);
  const f = await b.createObject('npl', 'FUNC', 'Z_DEMO_NEW', 'Demo FM', 'ZDEMO', undefined, { functionGroup: 'zdemo_fg' });
  assert.equal(f.uri, '/sap/bc/adt/functions/groups/zdemo_fg/fmodules/z_demo_new');
  assert.match(srv.bodies.func, /<fmodule:abapFunctionModule [^>]*adtcore:type="FUGR\/FF"/);
  assert.match(srv.bodies.func, /<adtcore:containerRef adtcore:name="ZDEMO_FG" adtcore:type="FUGR\/F" adtcore:uri="\/sap\/bc\/adt\/functions\/groups\/zdemo_fg"\/>/);
  await assert.rejects(b.createObject('npl', 'FUNC', 'Z_DEMO_X', 'x', 'ZDEMO', undefined, { functionGroup: 'znope' }), /does not exist/);
});
