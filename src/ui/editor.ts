// CodeMirror 5 setup: ABAP and CDS modes, completion popup wiring, breakpoint gutter.
import { KEYWORDS } from '../core/abap';
import { Proposal } from '../core/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CM = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const CodeMirror: any;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

export function defineModes() {
  const kw = new RegExp('(?:' + [...KEYWORDS].sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![\\w-])', 'i');
  CodeMirror.defineSimpleMode('abap', {
    start: [
      { regex: /\*.*/, token: 'comment', sol: true },
      { regex: /".*/, token: 'comment' },
      { regex: /'(?:[^']|'')*'?/, token: 'string' },
      { regex: /`(?:[^`]|``)*`?/, token: 'string' },
      { regex: /\|(?:[^|\\]|\\.)*\|?/, token: 'string-2' },
      { regex: /##\w+/, token: 'meta' },
      { regex: /(->|=>|~|-)([a-z_][\w]*)/i, token: ['operator', 'property'] },
      { regex: kw, token: 'keyword' },
      { regex: /(?:[zy]c[lx]_|[zy]if_|cl_|cx_|if_)\w+|\/\w+\/\w+/i, token: 'type' },
      { regex: /<\w+>/, token: 'variable-2' },
      { regex: /[a-z_][\w]*/i, token: 'variable' },
      { regex: /\d+(?![\w])/, token: 'number' },
      { regex: /[=<>+*/&?@-]+/, token: 'operator' },
      { regex: /[()[\]]/, token: 'bracket' },
    ],
    meta: { lineComment: '*' },
  });

  const cdsKw = /(?:transactional_query|implementation|corresponding|authorization|determination|composition|association|persistent|parameters|validation|projection|redirected|additional|dependent|unmanaged|mandatory|pfcg_auth|numbering|annotate|readonly|distinct|contract|instance|internal|behavior|abstract|provider|factory|mapping|managed|service|include|extend|create|custom|update|unique|result|having|select|expose|modify|master|global|define|strict|parent|delete|entity|aspect|static|action|query|total|union|early|where|class|table|grant|draft|outer|exact|inner|field|group|alias|role|join|root|else|with|left|from|cast|then|late|null|many|save|when|view|lock|case|etag|use|and|one|end|not|all|for|key|is|as|to|on|by|in|of|or)(?![\w])/i;
  CodeMirror.defineSimpleMode('cds', {
    start: [
      { regex: /\/\/.*/, token: 'comment' },
      { regex: /\/\*/, token: 'comment', next: 'comment' },
      { regex: /'(?:[^']|'')*'?/, token: 'string' },
      { regex: /@[\w.]+/, token: 'meta' },
      { regex: /\$\w+/, token: 'meta' },
      { regex: /#\w+/, token: 'atom' },
      { regex: /abap\.\w+/i, token: 'type' },
      { regex: cdsKw, token: 'keyword' },
      { regex: /\/\w+\/\w+|[zy]\w+/i, token: 'type' },
      { regex: /_\w+/, token: 'property' },
      { regex: /[a-z_][\w]*/i, token: 'variable' },
      { regex: /\d+/, token: 'number' },
      { regex: /[{}()[\]]/, token: 'bracket' },
    ],
    comment: [{ regex: /.*?\*\//, token: 'comment', next: 'start' }, { regex: /.*/, token: 'comment' }],
    meta: { lineComment: '//' },
  });
}

export function createEditor(host: HTMLElement): CM {
  defineModes();
  return CodeMirror(host, {
    value: '',
    mode: 'abap',
    theme: 'nusa',
    lineNumbers: true,
    gutters: ['bp-gutter', 'CodeMirror-linenumbers'],
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    styleActiveLine: true,
    matchBrackets: true,
    lineWiseCopyCut: true,
    extraKeys: {
      Tab: (cm: CM) => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  '),
      'Shift-Tab': (cm: CM) => cm.indentSelection('subtract'),
      'Ctrl-D': selectNextOccurrence, 'Cmd-D': selectNextOccurrence,
      'Alt-Up': (cm: CM) => moveLines(cm, -1), 'Alt-Down': (cm: CM) => moveLines(cm, 1),
      'Shift-Alt-Up': (cm: CM) => duplicateLines(cm, -1), 'Shift-Alt-Down': (cm: CM) => duplicateLines(cm, 1),
      'Ctrl-Shift-K': deleteLines, 'Cmd-Shift-K': deleteLines,
      'Ctrl-Enter': (cm: CM) => insertLine(cm, 1), 'Ctrl-Shift-Enter': (cm: CM) => insertLine(cm, -1),
      Esc: (cm: CM) => { const s = cm.listSelections(); if (s.length > 1) cm.setSelection(s[s.length - 1].anchor, s[s.length - 1].head); else return CodeMirror.Pass; },
    },
  });
}

// ---- VS Code editing commands (Eclipse has no multi-cursor, line move only with Alt+Up/Down)

type Pos = { line: number; ch: number };
const cmp = (a: Pos, b: Pos) => a.line - b.line || a.ch - b.ch;

/** Ctrl+D: select the word at the cursor, then add its next occurrence as another selection. */
export function selectNextOccurrence(cm: CM) {
  const sels: { anchor: Pos; head: Pos }[] = cm.listSelections();
  const last = sels[sels.length - 1];
  const from = cmp(last.anchor, last.head) <= 0 ? last.anchor : last.head;
  const to = cmp(last.anchor, last.head) <= 0 ? last.head : last.anchor;
  if (!cmp(from, to)) {
    const line: string = cm.getLine(from.line);
    let a = from.ch, b = from.ch;
    while (a > 0 && /[\w\/$%-]/.test(line[a - 1])) a--;
    while (b < line.length && /[\w\/$%-]/.test(line[b])) b++;
    if (a === b) return;
    cm.setSelections([...sels.slice(0, -1), { anchor: { line: from.line, ch: a }, head: { line: from.line, ch: b } }]);
    return;
  }
  const word: string = cm.getRange(from, to);
  const text: string = cm.getValue();
  const lower = text.toLowerCase(), w = word.toLowerCase();
  let idx = lower.indexOf(w, cm.indexFromPos(to));
  if (idx < 0) idx = lower.indexOf(w);
  const taken = new Set(sels.map(s => cm.indexFromPos(cmp(s.anchor, s.head) <= 0 ? s.anchor : s.head)));
  if (idx < 0 || taken.has(idx)) return;
  const anchor = cm.posFromIndex(idx), head = cm.posFromIndex(idx + word.length);
  cm.addSelection(anchor, head);
  cm.scrollIntoView(head, 80);
}

function lineSpans(cm: CM): [number, number][] {
  const spans: [number, number][] = [];
  for (const s of cm.listSelections() as { anchor: Pos; head: Pos }[]) {
    const a = Math.min(s.anchor.line, s.head.line);
    let b = Math.max(s.anchor.line, s.head.line);
    const end = cmp(s.anchor, s.head) <= 0 ? s.head : s.anchor;
    if (b > a && end.ch === 0) b--;
    const last = spans[spans.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else spans.push([a, b]);
  }
  return spans;
}

/** Alt+Up / Alt+Down: move the selected lines. */
export function moveLines(cm: CM, dir: -1 | 1) {
  const spans = lineSpans(cm);
  if (dir < 0 && spans[0][0] === 0) return;
  if (dir > 0 && spans[spans.length - 1][1] >= cm.lastLine()) return;
  const sels = cm.listSelections() as { anchor: Pos; head: Pos }[];
  cm.operation(() => {
    for (const [a, b] of dir < 0 ? spans : [...spans].reverse()) {
      if (dir < 0) {
        const above = cm.getLine(a - 1);
        cm.replaceRange('', { line: a - 1, ch: 0 }, { line: a, ch: 0 });
        cm.replaceRange(above + '\n', { line: b, ch: 0 });
      } else {
        const below = cm.getLine(b + 1);
        cm.replaceRange('', { line: b, ch: cm.getLine(b).length }, { line: b + 1, ch: below.length });
        cm.replaceRange(below + '\n', { line: a, ch: 0 });
      }
    }
    cm.setSelections(sels.map(s => ({ anchor: { line: s.anchor.line + dir, ch: s.anchor.ch }, head: { line: s.head.line + dir, ch: s.head.ch } })));
  });
}

/** Shift+Alt+Up / Down: copy the selected lines above or below. */
export function duplicateLines(cm: CM, dir: -1 | 1) {
  const spans = lineSpans(cm);
  const sels = cm.listSelections() as { anchor: Pos; head: Pos }[];
  cm.operation(() => {
    let shift = 0;
    const moved = sels.map(s => ({ anchor: { ...s.anchor }, head: { ...s.head } }));
    for (const [a, b] of spans) {
      const text = cm.getRange({ line: a + shift, ch: 0 }, { line: b + shift, ch: cm.getLine(b + shift).length });
      cm.replaceRange(text + '\n', { line: a + shift, ch: 0 });
      const n = b - a + 1;
      if (dir > 0) moved.forEach(s => { if (s.head.line >= a && s.head.line <= b) { s.anchor.line += n + shift; s.head.line += n + shift; } });
      shift += n;
    }
    if (dir > 0) cm.setSelections(moved);
  });
}

/** Ctrl+Shift+K: delete the selected lines. */
export function deleteLines(cm: CM) {
  const spans = lineSpans(cm);
  cm.operation(() => {
    for (const [a, b] of [...spans].reverse()) {
      if (b < cm.lastLine()) cm.replaceRange('', { line: a, ch: 0 }, { line: b + 1, ch: 0 });
      else if (a > 0) cm.replaceRange('', { line: a - 1, ch: cm.getLine(a - 1).length }, { line: b, ch: cm.getLine(b).length });
      else cm.replaceRange('', { line: 0, ch: 0 }, { line: b, ch: cm.getLine(b).length });
    }
  });
}

/** Ctrl+Enter / Ctrl+Shift+Enter: new line below or above, keeping the indentation. */
export function insertLine(cm: CM, dir: -1 | 1) {
  const c = cm.getCursor();
  const indent = (cm.getLine(c.line).match(/^\s*/) as RegExpMatchArray)[0];
  if (dir > 0) { cm.replaceRange('\n' + indent, { line: c.line, ch: cm.getLine(c.line).length }); cm.setCursor({ line: c.line + 1, ch: indent.length }); }
  else { cm.replaceRange(indent + '\n', { line: c.line, ch: 0 }); cm.setCursor({ line: c.line, ch: indent.length }); }
}

export function newDoc(text: string, mode: 'abap' | 'cds' | 'text') {
  return CodeMirror.Doc(text, mode);
}

const KIND_TAG: Record<Proposal['kind'], string> = {
  keyword: 'kw', method: 'meth', field: 'fld', variable: 'var', type: 'type', snippet: 'snip', object: 'obj', function: 'fn',
  parameter: 'par', constant: 'const', class: 'cls', interface: 'intf', exception: 'cx', table: 'tab', fm: 'fm', pragma: 'prag',
  operator: 'op', annotation: '@', enum: '#',
};

/** Insert a proposal, honouring $0 as caret position and re-indenting continuation lines. */
function applyProposal(cm: CM, from: { line: number; ch: number }, to: { line: number; ch: number }, p: Proposal) {
  const indent = (cm.getLine(from.line).match(/^\s*/) as RegExpMatchArray)[0];
  const text = p.insert.split('\n').map((l, i) => (i ? indent + l : l)).join('\n');
  const caret = text.indexOf('$0');
  const clean = text.replace('$0', '');
  cm.replaceRange(clean, from, to);
  if (caret >= 0) {
    const before = clean.slice(0, caret).split('\n');
    const line = from.line + before.length - 1;
    const ch = before.length === 1 ? from.ch + before[0].length : before[before.length - 1].length;
    cm.setCursor({ line, ch });
  }
}

let docEl: HTMLElement | null = null;
function hideDoc() { docEl?.remove(); docEl = null; }
function showDoc(p: Proposal, item: HTMLElement) {
  hideDoc();
  if (!p.doc && !p.detail) return;
  const list = item.parentElement as HTMLElement;
  const r = list.getBoundingClientRect();
  docEl = document.createElement('div');
  docEl.className = 'hint-doc';
  docEl.innerHTML = `<b></b><div></div>`;
  (docEl.querySelector('b') as HTMLElement).textContent = p.label;
  (docEl.querySelector('div') as HTMLElement).textContent = [p.detail, p.doc].filter(Boolean).join('\n');
  document.body.appendChild(docEl);
  const w = docEl.offsetWidth;
  const left = r.right + 6 + w < window.innerWidth ? r.right + 6 : Math.max(8, r.left - w - 6);
  docEl.style.left = left + 'px';
  docEl.style.top = Math.min(r.top, window.innerHeight - docEl.offsetHeight - 8) + 'px';
}

function toHints(cm: CM, list: Proposal[]) {
  const cur = cm.getCursor();
  const line: string = cm.getLine(cur.line);
  let start = cur.ch;
  while (start > 0 && /[\w/$]/.test(line[start - 1])) start--;
  const prefix = line.slice(start, cur.ch).toLowerCase();
  const items = list
    .filter(p => p.replaceFrom !== undefined || !prefix || p.label.toLowerCase().replace(/^[@#<]/, '').includes(prefix) || p.kind === 'snippet')
    .map(p => ({
      text: p.insert,
      displayText: p.label,
      p,
      from: CodeMirror.Pos(cur.line, p.replaceFrom ?? start),
      render(el: HTMLElement) {
        el.innerHTML = `<span class="hint-kind k-${KIND_TAG[p.kind]}">${KIND_TAG[p.kind]}</span><span class="hint-label"></span><span class="hint-detail"></span>`;
        (el.querySelector('.hint-label') as HTMLElement).textContent = p.label;
        (el.querySelector('.hint-detail') as HTMLElement).textContent = p.detail || '';
      },
      hint(cm2: CM, _data: unknown, self: { from: { line: number; ch: number } }) {
        applyProposal(cm2, self.from, cm2.getCursor(), p);
      },
    }));
  return { list: items, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, cur.ch) };
}

/**
 * Opens the completion popup. `fetch` is called again on every keystroke while the popup is
 * open, so typing `lo_service->` after the popup opened on `lo` shows the methods, not the
 * stale variable list. The popup closes when the new context has no proposals.
 */
export function startCompletion(cm: CM, fetch: () => Promise<Proposal[]>) {
  let seq = 0;
  const hint = (cm2: CM, callback: (d: unknown) => void) => {
    const my = ++seq;
    fetch().then(list => {
      if (my !== seq) return;                       // a newer keystroke is already being answered
      const data = toHints(cm2, list);
      if (!data.list.length) { callback(null); return; }
      CodeMirror.on(data, 'select', (c: { p: Proposal }, el: HTMLElement) => showDoc(c.p, el));
      CodeMirror.on(data, 'close', hideDoc);
      callback(data);
    }).catch(() => callback(null));
  };
  (hint as unknown as { async: boolean }).async = true;
  cm.showHint({ hint, completeSingle: false, closeCharacters: /[;]/, closeOnUnfocus: true, updateOnCursorActivity: true });
}

/** Kept for callers with a ready list (tests, one-off popups). */

export function bpMarker(): HTMLElement {
  const d = document.createElement('div');
  d.className = 'bp';
  d.title = 'Breakpoint';
  return d;
}

export function bpLines(doc: CM): number[] {
  const r: number[] = [];
  doc.eachLine((h: { gutterMarkers?: Record<string, unknown> }) => {
    if (h.gutterMarkers && h.gutterMarkers['bp-gutter']) r.push(doc.getLineNumber(h));
  });
  return r;
}

export function wordAt(cm: CM): string {
  const c = cm.getCursor();
  const t: string = cm.getLine(c.line);
  let a = c.ch, b = c.ch;
  while (a > 0 && /[\w/~]/.test(t[a - 1])) a--;
  while (b < t.length && /[\w/~]/.test(t[b])) b++;
  return t.slice(a, b);
}
