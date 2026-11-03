// Headless smoke test of the bundled prototype: boots, opens objects, saves with a transport, activates, runs tests, debugs.
let pw;
try { pw = await import('playwright'); } catch { pw = await import('/opt/npm-tools/node_modules/playwright/index.mjs'); }
const { chromium } = pw.default ?? pw;
import { readFileSync } from 'node:fs';
const fake = readFileSync('test/fake-codemirror.js', 'utf8');
const html = readFileSync('dist/nusa-adt-prototype.html', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.route('**/*', r => {
  const u = r.request().url();
  if (u.includes('codemirror.min.js')) return r.fulfill({ body: fake, contentType: 'text/javascript' });
  if (u.includes('cdnjs')) return r.fulfill({ body: '', contentType: 'text/javascript' });
  if (u.startsWith('http://app.test')) return r.fulfill({ body: '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', contentType: 'text/html' });
  return r.abort();
});
await page.goto('http://app.test/');
await page.waitForSelector('.tab.on');
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); } };
await step('opens class and program tabs', async () => {
  const tabs = await page.$$eval('.tab .tname', els => els.map(e => e.textContent));
  if (tabs.join() !== 'ZR_NUSA_FLIGHTS,ZCL_NUSA_FLIGHT_SERVICE') throw new Error(tabs.join());
});
await step('ATC findings shown at start', async () => { await page.waitForSelector('#panelBody .prio'); });
await page.screenshot({ path: 'dist/shot-start.png' });
await step('edit + save asks for transport? (already recorded) and marks inactive', async () => {
  await page.click('.fake-cm');
  await page.evaluate(() => { const ta = document.querySelector('.fake-cm'); ta.value = ta.value.replace('    rv_percent = round(', '    IF iv_seats_max = 0.\n      RETURN.\n    ENDIF.\n    rv_percent = round('); ta.dispatchEvent(new Event('input')); });
  await page.waitForSelector('.tclose.dirty');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.tab.on.inactive');
});
await step('activate', async () => { await page.keyboard.press('Control+F3'); await page.waitForSelector('.toast.t-ok >> text=Activated'); });
await step('unit tests pass after fix', async () => { await page.keyboard.press('Control+Shift+F10'); await page.waitForSelector('.toast >> text=All 3 tests passed'); });
await step('switch to Test Classes include', async () => { await page.click('.subtabs button:nth-child(4)'); await page.waitForSelector('.subtabs button.on >> text=Test Classes'); });
await step('palette opens objects', async () => {
  await page.keyboard.press('Control+Shift+A'); await page.keyboard.type('ZI_'); await page.waitForSelector('#palList li.on >> text=ZI_NUSA_FLIGHT'); await page.keyboard.press('Enter');
  await page.waitForSelector('.tab.on >> text=ZI_NUSA_FLIGHT');
});
await step('new object with new transport', async () => {
  await page.keyboard.press('Control+Shift+P'); await page.keyboard.type('new abap'); await page.keyboard.press('Enter');
  await page.fill('#noName', 'ZCL_NUSA_SMOKE'); await page.fill('#noDesc', 'Smoke'); await page.click('.modal button[type=submit]');
  await page.waitForSelector('#trNewDesc'); await page.click('input[value="__new"]'); await page.fill('#trNewDesc', 'Smoke request'); await page.click('.modal button[type=submit]');
  await page.waitForSelector('.tab.on >> text=ZCL_NUSA_SMOKE');
});
await step('debugger stops at breakpoint, steps into the class and finishes', async () => {
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.evaluate(() => { const cm = window.__cm; const l = cm.getValue().split('\n').findIndex(x => /LOOP AT/.test(x)); cm.setCursor({ line: l, ch: 2 }); });
  await page.keyboard.press('Control+Shift+B');
  await page.keyboard.press('F8');
  await page.waitForSelector('#debugbar:not([hidden])');
  await page.waitForSelector('.vars >> text=LT_FLIGHTS');
  await page.keyboard.press('F6');
  await page.keyboard.press('F5');
  await page.waitForSelector('.stack >> text=CALC_LOAD_FACTOR');
  await page.waitForSelector('.tab.on >> text=ZCL_NUSA_FLIGHT_SERVICE');
  await page.screenshot({ path: 'dist/shot-debug.png' });
  await page.keyboard.press('F7');
  await page.waitForSelector('.tab.on >> text=ZR_NUSA_FLIGHTS');
  for (let i = 0; i < 5 && await page.$('#debugbar:not([hidden])'); i++) { await page.keyboard.press('F8'); await page.waitForTimeout(250); }
  await page.waitForSelector('#debugbar', { state: 'hidden' });
  const out = await page.textContent('pre.out');
  if (!/0880/.test(out)) throw new Error(out);
});
await step('syntax error appears in Problems', async () => {
  await page.evaluate(() => { const ta = document.querySelector('.fake-cm'); ta.value = ta.value.replace('  ENDLOOP.', ''); ta.dispatchEvent(new Event('input')); });
  await page.keyboard.press('Control+F2');
  await page.waitForSelector('#panelBody >> text=LOOP block is not closed');
});
await step('dark mode toggle and theme picker', async () => {
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (before !== 'dark') throw new Error('default should be dark, got ' + before);
  await page.click('#themeBtn');
  if (await page.evaluate(() => document.documentElement.getAttribute('data-theme')) !== 'light') throw new Error('toggle failed');
  await page.screenshot({ path: 'dist/shot-light.png' });
  await page.click('#themeStatus');
  await page.keyboard.type('dark'); await page.keyboard.press('Enter');
  if (await page.evaluate(() => document.documentElement.getAttribute('data-theme')) !== 'dark') throw new Error('picker failed');
});
await step('completion in context: method of a typed variable', async () => {
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.evaluate(() => {
    const cm = window.__cm; const ta = document.querySelector('.fake-cm');
    const lines = cm.getValue().split('\n'); const l = lines.findIndex(x => /^\s*WRITE/.test(x));
    lines.splice(l, 0, '    ls_flight-'); ta.value = lines.join('\n'); ta.dispatchEvent(new Event('input'));
    cm.setCursor({ line: l, ch: 14 });
  });
  await page.keyboard.press('Control+Space');
  await page.waitForFunction(() => (window.__hintList || []).includes('seats_occupied'));
  await page.evaluate(() => {
    const cm = window.__cm; const ta = document.querySelector('.fake-cm');
    const lines = cm.getValue().split('\n'); const l = lines.findIndex(x => /^    ls_flight-$/.test(x));
    lines[l] = '    lo_service->'; ta.value = lines.join('\n'); ta.dispatchEvent(new Event('input')); window.__hintList = [];
    cm.setCursor({ line: l, ch: 16 });
  });
  await page.keyboard.press('Control+Space');
  await page.waitForFunction(() => (window.__hintList || [])[0] === 'get_flights');
});
await step('mobile layout has no horizontal overflow', async () => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(200);
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (w[0] > w[1]) throw new Error(String(w));
  await page.screenshot({ path: 'dist/shot-mobile.png' });
});
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
