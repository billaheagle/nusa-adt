// Context-aware code completion for ABAP and CDS.
// Works out where the cursor is (member access, type slot, SQL clause, call parameters,
// statement start, CDS annotation, element list…), infers variable types from the source,
// and asks a Catalog for repository objects. Pure and async; used offline and merged with
// server proposals on real systems.

import { KWSET, segs, statements } from './abap';
import {
  ABAP_FUNCTIONS, BUILTIN_TYPES, CDS_ANNOTATIONS, CDS_FUNCTIONS, CDS_TYPES, CONSTRUCTORS, Catalog, CatEntry, ClassInfo,
  EntryKind, Field, Member, Param, parseCdsSource, parseClassSource, PRAGMAS, SQL_FUNCTIONS, SY_FIELDS,
} from './catalog';
import { Proposal } from './types';

export interface CompletionRequest {
  source: string;
  line: number;
  col: number;
  catalog: Catalog;
  cloud?: boolean;
  /** Other includes of the same object (e.g. the class definition while editing test classes). */
  related?: string[];
}

type TI = { k: 'ref'; cls: string } | { k: 'table'; row: TI } | { k: 'struct'; fields: Field[]; name?: string } | { k: 'elem'; name: string } | { k: 'unknown' };
const UNKNOWN: TI = { k: 'unknown' };

const lc = (s: string) => s.toLowerCase();
const KIND_OF_ENTRY: Record<EntryKind, Proposal['kind']> = {
  table: 'table', structure: 'type', view: 'table', cds: 'table', dtel: 'type', ttyp: 'type', class: 'class', interface: 'interface', exception: 'exception', fm: 'fm',
};

// ====================================================================== source scanning

interface Scan { orig: string; mask: string }
/** Code text (comments removed, strings kept in orig and masked as 'x' in mask) for a range of lines. */
function scanCode(lines: string[], fromLine: number, toLine: number, toCol: number): Scan {
  let orig = '', mask = '';
  for (let i = fromLine; i <= toLine && i < lines.length; i++) {
    const text = i === toLine ? lines[i].slice(0, toCol) : lines[i];
    if (!text.startsWith('*')) {
      for (const sg of segs(text)) {
        if (sg.t === 'com') continue;
        orig += sg.s;
        mask += sg.t === 'str' ? 'x'.repeat(sg.s.length) : sg.s;
      }
    }
    if (i < toLine) { orig += '\n'; mask += '\n'; }
  }
  return { orig, mask };
}

/** Text of the current statement up to the cursor, with chained statements resolved. */
function currentStatement(lines: string[], line: number, col: number): { text: string; full: string; colonHead?: string } {
  const all = scanCode(lines, 0, line, col);
  const start = all.mask.lastIndexOf('.') + 1;
  let text = all.orig.slice(start);
  let mask = all.mask.slice(start);
  let colonHead: string | undefined;
  const colon = mask.indexOf(':');
  if (colon >= 0 && /^\s*[\w-]+\s*$/.test(mask.slice(0, colon))) {
    colonHead = text.slice(0, colon).trim();
    const tailMask = mask.slice(colon + 1);
    const comma = tailMask.lastIndexOf(',');
    const tail = text.slice(colon + 1 + comma + 1);
    text = colonHead + ' ' + tail.replace(/^\s+/, '');
    mask = text;
  }
  // rest of the statement after the cursor, for SQL sources declared after the field list
  const rest = scanCode(lines, line, lines.length - 1, Number.MAX_SAFE_INTEGER);
  const restOrig = rest.orig.slice(col);
  const restMask = rest.mask.slice(col);
  const end = restMask.indexOf('.');
  const full = all.orig.slice(start) + (end >= 0 ? restOrig.slice(0, end) : restOrig);
  return { text, full, colonHead };
}

interface Sym { name: string; type: string; kind: 'var' | 'fs' | 'type' | 'const' | 'param' }

/** Declarations found in source: DATA, inline DATA( ), FIELD-SYMBOLS, TYPES, CONSTANTS, parameters. */
function collectSymbols(source: string): { syms: Map<string, Sym>; types: Map<string, string | Field[]> } {
  const syms = new Map<string, Sym>();
  const types = new Map<string, string | Field[]>();
  const st = statements(source.split('\n'));
  const add = (name: string, type: string, kind: Sym['kind']) => { const n = lc(name); if (!syms.has(n)) syms.set(n, { name: n, type: lc(type.trim()), kind }); };
  let struct: { name: string; kind: 'type' | 'var' | 'const'; fields: Field[]; depth: number } | null = null;
  for (const s of st) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    const chain = text.match(/^([\w-]+)\s*:\s*(.*)$/);
    const head = (chain ? chain[1] : s.kw).toUpperCase();
    const bodies = chain ? chain[2].split(',') : [text.slice(s.kw.length)];
    if (['DATA', 'CLASS-DATA', 'STATICS', 'CONSTANTS', 'TYPES', 'PARAMETERS', 'FIELD-SYMBOLS', 'SELECT-OPTIONS'].includes(head) && !/^DATA\(/i.test(text)) {
      for (const raw of bodies) {
        const b = raw.trim();
        const bo = b.match(/^BEGIN\s+OF\s+([\w/]+)/i);
        if (bo) {
          if (!struct) struct = { name: lc(bo[1]), kind: head === 'TYPES' ? 'type' : head === 'CONSTANTS' ? 'const' : 'var', fields: [], depth: 1 };
          else struct.depth++;
          continue;
        }
        const eo = b.match(/^END\s+OF\s+([\w/]+)/i);
        if (eo && struct) {
          if (--struct.depth === 0) {
            if (struct.kind === 'type') types.set(struct.name, struct.fields);
            else { types.set('@' + struct.name, struct.fields); add(struct.name, '@' + struct.name, struct.kind === 'const' ? 'const' : 'var'); }
            struct = null;
          }
          continue;
        }
        const m = b.match(/^(<?[\w/]+>?)(?:\s*\(\s*\d+\s*\))?\s+(TYPE|LIKE|FOR)\s+(.+?)(?:\s+(?:VALUE|READ-ONLY|OBLIGATORY|DEFAULT|LOWER CASE|AS CHECKBOX|RADIOBUTTON GROUP)\b.*)?$/i);
        if (struct && m) { struct.fields.push({ name: lc(m[1]), type: lc(m[3]) }); continue; }
        if (!m) { const bare = b.match(/^(<?[\w/]+>?)/); if (bare && head !== 'TYPES') add(bare[1], 'c', head === 'FIELD-SYMBOLS' ? 'fs' : 'var'); continue; }
        const type = m[2].toUpperCase() === 'LIKE' ? `@like:${m[3]}` : head === 'SELECT-OPTIONS' ? `@range:${m[3]}` : m[3];
        if (head === 'TYPES') types.set(lc(m[1]), lc(type));
        else add(m[1], type, head === 'FIELD-SYMBOLS' ? 'fs' : head === 'CONSTANTS' ? 'const' : head === 'PARAMETERS' ? 'param' : 'var');
      }
    }
    if (s.kw === 'METHODS' || s.kw === 'CLASS-METHODS' || s.kw === 'FUNCTION') {
      const re = /(?:VALUE\(|REFERENCE\()?([\w/]+)\)?\s+(?:TYPE|LIKE)\s+((?:REF\s+TO\s+)?(?:(?:STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF\s+[\w/=>~-]+|[\w/=>~-]+))/gi;
      const sigText = s.text.replace(/^\s*(CLASS-)?METHODS\s*:?\s*[\w/~]+|^\s*FUNCTION\s+[\w/]+/i, '');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sigText))) add(m[1], m[2], 'param');
    }
    // inline declarations anywhere in a statement
    const t = s.text;
    for (const m of t.matchAll(/DATA\((\w+)\)\s*=\s*(.+)$/gi)) add(m[1], rhsType(m[2]), 'var');
    for (const m of t.matchAll(/FINAL\((\w+)\)\s*=\s*(.+)$/gi)) add(m[1], rhsType(m[2]), 'var');
    const loop = t.match(/^\s*(LOOP\s+AT|READ\s+TABLE)\s+([\w/>-]+)/i);
    if (loop) {
      for (const m of t.matchAll(/(?:INTO|REFERENCE\s+INTO)\s+DATA\((\w+)\)/gi)) add(m[1], `@row:${loop[2]}`, 'var');
      for (const m of t.matchAll(/ASSIGNING\s+FIELD-SYMBOL\((<\w+>)\)/gi)) add(m[1], `@row:${loop[2]}`, 'fs');
    }
    if (/^\s*SELECT\b/i.test(t)) {
      const src = (t.match(/\bFROM\s+([\w/]+)/i) || [])[1] || '';
      for (const m of t.matchAll(/\bINTO\s+(?:CORRESPONDING\s+FIELDS\s+OF\s+)?TABLE\s+@DATA\((\w+)\)/gi)) add(m[1], `standard table of ${src}`, 'var');
      for (const m of t.matchAll(/\bINTO\s+@DATA\((\w+)\)/gi)) add(m[1], src, 'var');
    }
    for (const m of t.matchAll(/\bCATCH\s+(?:BEFORE\s+UNWIND\s+)?([\w/]+)(?:\s+[\w/]+)*\s+INTO\s+DATA\((\w+)\)/gi)) add(m[2], `ref to ${m[1]}`, 'var');
  }
  if (/if_oo_adt_classrun/i.test(source)) add('out', 'ref to if_oo_adt_classrun_out', 'param');
  return { syms, types };
}

