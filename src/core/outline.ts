// Outline of the open source: classes, methods, attributes, events, forms, CDS elements.

import { statements } from './abap';
import { parseCdsSource } from './catalog';

export interface OutlineItem { name: string; kind: 'class' | 'interface' | 'method' | 'attribute' | 'constant' | 'type' | 'event' | 'form' | 'section' | 'element' | 'entity' | 'association'; line: number; depth: number; detail?: string }

export function outline(source: string, cds: boolean): OutlineItem[] {
  const lines = source.split('\n');
  if (cds) {
    const out: OutlineItem[] = [];
    const head = lines.findIndex(l => /\bdefine\b|\bannotate\b/i.test(l));
    if (head >= 0) out.push({ name: (lines[head].match(/(?:entity|table|role|service|behavior\s+for)\s+([\w/]+)/i) || [, lines[head].trim()])[1] as string, kind: 'entity', line: head, depth: 0 });
    const els = parseCdsSource(source);
    for (const e of els) {
      const re = new RegExp(`\\b${e.name.replace(/\$/g, '\\$')}\\b`);
      let ln = -1;
      for (let i = Math.max(0, head); i < lines.length; i++) if (re.test(lines[i]) && !/^\s*@/.test(lines[i])) { ln = i; }
      out.push({ name: e.name, kind: e.type === 'association' ? 'association' : 'element', line: Math.max(0, ln), depth: 1, detail: e.key ? 'key' : undefined });
    }
    if (!els.length) lines.forEach((l, i) => { const m = l.match(/^\s*(key\s+)?([\w/]+)\s*:\s*([\w/.()]+)/i); if (m && i > head) out.push({ name: m[2], kind: 'element', line: i, depth: 1, detail: m[3] }); });
    return out;
  }
  const out: OutlineItem[] = [];
  let depth = 0;
  for (const s of statements(lines)) {
    const w = s.words, k = s.kw;
    const name = (i: number) => (w[i] || '').toLowerCase().replace(/[:,.]$/, '');
    if (k === 'CLASS' && (w.includes('DEFINITION') || w.includes('IMPLEMENTATION')) && !w.includes('DEFERRED')) {
      out.push({ name: name(1), kind: 'class', line: s.start, depth: 0, detail: w.includes('DEFINITION') ? 'definition' : 'implementation' }); depth = 1; continue;
    }
    if (k === 'INTERFACE' && !w.includes('DEFERRED')) { out.push({ name: name(1), kind: 'interface', line: s.start, depth: 0 }); depth = 1; continue; }
    if (k === 'ENDCLASS' || k === 'ENDINTERFACE') { depth = 0; continue; }
    if (/^(PUBLIC|PROTECTED|PRIVATE)$/.test(k) && w[1] === 'SECTION') { out.push({ name: `${k.toLowerCase()} section`, kind: 'section', line: s.start, depth }); continue; }
    const chain = s.text.trim().match(/^([\w-]+)\s*:\s*(.*)$/s);
    const head = chain ? chain[1].toUpperCase() : k;
    const bodies = chain ? chain[2].split(',') : [s.text.trim().slice(k.length)];
    const kind: OutlineItem['kind'] | null = /^(CLASS-)?METHODS$/.test(head) ? 'method' : /^(CLASS-)?DATA$/.test(head) && depth > 0 ? 'attribute' : head === 'CONSTANTS' && depth > 0 ? 'constant' : head === 'TYPES' && depth > 0 ? 'type' : /^(CLASS-)?EVENTS$/.test(head) ? 'event' : null;
    if (kind) {
      for (const b of bodies) {
        const n = (b.trim().match(/^(?:BEGIN\s+OF\s+)?([\w/~]+)/i) || [])[1];
        if (n && !/^(END|BEGIN)$/i.test(n)) out.push({ name: n.toLowerCase(), kind, line: s.start, depth: depth + 1 });
      }
      continue;
    }
    if (k === 'METHOD') { out.push({ name: name(1), kind: 'method', line: s.start, depth: 1, detail: 'implementation' }); continue; }
    if (k === 'FORM') { out.push({ name: name(1), kind: 'form', line: s.start, depth: 0 }); continue; }
    if (/^(START-OF-SELECTION|END-OF-SELECTION|INITIALIZATION|TOP-OF-PAGE|LOAD-OF-PROGRAM)$/.test(k) || (k === 'AT' && w[1] === 'SELECTION-SCREEN')) {
      out.push({ name: s.text.trim().toLowerCase(), kind: 'event', line: s.start, depth: 0 });
    }
  }
  return out;
}
