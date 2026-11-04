import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoutingBackend, DEMO_ID } from '../src/backends/router';
import { AdtBackend } from '../src/backends/adt';
import { FakeAdtServer } from './fake-adt-server';
import { Connection } from '../src/core/types';

const local: Connection = { id: 'local', kind: 'runner', sid: 'LOCAL', client: '000', user: 'NUSA', url: 'http://localhost:7777', language: 'EN', auth: 'none', abapVersion: 'runner', favoritePackages: ['ZDEMO'], transports: false };

test('DEMO system comes first and works without SAP; other systems go to ADT', async () => {
  const srv = new FakeAdtServer();
  const b = RoutingBackend.withDemo(new AdtBackend(srv, { list: async () => [local], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined }), null);
  const conns = await b.connections();
  assert.deepEqual(conns.map(c => `${c.id}:${c.sid}`), ['demo:DEMO', 'local:LOCAL']);
  assert.equal(conns[0].url, 'built-in');
  const demoObjs = await b.packageObjects(DEMO_ID, 'ZNUSA_FLIGHT');
  assert.ok(demoObjs.some(o => o.name === 'ZCL_NUSA_FLIGHT_SERVICE'));
  assert.equal(srv.log.length, 0, 'demo never touches the network');
  const realObjs = await b.packageObjects('local', 'ZDEMO');
  assert.deepEqual(realObjs.map(o => o.name), ['ZCL_DEMO']);
  const tr = await b.createTransport(DEMO_ID, 'x', demoObjs[0]);
  assert.match(tr, /^DEMOK9/);
  await assert.rejects(b.deleteConnection(DEMO_ID), /cannot be removed/);
  await b.saveConnection({ ...conns[0], favoritePackages: ['ZNUSA_FLIGHT', 'ZNUSA_FLIGHT_SRV'] });
  assert.deepEqual((await b.connections())[0].favoritePackages, ['ZNUSA_FLIGHT', 'ZNUSA_FLIGHT_SRV']);
});

test('debugger calls stay on the backend that started the session', async () => {
  const b = RoutingBackend.withDemo(new AdtBackend(new FakeAdtServer(), { list: async () => [local], save: async () => undefined, remove: async () => undefined, resetSession: async () => undefined }), null);
  await b.connections();
  const prog = (await b.packageObjects(DEMO_ID, 'ZNUSA_FLIGHT')).find(o => o.type === 'PROG')!;
  const src = await b.read(DEMO_ID, prog, 'main', 'active');
  const line = src.split('\n').findIndex(l => /LOOP AT/.test(l));
  const bps = [{ uri: prog.uri, include: 'main' as const, line }];
  let st = await b.debugStart(DEMO_ID, prog, bps);
  assert.ok(st && !st.done);
  while (!st!.done) st = await b.debugStep('continue', []);
  assert.match(st!.outputSoFar, /0401/);
});
