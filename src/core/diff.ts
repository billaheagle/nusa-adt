/** Line diff (Myers, O((N+M)·D)) and hunks with context, for "Compare with…" views. */

export type DiffOp = { t: 'same' | 'del' | 'add'; a?: number; b?: number; text: string };
export interface Hunk { ops: DiffOp[]; aStart: number; bStart: number }

export function diffLines(a: string[], b: string[]): DiffOp[] {
  // trim common prefix and suffix first: most edits are small
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const mid = myers(A, B).map(op => ({ ...op, a: op.a !== undefined ? op.a + pre : undefined, b: op.b !== undefined ? op.b + pre : undefined }));
  const head: DiffOp[] = a.slice(0, pre).map((text, i) => ({ t: 'same', a: i, b: i, text }));
  const tail: DiffOp[] = a.slice(a.length - suf).map((text, i) => ({ t: 'same', a: a.length - suf + i, b: b.length - suf + i, text }));
  return [...head, ...mid, ...tail];
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length, max = n + m;
  if (!n) return b.map((text, j) => ({ t: 'add', b: j, text }));
  if (!m) return a.map((text, i) => ({ t: 'del', a: i, text }));
  const off = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { trace.push(v.slice()); break outer; }
    }
  }
  // backtrack
  const ops: DiffOp[] = [];
  let x = n, y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ t: 'same', a: x, b: y, text: a[x] }); }
    if (d > 0) {
      if (x === prevX) { y--; ops.push({ t: 'add', b: y, text: b[y] }); }
      else { x--; ops.push({ t: 'del', a: x, text: a[x] }); }
    }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ t: 'same', a: x, b: y, text: a[x] }); }
  return ops.reverse();
}

/** Groups changes with `ctx` unchanged lines around them; nearby groups merge. */
export function hunks(ops: DiffOp[], ctx = 3): Hunk[] {
  const ranges: [number, number][] = [];
  ops.forEach((o, i) => {
    if (o.t === 'same') return;
    const from = Math.max(0, i - ctx), to = Math.min(ops.length, i + ctx + 1);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  });
  return ranges.map(([f, t]) => {
    const slice = ops.slice(f, t);
    return { ops: slice, aStart: firstNum(slice, 'a'), bStart: firstNum(slice, 'b') };
  });
}

function firstNum(ops: DiffOp[], side: 'a' | 'b'): number {
  for (const o of ops) if (o[side] !== undefined) return o[side] as number;
  return 0;
}

export function diffStats(ops: DiffOp[]) {
  return { added: ops.filter(o => o.t === 'add').length, removed: ops.filter(o => o.t === 'del').length };
}

/** Local history: newest first, no consecutive duplicates, capped by count and size. */
export interface Snapshot { at: number; text: string; note: string }
export function addSnapshot(list: Snapshot[], snap: Snapshot, max = 25, maxChars = 400_000): Snapshot[] {
  if (list[0]?.text === snap.text) return list;
  const out = [snap, ...list];
  let size = 0;
  return out.filter((s, i) => { size += s.text.length; return i < max && (i === 0 || size <= maxChars); });
}
