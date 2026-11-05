// Bottom panel views for runtime analysis: the profiler (ABAP traces) and runtime errors (ST22).
// Pure renderers: the workbench passes the state in and handles the data-act clicks.

import type { Dump, TraceHit, TraceRun } from '../core/types';
import { INCLUDE_LABEL } from '../core/types';
import { ic } from './icons';
import { esc } from './util';

export const ms = (us?: number) => us === undefined ? '–' : us >= 1000 ? `${(us / 1000).toLocaleString(undefined, { maximumFractionDigits: us >= 100_000 ? 0 : 1 })} ms` : `${us} µs`;

export interface TracesView {
  user: string;
  /** the open object can be profiled: its name */
  profile?: string;
  sel: { run: TraceRun; hits: TraceHit[] } | null;
  list: TraceRun[] | { error: string } | null;
}

export function renderTraces(v: TracesView): string {
  const bar = `<div class="sumline trc-bar"><b>ABAP Profiler</b>
    <button class="btn small" data-act="trc-request" title="The next run of ${esc(v.user)} in any process is traced (a Fiori app, a report in SAP GUI, a console class)">Trace my next run</button>
    ${v.profile ? `<button class="btn small primary" data-act="trc-profile">Profile ${esc(v.profile)}</button>` : ''}
    <button class="btn small ghost" data-act="trc-refresh">Refresh</button></div>`;
  if (v.sel) {
    const { run, hits } = v.sel;
    const max = Math.max(1, ...hits.map(h => h.net));
    return `${bar}<div class="sumline"><button class="link" data-act="trc-back">All traces</button><b>${esc(run.title)}</b><span class="muted">${esc(new Date(run.at).toLocaleString())} · total ${ms(run.runtime)}</span></div>
      <table class="trc-hits"><thead><tr><th>Called unit</th><th class="num">Hits</th><th class="num">Gross</th><th class="num">Net</th><th class="trc-netbar">Net time</th></tr></thead><tbody>${[...hits].sort((a, b) => b.net - a.net).map((h, i) => `
        <tr ${h.at ? `class="go" data-act="goto" data-uri="${esc(h.at.uri)}" data-inc="${h.at.include}" data-line="${h.at.line}" title="Open where it is called"` : ''}><td><span class="trc-name">${esc(h.name)}</span><small>${esc(h.program)}</small></td><td class="num">${h.hits}</td><td class="num">${ms(h.gross)}</td><td class="num">${ms(h.net)}</td><td class="trc-netbar"><i style="width:${Math.max(2, Math.round(h.net * 100 / max))}%" class="${i === 0 ? 'top' : ''}"></i><span>${h.netPct.toFixed(1)}%</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty-panel">The trace has no entries.</td></tr>'}</tbody></table>`;
  }
  const list = v.list;
  if (!list) return `${bar}<div class="empty-panel"><i class="spin"></i>Reading the traces of ${esc(v.user)}</div>`;
  if ('error' in list) return `${bar}<div class="empty-panel sys-err">${esc(list.error)}</div>`;
  if (!list.length) return `${bar}<div class="empty-panel">No traces yet. Press <b>Trace my next run</b> and then run your code (a Fiori app, a report in SAP GUI), or <b>Profile</b> a console class.</div>`;
  return `${bar}<ul class="trc-list">${list.map(r => {
    const total = r.runtime || 0;
    const pc = (x?: number) => total && x ? Math.round(x * 100 / total) : 0;
    return `<li><button class="prow" data-act="trc-open" data-id="${esc(r.id)}"><span class="pmsg"><b>${esc(r.objectName || r.title)}</b><small>${esc(r.title)}</small></span>
      <span class="trc-split" title="ABAP ${pc(r.abap)}% · database ${pc(r.db)}% · system ${pc(r.system)}%"><i class="a" style="width:${pc(r.abap)}%"></i><i class="d" style="width:${pc(r.db)}%"></i><i class="s" style="width:${pc(r.system)}%"></i></span>
      <span class="ploc">${ms(r.runtime)} · ${esc(new Date(r.at).toLocaleString())}</span></button>
      <button class="icon-btn" data-act="trc-del" data-id="${esc(r.id)}" title="Delete this trace" aria-label="Delete trace">${ic('close')}</button></li>`;
  }).join('')}</ul>`;
  }

