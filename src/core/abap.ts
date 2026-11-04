// ABAP source analysis shared by the editor, the mock backend and the local fallbacks.
// Line-based and dependency-free: tokenises strings/comments, splits statements on
// periods, tracks control blocks for indentation and block-balance errors.

export const KEYWORDS = [
  'ABSTRACT', 'ADD', 'ALIASES', 'ALL', 'AND', 'ANY', 'APPEND', 'APPENDING', 'AS', 'ASCENDING', 'ASSIGN',
  'ASSIGNING', 'AT', 'AUTHORITY-CHECK', 'BEGIN', 'BETWEEN', 'BINARY', 'BY', 'BYPASSING', 'CALL', 'CASE', 'CAST',
  'CATCH', 'CHANGING', 'CHECK', 'CLASS', 'CLASS-DATA', 'CLASS-METHODS', 'CLEANUP', 'CLEAR', 'CLIENT', 'COLLECT',
  'COMMIT', 'COMPONENTS', 'CONCATENATE', 'COND', 'CONDENSE', 'CONSTANTS', 'CONTINUE', 'CONV', 'CORRESPONDING',
  'CREATE', 'CRITICAL', 'DANGEROUS', 'DATA', 'DECIMALS', 'DEFAULT', 'DEFERRED', 'DEFINITION', 'DELETE',
  'DESCENDING', 'DESCRIBE', 'DISTINCT', 'DO', 'DURATION', 'ELSE', 'ELSEIF', 'EMPTY', 'END', 'END-OF-PAGE',
  'END-OF-SELECTION', 'ENDAT', 'ENDCASE', 'ENDCLASS', 'ENDDO', 'ENDFORM', 'ENDFUNCTION', 'ENDIF', 'ENDINTERFACE',
  'ENDLOOP', 'ENDMETHOD', 'ENDMODULE', 'ENDSELECT', 'ENDTRY', 'ENDWHILE', 'EQ', 'EVENTS', 'EXACT', 'EXCEPTIONS',
  'EXIT', 'EXPORTING', 'FIELD-SYMBOL', 'FIELD-SYMBOLS', 'FIELDS', 'FILTER', 'FINAL', 'FIND', 'FOR', 'FORM', 'FREE',
  'FRIENDS', 'FROM', 'FUNCTION', 'GE', 'GROUP', 'GT', 'HARMLESS', 'IF', 'IMPLEMENTATION', 'IMPORTING', 'IN',
  'INCLUDE', 'INHERITING', 'INITIAL', 'INITIALIZATION', 'INNER', 'INSERT', 'INTERFACE', 'INTERFACES', 'INTO', 'IS',
  'JOIN', 'KEY', 'LE', 'LEAVE', 'LEFT', 'LENGTH', 'LET', 'LEVEL', 'LIKE', 'LINE', 'LOAD-OF-PROGRAM', 'LONG', 'LOOP',
  'LT', 'MEDIUM', 'MESSAGE', 'METHOD', 'METHODS', 'MOD', 'MODIFY', 'MODULE', 'MOVE', 'NE', 'NEW', 'NOT', 'OBJECT',
  'OBLIGATORY', 'OF', 'ON', 'OPTIONAL', 'OR', 'ORDER', 'OTHERS', 'OUTER', 'PARAMETERS', 'PERFORM', 'PRIVATE',
  'PROTECTED', 'PUBLIC', 'RAISE', 'RAISING', 'RANGE', 'READ', 'RECEIVING', 'REDEFINITION', 'REDUCE', 'REF',
  'REFERENCE', 'REPLACE', 'REPORT', 'RETURN', 'RETURNING', 'RISK', 'ROLLBACK', 'ROWS', 'SECTION', 'SELECT',
  'SELECT-OPTIONS', 'SELECTION-SCREEN', 'SET', 'SHORT', 'SINGLE', 'SORT', 'SPLIT', 'STANDARD', 'START-OF-SELECTION',
  'STATICS', 'STRUCTURE', 'SUBMIT', 'SWITCH', 'TABLE', 'TABLES', 'TESTING', 'THEN', 'TIMES', 'TO', 'TOP-OF-PAGE',
  'TRANSPORTING', 'TRY', 'TYPE', 'TYPES', 'UNDER', 'UNIQUE', 'UNTIL', 'UP', 'UPDATE', 'USING', 'VALUE', 'WHEN',
  'WHERE', 'WHILE', 'WITH', 'WRITE',
];
export const KWSET = new Set(KEYWORDS);

