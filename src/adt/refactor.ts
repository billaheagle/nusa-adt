// Quick fixes and refactorings over ADT, the services Eclipse ADT calls:
//   POST /sap/bc/adt/quickfixes/evaluation?uri=<source>#start=l,c      body: the source
//   POST <proposal uri>                                                 body: proposalRequest
//   POST /sap/bc/adt/refactorings?step=evaluate|preview|execute&rel=…  (rename, extract method)
// Lines in ADT fragments are 1-based, columns 0-based. The XML the system returns is sent
// back as it came, with only the fields the user changed, as Eclipse does; rebuilding it
// from parsed values would lose data the system keeps in userContent.

import { AdtClient, splitSourceUrl } from './client';
import { all, attr, decode, encode, first, kids, parseXml, textOf, XEl } from './xml';
import { adtTypeOf, ExtractParam, ExtractStart, ObjRef, RefactorPreview, TextEdit } from '../core/types';

const ANY = 'application/*';
const REL = 'http://www.sap.com/adt/relations/refactoring/';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

export interface Fragment { start: { line: number; ch: number }; end: { line: number; ch: number } }

/** "#start=12,4;end=12,10" (1-based lines) to 0-based positions. Without an end, the range is empty. */
export function parseFragment(s: string): Fragment | null {
  const m = /start=(\d+),(\d+)(?:;end=(\d+),(\d+))?/.exec(s || '');
  if (!m) return null;
  const start = { line: +m[1] - 1, ch: +m[2] };
  const end = m[3] ? { line: +m[3] - 1, ch: +m[4] } : start;
  return { start, end };
}
export const fragment = (line: number, ch: number, endLine?: number, endCh?: number) =>
  `#start=${line + 1},${ch}${endLine !== undefined ? `;end=${endLine + 1},${endCh}` : ''}`;

// ------------------------------------------------------------------ XML text surgery

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the text of the first element with this local name (`<p:name>…</p:name>` or `<p:name/>`). */
export function setElementText(xml: string, local: string, value: string): string {
  const re = new RegExp(`<((?:[\\w.-]+:)?${esc(local)})(\\s[^>]*)?(?:/>|>[^<]*</\\1>)`);
  return xml.replace(re, (_m, tag: string, attrs = '') => `<${tag}${attrs}>${encode(value)}</${tag}>`);
}

