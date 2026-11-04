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

function input(xpath: string, value: string, ro: boolean, label: string) {
  if (value === 'true' || value === 'false') {
    return `<label class="xf-check"><input type="checkbox" data-xpath="${esc(xpath)}" ${value === 'true' ? 'checked' : ''} ${ro ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
  }
  const long = value.length > 70;
  const ctl = long
    ? `<textarea data-xpath="${esc(xpath)}" rows="3" ${ro ? 'readonly' : ''} spellcheck="false">${esc(value)}</textarea>`
    : `<input data-xpath="${esc(xpath)}" value="${esc(value)}" ${ro ? 'readonly' : ''} spellcheck="false" autocomplete="off">`;
  return `<label class="field xf-field"><span>${esc(label)}</span>${ctl}</label>`;
}

function node(e: Element, path: string, ro: boolean, depth: number): string {
  if (hidden(e)) return '';
  const label = humanize(e.localName);
  const fields = attrs(e).map(a => input(`${path}@${a.name}`, a.value, ro, humanize(a.localName))).join('');
  const kids = Array.from(e.children);
  if (isTable(e)) {
    const cols: string[] = [];
    kids.forEach(k => attrs(k).forEach(a => { if (!cols.includes(a.name)) cols.push(a.name); }));
    const hasText = kids.some(k => (k.textContent || '').trim());
    const head = cols.map(c => `<th>${esc(humanize(c.split(':').pop() as string))}</th>`).join('') + (hasText ? '<th>Value</th>' : '');
    const rows = kids.map((k, i) => {
      const rp = `${path}/${i}`.replace(/^\//, '');
      const cells = cols.map(c => {
        const v = k.getAttribute(c);
        return `<td>${v === null ? '' : v === 'true' || v === 'false'
          ? `<input type="checkbox" data-xpath="${esc(rp)}@${esc(c)}" ${v === 'true' ? 'checked' : ''} ${ro ? 'disabled' : ''} aria-label="${esc(humanize(c.split(':').pop() as string))}">`
          : `<input data-xpath="${esc(rp)}@${esc(c)}" value="${esc(v)}" ${ro ? 'readonly' : ''} spellcheck="false" autocomplete="off" aria-label="${esc(humanize(c.split(':').pop() as string))}">`}</td>`;
      }).join('') + (hasText ? `<td><input data-xpath="${esc(rp)}#" value="${esc((k.textContent || '').trim())}" ${ro ? 'readonly' : ''}></td>` : '');
      return `<tr>${cells}${ro ? '' : `<td class="xf-row-act"><button type="button" class="icon-btn" data-act="xf-del" data-xpath="${esc(rp)}" title="Remove row" aria-label="Remove row">×</button></td>`}</tr>`;
    }).join('');
    const last = `${path}/${kids.length - 1}`.replace(/^\//, '');
    return `<section class="xf-sec" style="--xd:${depth}"><h3>${esc(label)} <small>${kids.length}</small></h3>${fields ? `<div class="xf-grid">${fields}</div>` : ''}
      <div class="xf-table"><table><thead><tr>${head}${ro ? '' : '<th></th>'}</tr></thead><tbody>${rows}</tbody></table></div>
      ${ro ? '' : `<button type="button" class="btn small ghost" data-act="xf-add" data-xpath="${esc(last)}">+ Add ${esc(humanize(kids[0].localName).toLowerCase())}</button>`}</section>`;
  }
  if (!kids.length) {
    const text = (e.textContent || '').trim();
    if (!attrs(e).length && !text) return `<section class="xf-sec" style="--xd:${depth}"><h3>${esc(label)}</h3><p class="muted">No entries</p></section>`;
    if (!attrs(e).length) return input(`${path}#`, text, ro, label);
    return `<section class="xf-sec" style="--xd:${depth}"><h3>${esc(label)}</h3><div class="xf-grid">${fields}${text ? input(`${path}#`, text, ro, 'Value') : ''}</div></section>`;
  }
  const inner = kids.map((k, i) => node(k, `${path}/${i}`.replace(/^\//, ''), ro, depth + 1)).join('');
  return `<section class="xf-sec" style="--xd:${depth}"><h3>${esc(label)}</h3>${fields ? `<div class="xf-grid">${fields}</div>` : ''}${inner}</section>`;
}

export function renderXmlForm(xml: string, o: { readOnly: boolean; typeLabel: string; note?: string }): string {
  let doc: Document;
  try { doc = parse(xml); } catch (e) {
    return `<div class="xf"><div class="notice err">The XML document has an error, so the form cannot show it: ${esc((e as Error).message)}</div><p><button class="btn" data-act="xml-mode" data-id="xml">Open the XML</button></p></div>`;
  }
  const r = doc.documentElement;
  const a = (n: string) => r.getAttributeNS(ADT, n) || '';
  const pkg = Array.from(r.children).find(c => c.namespaceURI === ADT && c.localName === 'packageRef')?.getAttributeNS(ADT, 'name') || '';
  const descAttr = Array.from(r.attributes).find(x => x.namespaceURI === ADT && x.localName === 'description');
  const facts = HEADER_ATTRS.map(([k, l]) => [l, a(k)]).filter(([, v]) => v);
  const body = Array.from(r.children).map((k, i) => node(k, String(i), o.readOnly, 0)).join('');
  return `<div class="xf">
    <header class="xf-head">
      <div class="xf-title"><h2>${esc(a('name') || r.localName)}</h2><span class="pill">${esc(o.typeLabel)}</span>${o.readOnly ? '<span class="pill p-warn">Read-only</span>' : ''}</div>
      ${descAttr ? input(`@${descAttr.name}`, descAttr.value, o.readOnly, 'Description') : ''}
      <dl class="xf-facts">${pkg ? `<dt>Package</dt><dd>${esc(pkg)}</dd>` : ''}${facts.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${o.note ? `<p class="note">${esc(o.note)}</p>` : ''}
    </header>
    ${body || '<p class="muted">This object has no further properties.</p>'}
  </div>`;
}