export const CLOSE: Record<string, string> = {
  IF: 'ENDIF', LOOP: 'ENDLOOP', DO: 'ENDDO', WHILE: 'ENDWHILE', CASE: 'ENDCASE', TRY: 'ENDTRY',
  METHOD: 'ENDMETHOD', CLASS: 'ENDCLASS', FORM: 'ENDFORM', FUNCTION: 'ENDFUNCTION', MODULE: 'ENDMODULE',
  INTERFACE: 'ENDINTERFACE', SELECT: 'ENDSELECT', AT: 'ENDAT',
};
const CLOSERS = new Set(Object.values(CLOSE));
const EVENTS = new Set(['START-OF-SELECTION', 'END-OF-SELECTION', 'INITIALIZATION', 'TOP-OF-PAGE', 'END-OF-PAGE', 'LOAD-OF-PROGRAM']);

export type Seg = { t: 'code' | 'str' | 'com'; s: string };

/** Split one line into code, string literal and comment segments. */
export function segs(line: string): Seg[] {
  if (line.startsWith('*')) return [{ t: 'com', s: line }];
  const out: Seg[] = [];
  let buf = '';
  let i = 0;
  const push = (t: Seg['t'], s: string) => { if (s) out.push({ t, s }); };
  while (i < line.length) {
    const c = line[i];
    if (c === '"') { push('code', buf); buf = ''; push('com', line.slice(i)); return out; }
    if (c === "'" || c === '`' || c === '|') {
      push('code', buf); buf = '';
      let j = i + 1;
      while (j < line.length) {
        if (c === '|' && line[j] === '\\') { j += 2; continue; }
        if (line[j] === c) {
          if (c !== '|' && line[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      push('str', line.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    buf += c; i++;
  }
  push('code', buf);
  return out;
}

export interface Stmt { start: number; end: number; text: string; open?: boolean; kw: string; words: string[] }
export interface Diag { line: number; msg: string; sev: 'error' | 'warning' | 'info' }

/** Split source into statements (period-terminated, comments removed, strings collapsed). */
export function statements(lines: string[]): Stmt[] {
  const st: Stmt[] = [];
  let cur: Stmt | null = null;
  const begin = (li: number): Stmt => ({ start: li, end: li, text: '', kw: '', words: [] });
  lines.forEach((line, li) => {
    for (const sg of segs(line)) {
      if (sg.t === 'com') continue;
      if (sg.t === 'str') { if (!cur) cur = begin(li); cur.text += "''"; cur.end = li; continue; }
      for (const ch of sg.s) {
        if (!cur) { if (/\s/.test(ch)) continue; cur = begin(li); }
        if (ch === '.') { cur.end = li; st.push(cur); cur = null; continue; }
        cur.text += ch; cur.end = li;
      }
    }
    if (cur) cur.text += ' ';
  });
  if (cur) { (cur as Stmt).open = true; st.push(cur); }
  for (const s of st) {
    s.words = s.text.trim().toUpperCase().split(/\s+/);
    s.kw = (s.words[0] || '').replace(/[:(].*$/, '');
  }
  return st;
}

function isOpener(s: Stmt): boolean {
  const k = s.kw, w = s.words, up = s.text.toUpperCase();
  if (['IF', 'LOOP', 'DO', 'WHILE', 'CASE', 'TRY', 'FORM', 'FUNCTION', 'MODULE', 'METHOD'].includes(k)) return true;
  if (k === 'CLASS') {
    if (w.includes('DEFERRED') || w.includes('LOAD') || (w.includes('LOCAL') && w.includes('FRIENDS'))) return false;
    return w.includes('DEFINITION') || w.includes('IMPLEMENTATION');
  }
  if (k === 'INTERFACE') return !w.includes('DEFERRED') && !w.includes('LOAD');
  if (k === 'SELECT') {
    if (/\bINTO\s+(CORRESPONDING\s+FIELDS\s+OF\s+)?TABLE\b|\bAPPENDING\b|\bSINGLE\b|\bCOUNT\s*\(/.test(up)) return false;
    return /\bINTO\b/.test(up);
  }
  if (k === 'AT') return /^(NEW|FIRST|LAST|END)$/.test(w[1] || '');
  return false;
}

export interface Analysis { st: Stmt[]; indent: (number | null)[]; errors: Diag[] }

export function analyze(lines: string[]): Analysis {
  const st = statements(lines);
  const indent: (number | null)[] = new Array(lines.length).fill(null);
  const errors: Diag[] = [];
  const stack: { kw: string; line: number; kind: 'block' | 'section' | 'when' | 'event' }[] = [];
  const orig = (l: number) => (lines[l].match(/^\s*/) as RegExpMatchArray)[0].length;
  const top = () => stack[stack.length - 1];
  const err = (line: number, msg: string) => errors.push({ line, msg, sev: 'error' });

  for (const s of st) {
    const k = s.kw, w = s.words;
    let print = stack.length;
    if (EVENTS.has(k) || (k === 'AT' && /^(SELECTION-SCREEN|LINE-SELECTION|USER-COMMAND)/.test(w[1] || ''))) {
      while (stack.length && top().kind === 'event') stack.pop();
      print = stack.length;
      stack.push({ kw: k, line: s.start, kind: 'event' });
    } else if (/^(PUBLIC|PROTECTED|PRIVATE)$/.test(k) && w[1] === 'SECTION') {
      if (top() && top().kind === 'section') stack.pop();
      if (!top() || top().kw !== 'CLASS') err(s.start, `${k} SECTION is only allowed in a class definition`);
      print = stack.length;
      stack.push({ kw: 'SECTION', line: s.start, kind: 'section' });
    } else if (k === 'WHEN') {
      if (top() && top().kind === 'when') stack.pop();
      if (!top() || top().kw !== 'CASE') err(s.start, 'WHEN is only allowed between CASE and ENDCASE');
      print = stack.length;
      stack.push({ kw: 'WHEN', line: s.start, kind: 'when' });
    } else if (k === 'ELSE' || k === 'ELSEIF') {
      if (!top() || top().kw !== 'IF') err(s.start, `${k} is only allowed between IF and ENDIF`);
      print = Math.max(0, stack.length - 1);
    } else if (k === 'CATCH' || k === 'CLEANUP') {
      if (!top() || top().kw !== 'TRY') err(s.start, `${k} is only allowed between TRY and ENDTRY`);
      print = Math.max(0, stack.length - 1);
    } else if (CLOSERS.has(k)) {
      if (k === 'ENDCASE' && top() && top().kind === 'when') stack.pop();
      if (k === 'ENDCLASS' && top() && top().kind === 'section') stack.pop();
      if (k !== 'ENDCLASS' && top() && top().kind === 'event') { /* closers never end an event block */ }
      if (top() && CLOSE[top().kw] === k) {
        stack.pop();
      } else {
        let idx = -1;
        for (let i = stack.length - 1; i >= 0; i--) if (CLOSE[stack[i].kw] === k) { idx = i; break; }
        if (idx >= 0) {
          const u = top();
          err(s.start, `${CLOSE[u.kw] || 'END…'} expected before ${k} (block opened in line ${u.line + 1})`);
          stack.length = idx;
        } else {
          err(s.start, `${k} has no matching opening statement`);
        }
      }
      print = stack.length;
    } else if (isOpener(s)) {
      print = stack.length;
      stack.push({ kw: k, line: s.start, kind: 'block' });
    }
    if (indent[s.start] === null) indent[s.start] = print * 2;
    for (let l = s.start + 1; l <= s.end; l++) {
      if (indent[l] === null) indent[l] = print * 2 + Math.max(2, orig(l) - orig(s.start));
    }
  }
  for (const e of stack) if (e.kind === 'block') err(e.line, `${e.kw} block is not closed: ${CLOSE[e.kw]} is missing`);
  const last = st[st.length - 1];
  if (last && last.open) err(last.end, 'The statement is not terminated with a period "."');
  return { st, indent, errors };
}

/** Keywords upper case, identifiers lower case; strings and comments untouched. */
const OPERATOR_WORDS = new Set(['EQ', 'NE', 'LT', 'GT', 'LE', 'GE', 'MOD']);
const EXPECTS_OPERAND = new Set(['AT', 'INTO', 'FROM', 'TABLE', 'TO', 'OF', 'DATA', 'TYPE', 'LIKE', 'IN', 'CLEAR', 'APPEND', 'SORT', 'FREE', 'UPDATE', 'MODIFY', 'DELETE', 'INSERT']);

export function caseCode(t: string, mode: 'upper' | 'lower' | 'keep' = 'upper'): string {
  if (mode === 'keep') return t;
  let prev = '';
  return segs(t).map(sg => sg.t !== 'code' ? (prev = '', sg.s) : sg.s.replace(/[A-Za-z_][\w-]*/g, (w, off: number, s: string) => {
    const pre = s.slice(Math.max(0, off - 2), off);
    const up = w.toUpperCase();
    let out: string;
    if (/->$|=>$|~$/.test(pre)) out = w.toLowerCase();
    else if (OPERATOR_WORDS.has(up) && EXPECTS_OPERAND.has(prev)) out = w.toLowerCase();  // "LOOP AT lt", "INTO to"
    else out = KWSET.has(up) ? up : w.toLowerCase();
    prev = out === up ? up : '';
    if (mode === 'lower') out = out.toLowerCase();
    return out;
  })).join('');
}

/** Local pretty printer (used offline; ADT systems use the server-side pretty printer). */
export function prettyPrint(text: string): string {
  const lines = text.split('\n');
  const { indent } = analyze(lines);
  return lines.map((line, i) => {
    const t = line.trim();
    if (!t) return '';
    if (line.startsWith('*')) return line.replace(/\s+$/, '');
    let ind = indent[i];
    if (ind === null) {
      for (let j = i + 1; j < lines.length; j++) if (indent[j] !== null) { ind = indent[j]; break; }
      if (ind === null) ind = 0;
    }
    return ' '.repeat(ind) + caseCode(t);
  }).join('\n');
}

/** Method names declared with METHODS / CLASS-METHODS, including chained declarations. */
export function declaredMethods(st: Stmt[]): { name: string; line: number; testing: boolean; cls: string }[] {
  const out: { name: string; line: number; testing: boolean; cls: string }[] = [];
  let cls = '';
  for (const s of st) {
    if (s.kw === 'CLASS' && s.words.includes('DEFINITION')) cls = (s.words[1] || '').toLowerCase();
    if (s.kw === 'METHODS' || s.kw === 'CLASS-METHODS') {
      const body = s.text.trim().replace(/^(CLASS-)?METHODS\s*:?/i, '');
      for (const part of body.split(',')) {
        const name = part.trim().split(/[\s(]/)[0];
        if (name) out.push({ name: name.toLowerCase(), line: s.start, testing: /\bFOR\s+TESTING\b/i.test(part), cls });
      }
    }
  }
  return out;
}

/** METHOD x. statements inside CLASS ... IMPLEMENTATION blocks. */
export function implementedMethods(st: Stmt[]): { name: string; line: number; cls: string }[] {
  const out: { name: string; line: number; cls: string }[] = [];
  let cls = '';
  for (const s of st) {
    if (s.kw === 'CLASS' && s.words.includes('IMPLEMENTATION')) cls = (s.words[1] || '').toLowerCase();
    if (s.kw === 'METHOD') out.push({ name: (s.words[1] || '').toLowerCase(), line: s.start, cls });
  }
  return out;
}

export function lineOf(src: string, re: RegExp, from = 0): number {
  const lines = src.split('\n');
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}
