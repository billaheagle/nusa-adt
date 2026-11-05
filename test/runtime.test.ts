// Runtime errors (ST22), version history, compare with other systems, problem reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpsDefaultQuery, followLink, parseDumps, parseRevisions, versionsLink } from '../src/adt/client';
import { anonymize, issueUrl } from '../src/core/diag';
import { ownDumps, renderDumps, dumpPage } from '../src/ui/runtime';
import { compareTargets, historyBlocker } from '../src/ui/history';
import { MockBackend } from '../src/backends/mock';
import { Connection, newObjectUri, fmUri } from '../src/core/types';

const DUMPS = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:title>ABAP Runtime Errors</atom:title>
  <atom:entry>
    <atom:author><atom:name>DEVELOPER</atom:name></atom:author>
    <atom:category term="COMPUTE_INT_ZERODIVIDE" label="ABAP runtime error"/>
    <atom:category term="ZCL_NUSA=====CP" label="Terminated ABAP program"/>
    <atom:id>/sap/bc/adt/runtime/dump/20261104101112vhcala_A4H_00%20DEVELOPER%20001</atom:id>
    <atom:link href="adt://A4H/sap/bc/adt/runtime/dump/20261104101112vhcala" rel="self" type="text/html"/>
    <atom:link href="/sap/bc/adt/oo/classes/zcl_nusa/source/main#start=42,4" rel="http://www.sap.com/adt/relations/objects" type="text/plain"/>
    <atom:summary type="html">&lt;h2&gt;Division by 0&lt;/h2&gt;&lt;p&gt;In &amp;quot;ZCL_NUSA&amp;quot;&lt;/p&gt;</atom:summary>
    <atom:title>Runtime error COMPUTE_INT_ZERODIVIDE</atom:title>
    <atom:updated>2026-11-04T10:11:12Z</atom:updated>
  </atom:entry>
  <atom:entry>
    <atom:category term="TIME_OUT" label="ABAP runtime error"/>
    <atom:id>/sap/bc/adt/runtime/dump/2</atom:id>
    <atom:title>TIME_OUT</atom:title>
    <atom:updated>2026-11-03T08:00:00Z</atom:updated>
  </atom:entry>
</atom:feed>`;

test('runtime errors feed: error, program, user, where it stopped, description', () => {
  const d = parseDumps(DUMPS);
  assert.equal(d.length, 2);
  assert.equal(d[0].error, 'COMPUTE_INT_ZERODIVIDE');
  assert.equal(d[0].program, 'ZCL_NUSA=====CP');
  assert.equal(d[0].user, 'DEVELOPER');
  assert.deepEqual(d[0].where, { uri: '/sap/bc/adt/oo/classes/zcl_nusa', include: 'main', line: 41 });
  assert.match(d[0].html || '', /<h2>Division by 0<\/h2>/);
  assert.equal(d[1].error, 'TIME_OUT');
  assert.equal(d[1].where, undefined);
  assert.equal(d[1].html, undefined);
});

test('runtime errors: the default query of the feed list is used', () => {
  const feeds = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry><atom:title>Traces</atom:title><atom:link href="/sap/bc/adt/runtime/traces"/></atom:entry>
  <atom:entry><atom:title>Runtime Errors</atom:title><atom:link href="/sap/bc/adt/runtime/dumps" type="application/atom+xml"/>
  <adtfeed:extendedData xmlns:adtfeed="http://www.sap.com/adt/feeds"><adtfeed:queryVariants>
    <adtfeed:queryVariant adtfeed:queryString="$query=and(equals(user,ALL))" adtfeed:title="All" adtfeed:isDefault="false"/>
    <adtfeed:queryVariant adtfeed:queryString="$query=and(equals(user,DEVELOPER))&amp;$top=50" adtfeed:title="Mine" adtfeed:isDefault="true"/>
  </adtfeed:queryVariants></adtfeed:extendedData></atom:entry></atom:feed>`;
  assert.deepEqual(dumpsDefaultQuery(feeds), { $query: 'and(equals(user,DEVELOPER))', $top: '50' });
  assert.deepEqual(dumpsDefaultQuery('<feed/>'), {});
});

