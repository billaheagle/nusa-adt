// Form editor for objects that ADT stores as XML documents (data elements, domains,
// authorization objects, IAM apps, communication scenarios, …). Types with a layout get
// Eclipse's sections, choices and value helps; other types are laid out from the XML itself.
// Every edit changes the XML text, so saving, drafts, history and compare work as for source.

import { ObjType } from '../core/types';
import { FieldDef, guessValueHelp, Layout, LAYOUTS, TableDef } from './layouts';

const ADT = 'http://www.sap.com/adt/core';
const HIDDEN_NS = new Set(['http://www.w3.org/2005/Atom']);
const HEADER_ATTRS: [string, string][] = [
  ['type', 'Type'], ['responsible', 'Responsible'], ['masterLanguage', 'Original language'], ['version', 'Version'],
  ['createdBy', 'Created by'], ['createdAt', 'Created'], ['changedBy', 'Changed by'], ['changedAt', 'Changed'],
];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function humanize(local: string): string {
  const words = local.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim().split(/\s+/);
  const fix: Record<string, string> = { id: 'ID', url: 'URL', uri: 'URI', odata: 'OData', http: 'HTTP', iam: 'IAM', api: 'API', x509: 'X.509', oauth: 'OAuth', abap: 'ABAP', cds: 'CDS' };
  return words.map((w, i) => fix[w.toLowerCase()] || (i ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error((err.textContent || 'The XML is not well-formed').split('\n').filter(Boolean).slice(0, 2).join(' '));
  return doc;
}
function serialize(doc: Document, original: string): string {
  const body = new XMLSerializer().serializeToString(doc);
  const decl = /^\s*<\?xml[^>]*\?>/.exec(original)?.[0];
  return decl && !body.startsWith('<?xml') ? `${decl.trim()}\n${body}` : body;
}
function elementAt(doc: Document, path: string): Element {
  let el: Element = doc.documentElement;
  for (const i of path.split('/').filter(Boolean)) el = el.children[+i];
  if (!el) throw new Error('The form is out of date. Switch to XML and back.');
  return el;
}
/** path forms: "1/0" element · "1/0@ns:attr" attribute · "1/0#" text */
function split(xpath: string): { path: string; attr?: string; text?: boolean } {
  const at = xpath.indexOf('@');
  if (at >= 0) return { path: xpath.slice(0, at), attr: xpath.slice(at + 1) };
  if (xpath.endsWith('#')) return { path: xpath.slice(0, -1), text: true };
  return { path: xpath };
}

export function setXmlValue(xml: string, xpath: string, value: string): string {
  const doc = parse(xml);
  const p = split(xpath);
  const el = elementAt(doc, p.path);
  if (p.attr) el.setAttribute(p.attr, value);
  else el.textContent = value;
  return serialize(doc, xml);
}

/** Adds a row after `rowPath`, copying its shape with empty values. */
export function addXmlRow(xml: string, rowPath: string): string {
  const doc = parse(xml);
  const row = elementAt(doc, rowPath);
  const copy = row.cloneNode(true) as Element;
  const clear = (e: Element) => {
    for (const a of Array.from(e.attributes)) if (!a.name.startsWith('xmlns')) e.setAttribute(a.name, '');
    if (!e.children.length) e.textContent = e.textContent ? '' : e.textContent;
    Array.from(e.children).forEach(clear);
  };
  clear(copy);
  const ws = row.previousSibling && row.previousSibling.nodeType === 3 && !row.previousSibling.textContent?.trim() ? row.previousSibling.cloneNode() : null;
  const next = row.nextSibling;
  if (ws) row.parentNode!.insertBefore(ws, next);
  row.parentNode!.insertBefore(copy, next);
  return serialize(doc, xml);
}

export function removeXmlRow(xml: string, rowPath: string): string {
  const doc = parse(xml);
  const row = elementAt(doc, rowPath);
  const prev = row.previousSibling;
  if (prev && prev.nodeType === 3 && !prev.textContent?.trim()) prev.parentNode!.removeChild(prev);
  row.parentNode!.removeChild(row);
  return serialize(doc, xml);
}

const attrs = (e: Element) => Array.from(e.attributes).filter(a => !a.name.startsWith('xmlns') && a.namespaceURI !== ADT);
const isTable = (e: Element) => {
  const k = Array.from(e.children);
  return k.length > 0 && k.every(c => c.nodeName === k[0].nodeName && c.children.length === 0);
};
const hidden = (e: Element) => HIDDEN_NS.has(e.namespaceURI || '') || (e.namespaceURI === ADT && e.localName === 'packageRef');
/** identifiers (ZUI_X_O4, /DMO/FLIGHT, 0001) read better in the code font */
const isCode = (v: string) => /^[A-Z0-9_/$*-]{2,}$/.test(v) && !/^(TRUE|FALSE)$/.test(v);
const width = (v: string): 'xs' | 'sm' | 'md' | 'lg' => v.length <= 6 ? 'sm' : v.length <= 30 ? 'md' : 'lg';

let uid = 0;
const LOCK = '<svg class="of-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.3-4.3"/></svg>';

// ------------------------------------------------------------------ finding values by element name
function descendant(root: Element, name: string): Element | null {
  for (const c of Array.from(root.children)) {
    if (c.localName === name) return c;
    const d = descendant(c, name);
    if (d) return d;
  }
  return null;
}
interface Hit { el: Element; attr?: Attr }
export function findAt(doc: Document, at: string): Hit | null {
  const [p, a] = at.split('@');
  const segs = p.split('/').filter(Boolean);
  let el: Element | null = doc.documentElement;
  if (segs.length) {
    el = descendant(doc.documentElement, segs[0]);
    for (const sg of segs.slice(1)) el = el ? Array.from(el.children).find(c => c.localName === sg) || null : null;
  }
  if (!el) return null;
  if (a) { const attr = Array.from(el.attributes).find(x => x.localName === a); return attr ? { el, attr } : null; }
  return { el };
}
function indexPath(el: Element): string {
  const parts: number[] = [];
  let e = el;
  while (e.parentElement) { parts.unshift(Array.from(e.parentElement.children).indexOf(e)); e = e.parentElement; }
  return parts.join('/');
}
const xpathOf = (h: Hit) => h.attr ? `${indexPath(h.el)}@${h.attr.name}` : `${indexPath(h.el)}#`;
const valueOf = (h: Hit | null) => !h ? '' : h.attr ? h.attr.value : h.el.children.length ? '' : (h.el.textContent || '').trim();
/** "000010" shows as "10" and is written back with the same width */
const shown = (v: string, number: boolean) => number && /^0+\d/.test(v) ? String(+v) : v;
const pad = (v: string) => /^0\d+$/.test(v) ? ` data-pad="${v.length}"` : '';

/** Applies a layout's follow-up changes (fixed lengths, clearing fields) after an edit. */
export function layoutEffects(type: ObjType, xml: string, at: string, value: string): { xml: string; rerender: boolean } {
  const lay = LAYOUTS[type];
  if (!lay?.effects) return { xml, rerender: false };
  const doc = parse(xml);
  const get = (a: string) => valueOf(findAt(doc, a));
  const set = (a: string, v: string) => {
    const h = findAt(doc, a);
    if (!h) return;
    const old = valueOf(h);
    const val = /^0\d+$/.test(old) && /^\d+$/.test(v) ? v.padStart(old.length, '0') : v;
    if (h.attr) h.el.setAttribute(h.attr.name, val); else h.el.textContent = val;
  };
  const rerender = lay.effects(at, value, set, get);
  return { xml: serialize(doc, xml), rerender };
}

/** Adds a row to a layout table: copies the last row, or builds one when the table is empty. */
export function addLayoutRow(xml: string, containerAt: string, row: string, cols: string[], numberAt?: string): string {
  const doc = parse(xml);
  const h = findAt(doc, containerAt);
  if (!h) throw new Error('This object has no place for new rows. Add them in the XML view.');
  const c = h.el;
  const rows = Array.from(c.children).filter(k => k.localName === row);
  const prefix = c.prefix ? c.prefix + ':' : '';
  let n: Element;
  if (rows.length) {
    n = rows[rows.length - 1].cloneNode(true) as Element;
    Array.from(n.children).forEach(k => { k.textContent = ''; });
    for (const a of Array.from(n.attributes)) if (!a.name.startsWith('xmlns')) n.setAttribute(a.name, '');
  } else {
    n = doc.createElementNS(c.namespaceURI, prefix + row);
    for (const col of [...(numberAt ? [numberAt] : []), ...cols]) n.appendChild(doc.createElementNS(c.namespaceURI, prefix + col));
  }
  if (numberAt) { const k = Array.from(n.children).find(x => x.localName === numberAt); if (k) k.textContent = String(rows.length + 1).padStart(4, '0'); }
  c.appendChild(n);
  return serialize(doc, xml);
}

// ------------------------------------------------------------------ controls
interface Ctl { xpath: string; value: string; label: string; ro: boolean; kind?: FieldDef['kind']; options?: [string, string][]; vh?: string; help?: string; w?: 'xs' | 'sm' | 'md' | 'lg'; at?: string; rerender?: boolean; note?: string; tech?: string; padded?: boolean }

function control(c: Ctl, id: string): string {
  const data = `data-xpath="${esc(c.xpath)}"${c.at ? ` data-at="${esc(c.at)}"` : ''}${c.rerender ? ' data-rr="1"' : ''}`;
  const v = shown(c.value, c.kind === 'number');
  if (c.ro) {
    let txt = v;
    if (c.kind === 'bool' || v === 'true' || v === 'false') return `<div class="of-value">${v === 'true' ? '<span class="of-yes">Yes</span>' : '<span class="of-no">No</span>'}</div>`;
    if (c.options) txt = c.options.find(o => o[0] === v)?.[1] || v;
    return `<div class="of-value ${isCode(v) ? 'mono' : ''}">${txt ? esc(txt) : '<span class="of-empty">Not set</span>'}</div>`;
  }
  if (c.kind === 'bool' || (!c.kind && (v === 'true' || v === 'false'))) {
    return `<label class="of-switch"><input id="${id}" type="checkbox" role="switch" ${data} ${v === 'true' ? 'checked' : ''}><i aria-hidden="true"></i><span>${v === 'true' ? 'On' : 'Off'}</span></label>`;
  }
  if (c.kind === 'radio' && c.options) {
    return `<div class="of-radios" role="radiogroup" aria-labelledby="${id}-l">${c.options.map(([val, l]) =>
      `<label class="of-radio ${val === v ? 'on' : ''}"><input type="radio" name="${id}" value="${esc(val)}" ${data} ${val === v ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>`;
  }
  if (c.kind === 'select' && c.options) {
    const opts = c.options.some(o => o[0] === v) || !v ? c.options : [[v, v] as [string, string], ...c.options];
    return `<select id="${id}" class="of-input w-${c.w || 'md'}" ${data}>${v ? '' : '<option value="" selected>Choose…</option>'}${opts.map(([val, l]) => `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  const wide = v.length > 80;
  const cls = `of-input w-${wide ? 'lg' : c.w || width(v)} ${c.kind === 'number' || isCode(v) || (!v && c.vh) ? 'mono' : ''}`;
  const input = wide
    ? `<textarea id="${id}" class="${cls}" ${data} rows="3" spellcheck="false">${esc(v)}</textarea>`
    : `<input id="${id}" class="${cls}" ${data}${c.padded ? pad(c.value) : ''} value="${esc(v)}" spellcheck="false" autocomplete="off"${c.kind === 'number' ? ' inputmode="numeric"' : ''}${c.vh ? ` data-vh="${esc(c.vh)}" aria-haspopup="listbox"` : ''}>`;
  if (!c.vh) return input;
  return `<div class="of-vh w-${c.w || 'md'}">${input}<button type="button" class="of-vh-btn" data-act="of-vh" data-for="${id}" title="Value help (Ctrl+Space)" aria-label="Value help for ${esc(c.label)}">${SEARCH}</button></div>`;
}

function row(c: Ctl): string {
  const id = `of-f-${++uid}`;
  const forAttr = c.kind === 'radio' || c.ro ? '' : ` for="${id}"`;
  return `<div class="of-row ${c.ro ? 'ro' : ''}">
    <div class="of-rl"><label class="of-label" id="${id}-l"${forAttr} title="${esc(c.tech || '')}">${esc(c.label)}${c.ro && c.kind !== 'radio' ? LOCK : ''}</label>${c.help ? `<span class="of-help" tabindex="0" role="note" title="${esc(c.help)}" aria-label="${esc(c.help)}">?</span>` : ''}</div>
    <div class="of-rc">${control(c, id)}${c.note ? `<div class="of-note">${esc(c.note)}</div>` : ''}</div>
  </div>`;
}

// ------------------------------------------------------------------ generic layout (types without a layout)
function genericRows(e: Element, path: string, ro: boolean): string {
  return attrs(e).map(a => row({ xpath: `${path}@${a.name}`, value: a.value, ro, label: humanize(a.localName), tech: a.name, vh: guessValueHelp(a.localName) })).join('');
}

function genericTable(e: Element, path: string, ro: boolean): string {
  const kids = Array.from(e.children);
  const cols: string[] = [];
  kids.forEach(k => attrs(k).forEach(a => { if (!cols.includes(a.name)) cols.push(a.name); }));
  const hasText = kids.some(k => (k.textContent || '').trim());
  const col = (c: string) => humanize(c.split(':').pop() as string);
  const head = cols.map(c => `<th scope="col" title="${esc(c)}">${esc(col(c))}</th>`).join('') + (hasText ? '<th scope="col">Value</th>' : '');
  const rows = kids.map((k, i) => {
    const rp = `${path}/${i}`.replace(/^\//, '');
    const cells = cols.map(c => cell(`${rp}@${c}`, k.getAttribute(c), ro, col(c), guessValueHelp(c.split(':').pop() as string))).join('')
      + (hasText ? cell(`${rp}#`, (k.textContent || '').trim(), ro, 'Value') : '');
    return `<tr>${cells}${ro ? '' : delBtn(rp, i)}</tr>`;
  }).join('');
  const last = `${path}/${kids.length - 1}`.replace(/^\//, '');
  return `<div class="of-table"><table><thead><tr>${head}${ro ? '' : '<th class="of-row-act"><span class="sr">Actions</span></th>'}</tr></thead><tbody>${rows}</tbody></table></div>
    ${ro ? '' : `<button type="button" class="of-add" data-act="xf-add" data-xpath="${esc(last)}">${PLUS}Add ${esc(humanize(kids[0].localName).toLowerCase())}</button>`}`;
}
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const delBtn = (rp: string, i: number) => `<td class="of-row-act"><button type="button" class="of-del" data-act="xf-del" data-xpath="${esc(rp)}" title="Remove this row" aria-label="Remove row ${i + 1}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>`;
function cell(xpath: string, v: string | null, ro: boolean, label: string, vh?: string, w?: string): string {
  if (v === null) return '<td><span class="of-empty">–</span></td>';
  if (v === 'true' || v === 'false') {
    return `<td class="of-c-bool">${ro ? (v === 'true' ? '<span class="of-yes">Yes</span>' : '<span class="of-no">No</span>')
      : `<label class="of-switch sm"><input type="checkbox" role="switch" data-xpath="${esc(xpath)}" ${v === 'true' ? 'checked' : ''} aria-label="${esc(label)}"><i aria-hidden="true"></i></label>`}</td>`;
  }
  if (ro) return `<td><span class="${isCode(v) ? 'mono' : ''}">${v ? esc(v) : '<span class="of-empty">–</span>'}</span></td>`;
  const id = `of-c-${++uid}`;
  const input = `<input id="${id}" class="of-cell ${isCode(v) || !v ? 'mono' : ''}" data-xpath="${esc(xpath)}" value="${esc(v)}" spellcheck="false" autocomplete="off" aria-label="${esc(label)}"${vh ? ` data-vh="${esc(vh)}"` : ''}>`;
  return `<td class="${w ? 'w-' + w : ''}">${vh ? `<div class="of-vh">${input}<button type="button" class="of-vh-btn" data-act="of-vh" data-for="${id}" title="Value help (Ctrl+Space)" aria-label="Value help for ${esc(label)}">${SEARCH}</button></div>` : input}</td>`;
}

function genericContent(e: Element, path: string, ro: boolean, level: number): string {
  const kids = Array.from(e.children).filter(k => !hidden(k));
  const text = (e.textContent || '').trim();
  let out = '';
  const own = genericRows(e, path, ro);
  if (isTable(e)) return (own ? `<div class="of-rows">${own}</div>` : '') + genericTable(e, path, ro);
  const simple = kids.filter(k => !k.children.length && !attrs(k).length);
  const rows = own + (!kids.length && !attrs(e).length && text ? row({ xpath: `${path}#`, value: text, ro, label: 'Value' }) : '')
    + simple.map(k => row({ xpath: `${indexPath(k)}#`, value: (k.textContent || '').trim(), ro, label: humanize(k.localName), tech: k.nodeName, vh: guessValueHelp(k.localName) })).join('');
  if (rows) out += `<div class="of-rows">${rows}</div>`;
  if (!kids.length && !attrs(e).length && !text) out += '<p class="of-none">No entries yet. Add them in the XML view.</p>';
  for (const k of kids.filter(x => !simple.includes(x))) {
    const count = isTable(k) ? `<span class="of-count">${k.children.length}</span>` : '';
    out += `<div class="of-sub lv${Math.min(level, 2)}"><h3>${esc(humanize(k.localName))}${count}</h3>${genericContent(k, indexPath(k), ro, level + 1)}</div>`;
  }
  return out;
}

// ------------------------------------------------------------------ layout-driven sections
interface Section { id: string; title: string; help?: string; half?: boolean; count?: number; html: string; more?: boolean }

function layoutSections(doc: Document, lay: Layout, ro: boolean, used: Set<Element>): Section[] {
  const get = (a: string) => valueOf(findAt(doc, a));
  const out: Section[] = [];
  lay.sections.forEach((sec, i) => {
    let html = '';
    const rows = (sec.fields || []).map(f => {
      if (f.when && !f.when(get)) { const h = findAt(doc, f.at); if (h) used.add(h.el); return ''; }
      const h = findAt(doc, f.at);
      if (!h) return '';
      used.add(h.el);
      const label = typeof f.label === 'function' ? f.label(get) : f.label;
      const fro = ro || !!f.readOnly?.(get);
      return row({
        xpath: xpathOf(h), value: valueOf(h), label, ro: fro, kind: f.kind, options: f.options, help: f.help, w: f.width, at: f.at,
        rerender: f.rerender, vh: typeof f.vh === 'function' ? f.vh(get) : f.vh, note: f.note?.(get) || undefined, tech: h.attr?.name || h.el.nodeName, padded: f.kind === 'number',
      });
    }).join('');
    if (rows) html += `<div class="of-rows">${rows}</div>`;
    const b = sec.block;
    let count: number | undefined;
    if (b?.kind === 'labels') {
      const trs = b.rows.map(([k, l]) => {
        const lab = findAt(doc, `${k}FieldLabel`), len = findAt(doc, `${k}FieldLength`), max = findAt(doc, `${k}FieldMaxLength`);
        [lab, len, max].forEach(x => x && used.add(x.el));
        if (!lab) return '';
        const n = +(valueOf(len) || 0) || +(valueOf(max) || 0) || 0;
        const text = valueOf(lab);
        const lenCell = len ? (ro ? `<td><span class="mono">${esc(shown(valueOf(len), true))}</span></td>`
          : `<td class="w-xs"><input class="of-cell mono" data-xpath="${esc(xpathOf(len))}"${pad(valueOf(len))} value="${esc(shown(valueOf(len), true))}" inputmode="numeric" aria-label="${l} length" data-len-for="${k}"></td>`) : '<td></td>';
        const txtCell = ro ? `<td>${text ? esc(text) : '<span class="of-empty">–</span>'}</td>`
          : `<td><div class="of-counted"><input class="of-cell" data-xpath="${esc(xpathOf(lab))}" value="${esc(text)}" ${n ? `maxlength="${n}"` : ''} aria-label="${l} field label" data-label-of="${k}"><span class="of-counter ${n && text.length > n ? 'over' : ''}">${text.length}${n ? ' / ' + n : ''}</span></div></td>`;
        return `<tr><th scope="row">${l}</th>${lenCell}${txtCell}</tr>`;
      }).join('');
      if (trs) html += `<div class="of-table labels"><table><thead><tr><th></th><th scope="col">Length</th><th scope="col">Field label</th></tr></thead><tbody>${trs}</tbody></table></div>`;
    }
    if (b?.kind === 'table') html += layoutTable(doc, b, ro, used, c => { count = c; });
    if (html) out.push({ id: `of-sec-${i}`, title: sec.title, help: sec.help, half: sec.half, count, html });
  });
  return out;
}

function layoutTable(doc: Document, b: TableDef, ro: boolean, used: Set<Element>, setCount: (n: number) => void): string {
  const h = findAt(doc, b.at);
  if (!h) return '';
  used.add(h.el);
  const rowName = singular(b.at);
  const rows = Array.from(h.el.children);
  setCount(rows.length);
  const head = `<th scope="col" class="w-xs">#</th>` + b.columns.map(c => `<th scope="col">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => {
    used.add(r);
    const rp = indexPath(r);
    const num = b.number ? valueOf({ el: Array.from(r.children).find(k => k.localName === b.number) || r }) || String(i + 1) : String(i + 1);
    const cells = b.columns.map(c => {
      const k = Array.from(r.children).find(x => x.localName === c.at);
      return k ? cell(`${indexPath(k)}#`, (k.textContent || '').trim(), ro, c.label, c.vh, c.width) : '<td><span class="of-empty">–</span></td>';
    }).join('');
    return `<tr><td class="of-num">${esc(shown(num, true))}</td>${cells}${ro ? '' : delBtn(rp, i)}</tr>`;
  }).join('');
  const add = ro ? '' : `<button type="button" class="of-add" data-act="xf-add-row" data-at="${esc(b.at)}" data-row="${esc(rowName)}" data-cols="${esc(b.columns.map(c => c.at).join(','))}" data-num="${esc(b.number || '')}">${PLUS}Add ${esc(b.noun)}</button>`;
  return `<div class="of-table">${rows.length ? `<table><thead><tr>${head}${ro ? '' : '<th class="of-row-act"><span class="sr">Actions</span></th>'}</tr></thead><tbody>${body}</tbody></table>` : `<p class="of-none pad">No ${esc(b.noun)}s yet.</p>`}</div>${add}`;
}
const singular = (at: string) => { const n = at.split('/').pop() as string; return n.endsWith('ies') ? n.slice(0, -3) + 'y' : n.endsWith('s') ? n.slice(0, -1) : n; };

/** Leaf values a layout did not place, so nothing in the object is out of reach. */
function moreSection(doc: Document, used: Set<Element>, ro: boolean): string {
  const within = (e: Element) => { for (let p: Element | null = e; p; p = p.parentElement) if (used.has(p)) return true; return false; };
  const leaves: Element[] = [];
  const walk = (e: Element) => Array.from(e.children).forEach(k => {
    if (hidden(k) || within(k)) return;
    if (!k.children.length) leaves.push(k); else walk(k);
  });
  walk(doc.documentElement);
  return leaves.map(k => row({ xpath: `${indexPath(k)}#`, value: (k.textContent || '').trim(), ro, label: humanize(k.localName), tech: k.nodeName, vh: guessValueHelp(k.localName) })).join('');
}

// ------------------------------------------------------------------ page
export interface FormHeader {
  type: ObjType; readOnly: boolean; typeLabel: string; glyph: string; status?: { text: string; tone: 'ok' | 'warn' | 'muted' }; note?: string;
}

export function renderXmlForm(xml: string, o: FormHeader): string {
  uid = 0;
  let doc: Document;
  try { doc = parse(xml); } catch (e) {
    return `<div class="of"><div class="of-banner err">The XML document has an error, so the form cannot show it: ${esc((e as Error).message)}<button class="btn small" data-act="xml-mode" data-id="xml">Open the XML</button></div></div>`;
  }
  const r = doc.documentElement;
  const a = (n: string) => r.getAttributeNS(ADT, n) || '';
  const pkg = Array.from(r.children).find(c => c.namespaceURI === ADT && c.localName === 'packageRef')?.getAttributeNS(ADT, 'name') || '';
  const descAttr = Array.from(r.attributes).find(x => x.namespaceURI === ADT && x.localName === 'description');
  const facts: [string, string][] = ([['Package', pkg], ...HEADER_ATTRS.filter(([k]) => k !== 'type').map(([k, l]) => [l, a(k)])] as [string, string][]).filter(([, v]) => v);

  const sections: Section[] = [];
  const lay = LAYOUTS[o.type];
  if (lay) {
    const used = new Set<Element>();
    sections.push(...layoutSections(doc, lay, o.readOnly, used));
    const more = moreSection(doc, used, o.readOnly);
    if (more) sections.push({ id: 'of-sec-more', title: 'More properties', html: `<div class="of-rows">${more}</div>`, more: true });
  } else {
    const kids = Array.from(r.children).filter(k => !hidden(k));
    const simple = kids.filter(k => !k.children.length && !attrs(k).length);
    const general = genericRows(r, '', o.readOnly) + simple.map(k => row({ xpath: `${indexPath(k)}#`, value: (k.textContent || '').trim(), ro: o.readOnly, label: humanize(k.localName), tech: k.nodeName, vh: guessValueHelp(k.localName) })).join('');
    if (general) sections.push({ id: 'of-sec-general', title: 'General', html: `<div class="of-rows">${general}</div>` });
    kids.filter(k => !simple.includes(k)).forEach((k, i) => {
      sections.push({ id: `of-sec-${i}`, title: humanize(k.localName), count: isTable(k) ? k.children.length : undefined, half: !isTable(k) && !k.children.length, html: genericContent(k, indexPath(k), o.readOnly, 1) });
    });
  }
  const tone = o.status ? `p-${o.status.tone}` : '';
  const card = (sec: Section) => sec.more
    ? `<details class="of-card of-more" id="${sec.id}"><summary><h2>${esc(sec.title)}</h2><span class="of-hint-inline">Values without their own place in this form</span></summary>${sec.html}</details>`
    : `<section class="of-card ${sec.half ? 'half' : ''}" id="${sec.id}" aria-labelledby="${sec.id}-h"><header><h2 id="${sec.id}-h">${esc(sec.title)}</h2>${sec.count !== undefined ? `<span class="of-count">${sec.count}</span>` : ''}</header>${sec.help ? `<p class="of-sec-help">${esc(sec.help)}</p>` : ''}${sec.html}</section>`;
  return `<div class="of">
    <header class="of-head">
      <div class="of-id">${o.glyph}<div class="of-titles"><div class="of-kicker">${esc(o.typeLabel)}</div><h1>${esc(a('name') || r.localName)}</h1></div>
        <div class="of-badges">${o.status ? `<span class="pill ${tone}">${esc(o.status.text)}</span>` : ''}${o.readOnly ? '<span class="pill p-muted">Read-only</span>' : ''}</div></div>
      ${descAttr ? `<div class="of-desc">${o.readOnly ? `<p class="of-lead">${esc(descAttr.value)}</p>` : `<label class="of-label" for="of-desc">Description</label><input id="of-desc" class="of-input w-lg" data-xpath="@${esc(descAttr.name)}" value="${esc(descAttr.value)}" maxlength="60" autocomplete="off">`}</div>` : ''}
      ${facts.length ? `<dl class="of-meta">${facts.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd class="${isCode(v) ? 'mono' : ''}">${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    </header>
    ${o.note ? `<div class="of-banner">${esc(o.note)}</div>` : ''}
    <div class="of-body">
      <div class="of-main">${sections.map(card).join('') || '<p class="of-none">This object has no further properties.</p>'}</div>
      ${sections.length >= 3 ? `<nav class="of-toc" aria-label="Sections"><div class="of-toc-h">On this page</div>${sections.map(sec => `<button type="button" data-act="of-goto" data-id="${sec.id}">${esc(sec.title)}</button>`).join('')}</nav>` : ''}
    </div>
  </div>`;
}
