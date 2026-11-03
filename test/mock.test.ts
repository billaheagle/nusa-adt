import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/backends/mock';
import { uriFor } from '../src/core/types';

const cls = { uri: uriFor('CLAS', 'ZCL_NUSA_FLIGHT_SERVICE'), name: 'ZCL_NUSA_FLIGHT_SERVICE', type: 'CLAS' as const, pkg: 'ZNUSA_FLIGHT', desc: '' };
const prog = { uri: uriFor('PROG', 'ZR_NUSA_FLIGHTS'), name: 'ZR_NUSA_FLIGHTS', type: 'PROG' as const, pkg: 'ZNUSA_FLIGHT', desc: '' };

test('sample sources are free of syntax errors', async () => {
  const b = new MockBackend();
  for (const inc of b.includesOf('CLAS')) {
    const src = await b.read('s4d', cls, inc, 'active');
    const errs = (await b.syntaxCheck('s4d', cls, inc, src)).filter(p => p.sev === 'error');
    assert.deepEqual(errs, [], inc);
  }
  const p = await b.read('s4d', prog, 'main', 'active');
  assert.deepEqual((await b.syntaxCheck('s4d', prog, 'main', p)).filter(x => x.sev === 'error'), []);
});

test('zero-seat test fails until the guard is activated', async () => {
  const b = new MockBackend();
  let r = await b.runUnit('s4d', cls);
  assert.equal(r.methods.length, 3);
  assert.equal(r.methods.filter(m => m.status !== 'ok').length, 1);
  const src = await b.read('s4d', cls, 'main', 'inactive');
  const fixed = src.replace('    rv_percent = round(', '    IF iv_seats_max = 0.\n      RETURN.\n    ENDIF.\n    rv_percent = round(');
  const lock = await b.lock('s4d', cls);
  await b.write('s4d', cls, 'main', fixed, lock);
  assert.equal((await b.state('s4d', cls)).inactive, true);
  r = await b.runUnit('s4d', cls);
  assert.ok(r.note, 'runs against active version');
  const act = await b.activate('s4d', [cls]);
  assert.equal(act.ok, true, JSON.stringify(act.problems));
  r = await b.runUnit('s4d', cls);
  assert.equal(r.methods.every(m => m.status === 'ok'), true);
});

test('activation fails on a broken block and keeps the active version', async () => {
  const b = new MockBackend();
  const src = await b.read('s4d', cls, 'main', 'inactive');
  const lock = await b.lock('s4d', cls);
  await b.write('s4d', cls, 'main', src.replace('  ENDMETHOD.\n\nENDCLASS.', '\nENDCLASS.'), lock);
  const act = await b.activate('s4d', [cls]);
  assert.equal(act.ok, false);
  assert.ok(act.problems.some(p => /ENDMETHOD/.test(p.msg)));
});

test('new objects in a transportable package need a request', async () => {
  const b = new MockBackend();
  const tr = await b.createTransport('s4d', 'test');
  const ref = await b.createObject('s4d', 'CLAS', 'ZCL_NUSA_NEW', 'x', 'ZNUSA_FLIGHT', tr);
  const need = await b.transportNeed('s4d', ref);
  assert.equal(need.current, tr);
  const list = await b.transports('s4d');
  assert.ok(list.find(t => t.id === tr)?.objects.includes('R3TR CLAS ZCL_NUSA_NEW'));
});

test('cloud system rejects WRITE', async () => {
  const b = new MockBackend();
  const p = await b.syntaxCheck('trl', cls, 'main', "CLASS zcl_nusa_flight_service DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_nusa_flight_service IMPLEMENTATION.\nENDCLASS.\nWRITE 'x'.");
  assert.ok(p.some(x => /not permitted in ABAP for Cloud/.test(x.msg)));
});

test('program run and debugger trace produce the same list', async () => {
  const b = new MockBackend();
  const run = await b.run('s4d', prog);
  assert.match(run.output, /0401 10\.11\.2026\s+90\.12/);
  const src = await b.read('s4d', prog, 'main', 'active');
  const loopLine = src.split('\n').findIndex(l => /LOOP AT/.test(l));
  const bps = [{ uri: prog.uri, include: 'main' as const, line: loopLine }];
  let st = await b.debugStart('s4d', prog, bps);
  assert.ok(st && !st.done);
  assert.equal(st!.frames[0].line, loopLine);
  st = await b.debugStep('over', bps);                     // on calc line
  st = await b.debugStep('into', bps);                     // inside CALC_LOAD_FACTOR
  assert.match(st.frames[0].name, /CALC_LOAD_FACTOR/);
  st = await b.debugStep('return', bps);                   // back on WRITE
  assert.equal(st.frames.length, 1);
  st = await b.debugStep('over', bps);                     // WRITE executed
  assert.match(st.outputSoFar, /0401/);
  while (!st.done) st = await b.debugStep('continue', []);
  assert.equal(st.outputSoFar.split('\n').length, 3);
});

test('completion after -> offers class methods', async () => {
  const b = new MockBackend();
  const src = 'DATA(lo_service) = NEW zcl_nusa_flight_service( ).\nlo_service->';
  const list = await b.complete('s4d', prog, 'main', src, 1, 'lo_service->'.length);
  assert.ok(list.some(p => p.label === 'calc_load_factor'));
});