test('version history: link of the object or class include, feed entries', () => {
  const prog = `<program:abapProgram xmlns:program="p" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="ZR_X">
    <atom:link href="source/main/versions" rel="http://www.sap.com/adt/relations/versions"/></program:abapProgram>`;
  assert.equal(versionsLink(prog, '/sap/bc/adt/programs/programs/zr_x', 'main'), '/sap/bc/adt/programs/programs/zr_x/source/main/versions');
  const cls = `<class:abapClass xmlns:class="c" xmlns:atom="http://www.w3.org/2005/Atom">
    <class:include class:includeType="main"><atom:link href="./source/main/versions" rel="http://www.sap.com/adt/relations/versions"/></class:include>
    <class:include class:includeType="testclasses"><atom:link href="/sap/bc/adt/oo/classes/zcl_x/includes/testclasses/versions" rel="http://www.sap.com/adt/relations/versions"/></class:include>
  </class:abapClass>`;
  assert.equal(versionsLink(cls, '/sap/bc/adt/oo/classes/zcl_x', 'main'), '/sap/bc/adt/oo/classes/zcl_x/source/main/versions');
  assert.equal(versionsLink(cls, '/sap/bc/adt/oo/classes/zcl_x', 'testclasses'), '/sap/bc/adt/oo/classes/zcl_x/includes/testclasses/versions');
  assert.equal(versionsLink(cls, '/sap/bc/adt/oo/classes/zcl_x', 'definitions'), '');
  assert.equal(followLink('/a/b', 'adt://A4H/sap/bc/adt/x'), '/sap/bc/adt/x');

  const feed = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core">
    <atom:entry><atom:author><atom:name>DEVELOPER</atom:name></atom:author>
      <atom:content src="/sap/bc/adt/programs/programs/zr_x/source/main/versions/20261104101112/00001/content" type="text/plain"/>
      <atom:id>00001</atom:id><atom:link href="/sap/bc/adt/cts/transportrequests/A4HK900123" adtcore:name="A4HK900123" type="application/vnd.sap.adt.transportrequests.v1+xml"/>
      <atom:title>Nusa: fix</atom:title><atom:updated>2026-11-04T10:11:12Z</atom:updated></atom:entry>
    <atom:entry><atom:content src="versions/1/content"/><atom:id>00000</atom:id><atom:updated>2026-10-01T00:00:00Z</atom:updated></atom:entry>
  </atom:feed>`;
  const r = parseRevisions(feed, '/sap/bc/adt/programs/programs/zr_x/source/main');
  assert.equal(r.length, 2);
  assert.equal(r[0].author, 'DEVELOPER');
  assert.equal(r[0].transport, 'A4HK900123');
  assert.equal(r[0].title, 'Nusa: fix');
  assert.equal(r[1].uri, '/sap/bc/adt/programs/programs/zr_x/source/main/versions/1/content');
});

test('problem report: hosts, IPs, user and routes are hidden; long text is cut', () => {
  const t = anonymize('GET https://s4d.nusa.internal:44300/sap/bc/adt/discovery as DEVELOPER via /H/10.1.2.3/S/3299/W/secret/H/host and sapnwrfc.dll from my-host.corp', ['DEVELOPER', 's4d.nusa.internal']);
  assert.ok(!t.includes('DEVELOPER'));
  assert.ok(!t.includes('nusa.internal'));
  assert.ok(!t.includes('10.1.2.3'));
  assert.ok(!t.includes('secret'));
  assert.ok(!t.includes('my-host.corp'));
  assert.match(t, /sapnwrfc\.dll/);
  assert.match(t, /\/sap\/bc\/adt\/discovery/);
  const short = issueUrl('o/r', 'Title', 'body');
  assert.equal(short.cut, false);
  assert.equal(short.url, 'https://github.com/o/r/issues/new?title=Title&body=body');
  const long = issueUrl('o/r', 'T', 'x'.repeat(9000));
  assert.equal(long.cut, true);
  assert.ok(long.url.length < 8000);
});

test('runtime errors view: own errors, sandboxed description', () => {
  const list = parseDumps(DUMPS).map((d, i) => ({ ...d, user: i ? 'BATCH' : 'DEVELOPER' }));
  assert.equal(ownDumps(list, 'developer', true).length, 1);
  assert.equal(ownDumps(list, 'developer', false).length, 2);
  const html = renderDumps({ user: 'DEVELOPER', list, mine: false, sel: { dump: list[0], html: '<script>alert(1)</script><b>x</b>' } });
  assert.match(html, /<iframe class="dmp-frame" sandbox=""/);
  assert.ok(!html.includes('<script>'), 'the description is escaped into srcdoc');
  assert.match(dumpPage('<b>x</b>'), /Content-Security-Policy/);
  assert.match(renderDumps({ user: 'U', list: [], mine: true, sel: null }), /No runtime errors of U/);
});

test('compare with other systems: targets and blockers', () => {
  const c = (id: string, kind: Connection['kind'], builtin = false) => ({ id, kind, builtin } as Connection);
  const all = [c('dev', 's4'), c('qas', 's4'), c('loc', 'runner'), c('demo', 's4', true)];
  assert.deepEqual(compareTargets(all, 'dev').map(x => x.id), ['qas']);
  assert.deepEqual(compareTargets(all, 'demo').map(x => x.id), []);
  assert.match(historyBlocker({ conn: 'dev', ref: { uri: '', name: 'ZR', type: 'PROG', pkg: '', desc: '' }, include: 'symbols' }), /Text elements/);
  assert.equal(historyBlocker({ conn: 'dev', ref: { uri: '', name: 'ZR', type: 'PROG', pkg: '', desc: '' }, include: 'main' }), '');
});

test('DEMO: function group and function module creation, dumps, versions after activation', async () => {
  const m = new MockBackend(null);
  const g = await m.createObject('s4d', 'FUGR', 'ZNUSA_FG_NEW', 'New group', 'ZNUSA_FLIGHT');
  assert.equal(g.uri, '/sap/bc/adt/functions/groups/znusa_fg_new');
  const parts = await m.groupContents('s4d', g);
  assert.ok(parts.some(p => p.name === 'LZNUSA_FG_NEWTOP'), 'the TOP include comes with the group');
  await assert.rejects(m.createObject('s4d', 'FUNC', 'Z_NUSA_X', 'x', 'ZNUSA_FLIGHT', undefined, { functionGroup: 'ZNOPE' }), /does not exist/);
  const f = await m.createObject('s4d', 'FUNC', 'Z_NUSA_NEW', 'New FM', 'WRONG', undefined, { functionGroup: 'ZNUSA_FG_NEW' });
  assert.equal(f.uri, fmUri('ZNUSA_FG_NEW', 'Z_NUSA_NEW'));
  assert.equal(f.uri, newObjectUri('FUNC', 'Z_NUSA_NEW', { functionGroup: 'ZNUSA_FG_NEW' }));
  assert.equal(f.pkg, 'ZNUSA_FLIGHT', 'a function module is in the package of its group');
  assert.ok((await m.groupContents('s4d', g)).some(p => p.type === 'FUNC' && p.name === 'Z_NUSA_NEW'));
  const contents = await m.packageContents('s4d', 'ZNUSA_FLIGHT');
  assert.ok(!contents.objects.some(o => o.name === 'Z_NUSA_NEW'), 'shown under its group, not in the package list');

  const dumps = await m.dumps('s4d');
  assert.ok(dumps.length >= 2);
  const plain = dumps.find(d => !d.html)!;
  assert.match((await m.dumpDetail('s4d', plain)).text || '', /Runtime Errors/);

  const cls = (await m.packageContents('s4d', 'ZNUSA_FLIGHT')).objects.find(o => o.name === 'ZCL_NUSA_FLIGHT_SERVICE')!;
  const before = await m.revisions('s4d', cls, 'main');
  assert.ok(before.length >= 1);
  const lock = await m.lock('s4d', cls);
  const src = await m.read('s4d', cls, 'main', 'inactive');
  await m.write('s4d', cls, 'main', src.replace('ENDCLASS.', '" changed\nENDCLASS.'), lock, 'S4DK900123');
  await m.activate('s4d', [cls]);
  const after = await m.revisions('s4d', cls, 'main');
  assert.equal(after.length, before.length + 1);
  assert.match(await m.revisionSource('s4d', after[0]), /" changed/);
  assert.equal(await m.revisionSource('s4d', after[after.length - 1]) === await m.revisionSource('s4d', after[0]), false);
});