/** Root namespace declarations, so a fragment taken out of a document still parses. */
function rootNamespaces(xml: string): Record<string, string> {
  const root = /<(?!\?)[\w.:-]+((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*\/?>/.exec(xml);
  const out: Record<string, string> = {};
  for (const m of (root?.[1] || '').matchAll(/xmlns(?::([\w.-]+))?\s*=\s*"([^"]*)"/g)) out[m[1] || ''] = m[2];
  return out;
}

/** The first element with this local name as its own document, carrying the namespaces it uses. */
export function elementDocument(xml: string, local: string): string | null {
  const open = new RegExp(`<((?:[\\w.-]+:)?${esc(local)})(\\s[^>]*)?>`).exec(xml);
  if (!open) return null;
  const tag = open[1];
  const closeTag = `</${tag}>`;
  // find the matching close tag, counting nested elements of the same name
  let depth = 0, i = open.index, end = -1;
  const scan = new RegExp(`<${esc(tag)}(?=[\\s>/])[^>]*?(/?)>|${esc(closeTag)}`, 'g');
  scan.lastIndex = i;
  for (let m = scan.exec(xml); m; m = scan.exec(xml)) {
    if (m[0] === closeTag) { depth--; if (depth === 0) { end = m.index + closeTag.length; break; } }
    else if (m[1] !== '/') depth++;
    else if (depth === 0) { end = m.index + m[0].length; break; }
  }
  if (end < 0) return null;
  let frag = xml.slice(open.index, end);
  const declared = new Set([...open[0].matchAll(/xmlns(?::([\w.-]+))?=/g)].map(m => m[1] || ''));
  const used = new Set([...frag.matchAll(/<\/?([\w.-]+):|\s([\w.-]+):[\w.-]+=/g)].map(m => m[1] || m[2]).filter(p => p !== 'xmlns' && p !== 'xml'));
  const ns = rootNamespaces(xml);
  const add = [...used].filter(p => !declared.has(p) && ns[p]).map(p => ` xmlns:${p}="${ns[p]}"`).join('');
  if (add) frag = frag.replace(/^<[\w.:-]+/, m => m + add);
  return XML_DECL + frag;
}

/** Element text without trimming: code fragments keep their line breaks and indentation. */
const rawText = (el: XEl | undefined, local: string) => first(el, local)?.text ?? '';

const body = (xml: string) => XML_DECL + xml.replace(/^\s*<\?xml[^>]*\?>\s*/, '');

// ------------------------------------------------------------------ parsing

function objectOf(uri: string, name: string, type: string): { uri: string; include: TextEdit['include']; ref: ObjRef } {
  const s = splitSourceUrl(uri);
  const t = adtTypeOf(type);
  return { uri: s.uri, include: s.include, ref: { uri: s.uri, name: name.toUpperCase(), type: t, pkg: '', desc: '' } };
}

/** Text changes of a genericRefactoring (affectedObjects / textReplaceDeltas). */
export function parseGeneric(xml: string): { title: string; edits: TextEdit[]; objects: ObjRef[] } {
  const x = parseXml(xml);
  const gen = all(x, 'genericRefactoring')[0] || x;
  const edits: TextEdit[] = [];
  const objects = new Map<string, ObjRef>();
  for (const o of all(gen, 'affectedObject')) {
    const uri = attr(o, 'uri') || '';
    const name = attr(o, 'name') || '';
    const { include, ref, uri: owner } = objectOf(uri, name, attr(o, 'type') || '');
    objects.set(owner, ref);
    for (const d of all(o, 'textReplaceDelta')) {
      const f = parseFragment(textOf(d, 'rangeFragment'));
      if (!f) continue;
      edits.push({ uri: owner, include, name: ref.name, type: ref.type, from: f.start, to: f.end, oldText: rawText(d, 'contentOld'), newText: rawText(d, 'contentNew') });
    }
  }
  return { title: textOf(gen, 'title'), edits, objects: [...objects.values()] };
}

// ------------------------------------------------------------------ quick fixes

export interface FixToken { uri: string; userContent: string }

export async function quickFixes(c: AdtClient, srcUrl: string, source: string, line: number, col: number) {
  const r = await c.req({ method: 'POST', path: '/sap/bc/adt/quickfixes/evaluation', query: { uri: srcUrl + fragment(line, col) }, contentType: ANY, accept: ANY, body: source });
  return all(parseXml(r.body), 'evaluationResult').map(e => {
    const ref = all(e, 'objectReference')[0];
    const token: FixToken = { uri: attr(ref, 'uri') || '', userContent: rawText(e, 'userContent') };
    return { title: attr(ref, 'name') || 'Quick fix', desc: attr(ref, 'description') || undefined, token: JSON.stringify(token) };
  }).filter(f => /\/sap\/bc\/adt\/quickfixes\//.test(JSON.parse(f.token).uri));
}

export async function applyQuickFix(c: AdtClient, srcUrl: string, source: string, line: number, col: number, tok: FixToken): Promise<TextEdit[]> {
  const req = `${XML_DECL}<quickfixes:proposalRequest xmlns:quickfixes="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core"><input><content>${encode(source)}</content><adtcore:objectReference adtcore:uri="${encode(srcUrl + fragment(line, col))}"/></input><userContent>${encode(tok.userContent)}</userContent></quickfixes:proposalRequest>`;
  const r = await c.req({ method: 'POST', path: tok.uri, contentType: ANY, accept: ANY, body: req });
  const x = parseXml(r.body);
  const out: TextEdit[] = [];
  for (const u of all(x, 'unit')) {
    const ref = all(u, 'objectReference')[0];
    const full = attr(ref, 'uri') || '';
    const f = parseFragment(full.split('#')[1] || '');
    if (!f) continue;
    const { include, ref: obj, uri } = objectOf(full, attr(ref, 'name') || '', attr(ref, 'type') || '');
    out.push({ uri, include, name: obj.name, type: obj.type, from: f.start, to: f.end, oldText: '', newText: rawText(u, 'content') });
  }
  return out;
}

// ------------------------------------------------------------------ rename

export async function renameEvaluate(c: AdtClient, srcUrl: string, line: number, from: number, to: number) {
  const r = await c.req({ method: 'POST', path: '/sap/bc/adt/refactorings', query: { step: 'evaluate', rel: REL + 'rename', uri: srcUrl + fragment(line, from, line, to) }, contentType: ANY, accept: ANY });
  const x = parseXml(r.body);
  return { oldName: textOf(x, 'oldName'), token: r.body };
}

/** The evaluate answer with the new name and the transport, wrapped in renameRefactoring if it came bare. */
export function renameRequest(evaluated: string, newName: string, transport = ''): string {
  let xml = evaluated.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  if (!/renameRefactoring[\s>]/.test(xml)) {
    const old = textOf(parseXml(xml), 'oldName');
    xml = `<rename:renameRefactoring xmlns:rename="http://www.sap.com/adt/refactoring/renamerefactoring" xmlns:generic="http://www.sap.com/adt/refactoring/genericrefactoring" xmlns:adtcore="http://www.sap.com/adt/core"><rename:oldName>${encode(old)}</rename:oldName><rename:newName/>${xml}<rename:userContent/></rename:renameRefactoring>`;
  }
  xml = setElementText(xml, 'newName', newName);
  if (transport) xml = setElementText(xml, 'transport', transport);
  return body(xml);
}

export async function renamePreview(c: AdtClient, evaluated: string, newName: string, transport?: string): Promise<RefactorPreview> {
  const r = await c.req({ method: 'POST', path: '/sap/bc/adt/refactorings', query: { step: 'preview', rel: REL + 'rename' }, contentType: ANY, accept: ANY, body: renameRequest(evaluated, newName, transport) });
  const g = parseGeneric(r.body);
  // execute takes the genericRefactoring part of the preview
  let exec = elementDocument(r.body, 'genericRefactoring') || r.body;
  if (transport) exec = setElementText(exec, 'transport', transport);
  return { title: g.title || 'Rename', edits: g.edits, objects: g.objects, token: exec };
}

// ------------------------------------------------------------------ extract method

export async function extractEvaluate(c: AdtClient, srcUrl: string, from: { line: number; ch: number }, to: { line: number; ch: number }): Promise<ExtractStart> {
  const r = await c.req({ method: 'POST', path: '/sap/bc/adt/refactorings', query: { step: 'evaluate', rel: REL + 'extractmethod', uri: srcUrl + fragment(from.line, from.ch, to.line, to.ch) }, contentType: ANY, accept: ANY });
  const x = parseXml(r.body);
  const root = all(x, 'extractMethodRefactoring')[0] || x;
  const direct = (local: string) => textOf(kids(root, local)[0]);
  const params: ExtractParam[] = all(root, 'parameter').map((p: XEl) => ({
    id: textOf(p, 'id'), name: textOf(p, 'name'), direction: textOf(p, 'direction'), type: textOf(p, 'type'),
  }));
  return {
    name: direct('name') || 'new_method', visibility: direct('visibility') || 'PRIVATE',
    isStatic: direct('isStatic') === 'true', className: direct('className'), params, token: r.body,
  };
}

/** The evaluate answer with the user's name, visibility, static flag and parameter names. */
export function extractRequest(s: ExtractStart, transport = ''): string {
  let xml = s.token.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  // top-level fields come before the parameters block, so the first match is the method's own
  const head = xml.search(/<([\w.-]+:)?parameters[\s>/]/);
  const split = head < 0 ? xml.length : head;
  let top = xml.slice(0, split), rest = xml.slice(split);
  top = setElementText(top, 'name', s.name);
  top = setElementText(top, 'visibility', s.visibility);
  top = setElementText(top, 'isStatic', String(s.isStatic));
  // parameter names, matched by id
  rest = rest.replace(/<((?:[\w.-]+:)?)parameter>([\s\S]*?)<\/\1parameter>/g, m => {
    const raw = /<(?:[\w.-]+:)?id>([^<]*)</.exec(m)?.[1] ?? '';
    const id = decode(raw);
    const want = s.params.find(q => q.id === id);
    return want ? setElementText(m, 'name', want.name) : m;
  });
  xml = top + rest;
  if (transport) xml = setElementText(xml, 'transport', transport);
  return body(xml);
}

export async function extractPreview(c: AdtClient, s: ExtractStart, transport?: string): Promise<RefactorPreview> {
  const r = await c.req({ method: 'POST', path: '/sap/bc/adt/refactorings', query: { step: 'preview', rel: REL + 'extractmethod' }, contentType: ANY, accept: ANY, body: extractRequest(s, transport) });
  const g = parseGeneric(r.body);
  let exec = elementDocument(r.body, 'genericRefactoring') || r.body;
  if (transport) exec = setElementText(exec, 'transport', transport);
  return { title: g.title || `Extract method ${s.name}`, edits: g.edits, objects: g.objects, token: exec };
}

export async function execute(c: AdtClient, preview: RefactorPreview): Promise<void> {
  await c.req({ method: 'POST', path: '/sap/bc/adt/refactorings', query: { step: 'execute' }, contentType: ANY, accept: ANY, body: body(preview.token) });
}
