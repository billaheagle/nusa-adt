// Renders the kawung mark to the PNG/ICO/ICNS files Tauri bundles.
let sharp;
try { sharp = (await import('sharp')).default; } catch { sharp = (await import('/opt/npm-tools/node_modules/sharp/dist/index.cjs')).default; }
import { writeFileSync, mkdirSync } from 'node:fs';

const svg = (size) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <rect x="0.6" y="0.6" width="22.8" height="22.8" rx="5.2" fill="#161922"/>
  <g fill="#e2a94f" transform="translate(12 12) scale(0.72) translate(-12 -12)">
    <ellipse cx="12" cy="6.2" rx="3.3" ry="5"/><ellipse cx="12" cy="17.8" rx="3.3" ry="5"/>
    <ellipse cx="6.2" cy="12" rx="5" ry="3.3"/><ellipse cx="17.8" cy="12" rx="5" ry="3.3"/>
  </g>
  <circle cx="12" cy="12" r="1.1" fill="#161922"/>
</svg>`);
const png = (s) => sharp(svg(s)).png().toBuffer();
const dir = 'src-tauri/icons';
mkdirSync(dir, { recursive: true });
const [p32, p128, p256, p512, p1024] = await Promise.all([32, 128, 256, 512, 1024].map(png));
writeFileSync(`${dir}/32x32.png`, p32);
writeFileSync(`${dir}/128x128.png`, p128);
writeFileSync(`${dir}/128x128@2x.png`, p256);
writeFileSync(`${dir}/app-icon.png`, p1024);
// ICO with PNG-compressed 32 and 256 images
const ico = (imgs) => {
  const head = Buffer.alloc(6 + 16 * imgs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let off = head.length;
  imgs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...imgs.map(i => i[1])]);
};
writeFileSync(`${dir}/icon.ico`, ico([[32, p32], [256, p256]]));
// ICNS with PNG payloads: ic08 = 256, ic09 = 512, ic10 = 1024
const entries = [['ic08', p256], ['ic09', p512], ['ic10', p1024]].map(([t, b]) => {
  const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(b.length + 8, 4); return Buffer.concat([h, b]);
});
const body = Buffer.concat(entries);
const icnsHead = Buffer.alloc(8); icnsHead.write('icns', 0, 'ascii'); icnsHead.writeUInt32BE(body.length + 8, 4);
writeFileSync(`${dir}/icon.icns`, Buffer.concat([icnsHead, body]));
writeFileSync(`${dir}/icon.png`, p512);
console.log('icons written');
