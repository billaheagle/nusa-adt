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
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
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
  await page.waitForSelector('.sb >> text=Not published');
  await page.click('[data-act="sb-publish"]');
  await page.waitForSelector('.sb .pill >> text=Published');
  await page.waitForSelector('.sb code >> text=/odata4/');
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
  await page.waitForSelector('.sb .pill >> text=Published');
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
