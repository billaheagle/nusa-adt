/** Applying text changes from quick fixes and refactorings (0-based lines and columns). */
import { TextEdit } from './types';

type Pos = { line: number; ch: number };
const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.ch < b.ch);

/** Offset of a position, clamped to the text. */
export function offsetOf(text: string, p: Pos): number {
  let off = 0, line = 0;
  while (line < p.line) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return text.length;
    off = nl + 1; line++;
  }
  const end = text.indexOf('\n', off);
  return Math.min(off + p.ch, end < 0 ? text.length : end);
}

/** Changes from the end backwards, so earlier positions stay valid. */
export function sortForApply<T extends { from: Pos }>(edits: T[]): T[] {
  return [...edits].sort((a, b) => (before(a.from, b.from) ? 1 : before(b.from, a.from) ? -1 : 0));
}

export function applyEdits(text: string, edits: Pick<TextEdit, 'from' | 'to' | 'newText'>[]): string {
  let out = text;
  for (const e of sortForApply(edits)) {
    const a = offsetOf(out, e.from), b = offsetOf(out, e.to);
    out = out.slice(0, a) + e.newText + out.slice(Math.max(a, b));
  }
  return out;
}

/** The lines an edit touches, before and after, for a preview. */
export function editLines(text: string, e: Pick<TextEdit, 'from' | 'to' | 'newText'>): { line: number; before: string[]; after: string[] } {
  const lines = text.split('\n');
  const first = e.from.line, last = Math.max(e.from.line, e.to.line);
  const before = lines.slice(first, last + 1);
  const changed = applyEdits(before.join('\n'), [{ ...e, from: { line: 0, ch: e.from.ch }, to: { line: last - first, ch: e.to.ch } }]);
  return { line: first, before, after: changed.split('\n') };
}

/** Identifier at a column: [start, end) or null. ABAP names may contain / for namespaces and ~ for interface components. */
export function wordRange(line: string, ch: number): [number, number] | null {
  const ok = (c: string) => /[\w/~]/.test(c);
  let a = ch, b = ch;
  while (a > 0 && ok(line[a - 1])) a--;
  while (b < line.length && ok(line[b])) b++;
  return a < b ? [a, b] : null;
}
