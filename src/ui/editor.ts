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

  const cdsKw = /(?:define|view|entity|root|as|select|from|association|composition|of|to|on|key|join|inner|left|outer|where|group|by|having|union|all|with|parameters|cast|case|when|then|else|end|and|or|not|is|null|distinct|projection|provider|contract|transactional_query|redirected|parent|exact|one|many|extend|abstract|custom)(?![\w])/i;
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
    },
  });
}

export function newDoc(text: string, mode: 'abap' | 'cds') {
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

export function showProposals(cm: CM, list: Proposal[]) {
  const cur = cm.getCursor();
  const line = cm.getLine(cur.line);
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
  if (!items.length) return;
  cm.showHint({
    hint: () => {
      const data = { list: items, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, cur.ch) };
      CodeMirror.on(data, 'select', (c: { p: Proposal }, el: HTMLElement) => showDoc(c.p, el));
      CodeMirror.on(data, 'close', hideDoc);
      return data;
    },
    completeSingle: false,
    closeCharacters: /[\s()[\]{};:,.]/,
  });
}

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