// ---------------------------------------------------------------- runtime errors (ST22)
export interface DumpsView {
  user: string;
  list: Dump[] | { error: string } | null;
  /** only the user's own errors */
  mine: boolean;
  sel: { dump: Dump; html?: string; text?: string } | null;
}

const when = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? iso : d.toLocaleString(); };
const goAttrs = (d: Dump) => d.where ? `data-act="goto" data-uri="${esc(d.where.uri)}" data-inc="${d.where.include}" data-line="${d.where.line}"` : '';

export function ownDumps(list: Dump[], user: string, mine: boolean): Dump[] {
  const u = user.toUpperCase();
  return mine && u ? list.filter(d => !d.user || d.user.toUpperCase() === u) : list;
}

export function renderDumps(v: DumpsView): string {
  const bar = `<div class="sumline trc-bar"><b>Runtime Errors</b><span class="muted">ST22</span>
    <label class="check small"><input type="checkbox" data-act="dmp-mine" ${v.mine ? 'checked' : ''}><span>Only ${esc(v.user)}</span></label>
    <button class="btn small ghost" data-act="dmp-refresh">Refresh</button></div>`;
  if (v.sel) {
    const d = v.sel.dump;
    const where = d.where ? `<button class="btn small" ${goAttrs(d)}>Show source line ${d.where.line + 1}${d.where.include !== 'main' ? ' · ' + esc(INCLUDE_LABEL[d.where.include]) : ''}</button>` : '';
    // the system's HTML is shown in a sandboxed frame: no scripts, no access to the workbench
    const detail = v.sel.html !== undefined
      ? `<iframe class="dmp-frame" sandbox="" referrerpolicy="no-referrer" title="Runtime error ${esc(d.error)}" srcdoc="${esc(dumpPage(v.sel.html))}"></iframe>`
      : v.sel.text !== undefined ? `<pre class="out dmp-text">${esc(v.sel.text)}</pre>` : '<div class="empty-panel"><i class="spin"></i>Reading the runtime error</div>';
    return `${bar}<div class="sumline"><button class="link" data-act="dmp-back">All runtime errors</button><b>${esc(d.error)}</b><span class="muted">${esc(d.program)} · ${esc(d.user)} · ${esc(when(d.at))}</span>${where}</div>${detail}`;
  }
  const list = v.list;
  if (!list) return `${bar}<div class="empty-panel"><i class="spin"></i>Reading the runtime errors</div>`;
  if ('error' in list) return `${bar}<div class="empty-panel sys-err">${esc(list.error)}</div>`;
  const shown = ownDumps(list, v.user, v.mine);
  if (!shown.length) return `${bar}<div class="empty-panel">No runtime errors${v.mine ? ` of ${esc(v.user)}` : ''} in the period the system shows (usually the last days). Good news.</div>`;
  return `${bar}<ul class="trc-list dmp-list">${shown.map(d => `<li><button class="prow" data-act="dmp-open" data-id="${esc(d.id)}">${ic('error', 's-error')}<span class="pmsg"><b>${esc(d.error)}</b><small>${esc(d.program)}${d.where ? ` · line ${d.where.line + 1}` : ''}</small></span><span class="ploc">${esc(d.user)} · ${esc(when(d.at))}</span></button>
    ${d.where ? `<button class="icon-btn" ${goAttrs(d)} title="Show where it stopped" aria-label="Show source">${ic('chev')}</button>` : ''}</li>`).join('')}</ul>`;
}

/** The system's description as a small page with readable colors in both themes. */
export function dumpPage(html: string): string {
  const body = /<body[\s>]/i.test(html) ? html : `<body>${html}</body>`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>:root{color-scheme:light}body{font:13px/1.5 system-ui,sans-serif;margin:12px;background:#fff;color:#1d212c}pre,code{font-family:ui-monospace,Consolas,monospace}table{border-collapse:collapse}td,th{padding:2px 6px;vertical-align:top}</style>${body}`;
}

