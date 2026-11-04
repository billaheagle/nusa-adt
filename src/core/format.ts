/**
 * Formatters that work offline, in the spirit of "Format Document" in VS Code:
 * ABAP gets block indentation, aligned continuation lines and keyword case;
 * CDS-like sources (DDL, DDLX, DCL, BDEF, SRVD, tables) get indentation by braces.
 */
import { analyze, caseCode, segs, statements } from './abap';

export type KeywordCase = 'upper' | 'lower' | 'keep';
export interface FormatOptions { keywordCase?: KeywordCase; maxBlankLines?: number }

const CLAUSE = /^(IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING|EXCEPTIONS|RESUMABLE)\b/i;
const DEDENT_NEXT = /^(END[A-Z-]*|ELSE|ELSEIF|WHEN|CATCH|CLEANUP|PROTECTED|PRIVATE|PUBLIC)\b/i;

type Open = { col: number; lineIndent: number; trailing: boolean };

/** Open parentheses left on a formatted line, scanning code only (not strings or comments). */
function scanParens(line: string, stack: Open[]) {
  const indent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
  let col = 0;
  for (const sg of segs(line)) {
    if (sg.t === 'code') {
      for (let i = 0; i < sg.s.length; i++) {
        const ch = sg.s[i];
        if (ch === '(') {
          const rest = (sg.s.slice(i + 1) + '').trim();
          stack.push({ col: col + i, lineIndent: indent, trailing: rest === '' && !line.slice(col + i + 1).trim().replace(/^".*$/, '') });
        } else if (ch === ')') stack.pop();
      }
    }
    col += sg.s.length;
  }
}

export function formatAbap(text: string, opt: FormatOptions = {}): string {
  const kc = opt.keywordCase ?? 'upper';
  const maxBlank = opt.maxBlankLines ?? 2;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { indent } = analyze(lines);
  const st = statements(lines);
  const out: (string | null)[] = new Array(lines.length).fill(null);
  const startOf = new Map<number, number>();         // line -> statement index starting there
  st.forEach((s, i) => { if (!startOf.has(s.start)) startOf.set(s.start, i); });
  const done = new Set<number>();

  for (const s of st) {
    if (done.has(s.start)) continue;
    const base = indent[s.start] ?? 0;
    const first = ' '.repeat(base) + caseCode(lines[s.start].trim(), kc);
    out[s.start] = first;
    done.add(s.start);
    const stack: Open[] = [];
    scanParens(first, stack);
    // METHODS ... IMPORTING a TYPE i / RETURNING ...: align clauses and their parameters
    const code0 = segs(first).filter(g => g.t === 'code').map(g => g.s).join('');
    const isDecl = /^\s*(CLASS-)?METHODS\b|^\s*(CLASS-)?EVENTS\b/i.test(code0);
    const cm = isDecl ? /\b(IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING|EXCEPTIONS)\b/i.exec(code0) : null;
    let clauseCol = cm ? cm.index : base + 2;
    let paramCol = cm ? cm.index + cm[0].length + 1 : base + 4;
    const colon = /^\s*[\w-]+\s*:\s*/.exec(code0);
    const chainCol = colon && !isDecl ? colon[0].length : -1;
    for (let l = s.start + 1; l <= s.end; l++) {
      const t = lines[l].trim();
      if (!t) { out[l] = ''; done.add(l); continue; }
      if (lines[l].startsWith('*')) { out[l] = lines[l].replace(/\s+$/, ''); done.add(l); continue; }
      let ind: number;
      const top = stack[stack.length - 1];
      if (top && t.startsWith(')')) ind = top.lineIndent;
      else if (top) ind = top.trailing ? top.lineIndent + 2 : top.col + 2;
      else if (isDecl && CLAUSE.test(t)) {
        if (!cm) clauseCol = base + 2;
        ind = clauseCol;
        paramCol = ind + (CLAUSE.exec(t) as RegExpExecArray)[0].length + 1;
      } else if (isDecl) ind = paramCol;
      else if (chainCol >= 0) ind = chainCol;
      else ind = base + 2;
      const line = ' '.repeat(ind) + caseCode(t, kc);
      out[l] = line;
      done.add(l);
      scanParens(line, stack);
    }
  }

  // comments and blank lines between statements
  const nextCode = (from: number) => { for (let j = from; j < lines.length; j++) if (out[j] !== null && out[j] !== '' && !lines[j].trim().startsWith('"') && !lines[j].startsWith('*')) return j; return -1; };
  const prevCode = (from: number) => { for (let j = from; j >= 0; j--) if (out[j] && !lines[j].trim().startsWith('"') && !lines[j].startsWith('*')) return j; return -1; };
  for (let i = 0; i < lines.length; i++) {
    if (out[i] !== null) continue;
    const raw = lines[i];
    const t = raw.trim();
    if (!t) { out[i] = ''; continue; }
    if (raw.startsWith('*')) { out[i] = raw.replace(/\s+$/, ''); continue; }
    const n = nextCode(i + 1);
    let ind = 0;
    if (n >= 0) {
      ind = indent[n] ?? 0;
      if (DEDENT_NEXT.test(lines[n].trim())) {
        const p = prevCode(i - 1);
        ind = p >= 0 ? Math.max(ind + 2, (indent[p] ?? 0)) : ind + 2;
        if (/^(ENDCLASS|ENDINTERFACE)\b/i.test(lines[n].trim())) ind = 2;
      }
    }
    out[i] = ' '.repeat(ind) + t;
  }

  // blank lines: at most maxBlank in a row, none at the end
  const res: string[] = [];
  let blanks = 0;
  for (const l of out as string[]) {
    if (l === '') { if (++blanks > maxBlank) continue; } else blanks = 0;
    res.push(l.replace(/\s+$/, ''));
  }
  while (res.length > 1 && res[res.length - 1] === '' && res[res.length - 2] === '') res.pop();
  return res.join(eol);
}

/** CDS-like sources: two spaces per open brace, bracket or parenthesis. */
export function formatCds(text: string, opt: { maxBlankLines?: number } = {}): string {
  const maxBlank = opt.maxBlankLines ?? 1;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let depth = 0;
  let inBlock = false;          // /* ... */
  let header = false;           // between "define ..." and its "{"
  const res: string[] = [];
  let blanks = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { if (++blanks <= maxBlank) res.push(''); continue; }
    blanks = 0;
    // code part without strings and comments, to count brackets
    let code = '';
    let i = 0;
    let block: boolean = inBlock;
    while (i < t.length) {
      if (block) { const e = t.indexOf('*/', i); if (e < 0) { i = t.length; break; } block = false; i = e + 2; continue; }
      if (t.startsWith('//', i) || t.startsWith('--', i)) break;
      if (t.startsWith('/*', i)) { block = true; i += 2; continue; }
      if (t[i] === "'") { const e = t.indexOf("'", i + 1); i = e < 0 ? t.length : e + 1; code += "''"; continue; }
      code += t[i++];
    }
    const lead = /^[}\])]+/.exec(code.trim())?.[0].length ?? 0;
    const isOpenBrace = /^\{/.test(code.trim());
    let ind = Math.max(0, depth - lead);
    if (header && !isOpenBrace && !/^(define|extend|annotate|@)/i.test(t)) ind += 1;
    if (inBlock) ind = depth;
    res.push('  '.repeat(ind) + t);
    if (/^\s*(define|extend)\b/i.test(code) && !code.includes('{')) header = true;
    if (code.includes('{')) header = false;
    for (const ch of code) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    }
    inBlock = block;
  }
  while (res.length > 1 && res[res.length - 1] === '' && res[res.length - 2] === '') res.pop();
  return res.join(eol);
}
