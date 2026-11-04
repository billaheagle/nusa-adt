// Quick fixes and refactorings computed from the source alone. The DEMO system uses them;
// real systems use the ADT services, which know the whole repository.

import { analyze, declaredMethods, implementedMethods } from './abap';
import { wordRange } from './edits';

export interface LocalEdit { from: { line: number; ch: number }; to: { line: number; ch: number }; newText: string }
export interface LocalFix { id: string; title: string; desc: string; edits: LocalEdit[] }

const at = (line: number, ch = 0) => ({ line, ch });
const insertLine = (line: number, text: string): LocalEdit => ({ from: at(line), to: at(line), newText: text + '\n' });
const indentOf = (s: string) => /^\s*/.exec(s)?.[0] ?? '';

/** Columns of a line that hold code: not inside '…', `…`, |…| literals, not after a " comment. */
function codeMask(line: string): boolean[] {
  const m: boolean[] = new Array(line.length).fill(true);
  if (/^\*/.test(line)) return m.fill(false);
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { m[i] = false; if (c === q) q = ''; continue; }
    if (c === '"') { for (let j = i; j < line.length; j++) m[j] = false; break; }
    if (c === "'" || c === '`' || c === '|') { q = c; m[i] = false; }
  }
  return m;
}

/** Whole-word, case-insensitive uses of a name in code (not in literals or comments). */
export function occurrences(source: string, name: string): { line: number; ch: number }[] {
  const out: { line: number; ch: number }[] = [];
  const re = new RegExp(`(?<![\\w/~])${name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w/])`, 'gi');
  source.split('\n').forEach((l, line) => {
    const mask = codeMask(l);
    for (const m of l.matchAll(re)) if (mask[m.index ?? 0]) out.push({ line, ch: m.index ?? 0 });
  });
  return out;
}

export function renameEdits(source: string, oldName: string, newName: string): LocalEdit[] {
  return occurrences(source, oldName).map(p => ({ from: p, to: { line: p.line, ch: p.ch + oldName.length }, newText: newName }));
}

const declared = (source: string, v: string) =>
  new RegExp(`(DATA|FIELD-SYMBOLS|CONSTANTS|STATICS|PARAMETERS|SELECT-OPTIONS|CLASS-DATA)\\s*(\\(|:)?[^.]*?(?<![\\w/])${v}(?![\\w/])`, 'i').test(source)
  || new RegExp(`(?<![\\w/])${v}(?![\\w/])\\s+TYPE`, 'i').test(source)
  || new RegExp(`(IMPORTING|EXPORTING|CHANGING|RETURNING)[^.]*(?<![\\w/])${v}(?![\\w/])`, 'i').test(source);

function guessType(v: string): string {
  const p = v.toLowerCase().slice(0, 3);
  return p === 'lt_' || p === 'gt_' ? 'string_table' : p === 'lo_' || p === 'go_' ? 'REF TO object' : p === 'lr_' ? 'REF TO data' : 'string';
}

