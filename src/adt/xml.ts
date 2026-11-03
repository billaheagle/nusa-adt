// Small, dependency-free XML reader/writer for ADT payloads.
// Handles prolog, comments, CDATA, namespaces (kept as prefixes) and entities.

export interface XEl { name: string; local: string; attrs: Record<string, string>; children: XEl[]; text: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}
export function encode(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const localOf = (n: string) => n.slice(n.indexOf(':') + 1);

export function parseXml(src: string): XEl {
  let i = 0;
  const root: XEl = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack: XEl[] = [root];
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += decode(src.slice(i)); break; }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); top.text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e).trim();
      while (stack.length > 1) { const el = stack.pop() as XEl; if (el.name === name) break; }
      i = e + 1; continue;
    }
    // start tag: scan to the closing '>' outside quotes
    let j = lt + 1, q = '';
    while (j < n) { const c = src[j]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j++; }
    let body = src.slice(lt + 1, j);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const m = body.match(/^([^\s/>]+)/);
    const name = m ? m[1] : '';
    const el: XEl = { name, local: localOf(name), attrs: {}, children: [], text: '' };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(name.length);
    while ((a = re.exec(rest))) el.attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
    top.children.push(el);
    if (!selfClose) stack.push(el);
    i = j + 1;
  }
  return root;
}

/** Attribute by local name, ignoring the namespace prefix. */
export function attr(el: XEl | undefined, local: string): string | undefined {
  if (!el) return undefined;
  if (local in el.attrs) return el.attrs[local];
  for (const k of Object.keys(el.attrs)) if (localOf(k) === local) return el.attrs[k];
  return undefined;
}
export function kids(el: XEl | undefined, local: string): XEl[] { return el ? el.children.filter(c => c.local === local) : []; }
export function kid(el: XEl | undefined, local: string): XEl | undefined { return el?.children.find(c => c.local === local); }
/** Depth-first search for all descendants with a local name. */
export function all(el: XEl | undefined, local: string, out: XEl[] = []): XEl[] {
  if (!el) return out;
  for (const c of el.children) { if (c.local === local) out.push(c); all(c, local, out); }
  return out;
}
export function first(el: XEl | undefined, local: string): XEl | undefined { return all(el, local)[0]; }
export function textOf(el: XEl | undefined, local?: string): string {
  const t = local ? first(el, local) : el;
  return (t?.text ?? '').trim();
}

/** asx:abap payloads: <asx:abap><asx:values><DATA>…</DATA></asx:values></asx:abap>. */
export function asxValues(payload: Record<string, string>, root = 'DATA'): string {
  const inner = Object.entries(payload).map(([k, v]) => v === '' ? `<${k}/>` : `<${k}>${encode(v)}</${k}>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><${root}>${inner}</${root}></asx:values></asx:abap>`;
}

/** Parse "…#start=12,4" (1-based line) into 0-based line/col. */
export function parseStart(uri: string): { path: string; line: number; col: number } {
  const [path, frag = ''] = uri.split('#');
  const m = frag.match(/start=(\d+)(?:,(\d+))?/);
  return { path, line: m ? Math.max(0, +m[1] - 1) : 0, col: m && m[2] ? +m[2] : 0 };
}

export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
