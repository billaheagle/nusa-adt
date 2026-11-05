// Compare the editor with other versions of the same source: the version history in the
// system (Eclipse: Compare With > Revision) and the same object in another system
// (for example DEV against QAS before a transport).

import type { Backend, Connection, Include, ObjRef, Revision, SystemInfo } from '../core/types';
import { INCLUDE_LABEL, isTextInclude, TYPE_INFO } from '../core/types';
import { esc, msg } from './util';

/** What the workbench lends this module. */
export interface HistoryCtx {
  backend: Backend;
  conns(): Connection[];
  sys(id: string): SystemInfo | { error: string } | undefined;
  setSys(id: string, s: SystemInfo | { error: string }): void;
  /** the editor text of the source */
  editorText(): Promise<string>;
  openDiff(left: string, leftLabel: string, right: string, rightLabel: string): void;
  modal(title: string, body: string, buttons: { label: string; value?: unknown }[], init?: (root: HTMLElement, close: (v: unknown) => void) => void): Promise<unknown>;
  /** shows the work in the status area; errors reach the caller */
  working<T>(label: string, fn: () => Promise<T>): Promise<T>;
  toast(text: string, kind?: 'ok' | 'warn' | 'error' | 'info', ms?: number): void;
}
export interface SourceRef { conn: string; ref: ObjRef; include: Include }

const fmt = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? iso : d.toLocaleString(); };
const label = (s: SourceRef) => `${s.ref.name}${s.include !== 'main' ? ' · ' + INCLUDE_LABEL[s.include] : ''}`;

/** Why the version history or a comparison is not available for this source (empty: it is). */
export function historyBlocker(s: SourceRef): string {
  if (isTextInclude(s.include)) return 'Text elements have no version history. Compare the program source instead.';
  if (TYPE_INFO[s.ref.type].editor === 'xml' || TYPE_INFO[s.ref.type].editor === 'form') return `${TYPE_INFO[s.ref.type].label} objects have no source versions to compare.`;
  return '';
}

/** Other systems that can hold the same object: not the current one, not the local runner, and sample systems only with sample systems. */
export function compareTargets(all: Connection[], current: string): Connection[] {
  const cur = all.find(c => c.id === current);
  return all.filter(c => c.id !== current && c.kind !== 'runner' && !!c.builtin === !!cur?.builtin);
}

export function revisionLabel(r: Revision): string {
  return `${fmt(r.date)}${r.author ? ' · ' + r.author : ''}`;
}

export function createHistory(ctx: HistoryCtx) {
  async function compareRevision(s: SourceRef): Promise<void> {
    const why = historyBlocker(s);
    if (why) { ctx.toast(why, 'warn', 6000); return; }
    let list: Revision[];
    try { list = await ctx.working(`Reading the versions of ${s.ref.name}`, () => ctx.backend.revisions(s.conn, s.ref, s.include)); }
    catch (e) { ctx.toast(`The system has no version history for ${label(s)}: ${msg(e)}`, 'warn', 8000); return; }
    if (!list.length) { ctx.toast(`${label(s)} has no versions in the system yet. A version is written on activation and on transport release.`, 'info', 7000); return; }
    const pick = await ctx.modal(`Version history · ${label(s)}`, `<p class="note">Versions in the system, newest first. Choose one to compare with the editor.</p>
      <ul class="pick hist">${list.map((r, i) => `<li><button type="button" data-rev="${i}"><b>${esc(fmt(r.date))}</b><span>${esc([r.title, r.author, r.transport].filter(Boolean).join(' · '))}</span></button></li>`).join('')}</ul>`,
      [{ label: 'Cancel', value: null }], (root, close) => {
        root.querySelectorAll<HTMLButtonElement>('[data-rev]').forEach(b => { b.onclick = () => close(b.dataset.rev); });
      });
    if (typeof pick !== 'string') return;
    const rev = list[+pick];
    const text = await ctx.working('Reading the version', () => ctx.backend.revisionSource(s.conn, rev)).catch(e => { ctx.toast(`Reading the version failed: ${msg(e)}`, 'error'); return undefined; });
    if (text === undefined) return;
    ctx.openDiff(text, `Version ${fmt(rev.date)}${rev.transport ? ' · ' + rev.transport : ''}`, await ctx.editorText(), 'Editor');
  }

  async function compareSystem(s: SourceRef, targetId?: string): Promise<void> {
    const why = historyBlocker(s);
    if (why && TYPE_INFO[s.ref.type].editor !== 'xml') { ctx.toast(why, 'warn', 6000); return; }
    const targets = compareTargets(ctx.conns(), s.conn);
    if (!targets.length) { ctx.toast('Add the other system first (for example QAS), then compare.', 'info', 7000); return; }
    let id = targetId;
    if (!id) {
      const v = await ctx.modal(`Compare ${label(s)} with another system`, `<p class="note">Reads the active version of ${esc(s.ref.name)} in the other system and compares it with the editor.</p>
        <ul class="pick">${targets.map(c => `<li><button type="button" data-sys="${esc(c.id)}"><b>${esc(c.sid)}${c.kind === 's4' ? ' · ' + esc(c.client) : ''}</b><span>${esc(c.label || c.url)}</span></button></li>`).join('')}</ul>`,
        [{ label: 'Cancel', value: null }], (root, close) => {
          root.querySelectorAll<HTMLButtonElement>('[data-sys]').forEach(b => { b.onclick = () => close(b.dataset.sys); });
        });
      id = typeof v === 'string' ? v : undefined;
    }
    const target = targets.find(c => c.id === id);
    if (!target) return;
    const text = await ctx.working(`Reading ${s.ref.name} in ${target.sid}`, async () => {
      const st = ctx.sys(target.id);
      if (!st || 'error' in st) ctx.setSys(target.id, await ctx.backend.connect(target.id));
      return ctx.backend.read(target.id, s.ref, s.include, 'active');
    }).catch(e => {
      const m = msg(e);
      ctx.toast(/not (be )?found|does not exist|404/i.test(m) ? `${s.ref.name} does not exist in ${target.sid} (not transported yet?)` : `Reading ${s.ref.name} in ${target.sid} failed: ${m}`, 'warn', 8000);
      return undefined;
    });
    if (text === undefined) return;
    ctx.openDiff(text, `${target.sid} active`, await ctx.editorText(), 'Editor');
  }

  return { compareRevision, compareSystem };
}
