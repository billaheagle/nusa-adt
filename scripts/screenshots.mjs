// Renders README screenshots of the prototype (dark and light).
let pw;
try { pw = await import('playwright'); } catch { pw = await import('/opt/npm-tools/node_modules/playwright/index.mjs'); }
const { chromium } = pw.default ?? pw;
import { readFileSync, mkdirSync } from 'node:fs';
const fake = readFileSync('test/shot-codemirror.js', 'utf8');
const html = readFileSync('dist/nusa-adt-prototype.html', 'utf8');
mkdirSync('docs', { recursive: true });
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: theme });
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.addInitScript((t) => { try { localStorage.setItem('nusa-adt-theme', t); } catch {} }, theme);
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('codemirror.min.js')) return r.fulfill({ body: fake, contentType: 'text/javascript' });
    if (u.includes('cdnjs')) return r.fulfill({ body: '', contentType: 'text/javascript' });
    if (u.startsWith('http://app.test')) return r.fulfill({ body: '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', contentType: 'text/html' });
    return r.abort();
  });
  await page.goto('http://app.test/');
  await page.waitForSelector('.tab.on');
  await page.click('.tab >> text=ZR_NUSA_FLIGHTS');
  await page.waitForTimeout(200);
  if (theme === 'dark') {
    await page.evaluate(() => {
      const cm = window.__cm;
      const lines = cm.getValue().split('\n');
      const l = lines.findIndex(x => /^\s*WRITE/.test(x));
      lines.splice(l, 0, '    lo_service->');
      cm.setValueForShot(lines.join('\n'));
      cm.setCursor({ line: l, ch: 16 });
    });
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('.CodeMirror-hints');
    await page.waitForTimeout(200);
  } else {
    await page.click('[data-view="transports"]');
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `docs/screenshot-${theme}.png` });
  await page.close();
}
await browser.close();
console.log('screenshots written');
