// Form editor for objects that ADT stores as XML documents (authorization objects, IAM apps,
// communication scenarios, business configuration, data elements, …). It does not need the
// schema of each type: attributes become fields, lists of equal elements become tables.
// Every edit changes the XML text, so saving, drafts, history and compare work as for source.

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

let uid = 0;
const LOCK = '<svg class="of-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** One labelled field. Editable fields look like inputs; read-only values are plain text. */
function field(xpath: string, value: string, ro: boolean, label: string, tech: string, lockIcon: boolean): string {
  const id = `of-f-${++uid}`;
  const wide = value.length > 60;
  if (value === 'true' || value === 'false') {
    if (ro) return `<div class="of-field ro"><span class="of-label" title="${esc(tech)}">${esc(label)}${lockIcon ? LOCK : ''}</span><div class="of-value">${value === 'true' ? '<span class="of-yes">Yes</span>' : '<span class="of-no">No</span>'}</div></div>`;
    return `<div class="of-field"><span class="of-label" title="${esc(tech)}">${esc(label)}</span><label class="of-switch"><input type="checkbox" role="switch" data-xpath="${esc(xpath)}" ${value === 'true' ? 'checked' : ''}><i aria-hidden="true"></i><span>${value === 'true' ? 'On' : 'Off'}</span></label></div>`;
  }
  if (ro) return `<div class="of-field ro ${wide ? 'wide' : ''}"><span class="of-label" title="${esc(tech)}">${esc(label)}${lockIcon ? LOCK : ''}</span><div class="of-value ${isCode(value) ? 'mono' : ''}">${value ? esc(value) : '<span class="of-empty">Not set</span>'}</div></div>`;
  const ctl = wide
    ? `<textarea id="${id}" class="of-input" data-xpath="${esc(xpath)}" rows="3" spellcheck="false">${esc(value)}</textarea>`
    : `<input id="${id}" class="of-input ${isCode(value) || !value ? 'mono' : ''}" data-xpath="${esc(xpath)}" value="${esc(value)}" spellcheck="false" autocomplete="off">`;
  return `<div class="of-field ${wide ? 'wide' : ''}"><label class="of-label" for="${id}" title="${esc(tech)}">${esc(label)}</label>${ctl}</div>`;
}

function fieldsOf(e: Element, path: string, ro: boolean): string {
  return attrs(e).map(a => field(`${path}@${a.name}`, a.value, ro, humanize(a.localName), a.name, false)).join('');
}