/** Statement start line for a line inside a chained or multi-line statement. */
function statementStart(lines: string[], line: number): number {
  let l = line;
  while (l > 0 && !/\.\s*("|$)/.test(lines[l - 1].replace(/'[^']*'/g, '')) && lines[l - 1].trim() !== '' && !/^\s*\*/.test(lines[l - 1])) l--;
  return l;
}

export function quickFixesAt(source: string, cls: string | null, line: number, ch: number): LocalFix[] {
  const lines = source.split('\n');
  const text = lines[line] ?? '';
  const fixes: LocalFix[] = [];
  const st = analyze(lines).st;
  const c = cls?.toLowerCase() || '';

  if (c) {
    const decl = declaredMethods(st).filter(m => m.cls === c);
    const impl = implementedMethods(st).filter(m => m.cls === c);
    const missingDecl = impl.find(m => m.line === line && !m.name.includes('~') && !decl.some(d => d.name === m.name));
    if (missingDecl) {
      for (const vis of ['private', 'protected', 'public'] as const) {
        const edits = declareMethod(lines, c, missingDecl.name, vis);
        if (edits) fixes.push({ id: `decl-${vis}`, title: `Declare ${missingDecl.name} as ${vis} method`, desc: `Adds METHODS ${missingDecl.name}. to the ${vis.toUpperCase()} SECTION`, edits });
      }
    }
    const missingImpl = decl.find(d => d.line === line && !impl.some(m => m.name === d.name));
    if (missingImpl) {
      const end = lastLine(lines, /^\s*ENDCLASS\s*\./i);
      if (end >= 0) fixes.push({ id: 'impl', title: `Add implementation of ${missingImpl.name}`, desc: 'Adds an empty METHOD … ENDMETHOD block', edits: [insertLine(end, `  METHOD ${missingImpl.name}.\n  ENDMETHOD.\n`)] });
    }
  }

  const w = wordRange(text, ch);
  const mask = codeMask(text);
  if (w && mask[w[0]]) {
    const word = text.slice(w[0], w[1]);
    const assigned = new RegExp(`(?<![\\w/~>-])${word}\\s*=[^=]`, 'i').test(text.slice(w[0]));
    if (/^[lg][vstorc]_\w+$/i.test(word) && assigned && !declared(source, word)) {
      const s = statementStart(lines, line);
      fixes.push({ id: 'inline', title: `Declare ${word} inline`, desc: `Writes DATA(${word}) at its first assignment`, edits: [{ from: at(line, w[0]), to: at(line, w[1]), newText: `DATA(${word})` }] });
      fixes.push({ id: 'local', title: `Declare local variable ${word}`, desc: `Adds DATA ${word} TYPE ${guessType(word)}. above the statement`, edits: [insertLine(s, `${indentOf(lines[s])}DATA ${word} TYPE ${guessType(word)}.`)] });
    }
  }

  // inside a '…' literal: string template
  const lit = /'((?:[^']|'')*)'/g;
  for (const m of text.matchAll(lit)) {
    const a = m.index ?? 0, b = a + m[0].length;
    if (ch > a && ch < b) {
      const inner = m[1].replace(/''/g, "'").replace(/[|{}\\]/g, x => '\\' + x);
      fixes.push({ id: 'template', title: 'Convert to string template', desc: `|${inner}|`, edits: [{ from: at(line, a), to: at(line, b), newText: `|${inner}|` }] });
    }
  }
  return fixes;
}

function lastLine(lines: string[], re: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}

/** METHODS name. in a section of the class definition, creating the section when it is missing. */
function declareMethod(lines: string[], cls: string, name: string, vis: 'private' | 'protected' | 'public'): LocalEdit[] | null {
  const defStart = lines.findIndex(l => new RegExp(`^\\s*CLASS\\s+${cls}\\s+DEFINITION`, 'i').test(l));
  if (defStart < 0) return null;
  const defEnd = lines.findIndex((l, i) => i > defStart && /^\s*ENDCLASS\s*\./i.test(l));
  if (defEnd < 0) return null;
  const sec = lines.findIndex((l, i) => i > defStart && i < defEnd && new RegExp(`^\\s*${vis}\\s+SECTION\\s*\\.`, 'i').test(l));
  if (sec >= 0) return [insertLine(sec + 1, `    METHODS ${name}.`)];
  // sections must keep their order: public, protected, private
  const order = ['public', 'protected', 'private'];
  const later = lines.findIndex((l, i) => i > defStart && i < defEnd && order.slice(order.indexOf(vis) + 1).some(v => new RegExp(`^\\s*${v}\\s+SECTION\\s*\\.`, 'i').test(l)));
  return [insertLine(later >= 0 ? later : defEnd, `  ${vis.toUpperCase()} SECTION.\n    METHODS ${name}.`)];
}

/** Extract Method for whole lines inside a method of a class in its main include. */
export function extractMethodEdits(source: string, cls: string, fromLine: number, toLine: number, name: string): LocalEdit[] {
  const lines = source.split('\n');
  let start = -1;
  for (let i = fromLine; i >= 0; i--) { if (/^\s*ENDMETHOD\s*\./i.test(lines[i]) && i < fromLine) break; if (/^\s*METHOD\s+[\w~/]+\s*\./i.test(lines[i])) { start = i; break; } }
  const end = lines.findIndex((l, i) => i > fromLine && /^\s*ENDMETHOD\s*\./i.test(l));
  if (start < 0 || end < 0 || toLine >= end || fromLine <= start) throw new Error('Select whole statements inside one method to extract them');
  const body = lines.slice(fromLine, toLine + 1);
  const pad = indentOf(body.find(l => l.trim()) ?? '    ');
  const moved = body.map(l => '    ' + l.slice(Math.min(pad.length, indentOf(l).length))).join('\n');
  const declare = declareMethod(lines, cls.toLowerCase(), name, 'private');
  if (!declare) throw new Error(`The definition of ${cls.toUpperCase()} is not in this source`);
  return [
    ...declare,
    { from: at(fromLine), to: at(toLine + 1), newText: `${pad}${name}( ).\n` },
    insertLine(end + 1, `\n  METHOD ${name}.\n${moved}\n  ENDMETHOD.`),
  ];
}
