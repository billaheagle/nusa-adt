// End-to-end UI test of the prototype bundle with the real CodeMirror 5 editor.
// Uses node_modules/codemirror after `npm install`, or CM_CORE + CM_ADDONS files.
let pw;
try { pw = await import('playwright'); } catch { pw = await import('/opt/npm-tools/node_modules/playwright/index.mjs'); }
const { chromium } = pw.default ?? pw;
import { readFileSync, existsSync, mkdirSync } from 'node:fs';

const nm = 'node_modules/codemirror';
const core = process.env.CM_CORE || `${nm}/lib/codemirror.js`;
const addons = process.env.CM_ADDONS ? [process.env.CM_ADDONS]
  : ['addon/mode/simple.js', 'addon/hint/show-hint.js', 'addon/selection/active-line.js', 'addon/edit/matchbrackets.js'].map(f => `${nm}/${f}`);
if (!existsSync(core)) { console.log('real CodeMirror not found, run npm install first'); process.exit(0); }
const cmJs = readFileSync(core, 'utf8') + '\n' + addons.map(f => readFileSync(f, 'utf8')).join('\n');
const html = readFileSync('dist/nusa-adt-prototype.html', 'utf8');
const shots = process.env.SHOTS || 'dist/shots';
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 880 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.route('**/*', r => {
  const u = r.request().url();
  if (u.includes('codemirror.min.js')) return r.fulfill({ body: cmJs, contentType: 'text/javascript' });
  if (u.includes('cdnjs')) return r.fulfill({ body: '', contentType: 'text/javascript' });
  if (u.startsWith('http://app.test')) return r.fulfill({ body: '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', contentType: 'text/html' });
  return r.abort();
});
await page.goto('http://app.test/');
await page.waitForSelector('.tab.on');
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, process.env.FULLERR ? e.message : e.message.split('\n')[0]]); } };
const cm = () => page.evaluateHandle(() => document.querySelector('.CodeMirror').CodeMirror);
const hints = () => page.$$eval('.CodeMirror-hints .hint-label', e => e.map(x => x.textContent));
const shot = n => page.screenshot({ path: `${shots}/${n}.png` });

await step('starts with sample editors, panel closed, no error toast', async () => {
  const tabs = await page.$$eval('.tab .tname', e => e.map(x => x.textContent));
  if (tabs.join() !== 'ZR_NUSA_FLIGHTS,ZCL_NUSA_FLIGHT_SERVICE') throw new Error(tabs.join());
  if (!(await page.$eval('#app', e => e.classList.contains('panel-closed')))) throw new Error('panel open');
  if (await page.$('.toast.t-error')) throw new Error('error toast');
});
await shot('01-start');

await step('completion follows typing: lo -> lo_service-> shows methods, Enter inserts call', async () => {
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  const h = await cm();
  await page.evaluate(c => { const l = c.getValue().split('\n').findIndex(x => /^\s*WRITE/.test(x)); c.replaceRange('\n', { line: l - 1, ch: c.getLine(l - 1).length }); c.setCursor({ line: l, ch: 0 }); c.focus(); }, h);
  await page.keyboard.type('    lo', { delay: 30 });
  await page.waitForSelector('.CodeMirror-hints');
  await page.keyboard.type('_service->', { delay: 30 });
  await page.waitForFunction(() => [...document.querySelectorAll('.CodeMirror-hints .hint-label')].map(x => x.textContent)[0] === 'get_flights');
  await shot('02-completion');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const line = await page.evaluate(c => c.getLine(c.getCursor().line), h);
  if (line.trim() !== 'lo_service->calc_load_factor( iv_seats_max =  iv_seats_occupied = )' && !/lo_service->calc_load_factor\( iv_seats_max = +iv_seats_occupied = \)/.test(line)) throw new Error(line);
  await page.keyboard.type('ls_flight-', { delay: 30 });
  await page.waitForFunction(() => [...document.querySelectorAll('.CodeMirror-hints .hint-label')].map(x => x.textContent).includes('seats_max'));
  await page.keyboard.press('Escape');
});

