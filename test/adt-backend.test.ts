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