function rhsType(rhs: string): string {
  const r = rhs.trim();
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^NEW\s+([\w/]+)\s*\(/i))) return `ref to ${m[1]}`;
  if ((m = r.match(/^CAST\s+([\w/]+)\s*\(/i))) return `ref to ${m[1]}`;
  if ((m = r.match(/^(?:VALUE|CONV|CORRESPONDING|EXACT|REDUCE|COND|SWITCH)\s+([\w/]+(?:=>[\w]+)?)\s*\(/i))) return m[1];
  if ((m = r.match(/^([\w/]+)=>([\w~]+)\s*\(/))) return `@call:${m[1]}=>${m[2]}`;
  if ((m = r.match(/^([\w/]+(?:->[\w~]+\s*\([^)]*\))*)->([\w~]+)\s*\(/))) return `@call:${m[1]}->${m[2]}`;
  if ((m = r.match(/^([\w/]+)\[/))) return `@row:${m[1]}`;
  if (/^(lines|strlen|numofchar|find|count|ipow)\s*\(/i.test(r)) return 'i';
  if (/^(xsdbool|boolc)\s*\(/i.test(r) || /^abap_(true|false)$/i.test(r)) return 'abap_bool';
  if (/^(utclong_current)\s*\(/i.test(r)) return 'utclong';
  if (/^''/.test(r) || /^(condense|to_upper|to_lower|substring\w*|replace|concat_lines_of|escape|translate|reverse|repeat|segment)\s*\(/i.test(r)) return 'string';
  if (/^\d+$/.test(r)) return 'i';
  if ((m = r.match(/^([\w/]+(?:-[\w]+)*)$/))) return `@like:${m[1]}`;
  return '';
}

// ====================================================================== type resolution

class Resolver {
  private classCache = new Map<string, ClassInfo | null>();
  constructor(private cat: Catalog, private syms: Map<string, Sym>, private types: Map<string, string | Field[]>, private ownClass: string | null, private ownSources: string[]) {}

  async classInfo(name: string): Promise<ClassInfo | null> {
    const n = name.toUpperCase();
    if (this.classCache.has(n)) return this.classCache.get(n) as ClassInfo | null;
    let info: ClassInfo | null = null;
    for (const src of this.ownSources) {
      if (new RegExp(`(CLASS|INTERFACE)\\s+${n.replace(/\//g, '\\/')}\\s+DEFINITION|INTERFACE\\s+${n.replace(/\//g, '\\/')}\\b`, 'i').test(src)) {
        const parsed = parseClassSource(src, n);
        if (parsed.members.length || parsed.interfaces.length) { info = parsed; break; }
      }
    }
    if (!info) info = await this.cat.classInfo(n).catch(() => null);
    this.classCache.set(n, info);
    return info;
  }

  /** Own and inherited members; interface components are returned as intf~name. */
  async members(cls: string, depth = 0): Promise<(Member & { owner: string })[]> {
    const info = await this.classInfo(cls);
    if (!info || depth > 5) return [];
    const out: (Member & { owner: string })[] = info.members.map(m => ({ ...m, owner: info.name }));
    if (info.superClass) for (const m of await this.members(info.superClass, depth + 1)) if (!out.some(o => o.name === m.name)) out.push(m);
    for (const i of info.interfaces) {
      for (const m of await this.members(i, depth + 1)) {
        const name = m.name.includes('~') ? m.name : `${lc(i)}~${m.name}`;
        if (!out.some(o => o.name === name)) out.push({ ...m, name, owner: m.owner });
      }
    }
    return out;
  }

  async varType(name: string, depth = 0): Promise<TI> {
    const n = lc(name.replace(/->\*$/, ''));
    if (n === 'me' && this.ownClass) return { k: 'ref', cls: this.ownClass };
    if (n === 'sy' || n === 'syst') return { k: 'struct', name: 'syst', fields: SY_FIELDS.map(([f, d]) => ({ name: f, type: '', desc: d })) };
    // structured access a-b-c
    if (n.includes('-')) {
      const parts = n.split('-');
      let t = await this.varType(parts[0], depth + 1);
      for (const p of parts.slice(1)) {
        if (t.k !== 'struct') return UNKNOWN;
        const f = t.fields.find(x => x.name === p);
        t = f ? await this.typeOf(f.type, null, depth + 1) : UNKNOWN;
      }
      return t;
    }
    const s = this.syms.get(n);
    if (s) return this.typeOf(s.type, null, depth + 1);
    // attribute of the own class
    if (this.ownClass) {
      const m = (await this.members(this.ownClass)).find(x => x.name === n && x.kind !== 'method');
      if (m && m.type) return this.typeOf(m.type, this.ownClass, depth + 1);
    }
    return UNKNOWN;
  }

  async typeOf(expr: string, ctxClass: string | null, depth = 0): Promise<TI> {
    if (depth > 8 || !expr) return UNKNOWN;
    const e = lc(expr.trim()).replace(/\s+/g, ' ');
    let m: RegExpMatchArray | null;
    if (e.startsWith('@like:')) return this.varType(e.slice(6), depth + 1);
    if (e.startsWith('@range:')) return { k: 'table', row: { k: 'struct', fields: ['sign', 'option', 'low', 'high'].map(n => ({ name: n, type: '' })) } };
    if (e.startsWith('@row:')) { const t = await this.varType(e.slice(5), depth + 1); return t.k === 'table' ? t.row : UNKNOWN; }
    if (e.startsWith('@call:')) {
      const c = e.slice(6);
      const sm = c.match(/^(.*)(=>|->)([\w~]+)$/);
      if (!sm) return UNKNOWN;
      const ownerT = sm[2] === '=>' ? { k: 'ref', cls: sm[1] } as TI : await this.exprType(sm[1], depth + 1);
      if (ownerT.k !== 'ref') return UNKNOWN;
      const mem = (await this.members(ownerT.cls)).find(x => x.name === sm[3]);
      const ret = mem?.params?.find(p => p.kind === 'returning');
      return ret ? this.typeOf(ret.type, mem!.owner, depth + 1) : UNKNOWN;
    }
    if (e.startsWith('@')) { const f = this.types.get(e); return Array.isArray(f) ? { k: 'struct', fields: f } : UNKNOWN; }
    if ((m = e.match(/^ref to (.+)$/))) return { k: 'ref', cls: m[1].trim() };
    if ((m = e.match(/^(?:standard |sorted |hashed |any |index )?table of (?:ref to )?([\w/=>~-]+)/))) {
      const row = await this.typeOf(m[1], ctxClass, depth + 1);
      return { k: 'table', row: e.includes('table of ref to') ? { k: 'ref', cls: m[1] } : row };
    }
    if ((m = e.match(/^range of (.+)$/))) return this.typeOf('@range:' + m[1], ctxClass, depth + 1);
    if ((m = e.match(/^line of (.+)$/))) { const t = await this.typeOf(m[1], ctxClass, depth + 1); return t.k === 'table' ? t.row : UNKNOWN; }
    if ((m = e.match(/^([\w/]+)=>([\w]+)$/))) {
      const t = (await this.members(m[1])).find(x => x.name === m![2] && x.kind === 'type');
      return t?.type ? this.typeOf(t.type, m[1], depth + 1) : UNKNOWN;
    }
    const local = this.types.get(e);
    if (local !== undefined) return Array.isArray(local) ? { k: 'struct', name: e, fields: local } : this.typeOf(local, ctxClass, depth + 1);
    for (const c of [ctxClass, this.ownClass]) {
      if (!c) continue;
      const t = (await this.members(c)).find(x => x.name === e && x.kind === 'type');
      if (t?.type) return t.type === 'structure' ? UNKNOWN : this.typeOf(t.type, c, depth + 1);
    }
    if (BUILTIN_TYPES.some(([b]) => b === e)) return { k: 'elem', name: e };
    const row = await this.cat.rowTypeOf(e).catch(() => null);
    if (row) return { k: 'table', row: await this.typeOf(row, null, depth + 1) };
    const fields = await this.cat.fieldsOf(e).catch(() => null);
    if (fields && fields.length) return { k: 'struct', name: e, fields: fields.filter(f => f.name !== '.include') };
    const ci = /^(z|y|\/\w+\/)?(c[lx]|if)_/.test(e) ? await this.classInfo(e) : null;
    if (ci) return { k: 'ref', cls: e };
    return { k: 'elem', name: e };
  }

  /** Type of an expression like lo_x, lo_x->get( ), cls=>create( )->m( ), ls-a-b. */
  async exprType(expr: string, depth = 0): Promise<TI> {
    const x = expr.trim().replace(/\s+/g, ' ');
    const call = x.match(/^(.*?)(=>|->)([\w~]+)\s*\([^()]*\)$/);
    if (call) return this.typeOf(`@call:${call[1]}${call[2]}${call[3]}`, null, depth + 1);
    if (/^[\w/]+\[[^\]]*\]$/.test(x)) { const t = await this.varType(x.replace(/\[.*$/, ''), depth); return t.k === 'table' ? t.row : UNKNOWN; }
    if (/^[\w/<>-]+$/.test(x)) {
      const t = await this.varType(x, depth);
      if (t.k !== 'unknown') return t;
      if (await this.classInfo(x)) return { k: 'ref', cls: x };
    }
    return UNKNOWN;
  }
}

// ====================================================================== proposal building

class Bag {
  items: (Proposal & { g: number })[] = [];
  private g = 0;
  group() { this.g++; return this; }
  add(p: Proposal) { if (!this.items.some(i => i.label === p.label && i.kind === p.kind)) this.items.push({ ...p, g: this.g }); return this; }
  result(prefix: string, limit = 80): Proposal[] {
    const p = prefix.toLowerCase();
    const scored = this.items.map(i => {
      const l = i.label.toLowerCase().replace(/^[@#<]/, '');
      const s = !p ? 1 : l.startsWith(p) ? 0 : p.length >= 2 && l.includes(p) ? 2 : -1;
      return { i, s };
    }).filter(x => x.s >= 0 || (x.i.kind === 'snippet' && !p));
    scored.sort((a, b) => a.s - b.s || a.i.g - b.i.g || (a.i.sort ?? 0) - (b.i.sort ?? 0) || a.i.label.localeCompare(b.i.label));
    return scored.slice(0, limit).map(({ i }) => { const { g, ...rest } = i; void g; return rest; });
  }
}

function paramList(ps: Param[]): string {
  const f = (k: Param['kind']) => ps.filter(p => p.kind === k);
  const parts: string[] = [];
  for (const k of ['importing', 'exporting', 'changing', 'tables'] as const) if (f(k).length) parts.push(`${k.toUpperCase()} ${f(k).map(p => p.name + (p.optional ? '?' : '')).join(' ')}`);
  const r = f('returning')[0];
  if (r) parts.push(`RETURNING ${r.name} TYPE ${r.type}`);
  return parts.join('  ');
}

function callSnippet(name: string, ps: Param[] = []): string {
  const imp = ps.filter(p => p.kind === 'importing');
  const req = imp.filter(p => !p.optional);
  const chg = ps.filter(p => p.kind === 'changing' && !p.optional);
  const exp = ps.filter(p => p.kind === 'exporting');
  const hasRet = ps.some(p => p.kind === 'returning');
  if (!chg.length && (hasRet || !exp.length)) {
    if (!imp.length) return `${name}( )$0`;
    if (req.length === 0) return `${name}( $0 )`;
    if (req.length === 1 && imp.length === 1) return `${name}( $0 )`;
    return `${name}( ${req.map((p, i) => `${p.name} = ${i === 0 ? '$0' : ''}`).join(' ').replace(/\s+$/, '')} )`.replace('= $0 ', '= $0 ');
  }
  const sec: string[] = [];
  let caret = false;
  const put = (kw: string, list: Param[]) => {
    if (!list.length) return;
    sec.push(`${kw} ${list.map(p => { const s = `${p.name} = ${caret ? '' : '$0'}`; caret = true; return s.trimEnd(); }).join(' ')}`);
  };
  put('EXPORTING', req);
  put('IMPORTING', exp.slice(0, 1));
  put('CHANGING', chg);
  return `${name}( ${sec.join(' ')} )`;
}

function fmPattern(name: string, info: { params: Param[]; exceptions: string[] } | null, quoted: boolean): string {
  const q = quoted ? `${name}'` : `'${name}'`;
  if (!info) return `${q}$0`;
  const lines = [q];
  let caret = false;
  const w = Math.max(6, ...info.params.map(p => p.name.length));
  // optional inputs are commented out the way the SAP GUI and ADT patterns do it
  const commented = (p: Param) => p.optional && p.kind !== 'exporting';
  const section = (kw: string, list: Param[]) => {
    if (!list.length) return;
    const allOff = list.every(commented);
    lines.push(allOff ? `* ${kw}` : `  ${kw}`);
    for (const p of list) {
      const off = commented(p);
      const val = !caret && !off ? '$0' : '';
      if (!off) caret = true;
      lines.push(`${off ? '*   ' : '    '}${p.name.padEnd(w)} = ${val}`);
    }
  };
  section('EXPORTING', info.params.filter(p => p.kind === 'importing'));
  section('IMPORTING', info.params.filter(p => p.kind === 'exporting'));
  section('CHANGING', info.params.filter(p => p.kind === 'changing'));
  section('TABLES', info.params.filter(p => p.kind === 'tables'));
  if (info.exceptions.length) {
    lines.push('  EXCEPTIONS');
    info.exceptions.forEach((e, i) => lines.push(`    ${e.padEnd(w)} = ${i + 1}`));
    lines.push(`    ${'others'.padEnd(w)} = ${info.exceptions.length + 1}`);
  }
  // the period goes after the last line that is not a comment
  let lastActive = lines.length - 1;
  while (lastActive > 0 && lines[lastActive].startsWith('*')) lastActive--;
  lines[lastActive] = lines[lastActive].replace(/\s+$/, ' ') + '.';
  let out = lines.join('\n');
  if (!out.includes('$0')) out = out.replace(/\.(?=[^.]*$)/, '.$0');
  return out;
}

const EXEC_KW = ['DATA', 'FINAL', 'FIELD-SYMBOLS', 'CONSTANTS', 'TYPES', 'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'CASE', 'WHEN', 'ENDCASE', 'DO', 'ENDDO', 'WHILE', 'ENDWHILE',
  'LOOP AT', 'ENDLOOP', 'EXIT', 'CONTINUE', 'CHECK', 'RETURN', 'SELECT', 'SELECT SINGLE', 'ENDSELECT', 'INSERT', 'UPDATE', 'MODIFY', 'DELETE', 'APPEND', 'READ TABLE',
  'SORT', 'CLEAR', 'FREE', 'COLLECT', 'CONCATENATE', 'SPLIT', 'CONDENSE', 'REPLACE', 'FIND', 'TRANSLATE', 'SHIFT', 'ASSIGN', 'UNASSIGN', 'CREATE OBJECT', 'CALL METHOD',
  'CALL FUNCTION', 'RAISE EXCEPTION', 'TRY', 'CATCH', 'CLEANUP', 'ENDTRY', 'MESSAGE', 'COMMIT WORK', 'ROLLBACK WORK', 'AUTHORITY-CHECK', 'GET TIME STAMP FIELD', 'WAIT UP TO',
  'WRITE', 'NEW-LINE', 'FORMAT', 'SUBMIT', 'LEAVE PROGRAM', 'SET PARAMETER ID', 'GET PARAMETER ID', 'ENDMETHOD'];
const CLOUD_FORBIDDEN = new Set(['WRITE', 'NEW-LINE', 'FORMAT', 'SUBMIT', 'LEAVE PROGRAM', 'SET PARAMETER ID', 'GET PARAMETER ID', 'CALL FUNCTION']);
const DEF_KW = ['PUBLIC SECTION', 'PROTECTED SECTION', 'PRIVATE SECTION', 'METHODS', 'CLASS-METHODS', 'DATA', 'CLASS-DATA', 'CONSTANTS', 'TYPES', 'INTERFACES', 'ALIASES', 'EVENTS', 'ENDCLASS'];
const PROG_KW = ['REPORT', 'PROGRAM', 'PARAMETERS', 'SELECT-OPTIONS', 'SELECTION-SCREEN', 'TABLES', 'DATA', 'TYPES', 'CONSTANTS', 'START-OF-SELECTION', 'INITIALIZATION',
  'AT SELECTION-SCREEN', 'END-OF-SELECTION', 'CLASS', 'INTERFACE', 'FORM', 'INCLUDE', 'TYPE-POOLS'];
const COMPARE = ['=', '<>', '<', '>', '<=', '>=', 'IS INITIAL', 'IS NOT INITIAL', 'IS BOUND', 'IS NOT BOUND', 'IS ASSIGNED', 'IS NOT ASSIGNED', 'IS SUPPLIED', 'IS INSTANCE OF',
  'IN', 'NOT IN', 'BETWEEN', 'CP', 'NP', 'CS', 'NS', 'CA', 'NA', 'CO', 'CN'];

const SNIP_EXEC: [string, string, string][] = [
  ['if', 'IF $0.\n  \nENDIF.', 'IF … ENDIF'], ['ife', 'IF $0.\n  \nELSE.\n  \nENDIF.', 'IF … ELSE … ENDIF'],
  ['loop', 'LOOP AT $0 INTO DATA(ls_line).\n  \nENDLOOP.', 'LOOP AT … INTO DATA( )'], ['loopfs', 'LOOP AT $0 ASSIGNING FIELD-SYMBOL(<ls_line>).\n  \nENDLOOP.', 'LOOP AT … ASSIGNING'],
  ['select', 'SELECT FROM $0\n  FIELDS *\n  WHERE \n  INTO TABLE @DATA(lt_result).', 'SELECT … INTO TABLE'],
  ['selectsingle', 'SELECT SINGLE FROM $0\n  FIELDS *\n  WHERE \n  INTO @DATA(ls_result).', 'SELECT SINGLE'],
  ['read', 'READ TABLE $0 INTO DATA(ls_line) WITH KEY  = .', 'READ TABLE … WITH KEY'],
  ['try', 'TRY.\n    $0\n  CATCH cx_root INTO DATA(lx_error).\n    \nENDTRY.', 'TRY … CATCH … ENDTRY'],
  ['case', 'CASE $0.\n  WHEN .\n    \n  WHEN OTHERS.\n    \nENDCASE.', 'CASE … ENDCASE'], ['do', 'DO $0 TIMES.\n  \nENDDO.', 'DO n TIMES'],
  ['while', 'WHILE $0.\n  \nENDWHILE.', 'WHILE … ENDWHILE'], ['raise', 'RAISE EXCEPTION NEW $0( ).', 'RAISE EXCEPTION NEW'],
  ['message', "MESSAGE |$0| TYPE 'E'.", 'MESSAGE … TYPE'], ['append', 'APPEND VALUE #( $0 ) TO .', 'APPEND VALUE #( ) TO'],
  ['data', 'DATA($0) = .', 'Inline declaration'], ['final', 'FINAL($0) = .', 'Immutable inline declaration'],
  ['assert', 'cl_abap_unit_assert=>assert_equals( act = $0 exp =  ).', 'ABAP Unit assertion'],
];
const SNIP_DEF: [string, string, string][] = [
  ['methods', 'METHODS $0\n  IMPORTING \n  RETURNING VALUE(rv_result) TYPE .', 'METHODS with signature'],
  ['data', 'DATA $0 TYPE .', 'Attribute'], ['constants', 'CONSTANTS $0 TYPE  VALUE .', 'Constant'],
  ['types', 'TYPES: BEGIN OF $0,\n         ,\n       END OF .', 'Structured type'], ['test', 'METHODS $0 FOR TESTING RAISING cx_static_check.', 'Test method'],
];
const SNIP_PROG: [string, string, string][] = [
  ['lcl', 'CLASS lcl_$0 DEFINITION FINAL.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\n\nCLASS lcl_ IMPLEMENTATION.\n  METHOD run.\n    \n  ENDMETHOD.\nENDCLASS.', 'Local class'],
  ['ltc', "CLASS ltc_$0 DEFINITION FINAL FOR TESTING\n  DURATION SHORT RISK LEVEL HARMLESS.\n  PRIVATE SECTION.\n    METHODS first_test FOR TESTING.\nENDCLASS.\n\nCLASS ltc_ IMPLEMENTATION.\n  METHOD first_test.\n    cl_abap_unit_assert=>fail( 'Implement me' ).\n  ENDMETHOD.\nENDCLASS.", 'Local test class'],
  ['parameters', 'PARAMETERS $0 TYPE .', 'Selection parameter'], ['selectoptions', 'SELECT-OPTIONS $0 FOR .', 'Selection range'],
];

// ====================================================================== ABAP

export async function completeAbap(req: CompletionRequest): Promise<Proposal[]> {
  const lines = req.source.split('\n');
  if (req.line < 0 || req.line >= lines.length) return [];
  const line = lines[req.line] ?? '';
  const before = line.slice(0, req.col);
  const bag = new Bag();
  const cat = req.catalog;

  // ---- comments and strings
  if (before.startsWith('*')) return [];
  const sg = segs(before);
  const last = sg[sg.length - 1];
  if (last?.t === 'com') {
    if (/"#EC\s*\w*$/.test(before)) ['CI_NOORDER', 'CI_NOWHERE', 'NEEDED', 'NOTEXT', 'CI_SUBRC', 'CI_VALPAR', 'CI_CYCLO'].forEach(e => bag.add({ label: e, insert: e, kind: 'pragma' }));
    return bag.result((before.match(/\w*$/) as RegExpMatchArray)[0]);
  }
  let inFmString = false;
  if (last?.t === 'str') {
    const q = last.s[0];
    const closed = last.s.length > 1 && last.s.endsWith(q);
    if (!closed) {
      if (q === "'" && /CALL\s+FUNCTION\s*$/i.test(before.slice(0, before.length - last.s.length))) inFmString = true;
      else if (q === '|' && (last.s.split('{').length > last.s.split('}').length)) { /* inside a template expression: continue as code */ }
      else return [];
    } else return [];
  }

  const prefix = (before.match(/[\w/]*$/) as RegExpMatchArray)[0];
  const P = prefix.toUpperCase();
  const { text: stmt, full: stmtFull, colonHead } = currentStatement(lines, req.line, req.col);
  const lead = stmt.slice(0, stmt.length - prefix.length);
  const leadT = lead.replace(/\s+/g, ' ');
  const { syms, types } = collectSymbols([req.source, ...(req.related || [])].join('\n.\n'));

  // scope: own class and where we are
  let ownClass: string | null = null, scope: 'program' | 'classdef' | 'classimpl' | 'method' = 'program';
  for (const s of statements(lines.slice(0, req.line + 1).map((l, i) => (i === req.line ? l.slice(0, req.col) : l)))) {
    if (s.open) continue;
    if (s.kw === 'CLASS' && s.words.includes('DEFINITION') && !s.words.includes('DEFERRED')) { ownClass = lc(s.words[1]); scope = 'classdef'; }
    else if (s.kw === 'INTERFACE' && !s.words.includes('DEFERRED')) { ownClass = lc(s.words[1]); scope = 'classdef'; }
    else if (s.kw === 'CLASS' && s.words.includes('IMPLEMENTATION')) { ownClass = lc(s.words[1]); scope = 'classimpl'; }
    else if (s.kw === 'METHOD') scope = 'method';
    else if (s.kw === 'ENDMETHOD') scope = 'classimpl';
    else if (s.kw === 'ENDCLASS' || s.kw === 'ENDINTERFACE') scope = 'program';
    else if (s.kw === 'FORM' || s.kw === 'START-OF-SELECTION' || s.kw === 'INITIALIZATION') scope = 'method';
  }
  const own = [req.source, ...(req.related || [])];
  const R = new Resolver(cat, syms, types, ownClass, own);

  const vars = (filter?: (s: Sym) => boolean, at = '') => {
    for (const s of syms.values()) if (s.kind !== 'type' && (!filter || filter(s))) bag.add({ label: at + s.name, insert: at + s.name, kind: 'variable', detail: s.type.startsWith('@') ? '' : s.type });
  };
  const entries = async (kinds: EntryKind[], wrap?: (e: CatEntry) => Partial<Proposal>) => {
    const list = await cat.find(P, kinds, 60).catch(() => [] as CatEntry[]);
    for (const e of list) bag.add({ label: lc(e.name), insert: lc(e.name), kind: KIND_OF_ENTRY[e.kind], detail: e.desc, ...(wrap ? wrap(e) : {}) });
  };
  const typeSlot = async (refTo: boolean) => {
    bag.group();
    if (refTo) { await entries(['class', 'interface', 'exception']); bag.add({ label: 'data', insert: 'data', kind: 'type', detail: 'Generic data reference' }); return; }
    for (const [n] of types) if (!n.startsWith('@')) bag.add({ label: n, insert: n, kind: 'type', detail: 'local type' });
    if (ownClass) for (const m of await R.members(ownClass)) if (m.kind === 'type') bag.add({ label: m.name, insert: m.name, kind: 'type', detail: `${ownClass} type` });
    bag.group();
    for (const [n, d] of BUILTIN_TYPES) bag.add({ label: n, insert: n, kind: 'type', detail: d });
    bag.add({ label: 'REF TO', insert: 'REF TO ', kind: 'keyword' }).add({ label: 'STANDARD TABLE OF', insert: 'STANDARD TABLE OF $0 WITH EMPTY KEY', kind: 'snippet', detail: 'Table type' })
      .add({ label: 'SORTED TABLE OF', insert: 'SORTED TABLE OF $0 WITH UNIQUE KEY ', kind: 'snippet' }).add({ label: 'HASHED TABLE OF', insert: 'HASHED TABLE OF $0 WITH UNIQUE KEY ', kind: 'snippet' })
      .add({ label: 'RANGE OF', insert: 'RANGE OF ', kind: 'keyword' }).add({ label: 'LINE OF', insert: 'LINE OF ', kind: 'keyword' });
    bag.group();
    await entries(['dtel', 'table', 'structure', 'cds', 'ttyp', 'view']);
  };
  const memberProposals = async (cls: string, wantStatic: boolean | null) => {
    const ms = await R.members(cls);
    const same = ownClass && lc(cls) === ownClass;
    const rank = { method: 0, attribute: 1, event: 2, constant: 3, type: 4 } as const;
    for (const [idx, m] of ms.entries()) {
      if (!same && m.visibility !== 'public') continue;
      if (wantStatic === true && !m.static && m.kind !== 'type') continue;
      if (wantStatic === false && m.kind === 'type') continue;
      const sort = rank[m.kind] * 1000 + idx;
      if (m.kind === 'method') bag.add({ label: m.name, insert: callSnippet(m.name, m.params), kind: 'method', detail: `${m.owner.toLowerCase()}${m.static ? ' · static' : ''}`, doc: paramList(m.params || []), sort });
      else bag.add({ label: m.name, insert: m.name, kind: m.kind === 'constant' ? 'constant' : m.kind === 'type' ? 'type' : m.kind === 'event' ? 'keyword' : 'field', detail: m.type || m.kind, sort });
    }
  };
  const valueSlot = async () => {
    bag.group(); vars();
    bag.add({ label: 'abap_true', insert: 'abap_true', kind: 'constant' }).add({ label: 'abap_false', insert: 'abap_false', kind: 'constant' }).add({ label: 'me', insert: 'me->', kind: 'variable', detail: ownClass || '' });
    bag.group(); for (const [n, ins, d] of CONSTRUCTORS) bag.add({ label: n, insert: ins, kind: 'function', detail: d });
    for (const [n, ins, d] of ABAP_FUNCTIONS) bag.add({ label: n, insert: ins, kind: 'function', detail: d });
    bag.add({ label: 'sy', insert: 'sy-', kind: 'variable', detail: 'System fields' });
    if (P) { bag.group(); await entries(['class', 'interface'], e => ({ insert: lc(e.name) + '=>' })); }
  };
  const fieldsOfTI = (t: TI) => { if (t.k === 'struct') for (const f of t.fields) bag.add({ label: f.name, insert: f.name, kind: 'field', detail: f.type, doc: f.desc }); };

  // ---- FM name inside CALL FUNCTION '…
  if (inFmString) {
    const list = await cat.find(P, ['fm'], 60).catch(() => []);
    for (const e of list) bag.add({ label: e.name, insert: fmPattern(e.name, await cat.fm(e.name).catch(() => null), true), kind: 'fm', detail: e.desc });
    return bag.result(P);
  }

  // ---- pragmas and field symbols
  const pragma = before.match(/##(\w*)$/);
  if (pragma) { for (const [n, d] of PRAGMAS) bag.add({ label: n, insert: n.slice(2), kind: 'pragma', detail: d }); return bag.result(pragma[1]); }
  if (/(^|[\s(,=])<$/.test(lead) && (prefix || /\b(ASSIGNING|ASSIGN|FIELD-SYMBOLS|UNASSIGN)\s*<$/i.test(lead) || /^\s*<$/.test(lead))) {
    for (const s of syms.values()) if (s.kind === 'fs') bag.add({ label: s.name, insert: s.name.slice(1), kind: 'variable', detail: s.type });
    return bag.result(P);
  }

  // ---- member access
  let m: RegExpMatchArray | null;
  if ((m = leadT.match(/((?:[\w/]+|\))(?:\s*\([^()]*\))?)->$/))) {
    const ownerExpr = leadT.slice(0, -2).match(/([\w/]+(?:(?:->|=>)[\w~]+\s*\([^()]*\))*(?:\s*\([^()]*\))?)$/)?.[1] || m[1];
    const t = await R.exprType(ownerExpr);
    if (t.k === 'ref') await memberProposals(t.cls, false);
    if (!bag.items.length && /^out$/i.test(ownerExpr)) await memberProposals('if_oo_adt_classrun_out', false);
    return bag.result(P);
  }
  if ((m = leadT.match(/([\w/]+)=>$/))) {
    await memberProposals(m[1], true);
    return bag.result(P);
  }
  if ((m = leadT.match(/([\w/]+)~$/))) {
    const owner = m[1];
    if (/^\s*(SELECT|WITH)\b/i.test(stmtFull) || /\bFROM\b/i.test(stmtFull)) {
      const src = sqlSources(stmtFull).find(s => lc(s.alias) === lc(owner) || lc(s.name) === lc(owner));
      const f = await cat.fieldsOf(src ? src.name : owner).catch(() => null);
      f?.forEach(x => bag.add({ label: lc(x.name), insert: lc(x.name), kind: 'field', detail: x.type, doc: x.desc }));
    } else {
      const info = await R.classInfo(owner);
      if (info) for (const mm of info.members) bag.add({ label: mm.name, insert: mm.kind === 'method' && !/^\s*METHOD\b/i.test(leadT) ? callSnippet(mm.name, mm.params) : mm.name, kind: mm.kind === 'method' ? 'method' : 'field', detail: info.name.toLowerCase(), doc: paramList(mm.params || []) });
    }
    return bag.result(P);
  }
  if ((m = leadT.match(/([\w/<>]+(?:-[\w]+)*)-$/)) && !/\s-$/.test(lead)) {
    const t = await R.varType(m[1]);
    fieldsOfTI(t.k === 'table' ? t.row : t);
    return bag.result(P);
  }

  // ---- SQL
  if (/^\s*(SELECT|WITH)\b/i.test(stmt) || /^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO|MODIFY)\s+[\w/]+\s+(SET|FROM|WHERE)\b/i.test(stmt)) {
    const r = await completeSql(req, bag, leadT, stmtFull, P, vars);
    if (r) return bag.result(P);
  }

  // ---- call parameters
  const open = unclosedParen(leadT);
  if (open >= 0) {
    const callee = leadT.slice(0, open).trimEnd();
    const inside = leadT.slice(open + 1);
    if (/=\s*$/.test(inside) || /[+\-*/&]\s*$/.test(inside) || !/[\w~]$/.test(callee)) { await valueSlot(); return bag.result(P); }
    let params: Param[] = [];
    const cm = callee.match(/(?:([\w/]+(?:->[\w~]+\s*\([^()]*\))*|\))(->|=>))?([\w~]+)$/);
    const nw = callee.match(/\bNEW\s+([\w/]+)$/i);
    if (nw) params = (await R.members(nw[1])).find(x => x.name === 'constructor')?.params || [];
    else if (cm && !KWSET.has(cm[3].toUpperCase())) {
      const fn = ABAP_FUNCTIONS.find(f => f[0] === lc(cm[3]));
      if (!cm[2] && fn) { await valueSlot(); return bag.result(P); }
      const ownerT = cm[2] === '=>' ? { k: 'ref', cls: cm[1] } as TI : cm[2] === '->' ? await R.exprType(cm[1]) : ownClass ? { k: 'ref', cls: ownClass } as TI : UNKNOWN;
      if (ownerT.k === 'ref') params = (await R.members(ownerT.cls)).find(x => x.name === lc(cm[3]))?.params || [];
    }
    if (params.length) {
      const used = new Set([...inside.matchAll(/([\w/]+)\s*=/g)].map(x => lc(x[1])));
      const sec = (inside.toUpperCase().match(/\b(EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)\b(?!.*\b(EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)\b)/) || [])[1];
      const want: Param['kind'][] = sec === 'IMPORTING' ? ['exporting'] : sec === 'CHANGING' ? ['changing'] : sec === 'RECEIVING' ? ['returning'] : sec === 'EXPORTING' ? ['importing'] : ['importing', 'exporting', 'changing'];
      bag.group();
      for (const p of params) if (want.includes(p.kind) && !used.has(p.name) && p.kind !== 'returning' || (sec === 'RECEIVING' && p.kind === 'returning')) bag.add({ label: p.name, insert: `${p.name} = `, kind: 'parameter', detail: `${p.kind}${p.optional ? ' · optional' : ''}`, doc: p.type, sort: p.optional ? 1 : 0 });
      bag.group();
      for (const k of ['EXPORTING', 'IMPORTING', 'CHANGING', 'RECEIVING', 'EXCEPTIONS']) bag.add({ label: k, insert: k + ' ', kind: 'keyword' });
      if (!/[\w~]\s*$/.test(inside) || P) vars();
      return bag.result(P);
    }
    if (!inside.trim() || /\s$/.test(inside)) { await valueSlot(); return bag.result(P); }
  }

  // ---- CALL FUNCTION 'X' parameters
  if ((m = stmt.match(/^\s*CALL\s+FUNCTION\s+'([\w/]+)'([\s\S]*)$/i))) {
    const after = m[2].slice(0, m[2].length - prefix.length);
    if (/=\s*$/.test(after)) { await valueSlot(); return bag.result(P); }
    const info = await cat.fm(m[1]).catch(() => null);
    const sec = (after.toUpperCase().match(/\b(EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS)\b(?![\s\S]*\b(EXPORTING|IMPORTING|CHANGING|TABLES|EXCEPTIONS)\b)/) || [])[1];
    const map: Record<string, Param['kind']> = { EXPORTING: 'importing', IMPORTING: 'exporting', CHANGING: 'changing', TABLES: 'tables' };
    if (info && sec && sec !== 'EXCEPTIONS') for (const p of info.params.filter(x => x.kind === map[sec])) bag.add({ label: p.name, insert: `${p.name} = `, kind: 'parameter', detail: p.type, sort: p.optional ? 1 : 0 });
    if (info && sec === 'EXCEPTIONS') { info.exceptions.forEach((e, i) => bag.add({ label: e, insert: `${e} = ${i + 1}`, kind: 'exception' })); bag.add({ label: 'OTHERS', insert: `OTHERS = ${info.exceptions.length + 1}`, kind: 'keyword' }); }
    bag.group();
    ['EXPORTING', 'IMPORTING', 'CHANGING', 'TABLES', 'EXCEPTIONS', 'DESTINATION', 'STARTING NEW TASK', 'IN UPDATE TASK'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    return bag.result(P);
  }
  if (/\bCALL\s+FUNCTION\s+$/i.test(leadT)) {
    const list = await cat.find(P, ['fm'], 60).catch(() => []);
    for (const e of list) bag.add({ label: e.name.toLowerCase(), insert: fmPattern(e.name, await cat.fm(e.name).catch(() => null), false), kind: 'fm', detail: e.desc });
    return bag.result(P);
  }

  // ---- slots after keywords
  if (/\b(TYPE|LIKE)\s+REF\s+TO\s+$/i.test(leadT) || /\bTYPE\s+(STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF\s+REF\s+TO\s+$/i.test(leadT)) { await typeSlot(true); return bag.result(P); }
  if (/\bTYPE\s+((STANDARD|SORTED|HASHED|ANY|INDEX)\s+)?TABLE\s+OF\s+$/i.test(leadT) || /\b(TYPE|RANGE\s+OF|LINE\s+OF)\s+$/i.test(leadT) || /\bTYPE\s+(RANGE|LINE)\s+OF\s+$/i.test(leadT)) {
    if (/\bTYPE\s+$/i.test(leadT) && /^\s*(MESSAGE|RAISE)\b/i.test(leadT)) { /* MESSAGE … TYPE 'E' / RAISE EXCEPTION TYPE */ }
    else { await typeSlot(false); return bag.result(P); }
  }
  if (/\bLIKE\s+(LINE\s+OF\s+)?$/i.test(leadT)) { vars(); return bag.result(P); }
  if (/^\s*MESSAGE\b.*\bTYPE\s+$/i.test(leadT)) { [["'E'", 'Error'], ["'W'", 'Warning'], ["'I'", 'Information'], ["'S'", 'Status'], ["'A'", 'Abort'], ["'X'", 'Exit']].forEach(([v, d]) => bag.add({ label: v, insert: v, kind: 'constant', detail: d })); return bag.result(P); }
  if (/\bRAISE\s+EXCEPTION\s+$/i.test(leadT)) { bag.add({ label: 'NEW', insert: 'NEW ', kind: 'keyword' }).add({ label: 'TYPE', insert: 'TYPE ', kind: 'keyword' }); bag.group(); vars(s => /ref to [\w/]*cx_/.test(s.type)); return bag.result(P); }
  if (/\b(RAISE\s+EXCEPTION\s+(TYPE|NEW)|RAISE\s+RESUMABLE\s+EXCEPTION\s+(TYPE|NEW)|CATCH(\s+BEFORE\s+UNWIND)?|RAISING(\s+[\w/]+)*)\s+$/i.test(leadT) && !/\bINTO\s+$/i.test(leadT)) {
    if (/^\s*CATCH\s+[\w/]+(\s+[\w/]+)*\s+$/i.test(leadT)) bag.add({ label: 'INTO DATA( )', insert: 'INTO DATA($0)', kind: 'snippet' });
    await entries(['exception']);
    return bag.result(P);
  }
  if (/\bINTERFACES\s+$/i.test(leadT)) { await entries(['interface']); return bag.result(P); }
  if (/\bINHERITING\s+FROM\s+$/i.test(leadT)) { await entries(['class', 'exception']); return bag.result(P); }
  if (/\b(NEW|CREATE\s+OBJECT\s+\S+\s+TYPE)\s+$/i.test(leadT)) { bag.add({ label: '#( )', insert: '#( $0 )', kind: 'snippet', detail: 'Type from context' }); bag.group(); await entries(['class', 'exception'], e => ({ insert: /^NEW/i.test(leadT.trim().split(' ').pop() || '') ? lc(e.name) + '( $0 )' : lc(e.name) })); return bag.result(P); }
  if (/\bCAST\s+$/i.test(leadT)) { bag.add({ label: '#( )', insert: '#( $0 )', kind: 'snippet' }); await entries(['class', 'interface'], e => ({ insert: lc(e.name) + '( $0 )' })); return bag.result(P); }
  if (/\b(VALUE|CONV|CORRESPONDING|EXACT|REDUCE|COND|SWITCH|FILTER|REF)\s+$/i.test(leadT)) {
    bag.add({ label: '#( )', insert: '#( $0 )', kind: 'snippet', detail: 'Type from context' });
    for (const [n] of types) if (!n.startsWith('@')) bag.add({ label: n, insert: n + '( $0 )', kind: 'type' });
    await entries(['dtel', 'table', 'structure', 'ttyp', 'cds'], e => ({ insert: lc(e.name) + '( $0 )' }));
    return bag.result(P);
  }
  if (/^\s*METHOD\s+$/i.test(leadT) && ownClass) {
    const defSrc = own.join('\n.\n');
    const info = parseClassSource(defSrc, ownClass);
    const done = new Set(statements(defSrc.split('\n')).filter(s => s.kw === 'METHOD').map(s => lc(s.words[1] || '')));
    for (const mm of info.members) if (mm.kind === 'method' && !done.has(mm.name)) bag.add({ label: mm.name, insert: `${mm.name}.\n  $0\nENDMETHOD.`, kind: 'method', detail: paramList(mm.params || []) });
    for (const i of info.interfaces) for (const mm of (await R.classInfo(i))?.members || []) {
      const n = `${lc(i)}~${mm.name}`;
      if (mm.kind === 'method' && !done.has(n)) bag.add({ label: n, insert: `${n}.\n  $0\nENDMETHOD.`, kind: 'method', detail: paramList(mm.params || []) });
    }
    return bag.result(P);
  }
  if ((m = leadT.match(/^\s*(CLASS-)?METHODS\s+[\w/~]+\s(.*)$/i))) {
    ['IMPORTING', 'EXPORTING', 'CHANGING', 'RETURNING VALUE( )', 'RAISING', 'FOR TESTING', 'REDEFINITION', 'ABSTRACT', 'FINAL', 'DEFAULT IGNORE', 'OPTIONAL', 'TYPE', 'DEFAULT'].forEach(k =>
      bag.add({ label: k, insert: k === 'RETURNING VALUE( )' ? 'RETURNING VALUE($0) TYPE ' : k + ' ', kind: 'keyword' }));
    if (/\bRETURNING\s+VALUE\($/i.test(leadT)) return [];
    return bag.result(P);
  }
  if (/^\s*CLASS\s+[\w/]+\s+(DEFINITION\b.*)?$/i.test(leadT) && !/IMPLEMENTATION/i.test(leadT)) {
    ['DEFINITION', 'IMPLEMENTATION', 'PUBLIC', 'FINAL', 'CREATE PUBLIC', 'CREATE PRIVATE', 'INHERITING FROM', 'ABSTRACT', 'FOR TESTING', 'DURATION SHORT', 'RISK LEVEL HARMLESS', 'DEFERRED', 'LOCAL FRIENDS']
      .forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    return bag.result(P);
  }
  if ((m = leadT.match(/^\s*(LOOP\s+AT|READ\s+TABLE|SORT|DELETE|MODIFY|INSERT|APPEND|CLEAR|FREE|REFRESH|DESCRIBE\s+TABLE)\s+$/i))) {
    vars(s => !/^LOOP|^READ|^SORT|^DESCRIBE/i.test(m![1]) || /table|@row|@range|^tt_|^ty_t/.test(s.type) || s.type === '');
    if (/^APPEND|^INSERT/i.test(m[1])) bag.add({ label: 'VALUE #( )', insert: 'VALUE #( $0 )', kind: 'snippet' }).add({ label: 'INITIAL LINE TO', insert: 'INITIAL LINE TO ', kind: 'keyword' }).add({ label: 'LINES OF', insert: 'LINES OF ', kind: 'keyword' });
    return bag.result(P);
  }
  if ((m = leadT.match(/^\s*LOOP\s+AT\s+([\w/>-]+)\s(.*)$/i)) && !/\b(INTO|ASSIGNING|WHERE)\s*$/i.test(leadT) || (m = leadT.match(/^\s*READ\s+TABLE\s+([\w/>-]+)\s(.*)$/i)) && !/\b(INTO|ASSIGNING|KEY|INDEX)\s*$/i.test(leadT)) {
    const itab = m[1];
    if (/\b(WHERE|KEY|AND|OR|BY)\s+([\w]+\s*=\s*[\w'@-]+\s+)*$/i.test(leadT) || /\bWITH\s+(TABLE\s+)?KEY\s+$/i.test(leadT)) {
      const t = await R.varType(itab); fieldsOfTI(t.k === 'table' ? t.row : UNKNOWN); return bag.result(P);
    }
    if (/=\s*$/.test(leadT)) { await valueSlot(); return bag.result(P); }
    const isLoop = /^\s*LOOP/i.test(leadT);
    (isLoop ? [['INTO DATA( )', 'INTO DATA($0)'], ['ASSIGNING FIELD-SYMBOL( )', 'ASSIGNING FIELD-SYMBOL(<$0>)'], ['REFERENCE INTO DATA( )', 'REFERENCE INTO DATA($0)'], ['WHERE', 'WHERE '], ['GROUP BY', 'GROUP BY '], ['FROM', 'FROM '], ['TO', 'TO '], ['USING KEY', 'USING KEY ']]
      : [['INTO DATA( )', 'INTO DATA($0)'], ['ASSIGNING FIELD-SYMBOL( )', 'ASSIGNING FIELD-SYMBOL(<$0>)'], ['WITH KEY', 'WITH KEY '], ['WITH TABLE KEY', 'WITH TABLE KEY '], ['INDEX', 'INDEX '], ['TRANSPORTING NO FIELDS', 'TRANSPORTING NO FIELDS'], ['BINARY SEARCH', 'BINARY SEARCH'], ['REFERENCE INTO DATA( )', 'REFERENCE INTO DATA($0)']])
      .forEach(([l, i]) => bag.add({ label: l, insert: i, kind: 'keyword' }));
    return bag.result(P);
  }
  if ((m = leadT.match(/^\s*SORT\s+([\w/>-]+)\s+(BY\s+)?(.*)$/i))) {
    if (!/\bBY\b/i.test(leadT)) { ['BY', 'ASCENDING', 'DESCENDING', 'STABLE'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' })); return bag.result(P); }
    const t = await R.varType(m[1]); fieldsOfTI(t.k === 'table' ? t.row : UNKNOWN);
    ['ASCENDING', 'DESCENDING', 'AS TEXT'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    return bag.result(P);
  }
  if ((m = leadT.match(/^\s*(APPEND|INSERT)\s+(\S+)\s+$/i)) && !/^(VALUE|INITIAL|LINES)$/i.test(m[2])) { bag.add({ label: 'TO', insert: 'TO ', kind: 'keyword' }).add({ label: 'INTO TABLE', insert: 'INTO TABLE ', kind: 'keyword' }); return bag.result(P); }
  if (/^\s*(APPEND|INSERT)\b.*\b(TO|INTO\s+TABLE)\s+$/i.test(leadT)) { vars(s => /table|@row|^tt_/.test(s.type) || !s.type); return bag.result(P); }
  if (/\b(INTO|ASSIGNING|REFERENCE\s+INTO)\s+$/i.test(leadT)) {
    bag.add({ label: 'DATA( )', insert: 'DATA($0)', kind: 'snippet' }).add({ label: 'FIELD-SYMBOL( )', insert: 'FIELD-SYMBOL(<$0>)', kind: 'snippet' });
    vars(); return bag.result(P);
  }
  if ((m = leadT.match(/^\s*(DATA|CLASS-DATA|STATICS|CONSTANTS|PARAMETERS|FIELD-SYMBOLS|TYPES)\s+(<?[\w/]+>?)\s+$/i)) || (colonHead && /^\s*[\w-]+\s+<?[\w/]+>?\s+$/.test(leadT))) {
    ['TYPE', 'LIKE', 'TYPE REF TO', 'TYPE STANDARD TABLE OF', 'VALUE', 'READ-ONLY', 'LENGTH', 'DECIMALS'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    return bag.result(P);
  }

  // ---- logical expressions
  const logical = /^\s*(IF|ELSEIF|WHILE|CHECK|WHEN)\b/i.test(leadT) || /\b(WHERE|AND|OR|NOT|WHEN)\b/i.test(leadT) && /\bCOND\b|\bIF\b/i.test(leadT);
  if (logical) {
    if (/(^\s*(IF|ELSEIF|WHILE|CHECK|WHEN)|\b(AND|OR|NOT|\())\s*$/i.test(leadT) || /[=<>]\s*$/.test(leadT) || /\b(IS\s+INSTANCE\s+OF)\s*$/i.test(leadT)) {
      await valueSlot();
      bag.group(); ['NOT', 'line_exists( )'].forEach(k => bag.add({ label: k, insert: k === 'NOT' ? 'NOT ' : 'line_exists( $0[ ] )', kind: k === 'NOT' ? 'keyword' : 'function' }));
      return bag.result(P);
    }
    if (/[\w)\]'-]\s+$/.test(leadT)) {
      for (const o of COMPARE) bag.add({ label: o, insert: o + ' ', kind: 'operator' });
      ['AND', 'OR', 'THEN'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
      return bag.result(P);
    }
  }

  // ---- value positions: after = or operator
  if (/(^|[^=<>!])=\s*$/.test(leadT) || /[+\-*/&]\s+$/.test(leadT) || /\b(RETURN|EXPORTING|THEN|ELSE)\s+$/i.test(leadT)) { await valueSlot(); return bag.result(P); }

  // ---- statement start
  if (!leadT.trim() || (colonHead && !lead.slice(colonHead.length).trim())) {
    const cloud = !!req.cloud;
    if (scope === 'classdef') {
      bag.group(); for (const k of DEF_KW) bag.add({ label: k, insert: /SECTION$/.test(k) ? k + '.' : k + ' ', kind: 'keyword' });
      bag.group(); for (const [n, ins, d] of SNIP_DEF) bag.add({ label: n, insert: ins, kind: 'snippet', detail: d });
    } else if (scope === 'classimpl') {
      bag.add({ label: 'METHOD', insert: 'METHOD ', kind: 'keyword' }).add({ label: 'ENDCLASS', insert: 'ENDCLASS.', kind: 'keyword' });
    } else {
      bag.group(); vars();
      if (ownClass) { bag.add({ label: 'me', insert: 'me->', kind: 'variable', detail: ownClass }); for (const mm of await R.members(ownClass)) if (mm.kind === 'method') bag.add({ label: mm.name, insert: callSnippet(mm.name, mm.params) + '.', kind: 'method', detail: 'own method', doc: paramList(mm.params || []) }); }
      bag.group(); for (const [n, ins, d] of SNIP_EXEC) bag.add({ label: n, insert: ins, kind: 'snippet', detail: d });
      bag.group(); for (const k of EXEC_KW) if (!(cloud && CLOUD_FORBIDDEN.has(k))) bag.add({ label: k, insert: k + (/^END|^ELSE$|^EXIT$|^CONTINUE$|^RETURN$|^TRY$|^CLEANUP$|WORK$/.test(k) ? '.' : ' '), kind: 'keyword' });
      if (scope === 'program') { bag.group(); for (const k of PROG_KW) bag.add({ label: k, insert: k + (/SELECTION$|^INITIALIZATION$/.test(k) ? '.' : ' '), kind: 'keyword' }); for (const [n, ins, d] of SNIP_PROG) bag.add({ label: n, insert: ins, kind: 'snippet', detail: d }); }
      if (P) { bag.group(); await entries(['class', 'interface'], e => ({ insert: lc(e.name) + '=>' })); }
    }
    return bag.result(P);
  }

  // ---- fallback: anything that fits the prefix
  if (!P) return [];
  bag.group(); vars();
  bag.group(); for (const [n, ins, d] of ABAP_FUNCTIONS) bag.add({ label: n, insert: ins, kind: 'function', detail: d });
  for (const k of KWSET) bag.add({ label: k, insert: k, kind: 'keyword' });
  bag.group(); await entries(['class', 'interface', 'exception', 'table', 'cds', 'dtel', 'structure']);
  return bag.result(P);
}

function unclosedParen(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) return i; depth--; }
    else if (c === '.' ) return -1;
  }
  return -1;
}

function sqlSources(stmt: string): { name: string; alias: string }[] {
  const out: { name: string; alias: string }[] = [];
  for (const m of stmt.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|MODIFY)\s+([\w/]+)(?:\s+AS\s+(\w+))?/gi)) {
    if (/^(TABLE|@|DATA|CORRESPONDING)/i.test(m[1])) continue;
    out.push({ name: m[1], alias: m[2] || m[1] });
  }
  return out;
}

async function completeSql(req: CompletionRequest, bag: Bag, lead: string, full: string, P: string, vars: (f?: (s: Sym) => boolean, at?: string) => void): Promise<boolean> {
  const cat = req.catalog;
  const sources = sqlSources(full);
  const clauseRe = /\b(SELECT\s+SINGLE|SELECT\s+DISTINCT|SELECT|FROM|INNER\s+JOIN|LEFT\s+OUTER\s+JOIN|RIGHT\s+OUTER\s+JOIN|JOIN|ON|FIELDS|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|INTO\s+CORRESPONDING\s+FIELDS\s+OF\s+TABLE|INTO\s+TABLE|INTO|APPENDING\s+TABLE|UP\s+TO|FOR\s+ALL\s+ENTRIES\s+IN|SET)\b/gi;
  let clause = '', clauseEnd = 0;
  for (const m of lead.matchAll(clauseRe)) { clause = m[1].toUpperCase().replace(/\s+/g, ' '); clauseEnd = (m.index ?? 0) + m[0].length; }
  const after = lead.slice(clauseEnd);
  const addSources = async () => {
    const list = await cat.find(P, ['table', 'cds', 'view'], 60).catch(() => [] as CatEntry[]);
    for (const e of list) bag.add({ label: lc(e.name), insert: lc(e.name), kind: 'table', detail: `${e.kind === 'cds' ? 'CDS' : 'Table'} · ${e.desc}` });
  };
  const addFields = async () => {
    const multi = sources.length > 1;
    for (const s of sources) {
      const f = await cat.fieldsOf(s.name).catch(() => null);
      for (const x of f || []) if (x.name !== '.include' && x.type !== 'association') bag.add({ label: multi ? `${lc(s.alias)}~${lc(x.name)}` : lc(x.name), insert: multi ? `${lc(s.alias)}~${lc(x.name)}` : lc(x.name), kind: 'field', detail: `${lc(s.name)} · ${x.type}`, doc: x.desc });
    }
  };
  if (/^(FROM|JOIN|INNER JOIN|LEFT OUTER JOIN|RIGHT OUTER JOIN)$/.test(clause) && !after.trim()) { await addSources(); return true; }
  if (/^(FROM|.*JOIN)$/.test(clause) && /^\s*[\w/]+(\s+AS\s+\w+)?\s+$/i.test(after)) {
    ['AS', 'FIELDS', 'WHERE', 'INNER JOIN', 'LEFT OUTER JOIN', 'ON', 'INTO TABLE @DATA( )', 'INTO @DATA( )', 'ORDER BY', 'GROUP BY', 'UP TO', 'FOR ALL ENTRIES IN']
      .forEach(k => bag.add({ label: k, insert: k.endsWith('( )') ? k.replace('( )', '($0)') : k + ' ', kind: 'keyword' }));
    return true;
  }
  if (/^(INTO|INTO TABLE|APPENDING TABLE|INTO CORRESPONDING FIELDS OF TABLE)$/.test(clause)) {
    if (/@$/.test(lead.trimEnd())) { bag.add({ label: 'DATA( )', insert: 'DATA($0)', kind: 'snippet' }); vars(); return true; }
    if (clause === 'INTO') bag.add({ label: 'TABLE @DATA( )', insert: 'TABLE @DATA($0)', kind: 'snippet' }).add({ label: 'CORRESPONDING FIELDS OF TABLE', insert: 'CORRESPONDING FIELDS OF TABLE @', kind: 'keyword' });
    bag.add({ label: '@DATA( )', insert: '@DATA($0)', kind: 'snippet' });
    vars(undefined, '@');
    return true;
  }
  if (/^(SELECT|SELECT SINGLE|SELECT DISTINCT|FIELDS|WHERE|ON|GROUP BY|HAVING|ORDER BY|SET)$/.test(clause)) {
    if (/@\s*$/.test(lead)) { vars(); return true; }
    if (/(=|<>|<|>|<=|>=|\bIN|\bLIKE|\bBETWEEN)\s*$/i.test(after) || /\bAND\s*$/i.test(after) && /\bBETWEEN\s+\S+\s+AND\s*$/i.test(after)) { vars(undefined, '@'); bag.add({ label: "''", insert: "'$0'", kind: 'constant' }); return true; }
    if (/^(WHERE|ON|HAVING)$/.test(clause) && /[\w~)']\s+$/.test(after) && !/\b(AND|OR|NOT)\s+$/i.test(after)) {
      ['=', '<>', '<', '>', '<=', '>=', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'IS INITIAL', 'AND', 'OR', 'INTO', 'ORDER BY', 'GROUP BY'].forEach(o => bag.add({ label: o, insert: o + ' ', kind: /^[A-Z]/.test(o) ? 'keyword' : 'operator' }));
      return true;
    }
    if (clause.startsWith('SELECT') && !/\bFROM\b/i.test(lead) && !after.trim() && !sources.length) bag.add({ label: 'FROM', insert: 'FROM ', kind: 'keyword' });
    await addFields();
    bag.group();
    if (/^(SELECT|SELECT SINGLE|SELECT DISTINCT|FIELDS)$/.test(clause)) { bag.add({ label: '*', insert: '*', kind: 'operator' }); for (const [f, d] of SQL_FUNCTIONS) bag.add({ label: f.replace(/\$0/, '…'), insert: f, kind: 'function', detail: d }); }
    if (clause === 'ORDER BY') ['PRIMARY KEY', 'ASCENDING', 'DESCENDING'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    if (/^(WHERE|ON|HAVING)$/.test(clause)) ['NOT', 'EXISTS ( SELECT'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    if (clause === 'FIELDS' || clause.startsWith('SELECT')) ['FROM', 'WHERE', 'INTO TABLE @DATA( )', 'INTO @DATA( )', 'AS'].forEach(k => bag.add({ label: k, insert: k.endsWith('( )') ? k.replace('( )', '($0)') : k + ' ', kind: 'keyword' }));
    return true;
  }
  return false;
}

// ====================================================================== CDS

export async function completeCds(req: CompletionRequest): Promise<Proposal[]> {
  const lines = req.source.split('\n');
  if (req.line < 0 || req.line >= lines.length) return [];
  const before = (lines[req.line] ?? '').slice(0, req.col);
  const textBefore = lines.slice(0, req.line).join('\n') + '\n' + before;
  const bag = new Bag();
  const cat = req.catalog;
  if (/\/\/.*$/.test(before) || (textBefore.split('/*').length > textBefore.split('*/').length)) return [];
  if ((before.split("'").length - 1) % 2 === 1) return [];
  let m: RegExpMatchArray | null;

  // annotations
  if ((m = before.match(/@([\w.]+)\s*:\s*\[?\s*#(\w*)$/))) {
    const a = CDS_ANNOTATIONS.find(x => lc(x[0]) === lc(m![1]));
    for (const v of (a?.[1] || '').split('|').filter(x => x.startsWith('#'))) bag.add({ label: v.slice(1), insert: v.slice(1), kind: 'enum', replaceFrom: req.col - m[2].length });
    return bag.result(m[2]);
  }
  if ((m = before.match(/@<?([\w.]*)$/))) {
    const typed = m[1];
    for (const [n, v, d] of CDS_ANNOTATIONS) {
      const value = v.startsWith('#') ? '#' : v === "''" ? "'$0'" : v === "['']" ? "[ '$0' ]" : v.includes('[') || v.includes('{') ? v.replace(/''/, "'$0'") : v;
      bag.add({ label: n, insert: `${n}: ${value}`, kind: 'annotation', detail: d, doc: v.startsWith('#') ? v.replace(/\|/g, ' ') : undefined, replaceFrom: req.col - typed.length });
    }
    const p = lc(typed);
    return bag.items.filter(i => lc(i.label).startsWith(p) || (p.length > 2 && lc(i.label).includes(p))).slice(0, 80).map(({ g, ...r }) => { void g; return r; });
  }

  const prefix = (before.match(/[\w/$]*$/) as RegExpMatchArray)[0];
  const P = prefix.toUpperCase();
  const lead = textBefore.slice(0, textBefore.length - prefix.length);
  const leadT = lead.replace(/\s+/g, ' ');

  // sources and aliases
  const srcs: { name: string; alias: string; assoc: boolean }[] = [];
  for (const s of req.source.matchAll(/\b(?:select\s+from|projection\s+on|join)\s+([\w/]+)(?:\s+as\s+(\w+))?/gi)) srcs.push({ name: s[1], alias: s[2] || s[1], assoc: false });
  for (const s of req.source.matchAll(/\b(?:association|composition)\s*(?:\[[^\]]*\])?\s*(?:to|of)\s+(?:parent\s+)?([\w/]+)\s+as\s+(\w+)/gi)) srcs.push({ name: s[1], alias: s[2], assoc: true });
  const main = srcs.find(s => !s.assoc);
  const fieldsOf = async (name: string) => (await cat.fieldsOf(name).catch(() => null)) || [];
  const addFieldsOf = async (name: string, qualify?: string) => {
    for (const f of await fieldsOf(name)) bag.add({ label: qualify ? `${qualify}.${f.name}` : f.name, insert: qualify ? `${qualify}.${f.name}` : f.name, kind: f.type === 'association' ? 'field' : 'field', detail: `${lc(name)}${f.type ? ' · ' + f.type : ''}`, doc: f.desc, sort: f.key ? 0 : 1 });
  };
  const addSources = async () => {
    const list = await cat.find(P, ['cds', 'table', 'view'], 60).catch(() => [] as CatEntry[]);
    for (const e of list) bag.add({ label: e.kind === 'cds' ? e.name : lc(e.name), insert: e.kind === 'cds' ? e.name : lc(e.name), kind: 'table', detail: `${e.kind === 'cds' ? 'CDS' : 'Table'} · ${e.desc}` });
  };

  // qualified element: alias.field, $projection.x, abap.type
  if ((m = leadT.match(/([\w$]+)\.$/))) {
    const left = m[1];
    if (lc(left) === 'abap') { CDS_TYPES.forEach(t => bag.add({ label: t.replace(/\(.*$/, ''), insert: t.replace(/\( (\d+)/, '( $0$1'), kind: 'type', detail: 'ABAP built-in type' })); return bag.result(P); }
    if (lc(left) === '$projection') { for (const f of parseCdsSource(req.source)) bag.add({ label: f.name, insert: f.name, kind: 'field', detail: 'element of this view' }); return bag.result(P); }
    if (lc(left) === '$session') { ['user', 'client', 'system_language', 'system_date', 'user_timezone', 'user_date'].forEach(n => bag.add({ label: n, insert: n, kind: 'field', detail: 'session variable' })); return bag.result(P); }
    const src = srcs.find(s => lc(s.alias) === lc(left) || lc(s.name) === lc(left));
    if (src) await addFieldsOf(src.name);
    return bag.result(P);
  }
  if (/\b(select\s+from|projection\s+on|join|(association|composition)\s*(\[[^\]]*\])?\s*(to|of)(\s+parent)?)\s+$/i.test(leadT)) { await addSources(); return bag.result(P); }
  if (/\bcast\s*\([^()]*\bas\s+$/i.test(leadT)) {
    CDS_TYPES.forEach(t => bag.add({ label: 'abap.' + t.replace(/\(.*$/, ''), insert: 'abap.' + t, kind: 'type', detail: 'ABAP built-in type' }));
    for (const e of await cat.find(P, ['dtel'], 40).catch(() => [])) bag.add({ label: lc(e.name), insert: lc(e.name), kind: 'type', detail: e.desc });
    return bag.result(P);
  }
  if (/\bas\s+$/i.test(leadT) && /[{,]/.test(leadT)) return [];

  const openIdx = lead.search(/\b(select\s+from|projection\s+on)\b[\s\S]*?\{/i) >= 0 ? lead.indexOf('{', lead.search(/\b(select\s+from|projection\s+on)\b/i)) : -1;
  const inElements = openIdx >= 0 && lead.slice(openIdx).split('{').length > lead.slice(openIdx).split('}').length;

  if (inElements) {
    const onCond = /\bon\s+[^,{}]*$/i.test(leadT.slice(leadT.lastIndexOf(',') + 1));
    bag.group();
    if (main) await addFieldsOf(main.name);
    for (const s of srcs) if (s.assoc) bag.add({ label: s.alias, insert: s.alias, kind: 'field', detail: `association to ${s.name}` });
    if (srcs.filter(s => !s.assoc).length > 1) for (const s of srcs.filter(x => !x.assoc)) bag.add({ label: s.alias, insert: s.alias + '.', kind: 'table', detail: s.name });
    bag.group();
    if (onCond) bag.add({ label: '$projection', insert: '$projection.', kind: 'variable' });
    ['key', 'virtual', 'as', 'cast', 'case', 'when', 'then', 'else', 'end', 'and', 'or', 'not', 'is null', 'is not null', 'redirected to'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    for (const [f, d] of CDS_FUNCTIONS) bag.add({ label: f.replace(/\(.*$/, '').trim(), insert: f, kind: 'function', detail: d });
    bag.add({ label: '$session', insert: '$session.', kind: 'variable' }).add({ label: '$parameters', insert: '$parameters.', kind: 'variable' });
    return bag.result(P);
  }

  // top level
  const trimmed = leadT.trim();
  if (!trimmed || /\}\s*$/.test(trimmed) && !/\bwhere\b/i.test(trimmed.slice(trimmed.lastIndexOf('}'))) || /^(@[\w.]+\s*:\s*(\[[^\]]*\]|\{[^}]*\}|'[^']*'|\S+)\s*)+$/.test(trimmed)) {
    if (/\}\s*$/.test(trimmed)) { bag.add({ label: 'where', insert: 'where ', kind: 'keyword' }).add({ label: 'group by', insert: 'group by ', kind: 'keyword' }).add({ label: 'union all', insert: 'union all select from ', kind: 'keyword' }); return bag.result(P); }
    const name = 'ZI_$0';
    bag.add({ label: 'define view entity', insert: `define view entity ${name}\n  as select from \n{\n  key \n}`, kind: 'snippet', detail: 'Interface view' })
      .add({ label: 'define root view entity', insert: `define root view entity ${name}\n  as select from \n  composition [0..*] of  as _Child\n{\n  key ,\n      _Child\n}`, kind: 'snippet', detail: 'RAP root' })
      .add({ label: 'define root view entity … projection', insert: 'define root view entity ZC_$0\n  provider contract transactional_query\n  as projection on \n{\n  key \n}', kind: 'snippet', detail: 'Projection view' })
      .add({ label: 'extend view entity', insert: 'extend view entity $0 with\n{\n  \n}', kind: 'snippet', detail: 'Extension' })
      .add({ label: 'define abstract entity', insert: 'define abstract entity ZA_$0\n{\n  \n}', kind: 'snippet' })
      .add({ label: 'define custom entity', insert: "@ObjectModel.query.implementedBy: 'ABAP:ZCL_$0'\ndefine custom entity ZCE_\n{\n  key \n}", kind: 'snippet' })
      .add({ label: '@', insert: '@', kind: 'annotation', detail: 'Annotation' });
    return bag.result(P);
  }
  if (/\bdefine\s+$/i.test(leadT)) { ['view entity', 'root view entity', 'abstract entity', 'custom entity', 'table function', 'transient view entity'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' })); return bag.result(P); }
  if (/\bview\s+entity\s+\w+\s+$/i.test(leadT)) { ['as select from', 'as projection on', 'with parameters', 'provider contract transactional_query'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' })); return bag.result(P); }
  if (/\bas\s+$/i.test(leadT)) { ['select from', 'projection on'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' })); return bag.result(P); }
  if (/\bwhere\b[^{}]*$/i.test(leadT) || /\bon\s+[^{}]*$/i.test(leadT)) {
    if (main) await addFieldsOf(main.name);
    bag.add({ label: '$projection', insert: '$projection.', kind: 'variable' });
    for (const s of srcs) bag.add({ label: s.alias, insert: s.alias + '.', kind: 'table', detail: s.name });
    ['and', 'or', 'not', 'is null', 'is not null', 'between', 'like'].forEach(k => bag.add({ label: k, insert: k + ' ', kind: 'keyword' }));
    return bag.result(P);
  }
  if (/\b(from|on|of|to)\s+[\w/]+(\s+as\s+\w+)?\s+$/i.test(leadT) || /\bon\s+[^{]*$/i.test(leadT)) {
    ['as', 'association [0..1] to', 'association [0..*] to', 'composition [0..*] of', 'association to parent', 'inner join', 'left outer join', 'on', '{'].forEach(k =>
      bag.add({ label: k, insert: k === '{' ? '{\n  $0\n}' : k + ' ', kind: 'keyword' }));
    return bag.result(P);
  }
  for (const k of ['define', 'as', 'select', 'from', 'projection', 'on', 'association', 'composition', 'join', 'where', 'key']) bag.add({ label: k, insert: k + ' ', kind: 'keyword' });
  return bag.result(P);
}