await step('Ctrl+Z restores, F2 shows element info for a method', async () => {
  const h = await cm();
  await page.evaluate(c => { while (c.historySize().undo) c.undo(); }, h);
  await page.evaluate(c => { const l = c.getValue().split('\n').findIndex(x => /calc_load_factor\(/.test(x)); c.setCursor({ line: l, ch: c.getLine(l).indexOf('calc_load') + 3 }); c.focus(); }, h);
  await page.keyboard.press('F2');
  await page.waitForSelector('#infoPop:not([hidden]) >> text=calc_load_factor');
  const t = await page.textContent('#infoPop');
  if (!/RETURNING rv_percent/.test(t)) throw new Error(t);
  await shot('03-element-info');
  await page.keyboard.press('Escape');
});

await step('run on a report shows output; Ctrl+4 cleans obsolete statements', async () => {
  await page.keyboard.press('F8');
  await page.waitForSelector('pre.out >> text=0401');
  await page.click('.tab >> text=ZCL_NUSA_FLIGHT_SERVICE');
  const h = await cm();
  await page.evaluate(c => { const l = c.getValue().split('\n').findIndex(x => /rv_percent = round/.test(x)); c.replaceRange('    DATA: lv_a TYPE i, lv_bb TYPE i.\n    MOVE 1 TO lv_a.\n    IF NOT lv_a IS INITIAL.\n    ENDIF.\n', { line: l, ch: 0 }); c.focus(); }, h);
  await page.keyboard.press('Control+4');
  await page.waitForSelector('.toast >> text=Cleaned up');
  const v = await page.evaluate(c => c.getValue(), h);
  if (!/lv_a = 1\./.test(v) || !/IF lv_a IS NOT INITIAL\./.test(v) || !/DATA lv_bb TYPE i\./.test(v)) throw new Error(v.slice(v.indexOf('DATA'), v.indexOf('DATA') + 200));
  await page.evaluate(c => { while (c.historySize().undo) c.undo(); }, h);
});

await step('explorer: subpackage, service binding publish', async () => {
  await page.click('.row >> text=ZNUSA_FLIGHT_SRV');
  await page.waitForSelector('.row >> text=ZUI_NUSA_FLIGHT_O4');
  await page.click('.row >> text=ZUI_NUSA_FLIGHT_O4');
  await page.waitForSelector('.of-head .pill >> text=Not published');
  await page.click('[data-act="sb-publish"]');
  await page.waitForSelector('.of-head .pill >> text=/^Published$/');
  await page.waitForSelector('.of-url code >> text=/odata4/');
  await shot('04-service-binding');
});

await step('context menu on a table: data preview grid and SQL filter', async () => {
  await page.click('.row >> text=ZNUSA_TRAVEL', { button: 'right' });
  await page.waitForSelector('#ctx:not([hidden]) >> text=Data Preview');
  await shot('05-context-menu');
  await page.click('#ctx >> text=Data Preview');
  await page.waitForSelector('.dp-grid tbody tr >> nth=2');
  await page.fill('#dpSql', "SELECT travel_id, description, total_price FROM ZNUSA_TRAVEL WHERE status = 'A'");
  await page.focus('#dpSql');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.dp-grid tbody tr').length === 1);
  await shot('06-data-preview');
});

await step('RAP generator from the table creates and activates 7 objects and publishes', async () => {
  await page.click('.row >> text=ZNUSA_TRAVEL', { button: 'right' });
  await page.click('#ctx >> text=Generate RAP Service');
  await page.waitForSelector('#rgPlan li >> nth=6');
  await shot('07-rap-generator');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal >> text=Select transport request');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.toast >> text=Generated 7 objects', { timeout: 15000 });
  await page.waitForSelector('.of-head .pill >> text=/^Published$/');
});

await step('new package and new object in it', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.keyboard.type('new package'); await page.keyboard.press('Enter');
  await page.waitForSelector('#npName');
  await page.fill('#npName', 'ZNUSA_DEMO'); await page.fill('#npDesc', 'Nusa: demo'); await page.fill('#npSuper', 'ZNUSA_FLIGHT');
  await page.uncheck('#npFav');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal >> text=Select transport request'); await page.click('.modal button[type=submit]');
  await page.waitForSelector('.toast >> text=Created package ZNUSA_DEMO');
  await page.click('.row >> text=ZNUSA_DEMO', { button: 'right' });
  await page.click('#ctx >> text=New ABAP Object');
  await page.selectOption('#noType', 'DDLS');
  await page.fill('#noName', 'ZI_NUSA_DEMO'); await page.fill('#noDesc', 'Demo view'); await page.fill('#noRef', '/DMO/CARRIER');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal >> text=Select transport request'); await page.click('.modal button[type=submit]');
  await page.waitForSelector('.tab.on >> text=ZI_NUSA_DEMO');
});

