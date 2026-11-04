// "Clean Up" in the spirit of SAP's ABAP Cleaner: rewrites obsolete or noisy statements to
// modern ABAP. Each rule is conservative: statements with comments inside, or forms the rule
// does not fully understand, are left alone.

import { caseCode, segs, statements, Stmt } from './abap';

export type RuleId =
  | 'moveToAssign' | 'createObjectToNew' | 'callMethodToFunctional' | 'comparisonOperators' | 'notIsToIsNot'
  | 'translateToFunction' | 'unchainDeclarations' | 'alignDeclarations' | 'trailingWhitespace' | 'blankLines' | 'keywordCase';

export const RULES: { id: RuleId; label: string; example: string; short?: string }[] = [
  { id: 'moveToAssign', label: 'Replace MOVE with assignment', example: 'MOVE a TO b.  →  b = a.', short: 'MOVE → =' },
  { id: 'createObjectToNew', label: 'Replace CREATE OBJECT with NEW', example: 'CREATE OBJECT lo_x.  →  lo_x = NEW #( ).', short: 'CREATE OBJECT → NEW' },
  { id: 'callMethodToFunctional', label: 'Replace CALL METHOD with functional call', example: 'CALL METHOD lo->run.  →  lo->run( ).', short: 'CALL METHOD → functional call' },
  { id: 'comparisonOperators', label: 'Use symbolic comparison operators', example: 'IF a EQ b.  →  IF a = b.', short: 'EQ/NE → =/<>' },
  { id: 'notIsToIsNot', label: 'Prefer IS NOT to NOT IS', example: 'IF NOT a IS INITIAL.  →  IF a IS NOT INITIAL.', short: 'NOT … IS → IS NOT' },
  { id: 'translateToFunction', label: 'Replace TRANSLATE … CASE with functions', example: 'TRANSLATE s TO UPPER CASE.  →  s = to_upper( s ).', short: 'TRANSLATE → to_upper/to_lower' },
  { id: 'unchainDeclarations', label: 'Unchain declarations', example: 'DATA: a TYPE i, b TYPE i.  →  two DATA statements', short: 'unchained declarations' },
  { id: 'alignDeclarations', label: 'Align declarations', example: 'Aligns TYPE in consecutive DATA lines', short: 'aligned declarations' },
  { id: 'trailingWhitespace', label: 'Remove trailing whitespace', example: '', short: 'trailing spaces' },
  { id: 'blankLines', label: 'Keep at most one blank line', example: '', short: 'extra blank lines' },
  { id: 'keywordCase', label: 'Upper case keywords, lower case identifiers', example: 'data lv type i.  →  DATA lv TYPE i.', short: 'keyword case' },
];
export const DEFAULT_RULES: RuleId[] = RULES.map(r => r.id);

export interface CleanResult { text: string; changes: { rule: RuleId; count: number }[] }

const hasComment = (lines: string[], s: Stmt) => {
  for (let l = s.start; l <= s.end; l++) if (segs(lines[l]).some(g => g.t === 'com')) return true;
  return false;
};
const indentOf = (line: string) => (line.match(/^\s*/) as RegExpMatchArray)[0];

/** Replace whole single statements (one or more lines) by a new single-line text. */
function rewrite(lines: string[], fn: (s: Stmt, code: string) => string | null): number {
  let count = 0;
  const st = statements(lines);
  for (let i = st.length - 1; i >= 0; i--) {
    const s = st[i];
    if (s.open || s.text.includes(':') || hasComment(lines, s)) continue;
    // the statement must own its lines: nothing before it on the first line, nothing after the period on the last
    const first = lines[s.start], last = lines[s.end];
    const before = first.slice(0, first.length - first.trimStart().length);
    if (!first.trimStart().toUpperCase().startsWith(s.kw)) continue;
    if (!/\.\s*$/.test(last)) continue;
    if (s.start !== s.end && st.some(o => o !== s && o.start <= s.end && o.end >= s.start)) continue;
    if (st.some(o => o !== s && (o.start === s.start || o.end === s.end))) continue;
    const code = lines.slice(s.start, s.end + 1).map(l => l.trim()).join(' ').replace(/\s+/g, ' ').replace(/\s*\.\s*$/, '');
    const out = fn(s, code);
    if (out === null || out === code) continue;
    lines.splice(s.start, s.end - s.start + 1, before + out + '.');
    count++;
  }
  return count;
}