function table(e: Element, path: string, ro: boolean): string {
  const kids = Array.from(e.children);
  const cols: string[] = [];
  kids.forEach(k => attrs(k).forEach(a => { if (!cols.includes(a.name)) cols.push(a.name); }));
  const hasText = kids.some(k => (k.textContent || '').trim());
  const col = (c: string) => humanize(c.split(':').pop() as string);
  const head = cols.map(c => `<th scope="col" title="${esc(c)}">${esc(col(c))}</th>`).join('') + (hasText ? '<th scope="col">Value</th>' : '');
  const cell = (rp: string, c: string, v: string | null) => {
    if (v === null) return '<td><span class="of-empty">–</span></td>';
    if (v === 'true' || v === 'false') {
      return `<td class="of-c-bool">${ro ? (v === 'true' ? '<span class="of-yes">Yes</span>' : '<span class="of-no">No</span>')
        : `<label class="of-switch sm"><input type="checkbox" role="switch" data-xpath="${esc(rp)}@${esc(c)}" ${v === 'true' ? 'checked' : ''} aria-label="${esc(col(c))}"><i aria-hidden="true"></i></label>`}</td>`;
    }
    return ro ? `<td><span class="${isCode(v) ? 'mono' : ''}">${v ? esc(v) : '<span class="of-empty">–</span>'}</span></td>`
      : `<td><input class="of-cell ${isCode(v) || !v ? 'mono' : ''}" data-xpath="${esc(rp)}@${esc(c)}" value="${esc(v)}" spellcheck="false" autocomplete="off" aria-label="${esc(col(c))}"></td>`;
  };
  const rows = kids.map((k, i) => {
    const rp = `${path}/${i}`.replace(/^\//, '');
    const txt = (k.textContent || '').trim();
    return `<tr>${cols.map(c => cell(rp, c, k.getAttribute(c))).join('')}${hasText ? (ro ? `<td>${esc(txt)}</td>` : `<td><input class="of-cell" data-xpath="${esc(rp)}#" value="${esc(txt)}" aria-label="Value"></td>`) : ''}
      ${ro ? '' : `<td class="of-row-act"><button type="button" class="of-del" data-act="xf-del" data-xpath="${esc(rp)}" title="Remove this row" aria-label="Remove row ${i + 1}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>`}</tr>`;
  }).join('');
  const last = `${path}/${kids.length - 1}`.replace(/^\//, '');
  const noun = humanize(kids[0].localName).toLowerCase();
  return `<div class="of-table"><table><thead><tr>${head}${ro ? '' : '<th class="of-row-act"><span class="sr">Actions</span></th>'}</tr></thead><tbody>${rows}</tbody></table></div>
    ${ro ? '' : `<button type="button" class="of-add" data-act="xf-add" data-xpath="${esc(last)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add ${esc(noun)}</button>`}`;
}

/** Content of a section: its fields, then a table or sub-sections. */
function content(e: Element, path: string, ro: boolean, level: number): string {
  const kids = Array.from(e.children).filter(k => !hidden(k));
  const fields = fieldsOf(e, path, ro);
  const text = (e.textContent || '').trim();
  let out = fields ? `<div class="of-grid">${fields}</div>` : '';
  if (isTable(e)) return out + table(e, path, ro);
  if (!kids.length) {
    if (!attrs(e).length) out += text ? `<div class="of-grid">${field(`${path}#`, text, ro, 'Value', e.nodeName, false)}</div>` : '<p class="of-none">No entries yet. Add them in the XML view.</p>';
    return out;
  }
  // leaf children without attributes are simple fields of this section
  const simple = kids.filter(k => !k.children.length && !attrs(k).length);
  const rest = kids.filter(k => !simple.includes(k));
  if (simple.length) {
    out += `<div class="of-grid">${simple.map(k => field(`${path}/${Array.from(e.children).indexOf(k)}#`.replace(/^\//, ''), (k.textContent || '').trim(), ro, humanize(k.localName), k.nodeName, false)).join('')}</div>`;
  }
  for (const k of rest) {
    const kp = `${path}/${Array.from(e.children).indexOf(k)}`.replace(/^\//, '');
    const count = isTable(k) ? `<span class="of-count">${k.children.length}</span>` : '';
    out += `<div class="of-sub lv${Math.min(level, 2)}"><h3>${esc(humanize(k.localName))}${count}</h3>${content(k, kp, ro, level + 1)}</div>`;
  }
  return out;
}

export interface FormHeader {
  readOnly: boolean; typeLabel: string; glyph: string; status?: { text: string; tone: 'ok' | 'warn' | 'muted' }; note?: string;
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
  // sections: top-level elements; plain values of the root are collected in "General"
  const kids = Array.from(r.children).map((k, i) => [k, String(i)] as [Element, string]).filter(([k]) => !hidden(k));
  const simple = kids.filter(([k]) => !k.children.length && !attrs(k).length);
  const sections: { id: string; title: string; count?: number; html: string }[] = [];
  const rootFields = fieldsOf(r, '', o.readOnly);
  if (simple.length || rootFields) {
    sections.push({ id: 'of-sec-general', title: 'General', html: `<div class="of-grid">${rootFields}${simple.map(([k, p]) => field(`${p}#`, (k.textContent || '').trim(), o.readOnly, humanize(k.localName), k.nodeName, false)).join('')}</div>` });
  }
  kids.filter(([k]) => !simple.some(([s]) => s === k)).forEach(([k, p], i) => {
    sections.push({ id: `of-sec-${i}`, title: humanize(k.localName), count: isTable(k) ? k.children.length : undefined, html: content(k, p, o.readOnly, 1) });
  });
  const tone = o.status ? `p-${o.status.tone === 'ok' ? 'ok' : o.status.tone === 'warn' ? 'warn' : 'muted'}` : '';
  return `<div class="of">
    <header class="of-head">
      <div class="of-id">${o.glyph}<div class="of-titles"><div class="of-kicker">${esc(o.typeLabel)}</div><h1>${esc(a('name') || r.localName)}</h1></div>
        <div class="of-badges">${o.status ? `<span class="pill ${tone}">${esc(o.status.text)}</span>` : ''}${o.readOnly ? '<span class="pill p-muted">Read-only</span>' : ''}</div></div>
      ${descAttr ? `<div class="of-desc">${field(`@${descAttr.name}`, descAttr.value, o.readOnly, 'Description', descAttr.name, false)}</div>` : ''}
      ${facts.length ? `<dl class="of-meta">${facts.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd class="${isCode(v) ? 'mono' : ''}">${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    </header>
    ${o.note ? `<div class="of-banner">${esc(o.note)}</div>` : ''}
    <div class="of-body">
      <div class="of-main">${sections.map(sec => `<section class="of-card" id="${sec.id}" aria-labelledby="${sec.id}-h"><header><h2 id="${sec.id}-h">${esc(sec.title)}</h2>${sec.count !== undefined ? `<span class="of-count">${sec.count}</span>` : ''}</header>${sec.html}</section>`).join('') || '<p class="of-none">This object has no further properties.</p>'}</div>
      ${sections.length >= 3 ? `<nav class="of-toc" aria-label="Sections"><div class="of-toc-h">On this page</div>${sections.map(sec => `<button type="button" data-act="of-goto" data-id="${sec.id}">${esc(sec.title)}</button>`).join('')}</nav>` : ''}
    </div>
  </div>`;
}