await step('CDS completion in the new view: annotation enum values', async () => {
  const h = await cm();
  await page.evaluate(c => { c.setCursor({ line: 0, ch: 0 }); c.replaceRange('\n', { line: 0, ch: 0 }); c.setCursor({ line: 0, ch: 0 }); c.focus(); }, h);
  await page.keyboard.type('@ObjectModel.usageType.dataCl', { delay: 15 });
  await page.waitForFunction(() => [...document.querySelectorAll('.CodeMirror-hints .hint-label')].some(x => x.textContent === 'ObjectModel.usageType.dataClass'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.CodeMirror-hints .hint-label')].includes ? true : true);
  await page.keyboard.type('MAS', { delay: 30 });
  await page.waitForFunction(() => [...document.querySelectorAll('.CodeMirror-hints .hint-label')].map(x => x.textContent).includes('MASTER'));
  await page.keyboard.press('Enter');
  const line = await page.evaluate(c => c.getLine(0), h);
  if (line !== '@ObjectModel.usageType.dataClass: #MASTER') throw new Error(line);
});

await step('delete an object through the context menu', async () => {
  await page.click('.tab.on', { button: 'right' });
  await page.click('#ctx button:has-text("Close") >> nth=0');
  await page.waitForSelector('.modal >> text=Save changes to ZI_NUSA_DEMO');
  await page.click(".modal button:has-text(\"Don't save\")");
  await page.waitForSelector('#modal', { state: 'hidden' });
  const dbg = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#sideBody .row .lbl')].map(x => x.textContent).filter(t => /DEMO/.test(t)), view: document.querySelector('#sideTitle')?.textContent }));
  if (!dbg.rows.some(r => r === 'ZI_NUSA_DEMO')) throw new Error('explorer rows: ' + JSON.stringify(dbg));
  await page.click('.row >> text=ZI_NUSA_DEMO', { button: 'right' });
  await page.click('#ctx >> text=Delete');
  await page.click('.modal .btn.danger');
  await page.waitForSelector('.toast >> text=Deleted ZI_NUSA_DEMO');
});

await step('abapGit view lists and pulls', async () => {
  await page.click('[data-view="git"]');
  await page.waitForSelector('.repo >> text=ZNUSA_FLIGHT');
  await page.click('[data-act="git-pull"] >> nth=0');
  await page.waitForSelector('.modal >> text=Select transport request'); await page.click('.modal button[type=submit]');
  await page.waitForSelector('.toast >> text=Pulled');
});

await step('extensions can be switched off and on', async () => {
  await page.click('[data-view="extensions"]');
  await shot('08-extensions');
  await page.click('.ext:has-text("abapGit") .switch');
  await page.waitForFunction(() => !document.querySelector('[data-view="git"]'));
  await page.click('.ext:has-text("abapGit") .switch');
  await page.waitForSelector('[data-view="git"]');
});

await step('systems: add S/4HANA Cloud with browser logon, validation, remove', async () => {
  await page.click('[data-view="connections"]');
  await page.click('#sideBody [data-act="add-conn"]');
  await page.selectOption('#sfKind', 's4cloud');
  if (!(await page.isHidden('#sfPw'))) throw new Error('password visible for cloud');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('#sfErr >> text=system URL');
  await page.fill('#sfUrl', 'https://my123456-api.s4hana.cloud.sap');
  await shot('09-add-system');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.conn >> text=MY123456');
  await page.click('.conn:has-text("MY123456") [data-act="del-conn"]');
  await page.click('.modal .btn.danger');
  await page.waitForFunction(() => !document.querySelector('.conn b') || ![...document.querySelectorAll('.conn b')].some(b => b.textContent === 'MY123456'));
});

await step('systems: on-premise over RFC like the SAP GUI logon pad (SAProuter route is split)', async () => {
  await page.click('#sideBody [data-act="add-conn"]');
  await page.selectOption('#sfKind', 's4');
  await page.selectOption('#sfAuth', 'rfc');
  if (!(await page.isHidden('#sfUrl'))) throw new Error('URL field visible for RFC');
  if (await page.isHidden('#sfPw')) throw new Error('password hidden for RFC');
  await page.fill('#sfSid', 'LNP');
  await page.fill('#sfRouter', '/H/36.92.53.190/S/3299/W/PC/H/10.27.1.2/S/3220');
  await page.dispatchEvent('#sfRouter', 'change');
  if (await page.inputValue('#sfHost') !== '10.27.1.2' || await page.inputValue('#sfSysnr') !== '20' || await page.inputValue('#sfRouter') !== '/H/36.92.53.190/S/3299/W/PC') throw new Error('route not split');
  await page.fill('#sfUser', 'developer');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('#sfErr >> text=password');
  await page.fill('#sfPw', 'not-a-real-password');
  await shot('09b-add-rfc');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.conn:has-text("LNP") >> text=10.27.1.2 · instance 20 via /H/36.92.53.190/S/3299/W/***');
  await page.click('.conn:has-text("LNP") [data-act="del-conn"]');
  await page.click('.modal .btn.danger');
  await page.waitForFunction(() => ![...document.querySelectorAll('.conn b')].some(b => b.textContent === 'LNP'));
});

await step('settings: light theme, larger editor font', async () => {
  await page.click('[data-view="settings"]');
  await page.click('[data-act="set-theme"][data-id="light"]');
  await page.selectOption('#setFont', '15');
  if (await page.evaluate(() => document.documentElement.getAttribute('data-theme')) !== 'light') throw new Error('theme');
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.click('[data-view="explorer"]');
  await shot('10-light');
  await page.click('[data-act="set-theme"][data-id="dark"]').catch(() => page.keyboard.press('Control+Alt+D'));
});

const saveNow = async (name) => {
  await page.keyboard.press('Control+s');
  const tr = page.waitForSelector('.modal >> text=Select transport request', { timeout: 3000 }).then(() => page.click('.modal button[type=submit]')).catch(() => {});
  await page.waitForSelector(`.toast >> text=Saved ${name}`);
  await tr;
};
const palette = async (text) => {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(text, { delay: 5 });
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
};

await step('local history and compare: active version, history entry, restore', async () => {
  await page.click('.tab >> text=ZCL_NUSA_FLIGHT_SERVICE');
  const h = await cm();
  await page.evaluate(c => { c.replaceRange('* change one\n', { line: 0, ch: 0 }); c.focus(); }, h);
  await saveNow('ZCL_NUSA_FLIGHT_SERVICE');
  await page.evaluate(c => { c.replaceRange('* change two\n', { line: 0, ch: 0 }); c.focus(); }, h);
  await palette('Compare With: Active');
  await page.waitForSelector('.df-bar >> text=Active version');
  const st = (await page.textContent('.df-stats')).replace(/\s+/g, ' ').trim();
  if (st !== '+2 −0') throw new Error('active diff ' + st);
  if ((await page.$$('.df-body .d-add')).length !== 2) throw new Error('rows');
  await shot('11-compare');
  await page.click('[data-act="df-edit"]');
  await page.waitForSelector('.tab.on >> text=ZCL_NUSA_FLIGHT_SERVICE');
  await palette('Compare With: Local History');
  await page.waitForSelector('.pick.hist button');
  await page.click('.pick.hist button');
  await page.waitForSelector('.df-bar >> text=Local');
  const st2 = (await page.textContent('.df-stats')).replace(/\s+/g, ' ').trim();
  if (st2 !== '+1 −0') throw new Error('history diff ' + st2);
  await page.click('[data-act="df-restore"]');
  await page.waitForSelector('.toast >> text=Replaced the editor content');
  const first = await page.evaluate(c => c.getLine(0), await cm());
  if (first !== '* change one') throw new Error('restored ' + first);
});

await step('unsaved changes survive a restart as a draft', async () => {
  const h = await cm();
  await page.evaluate(c => { c.replaceRange('* draft line\n', { line: 0, ch: 0 }); c.focus(); }, h);
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.toast >> text=Restored your unsaved changes to ZCL_NUSA_FLIGHT_SERVICE');
  const first = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getLine(0));
  if (first !== '* draft line') throw new Error('draft ' + first);
  if (!(await page.$('.tab.on .tclose.dirty'))) throw new Error('not dirty');
  await page.click('.toast-act >> text=Show changes');
  await page.waitForSelector('.df-bar >> text=System version');
  await page.click('[data-act="df-edit"]');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('.tab.on .tclose.dirty'));
});

await step('VS Code editing keys: Ctrl+D, Alt+Down, Shift+Alt+Down, Ctrl+Shift+K', async () => {
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.waitForSelector('.tab.on >> text=ZR_NUSA_FLIGHTS');
  await page.waitForFunction(() => /^REPORT/m.test(document.querySelector('.CodeMirror').CodeMirror.getValue()));
  const h = await cm();
  const before = await page.evaluate(c => c.getValue(), h);
  const l = await page.evaluate(c => { const l = c.getValue().split('\n').findIndex(x => /\blo_service\b/.test(x)); c.setCursor({ line: l, ch: c.getLine(l).indexOf('lo_service') + 2 }); c.focus(); return l; }, h);
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Control+d');
  const sels = await page.evaluate(c => c.getSelections(), h);
  if (sels.length !== 2 || sels.some(x => x !== 'lo_service')) throw new Error('ctrl+d ' + JSON.stringify(sels));
  await page.keyboard.press('Escape');
  await page.evaluate(([c, l]) => c.setCursor({ line: l, ch: 4 }), [h, l]);
  const line = await page.evaluate(([c, l]) => c.getLine(l), [h, l]);
  await page.keyboard.press('Alt+ArrowDown');
  if (await page.evaluate(([c, l]) => c.getLine(l + 1), [h, l]) !== line) throw new Error('alt+down');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Shift+Alt+ArrowDown');
  if (await page.evaluate(([c, l]) => c.getLine(l + 1), [h, l]) !== line) throw new Error('copy line');
  await page.keyboard.press('Control+Shift+k');
  if (await page.evaluate(c => c.getValue(), h) !== before) throw new Error('delete line');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  if (await page.evaluate(c => c.getValue(), h) !== before) throw new Error('undo');
});

await step('clean up on save', async () => {
  await page.click('[data-view="settings"]');
  await page.check('#setCleanSave');
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  const h = await cm();
  await page.evaluate(c => { const l = c.getValue().split('\n').findIndex(x => /^\s*LOOP AT/.test(x)); c.replaceRange('  DATA lv_n TYPE i.\n  MOVE 5 TO lv_n.\n', { line: l, ch: 0 }); c.focus(); }, h);
  await saveNow('ZR_NUSA_FLIGHTS');
  const v = await page.evaluate(c => c.getValue(), h);
  if (/MOVE 5 TO/.test(v) || !/lv_n = 5\./.test(v)) throw new Error('not cleaned');
  await page.uncheck('#setCleanSave');
});

await step('Eclipse guide and connection log', async () => {
  await palette('Coming from Eclipse');
  await page.waitForSelector('.modal .eclipse-list').catch(() => { throw new Error('guide'); });
  await shot('12-eclipse');
  await page.click('.modal button:has-text("Close")');
  await page.waitForSelector('#modal', { state: 'hidden' }).catch(() => { throw new Error('guide close'); });
  await page.waitForTimeout(300);
  await palette('Show Connection Log');
  await page.waitForSelector('.modal pre.diag').catch(() => { throw new Error('log'); });
  if (!/Nusa Studio diagnostics/.test(await page.textContent('.modal pre.diag'))) throw new Error('log text');
  await page.click('.modal button:has-text("Close")');
  await page.waitForSelector('#modal', { state: 'hidden' });
});

const explorer = async () => {
  const open = await page.evaluate(() => !document.querySelector('#app').classList.contains('side-closed') && document.querySelector('#sideTitle')?.textContent === 'Project Explorer' && document.querySelector('#sideBody').offsetWidth > 0);
  if (!open) await page.click('[data-view="explorer"]');
  await page.waitForFunction(() => document.querySelector('#sideTitle')?.textContent === 'Project Explorer' && document.querySelector('#sideBody').offsetWidth > 0);
};
await step('preview tabs: single click reuses the tab, editing keeps it', async () => {
  await explorer();
  const before = (await page.$$('.tab')).length;
  await page.click('.row >> text=ZIF_NUSA_LOGGER');
  await page.waitForSelector('.tab.on.preview >> text=ZIF_NUSA_LOGGER');
  await page.click('.row.leaf >> text=ZNUSA_TRAVEL');
  await page.waitForSelector('.tab.on.preview >> text=ZNUSA_TRAVEL');
  if (await page.$('.tab >> text=ZIF_NUSA_LOGGER')) throw new Error('preview tab was not replaced');
  if ((await page.$$('.tab')).length > before + 1) throw new Error('tab count');
  await page.evaluate(() => { const c = document.querySelector('.CodeMirror').CodeMirror; c.replaceRange(' ', { line: 0, ch: 0 }); });
  await page.waitForFunction(() => !document.querySelector('.tab.on').classList.contains('preview'));
  await page.click('.row >> text=ZIF_NUSA_LOGGER');
  await page.waitForSelector('.tab.on.preview >> text=ZIF_NUSA_LOGGER');
  if (!(await page.$('.tab >> text=ZNUSA_TRAVEL'))) throw new Error('edited tab was replaced');
  await page.dblclick('.tab.on');
  await page.waitForFunction(() => !document.querySelector('.tab.on').classList.contains('preview'));
  await page.click('.tab >> text=ZNUSA_TRAVEL');
  await page.keyboard.press('Control+z');
});

await step('format document: indentation and aligned parameters (Shift+Alt+F)', async () => {
  await page.click('.tab >> text=ZCL_NUSA_FLIGHT_SERVICE');
  await page.waitForSelector('.tab.on >> text=ZCL_NUSA_FLIGHT_SERVICE');
  const h = await cm();
  const orig = await page.evaluate(c => c.getValue(), h);
  await page.evaluate(c => { c.setValue(c.getValue().split('\n').map(l => l.trimStart()).join('\n')); c.focus(); }, h);
  await page.keyboard.press('Shift+Alt+F');
  await page.waitForSelector('.toast >> text=Formatted');
  const v = await page.evaluate(c => c.getValue(), h);
  if (!/\n  PUBLIC SECTION\.\n/.test(v) || !/\n    METHODS get_flights\n/.test(v)) throw new Error('not indented:\n' + v.slice(0, 600));
  if (v.replace(/\s+/g, '') !== orig.replace(/\s+/g, '')) throw new Error('tokens changed');
  await page.evaluate((c) => { c.setValue(c.getValue()); }, h);
  await page.evaluate((c) => { while (c.historySize().undo) c.undo(); }, h);
});

await step('form objects: IAM app opens as a form, edit, add a row, XML view, save', async () => {
  await explorer();
  await page.click('.row >> text=ZNUSA_FLIGHT_IAM');
  await page.waitForSelector('.row >> text=Identity and Access Management');
  for (const f of ['Authorizations', 'Cloud Communication Management', 'Business Configuration Management']) await page.waitForSelector(`.row >> text=${f}`);
  await page.dblclick('.row.leaf >> text=ZNUSA_FLIGHT_APP');
  await page.waitForSelector('.of-head .of-kicker >> text=IAM App');
  for (const t of ['General Information', 'Services', 'Authorizations']) await page.waitForSelector(`.of-card h2 >> text="${t}"`);
  // the system's plugin settings decide: app type locked, transaction code hidden
  await page.waitForSelector('.of-row.ro:has(.of-label:text-is("App type")) >> text=Business configuration (MBC)');
  if (await page.$('.of-label:text-is("Transaction code")')) throw new Error('transaction code should be hidden');
  await page.waitForSelector('.of-table >> text=ZUI_NUSA_FLIGHT_O4');
  await page.waitForSelector('.of-auth-h >> text=S_TABU_NAM');
  await shot('13-iam-form');
  await page.fill('[aria-label="TABLE value 1"]', 'ZNUSA_TRAVEL_D');
  await page.waitForSelector('.tab.on .tclose.dirty');
  await page.click('[aria-label="Add a value for ACTVT"]');
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label^="ACTVT value"]').length === 4);
  await page.selectOption('[aria-label="ACTVT value 4"]', '06');
  await page.click('[data-act="xml-mode"][data-id="xml"]');
  const xml = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  if (!/<commonAuthorization:lowValue>ZNUSA_TRAVEL_D</.test(xml) || !/<commonAuthorization:lowValue>06</.test(xml)) throw new Error('xml not updated');
  await page.click('[data-act="xml-mode"][data-id="form"]');
  await saveNow('ZNUSA_FLIGHT_APP');
  if (await page.$('.toast.t-error')) throw new Error(await page.textContent('.toast.t-error'));
});

await step('new communication scenario from the New Object dialog', async () => {
  await page.click('[data-cmd="new"]');
  await page.selectOption('#noType', 'SCO1');
  if (!(await page.isVisible('#noFormNote'))) throw new Error('note');
  await page.fill('#noName', 'ZNUSA_PARTNER_CS');
  await page.fill('#noPkg', 'ZNUSA_FLIGHT_IAM');
  await page.fill('#noDesc', 'Nusa: partner access');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal >> text=Select transport request').then(() => page.click('.modal button[type=submit]')).catch(() => {});
  await page.waitForSelector('.tab.on >> text=ZNUSA_PARTNER_CS');
  await page.waitForSelector('.of-head .of-kicker >> text=Communication Scenario');
});

await step('collapse all, then favorites and packages open again', async () => {
  await explorer();
  await page.click('[data-act="collapse-all"]');
  await page.click('.row >> text=Favorite Packages');
  await page.click('.row[data-pkg="ZNUSA_FLIGHT"]');
  await page.waitForSelector('.row.leaf >> text=ZR_NUSA_FLIGHTS', { state: 'visible' });
  await page.click('.row[data-pkg="ZNUSA_FLIGHT_IAM"]');
  await page.waitForSelector('.row.leaf >> text=ZNUSA_FLT', { state: 'visible' });
});

await step('form screens: data element, authorization object, light theme', async () => {
  await page.dblclick('.row.leaf >> text=ZNUSA_FLT');
  await page.waitForSelector('.of-head .of-kicker >> text=Authorization Object');
  await shot('14-suso');
  await page.click('.row[data-pkg="ZNUSA_FLIGHT"]');
  await page.click('.row[data-pkg="ZNUSA_FLIGHT"]');
  await page.dblclick('.row.leaf >> text=ZNUSA_CARRIER_ID');
  await page.waitForSelector('.of-head .of-kicker >> text=Data Element');
  await shot('15-dtel');
  await page.keyboard.press('Control+Alt+D');
  await page.waitForTimeout(200);
  await shot('16-dtel-light');
  await page.keyboard.press('Control+Alt+D');
  await page.keyboard.press('Control+Shift+A');
  await page.keyboard.type('ZUI_NUSA_FLIGHT_O4', { delay: 5 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.of-head .of-kicker >> text=Service Binding');
  await page.waitForTimeout(200);
  await shot('17-binding');
});

await step('data element like Eclipse: category, built-in type rules, value help, field labels', async () => {
  await page.keyboard.press('Control+Shift+A');
  await page.keyboard.type('ZNUSA_CARRIER_ID', { delay: 5 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.of-head .of-kicker >> text=Data Element');
  for (const t of ['Data Type', 'Field Labels', 'Additional Properties']) await page.waitForSelector(`.of-card h2 >> text="${t}"`);
  await page.waitForSelector('.of-row:has(.of-label:text-is("Domain")) input[value="/DMO/CARRIER_ID"]');
  if (!(await page.$('.of-row.ro:has(.of-label:text-is("Data type"))'))) throw new Error('data type should be read-only for a domain');
  await shot('18-dtel-domain');
  // switch to a predefined type: data type becomes a choice, DATS fixes the length
  await page.click('.of-radio:has-text("Predefined type")');
  await page.waitForSelector('.of-row:not(.ro):has(.of-label:text-is("Data type")) select');
  await page.selectOption('.of-row:has(.of-label:text-is("Data type")) select', 'DATS');
  await page.waitForSelector('.of-row.ro:has(.of-label:text-is("Length")) >> text="8"');
  const xml1 = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  if (!/<dtel:typeKind>predefinedAbapType</.test(xml1) || !/<dtel:dataTypeLength>000008</.test(xml1) || !/<dtel:typeName\/>|<dtel:typeName><\/dtel:typeName>/.test(xml1)) throw new Error('xml ' + xml1.slice(0, 900));
  // value help for the search help
  await page.click('.of-row:has(.of-label:text-is("Search help")) [data-act="of-vh"]');
  await page.waitForSelector('.vh-pop .vh-list li[data-i]');
  await page.keyboard.type('H_T', { delay: 10 });
  await page.waitForSelector('.vh-pop li >> text=H_T005');
  await shot('19-value-help');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-at="searchHelp"]')?.value === 'H_T005');
  if (!/<dtel:searchHelp>H_T005</.test(await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue()))) throw new Error('search help not in xml');
  // field label counter follows the length
  const short = page.locator('[data-label-of="short"]');
  await short.fill('Airline code');
  if (await short.inputValue() !== 'Airline co') throw new Error('maxlength ' + await short.inputValue());
  await page.waitForSelector('.of-counter >> text="10 / 10"');
  await shot('20-dtel-edited');
});

await step('domain like Eclipse: format, output, fixed values', async () => {
  await page.keyboard.press('Control+Shift+A');
  await page.keyboard.type('ZNUSA_STATUS', { delay: 5 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.of-head .of-kicker >> text=Domain');
  for (const t of ['Format', 'Output Characteristics', 'Value Range']) await page.waitForSelector(`.of-card h2 >> text="${t}"`);
  const before = (await page.$$('#of-sec-2 tbody tr')).length;
  await page.click('[data-act="xf-add-row"]');
  await page.waitForFunction(n => document.querySelectorAll('#of-sec-2 tbody tr').length === n + 1, before);
  const xml = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  if (!/<doma:position>0004<\/doma:position>/.test(xml)) throw new Error('position not numbered');
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.waitForTimeout(200);
  await shot('21-doma-wide');
  await page.setViewportSize({ width: 1440, height: 880 });
});

await step('open subpackages load after a restart instead of staying on "Loading"', async () => {
  await page.reload();
  await page.waitForSelector('.tab.on');
  await explorer();
  await page.waitForFunction(() => ![...document.querySelectorAll('#sideBody .empty')].some(e => /Loading/.test(e.textContent)), null, { timeout: 8000 });
});

await step('quick fix (Ctrl+1), rename (Alt+Shift+R) and extract method (Alt+Shift+M) like Eclipse', async () => {
  await page.click('.tab >> text=ZCL_NUSA_FLIGHT_SERVICE');
  await page.waitForSelector('.tab.on >> text=ZCL_NUSA_FLIGHT_SERVICE');
  const lineOf = re => page.evaluate(r => document.querySelector('.CodeMirror').CodeMirror.getValue().split('\n').findIndex(x => new RegExp(r).test(x)), re);
  const sel = await lineOf('INTO TABLE @rt_flights');
  await page.evaluate(l => { const c = document.querySelector('.CodeMirror').CodeMirror; c.replaceRange('    lv_count = lines( rt_flights ).\n    lv_count = lv_count + 1.\n', { line: l + 1, ch: 0 }); c.setCursor({ line: l + 1, ch: 6 }); c.focus(); }, sel);
  await page.keyboard.press('Control+1');
  await page.waitForSelector('#ctx >> text=Declare local variable lv_count');
  await shot('31-quickfix');
  await page.click('#ctx >> text=Declare local variable lv_count');
  await page.waitForFunction(() => /DATA lv_count TYPE string\.\n    lv_count = lines/.test(document.querySelector('.CodeMirror').CodeMirror.getValue()));
  // rename saves first, then shows every change before the system makes it
  const use = await lineOf('lv_count = lv_count');
  await page.evaluate(l => { const c = document.querySelector('.CodeMirror').CodeMirror; c.setCursor({ line: l, ch: 7 }); c.focus(); }, use);
  await page.keyboard.press('Alt+Shift+R');
  const tr = page.waitForSelector('.modal >> text=Select transport request', { timeout: 3000 }).then(() => page.click('.modal button[type=submit]')).catch(() => {});
  await page.waitForSelector('#rnIn');
  await tr;
  await page.fill('#rnIn', 'lv_rows');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.rf-edit');
  const changes = (await page.$$('.rf-edit')).length;
  if (changes !== 3) throw new Error(`expected 3 changed lines, got ${changes}`);
  if (!(await page.textContent('.rf-prev')).includes('lv_rows = lv_rows + 1')) throw new Error('two changes on one line not merged');
  await shot('32-rename-preview');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.toast >> text=Activate to finish');
  const after = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  if (/lv_count/.test(after) || !/lv_rows = lv_rows \+ 1/.test(after)) throw new Error('rename not applied in the editor');
  if (await page.$('.tab.on.dirty, .tab.on .dot')) throw new Error('editor should be clean after the refactoring');
  // extract the three statements into a private method
  const a = await lineOf('DATA lv_rows'), b = await lineOf('lv_rows = lv_rows');
  await page.evaluate(([x, y]) => { const c = document.querySelector('.CodeMirror').CodeMirror; c.setSelection({ line: x, ch: 0 }, { line: y + 1, ch: 0 }); c.focus(); }, [a, b]);
  await page.keyboard.press('Alt+Shift+M');
  await page.waitForSelector('#exName');
  await page.fill('#exName', 'count_rows');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.rf-edit');
  await page.click('.modal .btn.primary');
  await page.waitForSelector('.toast >> text=Extract method count_rows');
  const ex = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  if (!/PRIVATE SECTION\.\n    METHODS count_rows\./.test(ex) || !/    count_rows\( \)\.\n  ENDMETHOD\./.test(ex) || !/  METHOD count_rows\.\n    DATA lv_rows TYPE string\./.test(ex)) throw new Error(ex.slice(0, 1600));
});

await step('transport requests: change the description and delete one', async () => {
  await page.click('[data-view="transports"]');
  await page.fill('#newTrDesc', 'Temporary request');
  await page.click('#newTr button[type=submit]');
  await page.waitForSelector('.tr >> text=Temporary request');
  const id = await page.$eval('.tr:has-text("Temporary request") code', e => e.textContent);
  await page.click(`.tr:has-text("${id}") [data-act="tr-edit"]`);
  await page.fill('#trDescIn', 'Renamed request');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector(`.tr:has-text("${id}") >> text=Renamed request`);
  await shot('33-transport-actions');
  await page.click(`.tr:has-text("${id}") [data-act="tr-delete"]`);
  await page.click('.modal .btn.danger');
  await page.waitForFunction(i => ![...document.querySelectorAll('.tr code')].some(c => c.textContent === i), id);
  // move one object to a new request, then take it out of that request
  const src = await page.$eval('.tr:has(.tr-name:text-is("ZI_NUSA_FLIGHT"))', el => el.querySelector('code').textContent);
  await page.check(`.tr:has-text("${src}") .tr-pick[data-entry="R3TR DDLS ZI_NUSA_FLIGHT"]`);
  await page.waitForSelector(`.tr:has-text("${src}") >> text=1 selected`);
  await page.click(`.tr:has-text("${src}") [data-act="tr-move"]`);
  await page.click('.modal input[value="__new"]');
  await page.fill('#mvNewDesc', 'Moved here');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.toast >> text=Moved 1 object');
  const dst = await page.$eval('.tr:has-text("Moved here") code', e => e.textContent);
  await page.waitForSelector(`.tr:has-text("${dst}") .tr-name:text-is("ZI_NUSA_FLIGHT")`);
  if (await page.$(`.tr:has-text("${src}") .tr-name:text-is("ZI_NUSA_FLIGHT")`)) throw new Error('still in the source request');
  await page.check(`.tr:has-text("${dst}") .tr-pick`);
  await shot('35-transport-pick');
  await page.click(`.tr:has-text("${dst}") [data-act="tr-remove"]`);
  await page.click('.modal .btn.danger');
  await page.waitForSelector(`.tr:has-text("${dst}") >> text=No objects recorded`);
});

await step('debugger: grouped variables, other stack frame, change a value', async () => {
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.waitForSelector('.tab.on >> text=ZR_NUSA_FLIGHTS');
  // earlier steps changed the report; the sample run follows the active version
  if (await page.$('#crumbs .p-warn')) { await page.keyboard.press('Control+F3'); await page.waitForSelector('.toast >> text=Activated ZR_NUSA_FLIGHTS'); }
  const l = await page.evaluate(() => { const c = document.querySelector('.CodeMirror').CodeMirror; const n = c.getValue().split('\n').findIndex(x => /->calc_load_factor/i.test(x)); c.setCursor({ line: n, ch: 4 }); c.focus(); return n; });
  await page.keyboard.press('Control+Shift+B');
  await page.keyboard.press('F8');
  await page.waitForSelector('#debugbar:not([hidden])');
  await page.waitForSelector('.vars .vg >> text=Locals');
  await page.keyboard.press('F5');
  await page.waitForSelector('.stack >> text=CALC_LOAD_FACTOR');
  await page.waitForSelector('.vars >> text=IV_SEATS_MAX');
  await page.click('[data-act="dbg-frame"][data-i="1"]');
  await page.waitForSelector('.vars >> text=LT_FLIGHTS');
  await page.waitForSelector('.tab.on >> text=ZR_NUSA_FLIGHTS');
  await page.click('[data-act="dbg-frame"][data-i="0"]');
  await page.waitForSelector('.vars >> text=IV_SEATS_MAX');
  await page.dblclick('.vars li.leafvar:has(.vn:text-is("RV_PERCENT")) .vv');
  await page.fill('#dvIn', '42');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.vars li.leafvar:has(.vn:text-is("RV_PERCENT")) .vv:text-is("42")');
  await shot('34-debugger');
  await page.keyboard.press('Shift+F5');
  await page.waitForSelector('#debugbar', { state: 'hidden' });
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.evaluate(n => { const c = document.querySelector('.CodeMirror').CodeMirror; c.setCursor({ line: n, ch: 4 }); c.focus(); }, l);
  await page.keyboard.press('Control+Shift+B');
});

await step('phone width has no horizontal overflow', async () => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(200);
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (w[0] > w[1]) throw new Error(String(w));
});

for (const r of results) console.log(r.join('  '));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exitCode = results.some(r => r[0] === 'FAIL') || errors.length ? 1 : 0;