export function cleanAbap(source: string, enabled: RuleId[] = DEFAULT_RULES): CleanResult {
  const on = new Set(enabled);
  let lines = source.split('\n');
  const changes: CleanResult['changes'] = [];
  const note = (rule: RuleId, count: number) => { if (count) changes.push({ rule, count }); };

  if (on.has('moveToAssign')) note('moveToAssign', rewrite(lines, (s, code) => {
    const m = code.match(/^MOVE\s+(.+?)\s+TO\s+([\w\-<>~/]+)$/i);
    if (!m || /\bEXACT\b|\bCORRESPONDING\b|\?TO/i.test(code)) return null;
    return `${m[2]} = ${m[1]}`;
  }));

  if (on.has('createObjectToNew')) note('createObjectToNew', rewrite(lines, (s, code) => {
    const m = code.match(/^CREATE\s+OBJECT\s+([\w\-<>~/]+)(?:\s+TYPE\s+([\w/]+))?(?:\s+EXPORTING\s+(.+))?$/i);
    if (!m || /\bEXCEPTIONS\b|\bAREA\s+HANDLE\b|\bTYPE\s*\(/i.test(code)) return null;
    const args = m[3] ? ` ${m[3].trim()} ` : ' ';
    return `${m[1]} = NEW ${m[2] ? m[2].toLowerCase() : '#'}(${args})`;
  }));

  if (on.has('callMethodToFunctional')) note('callMethodToFunctional', rewrite(lines, (s, code) => {
    const m = code.match(/^CALL\s+METHOD\s+([\w/]+(?:(?:->|=>)[\w~/]+)+|[\w~/]+)(?:\s*\(\s*(.*?)\s*\)|\s+(.+))?$/i);
    if (!m || /\(\s*[\w'"]+\s*\)\s*$/.test(m[1]) || /\bEXCEPTIONS\b|\bRECEIVING\b/i.test(code) || /^\(/.test(m[1])) return null;
    const rest = (m[2] ?? m[3] ?? '').trim();
    if (!rest) return `${m[1]}( )`;
    const sections = rest.match(/\b(EXPORTING|IMPORTING|CHANGING)\b/gi) || [];
    const body = sections.length === 1 && /^EXPORTING\b/i.test(rest) ? rest.replace(/^EXPORTING\s+/i, '') : rest;
    return `${m[1]}( ${body} )`;
  }));

  const OPS: Record<string, string> = { EQ: '=', NE: '<>', LT: '<', GT: '>', LE: '<=', GE: '>=' };
  if (on.has('comparisonOperators') || on.has('notIsToIsNot')) {
    let ops = 0, nots = 0;
    const st = statements(lines);
    for (const s of st) {
      if (!/^(IF|ELSEIF|WHILE|CHECK|WHEN|ASSERT)$/.test(s.kw) && !/\bWHERE\b/i.test(s.text)) continue;
      for (let l = s.start; l <= s.end; l++) {
        lines[l] = segs(lines[l]).map(g => {
          if (g.t !== 'code') return g.s;
          let c = g.s;
          if (on.has('comparisonOperators')) c = c.replace(/(\s)(EQ|NE|LT|GT|LE|GE)(?=\s)/gi, (_m, sp: string, op: string) => { ops++; return sp + OPS[op.toUpperCase()]; });
          if (on.has('notIsToIsNot')) c = c.replace(/\bNOT\s+([\w\-<>~/]+(?:\([^()]*\))?)\s+IS\s+(INITIAL|BOUND|ASSIGNED|SUPPLIED)\b/gi, (_m, v: string, w: string) => { nots++; return `${v} IS NOT ${w}`; });
          return c;
        }).join('');
      }
    }
    note('comparisonOperators', ops); note('notIsToIsNot', nots);
  }

  if (on.has('translateToFunction')) note('translateToFunction', rewrite(lines, (s, code) => {
    const m = code.match(/^TRANSLATE\s+([\w\-<>~/]+)\s+TO\s+(UPPER|LOWER)\s+CASE$/i);
    return m ? `${m[1]} = to_${m[2].toLowerCase()}( ${m[1]} )` : null;
  }));

  if (on.has('unchainDeclarations')) {
    let n = 0;
    const st = statements(lines);
    for (let i = st.length - 1; i >= 0; i--) {
      const s = st[i];
      const m = s.text.trim().match(/^(DATA|CLASS-DATA|STATICS|CONSTANTS|FIELD-SYMBOLS|TYPES)\s*:\s*([\s\S]+)$/i);
      if (!m || /\bBEGIN\s+OF\b|\bEND\s+OF\b/i.test(s.text) || hasComment(lines, s) || s.text.includes("''")) continue;
      if (st.some(o => o !== s && (o.start === s.start || o.end === s.end))) continue;
      const parts = m[2].split(',').map(p => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
      if (parts.length < 2) continue;
      const ind = indentOf(lines[s.start]);
      lines.splice(s.start, s.end - s.start + 1, ...parts.map(p => `${ind}${m[1]} ${p}.`));
      n++;
    }
    note('unchainDeclarations', n);
  }

  if (on.has('alignDeclarations')) {
    let n = 0;
    const re = /^(\s*)(DATA|CLASS-DATA|STATICS|CONSTANTS|FIELD-SYMBOLS)\s+(<?[\w/]+>?)\s+(TYPE|LIKE)\s+(.*)$/i;
    for (let i = 0; i < lines.length;) {
      let j = i;
      while (j < lines.length && re.test(lines[j]) && !lines[j].includes('"') && (j === i || (lines[j].match(re) as RegExpMatchArray)[1] === (lines[i].match(re) as RegExpMatchArray)[1])) j++;
      if (j - i >= 2) {
        const rows = lines.slice(i, j).map(l => l.match(re) as RegExpMatchArray);
        const kw = Math.max(...rows.map(r => r[2].length)), nm = Math.max(...rows.map(r => r[3].length));
        rows.forEach((r, k) => {
          const out = `${r[1]}${r[2].padEnd(kw)} ${r[3].padEnd(nm)} ${r[4]} ${r[5].trim()}`;
          if (out !== lines[i + k]) { lines[i + k] = out; n++; }
        });
      }
      i = Math.max(j, i + 1);
    }
    note('alignDeclarations', n);
  }

  if (on.has('trailingWhitespace')) {
    let n = 0;
    lines = lines.map(l => { const t = l.replace(/[ \t]+$/, ''); if (t !== l) n++; return t; });
    note('trailingWhitespace', n);
  }

  if (on.has('blankLines')) {
    let n = 0, run = 0, prevCode = '';
    const out: string[] = [];
    for (const l of lines) {
      if (l.trim()) { run = 0; prevCode = l; out.push(l); continue; }
      run++;
      // ADT leaves two blank lines between the class definition and implementation
      const max = /^\s*ENDCLASS\./i.test(prevCode) ? 2 : 1;
      if (run > max) { n++; continue; }
      out.push(l);
    }
    lines = out;
    note('blankLines', n);
  }

  if (on.has('keywordCase')) {
    let n = 0;
    lines = lines.map(l => {
      if (l.startsWith('*') || !l.trim()) return l;
      const ind = indentOf(l);
      const t = ind + caseCode(l.slice(ind.length));
      if (t !== l) n++;
      return t;
    });
    note('keywordCase', n);
  }

  return { text: lines.join('\n'), changes };
}
