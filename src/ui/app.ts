// Nusa ADT workbench: explorer, tabs, editor, panels, palette, transports, debugger.
// Everything that talks to a system goes through the Backend interface.

import {
  AtcFinding, Backend, Breakpoint, Connection, DebugState, DebugVar, Hit, Include, INCLUDE_LABEL, Location,
  ObjRef, ObjState, ObjType, Problem, RunResult, StepKind, SystemInfo, Transport, TransportNeed, TYPE_INFO,
  UnitResult, uriFor,
} from '../core/types';
import { bpLines, bpMarker, CM, createEditor, newDoc, showProposals, wordAt } from './editor';
import { ic, LOGO } from './icons';

type View = 'explorer' | 'search' | 'transports' | 'debug' | 'connections';
type PanelTab = 'problems' | 'output' | 'unit' | 'atc' | 'where';
interface Tab { key: string; conn: string; ref: ObjState; include: Include; lock?: string }

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => { let t = 0; return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export async function startApp(backend: Backend, opts: { brand?: string; prototype?: boolean } = {}) {
  const S = {
    conns: [] as Connection[],
    conn: store.get('nusa-adt-conn') || 's4d',
    sys: {} as Record<string, SystemInfo | { error: string }>,
    tabs: [] as Tab[],
    activeByConn: {} as Record<string, string | null>,
    tree: {} as Record<string, Record<string, ObjState[]>>,
    collapsed: new Set<string>(JSON.parse(store.get('nusa-adt-collapsed') || '[]')),
    view: 'explorer' as View,
    sideOpen: window.innerWidth >= 760,
    panel: 'atc' as PanelTab,
    panelOpen: true,
    problems: [] as Problem[],
    output: null as (RunResult & { title: string; at: string }) | null,
    unit: null as (UnitResult & { name: string; at: string }) | null,
    atc: null as { name: string; findings: AtcFinding[]; at: string } | null,
    where: null as { term: string; hits: Hit[] } | null,
    transports: [] as Transport[],
    debug: null as DebugState | null,
    searchQ: '',
    searchRes: [] as ObjRef[],
    busy: '' as string,
  };
  const docs = new Map<string, CM>();

  // ------------------------------------------------------------------ theme
  type ThemePref = 'dark' | 'light' | 'system';
  const html = document.documentElement;
  let hostTheme = html.getAttribute('data-theme');          // what the surrounding page asked for
  let themePref: ThemePref = (store.get('nusa-adt-theme') as ThemePref) || 'dark';
  let applyingTheme = false;
  const effectiveTheme = (): 'dark' | 'light' => themePref !== 'system' ? themePref
    : (hostTheme === 'dark' || hostTheme === 'light') ? hostTheme : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  function applyTheme() {
    applyingTheme = true;
    if (themePref === 'system') { if (hostTheme) html.setAttribute('data-theme', hostTheme); else html.removeAttribute('data-theme'); }
    else html.setAttribute('data-theme', themePref);
    applyingTheme = false;
  }
  new MutationObserver(() => {
    if (applyingTheme) return;
    hostTheme = html.getAttribute('data-theme');
    if (themePref !== 'system' && hostTheme !== themePref) applyTheme();
    renderThemeBits();
  }).observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => renderThemeBits());
  function setTheme(p: ThemePref) {
    themePref = p; store.set('nusa-adt-theme', p); applyTheme(); renderThemeBits();
    toast(p === 'system' ? `Theme follows the system (${effectiveTheme()})` : `${p === 'dark' ? 'Dark' : 'Light'} theme`, 'info', 1600);
  }
  applyTheme();
  const conn = () => S.conns.find(c => c.id === S.conn) as Connection;
  const tabsHere = () => S.tabs.filter(t => t.conn === S.conn);
  const cur = (): Tab | undefined => S.tabs.find(t => t.key === S.activeByConn[S.conn]);
  const docKey = (t: Tab, inc: Include = t.include) => `${t.key}|${inc}`;
  const isDirty = (t: Tab) => backend.includesOf(t.ref.type).some(inc => { const d = docs.get(docKey(t, inc)); return d && !d.isClean(); });
  const incDirty = (t: Tab, inc: Include) => { const d = docs.get(docKey(t, inc)); return !!d && !d.isClean(); };

  // ------------------------------------------------------------------ shell markup
  const root = document.getElementById('nusa-root') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'nusa-root' }));
  root.innerHTML = `
  <div id="app" class="${opts.prototype ? 'is-proto' : ''}">
    <header class="titlebar">
      <div class="brand">${LOGO}<span>${esc(opts.brand || 'Nusa ADT')}</span></div>
      <button class="conn-chip" id="connChip" data-act="pick-conn" title="Switch system"></button>
      <div class="toolbar" role="toolbar" aria-label="Editor actions">
        <button data-cmd="save" title="Save (Ctrl+S)">${ic('save')}<span>Save</span></button>
        <button data-cmd="check" title="Check syntax (Ctrl+F2)">${ic('check')}<span>Check</span></button>
        <button data-cmd="activate" class="primary" title="Activate (Ctrl+F3)">${ic('bolt')}<span>Activate</span></button>
        <span class="tb-sep"></span>
        <button data-cmd="format" title="Format with pretty printer (Shift+F1)">${ic('format')}<span>Format</span></button>
        <button data-cmd="run" title="Run (F8)">${ic('play')}<span>Run</span></button>
        <button data-cmd="unit" title="Run ABAP Unit tests (Ctrl+Shift+F10)">${ic('flask')}<span>Test</span></button>
        <button data-cmd="atc" title="Run ATC checks (Ctrl+Shift+F2)">${ic('shield')}<span>ATC</span></button>
      </div>
      <button class="icon-btn theme-btn" id="themeBtn" data-cmd="theme-toggle" title="Toggle dark mode"></button>
      <button class="omnibox" id="omni" data-act="palette-obj" title="Open ABAP development object (Ctrl+Shift+A)">
        ${ic('search')}<span class="omni-text">Open object or run a command</span><kbd>Ctrl+Shift+A</kbd>
      </button>
    </header>
    <div class="main">
      <nav class="activity" aria-label="Views">
        <button data-view="explorer" title="Project Explorer">${ic('files')}</button>
        <button data-view="search" title="Search objects">${ic('search')}</button>
        <button data-view="transports" title="Transport Organizer">${ic('transport')}<i class="badge" id="trBadge" hidden></i></button>
        <button data-view="debug" title="Debugger">${ic('bug')}</button>
        <span class="grow"></span>
        <button data-view="connections" title="Systems">${ic('server')}</button>
      </nav>
      <aside class="sidebar" id="sidebar">
        <div class="side-head"><h2 id="sideTitle"></h2><div class="side-actions" id="sideActions"></div></div>
        <div class="side-body" id="sideBody"></div>
      </aside>
      <div class="sash sash-v" id="sashSide" role="separator" aria-orientation="vertical"></div>
      <section class="workbench">
        <div class="tabs" id="tabs" role="tablist"></div>
        <div class="crumbs" id="crumbs"></div>
        <div class="editor-wrap">
          <div id="editor"></div>
          <div class="welcome" id="welcome" hidden></div>
          <div class="debugbar" id="debugbar" hidden>
            <span class="grip">Debugging</span>
            <button data-cmd="dbg-continue" title="Resume (F8)">${ic('cont')}</button>
            <button data-cmd="dbg-over" title="Step over (F6)">${ic('over')}</button>
            <button data-cmd="dbg-into" title="Step into (F5)">${ic('into')}</button>
            <button data-cmd="dbg-return" title="Step return (F7)">${ic('ret')}</button>
            <button data-cmd="dbg-stop" class="danger" title="Terminate (Shift+F5)">${ic('stop')}</button>
          </div>
        </div>
        <div class="subtabs" id="subtabs" hidden></div>
        <div class="sash sash-h" id="sashPanel" role="separator" aria-orientation="horizontal"></div>
        <div class="panel" id="panel">
          <div class="panel-tabs" id="panelTabs" role="tablist"></div>
          <div class="panel-body" id="panelBody"></div>
        </div>
      </section>
    </div>
    <footer class="statusbar" id="status"></footer>
  </div>
  <div class="scrim" id="palette" hidden>
    <div class="palette" role="dialog" aria-label="Command palette">
      <input id="palInput" autocomplete="off" spellcheck="false" aria-label="Search objects and commands">
      <div class="pal-hint" id="palHint"></div>
      <ul id="palList" role="listbox"></ul>
    </div>
  </div>
  <div class="scrim" id="modal" hidden><div class="modal" role="dialog" aria-modal="true"></div></div>
  <div class="toasts" id="toasts" aria-live="polite"></div>`;

  const app = $('#app');
  const cm: CM = createEditor($('#editor'));
  const placeholderDoc = newDoc('', 'abap');
  cm.swapDoc(placeholderDoc);

  // ------------------------------------------------------------------ toasts & modal
  function toast(msg: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = `toast t-${kind}`;
    el.innerHTML = `${ic(kind === 'ok' ? 'ok' : kind === 'warn' ? 'warning' : kind === 'error' ? 'error' : 'info')}<span></span>`;
    (el.querySelector('span') as HTMLElement).textContent = msg;
    const box = $('#toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild?.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
  }
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error', 6000);

  let modalResolve: ((v: unknown) => void) | null = null;
  function modal<T>(title: string, body: string, actions: { label: string; value?: unknown; kind?: string; submit?: boolean }[], onMount?: (root: HTMLElement, close: (v: unknown) => void) => void): Promise<T | null> {
    const scrim = $('#modal');
    const root = $('.modal', scrim);
    root.innerHTML = `<h3>${esc(title)}</h3><form class="modal-body" id="modalForm">${body}<div class="modal-actions">${actions.map((a, i) =>
      `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></form>`;
    scrim.hidden = false;
    return new Promise<T | null>(resolve => {
      const close = (v: unknown) => { scrim.hidden = true; modalResolve = null; resolve(v as T | null); setTimeout(() => cm.focus(), 0); };
      modalResolve = close;
      root.querySelectorAll<HTMLButtonElement>('.modal-actions button').forEach(b => {
        b.onclick = (ev) => { const a = actions[+(b.dataset.i as string)]; if (a.submit) return; ev.preventDefault(); close(a.value ?? null); };
      });
      onMount?.(root, close);
      const first = root.querySelector<HTMLElement>('input,select,textarea,button.primary');
      first?.focus();
    });
  }

  // ------------------------------------------------------------------ data loading
  async function loadConn() {
    try {
      S.sys[S.conn] = await backend.connect(S.conn);
    } catch (e) {
      S.sys[S.conn] = { error: e instanceof Error ? e.message : String(e) };
    }
    await loadTree();
    try { S.transports = conn().transports ? await backend.transports(S.conn) : []; } catch { S.transports = []; }
  }
  async function loadTree() {
    const c = conn();
    const pkgs = [...new Set([...c.favoritePackages, ...(c.kind === 'runner' ? [] : ['$TMP'])])];
    const t: Record<string, ObjState[]> = {};
    for (const p of pkgs) { try { t[p] = await backend.packageObjects(S.conn, p); } catch { t[p] = []; } }
    S.tree[S.conn] = t;
  }
  const allObjs = () => Object.values(S.tree[S.conn] || {}).flat();
  const objByUri = (uri: string) => allObjs().find(o => o.uri === uri);

  // ------------------------------------------------------------------ rendering
  function renderTitle() {
    const c = conn();
    const sys = S.sys[S.conn];
    const err = sys && 'error' in sys;
    $('#connChip').innerHTML = `<i class="dot ${err ? 'bad' : 'good'}"></i><b>${esc(c.sid)}</b><span>${esc(c.client)} · ${esc(c.user)}</span>${ic('chev', 'rot90')}`;
    const t = cur();
    app.querySelectorAll<HTMLButtonElement>('.toolbar button').forEach(b => {
      const cmd = b.dataset.cmd as string;
      let dis = !t;
      if (t && cmd === 'unit') dis = t.ref.type !== 'CLAS';
      if (t && cmd === 'run') dis = !(t.ref.type === 'PROG' || t.ref.type === 'CLAS');
      if (t && cmd === 'format') dis = t.ref.type === 'DDLS';
      b.disabled = dis;
    });
  }

  function renderActivity() {
    app.querySelectorAll<HTMLButtonElement>('.activity button').forEach(b => {
      b.classList.toggle('on', S.sideOpen && b.dataset.view === S.view);
      b.setAttribute('aria-pressed', String(S.sideOpen && b.dataset.view === S.view));
    });
    const open = S.transports.filter(t => t.status === 'modifiable').length;
    const badge = $('#trBadge');
    badge.hidden = !open; badge.textContent = String(open);
    app.classList.toggle('side-closed', !S.sideOpen);
  }

  function glyph(type: ObjType) { return `<i class="glyph g-${type}">${TYPE_INFO[type].glyph}</i>`; }

  function treeNode(id: string, label: string, inner: string, extra = '', depth = 0) {
    const closed = S.collapsed.has(id);
    return `<li class="node ${closed ? 'closed' : ''}" style="--d:${depth}">
      <button class="row" data-act="toggle" data-id="${esc(id)}" aria-expanded="${!closed}">${ic('chev', 'twisty')}<span class="lbl">${label}</span>${extra}</button>
      <ul>${inner}</ul></li>`;
  }
  function objRow(o: ObjState, depth: number) {
    const t = cur();
    const on = t && t.ref.uri === o.uri;
    return `<li style="--d:${depth}"><button class="row leaf ${on ? 'on' : ''}" data-act="open" data-uri="${esc(o.uri)}" title="${esc(o.desc)}">
      ${glyph(o.type)}<span class="lbl">${esc(o.name)}</span>${o.inactive ? '<em class="inact" title="Inactive version exists">inactive</em>' : ''}</button></li>`;
  }

  function renderExplorer() {
    const c = conn();
    const sys = S.sys[S.conn];
    const tree = S.tree[S.conn] || {};
    const pkgHtml = (pkg: string, depth: number) => {
      const objs = tree[pkg] || [];
      const groups: string[] = [];
      const cds = objs.filter(o => TYPE_INFO[o.type].group === 'cds');
      if (cds.length) groups.push(treeNode(`${S.conn}/${pkg}/cds`, 'Core Data Services',
        treeNode(`${S.conn}/${pkg}/cds/DDLS`, 'Data Definitions', cds.map(o => objRow(o, depth + 3)).join(''), `<span class="cnt">${cds.length}</span>`, depth + 2), '', depth + 1));
      const src = objs.filter(o => TYPE_INFO[o.type].group === 'src');
      if (src.length) {
        const sub = (['CLAS', 'INTF', 'PROG'] as ObjType[]).map(ty => {
          const list = src.filter(o => o.type === ty);
          return list.length ? treeNode(`${S.conn}/${pkg}/src/${ty}`, TYPE_INFO[ty].folder, list.map(o => objRow(o, depth + 3)).join(''), `<span class="cnt">${list.length}</span>`, depth + 2) : '';
        }).join('');
        groups.push(treeNode(`${S.conn}/${pkg}/src`, 'Source Code Library', sub, '', depth + 1));
      }
      if (!objs.length) groups.push(`<li class="empty" style="--d:${depth + 1}">No objects yet</li>`);
      return groups.join('');
    };
    const favs = c.favoritePackages.map(p => treeNode(`${S.conn}/${p}`, `<i class="pkg-ic"></i>${esc(p)}`, pkgHtml(p, 2), '', 1)).join('');
    const tmp = c.kind !== 'runner' && (tree['$TMP'] || []).length ? treeNode(`${S.conn}/$TMP`, '<i class="pkg-ic local"></i>Local Objects ($TMP)', pkgHtml('$TMP', 1), '', 0) : '';
    const sysLine = sys ? ('error' in sys ? `<span class="sys-err">${esc(sys.error)}</span>` : esc(sys.release)) : 'Connecting…';
    $('#sideBody').innerHTML = `
      <div class="sys-card">
        <div class="sys-top"><b>${esc(c.sid)}</b><span>${esc(c.client)}, ${esc(c.user)}, ${esc(c.language)}</span></div>
        <div class="sys-sub">${sysLine}</div>
      </div>
      <ul class="tree" role="tree">
        ${treeNode(`${S.conn}/fav`, 'Favorite Packages', favs, '', 0)}
        ${tmp}
      </ul>`;
  }

  function renderSearch() {
    const res = S.searchRes;
    $('#sideBody').innerHTML = `
      <div class="side-pad">
        <label class="field"><span>Object name or description</span>
          <input id="searchInput" value="${esc(S.searchQ)}" placeholder="ZCL_NUSA*" autocomplete="off" spellcheck="false"></label>
      </div>
      <ul class="list">${res.map(o => `<li><button class="row leaf" data-act="open" data-uri="${esc(o.uri)}">${glyph(o.type)}<span class="lbl">${esc(o.name)}<small>${esc(o.desc)}</small></span></button></li>`).join('') ||
        `<li class="empty">${S.searchQ ? 'No objects match' : 'Type to search the repository of ' + esc(conn().sid)}</li>`}</ul>`;
    const inp = $<HTMLInputElement>('#searchInput');
    inp.oninput = debounce(async () => {
      S.searchQ = inp.value;
      S.searchRes = S.searchQ ? await backend.search(S.conn, S.searchQ) : [];
      const pos = inp.selectionStart;
      renderSearch();
      const again = $<HTMLInputElement>('#searchInput'); again.focus(); again.setSelectionRange(pos, pos);
    }, 180);
  }

  function renderTransports() {
    const c = conn();
    if (!c.transports) {
      $('#sideBody').innerHTML = `<div class="side-pad note">${esc(c.label || c.sid)} keeps objects local. Nothing here needs a transport request.</div>`;
      return;
    }
    const list = S.transports;
    $('#sideBody').innerHTML = `
      <form class="side-pad new-tr" id="newTr">
        <label class="field"><span>New request</span><input id="newTrDesc" placeholder="Short description" maxlength="60" required></label>
        <button class="btn" type="submit">${ic('plus')}Create</button>
      </form>
      <ul class="trs">${list.map(t => `
        <li class="tr ${t.status}">
          <div class="tr-head">
            <code>${esc(t.id)}</code>
            <span class="pill ${t.status === 'modifiable' ? 'p-open' : 'p-done'}">${t.status === 'modifiable' ? 'Modifiable' : 'Released'}</span>
          </div>
          <div class="tr-desc">${esc(t.desc)}</div>
          <div class="tr-meta">Owner ${esc(t.owner)}${t.task ? ` · Task <code>${esc(t.task)}</code>` : ''}</div>
          <ul class="tr-objs">${t.objects.map(e => {
            const [, type, name] = e.split(' ');
            const o = allObjs().find(x => x.name === name && x.type === type);
            return `<li>${o ? `<button class="link" data-act="open" data-uri="${esc(o.uri)}">` : '<span>'}${glyph(type as ObjType)}${esc(name)}${o ? '</button>' : '</span>'}<small>R3TR ${esc(type)}</small></li>`;
          }).join('') || '<li class="empty">No objects recorded</li>'}</ul>
          ${t.status === 'modifiable' ? `<div class="tr-actions"><button class="btn ghost" data-act="release" data-id="${esc(t.id)}">Release…</button></div>` : ''}
        </li>`).join('') || '<li class="empty">No requests</li>'}</ul>`;
    ($('#newTr') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const desc = $<HTMLInputElement>('#newTrDesc').value.trim();
      if (!desc) return;
      const t = cur();
      try {
        const id = await backend.createTransport(S.conn, desc, t?.ref ?? { uri: '', name: '', type: 'CLAS', pkg: '', desc: '' });
        S.transports = await backend.transports(S.conn);
        toast(`Created request ${id}`, 'ok');
        renderSide(); renderActivity();
      } catch (er) { fail(er); }
    };
  }

  function varTree(vs: DebugVar[]): string {
    return vs.map(v => v.children && v.children.length
      ? `<li><details><summary><span class="vn">${esc(v.name)}</span><span class="vv">${esc(v.value)}</span><span class="vt">${esc(v.type)}</span></summary><ul>${varTree(v.children)}</ul></details></li>`
      : `<li class="leafvar"><span class="vn">${esc(v.name)}</span><span class="vv">${esc(v.value)}</span><span class="vt">${esc(v.type)}</span></li>`).join('');
  }

  function allBreakpoints(): Breakpoint[] {
    const out: Breakpoint[] = [];
    for (const [k, d] of docs) {
      const [c, uri, inc] = k.split('|');
      if (c !== S.conn) continue;
      for (const line of bpLines(d)) out.push({ uri, include: inc as Include, line });
    }
    return out;
  }

  function renderDebug() {
    const d = S.debug;
    const bps = allBreakpoints();
    const bpHtml = bps.map(b => {
      const o = objByUri(b.uri);
      return `<li><button class="row leaf" data-act="goto" data-uri="${esc(b.uri)}" data-inc="${b.include}" data-line="${b.line}"><i class="bp-dot"></i><span class="lbl">${esc(o?.name || b.uri)}<small>${b.include === 'main' ? '' : esc(INCLUDE_LABEL[b.include]) + ' · '}line ${b.line + 1}</small></span></button></li>`;
    }).join('') || '<li class="empty">Click left of a line number to set a breakpoint</li>';
    const t = cur();
    const canDebug = t && t.ref.type === 'PROG';
    $('#sideBody').innerHTML = d && !d.done ? `
      <section class="dsec"><h3>Variables</h3><ul class="vars">${varTree(d.vars)}</ul></section>
      <section class="dsec"><h3>Call stack</h3><ol class="stack">${d.frames.map((f, i) => `<li><button class="row leaf ${i === 0 ? 'on' : ''}" data-act="goto" data-uri="${esc(f.uri)}" data-inc="${f.include}" data-line="${f.line}"><span class="lbl">${esc(f.name)}<small>line ${f.line + 1}</small></span></button></li>`).join('')}</ol></section>
      <section class="dsec"><h3>Breakpoints</h3><ul class="list">${bpHtml}</ul></section>`
      : `<div class="side-pad note">${canDebug ? `Set a breakpoint in <b>${esc(t!.ref.name)}</b> or in a class it calls, then press <kbd>F8</kbd>.` : 'Open a program, set a breakpoint and press <kbd>F8</kbd> to debug it.'}
          ${canDebug ? `<button class="btn primary block" data-cmd="run">${ic('play')}Debug ${esc(t!.ref.name)}</button>` : ''}</div>
        <section class="dsec"><h3>Breakpoints</h3><ul class="list">${bpHtml}</ul></section>`;
  }

  function renderConnections() {
    $('#sideBody').innerHTML = `
      <ul class="conns">${S.conns.map(c => {
        const sys = S.sys[c.id];
        return `<li class="conn ${c.id === S.conn ? 'on' : ''}">
          <div class="conn-head"><b>${esc(c.sid)}</b><span class="pill k-${c.kind}">${c.kind === 's4' ? 'S/4HANA' : c.kind === 'btp' ? 'BTP' : 'Runner'}</span></div>
          <div class="conn-sub">${esc(c.label || '')}</div>
          <dl>
            <dt>URL</dt><dd><code>${esc(c.url)}</code></dd>
            <dt>Client</dt><dd>${esc(c.client)} · ${esc(c.user)} · ${esc(c.language)}</dd>
            <dt>Login</dt><dd>${c.auth === 'basic' ? 'User and password (keychain)' : c.auth === 'oauth' ? 'Browser single sign-on (OAuth)' : 'No login'}</dd>
            <dt>ABAP</dt><dd>${c.abapVersion === 'cloud' ? 'ABAP for Cloud Development' : c.abapVersion === 'runner' ? 'Runner subset' : 'Standard ABAP'}</dd>
            ${sys ? `<dt>System</dt><dd>${'error' in sys ? `<span class="sys-err">${esc(sys.error)}</span>` : esc(sys.release)}</dd>` : ''}
          </dl>
          ${c.id === S.conn ? '<div class="conn-state">Connected</div>' : `<button class="btn" data-act="switch" data-id="${esc(c.id)}">Connect</button>`}
        </li>`;
      }).join('')}</ul>
      <form class="side-pad add-conn" id="addConn">
        <h3>Add system</h3>
        <label class="field"><span>Type</span><select id="acKind"><option value="s4">S/4HANA or NetWeaver (on-premise)</option><option value="btp">BTP ABAP Environment</option><option value="runner">Local ABAP runner</option></select></label>
        <div class="two">
          <label class="field"><span>System ID</span><input id="acSid" maxlength="8" placeholder="S4D" required></label>
          <label class="field"><span>Client</span><input id="acClient" maxlength="3" placeholder="100" inputmode="numeric"></label>
        </div>
        <label class="field"><span>URL</span><input id="acUrl" placeholder="https://host:44300" required></label>
        <label class="field"><span>User</span><input id="acUser" placeholder="DEVELOPER"></label>
        <label class="check"><input type="checkbox" id="acSelfSigned"><span>Accept a self-signed certificate (development systems only)</span></label>
        <button class="btn primary" type="submit">Save system</button>
      </form>`;
    ($('#addConn') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const kind = $<HTMLSelectElement>('#acKind').value as Connection['kind'];
      const sid = $<HTMLInputElement>('#acSid').value.trim().toUpperCase();
      const c: Connection = {
        id: sid.toLowerCase() + '-' + Date.now().toString(36), kind, sid,
        client: $<HTMLInputElement>('#acClient').value.trim() || '100',
        user: $<HTMLInputElement>('#acUser').value.trim().toUpperCase(),
        url: $<HTMLInputElement>('#acUrl').value.trim(), language: 'EN',
        auth: kind === 'btp' ? 'oauth' : kind === 'runner' ? 'none' : 'basic',
        abapVersion: kind === 'btp' ? 'cloud' : kind === 'runner' ? 'runner' : 'standard',
        favoritePackages: kind === 'runner' ? ['$TMP'] : [], transports: kind !== 'runner',
        allowSelfSigned: $<HTMLInputElement>('#acSelfSigned').checked || undefined,
      };
      let secret: string | undefined;
      if (c.auth === 'basic') {
        secret = await modal<string>(`Password for ${c.user || 'user'} on ${sid}`, `<label class="field"><span>Password</span><input type="password" id="pw" autocomplete="off"></label><p class="note">Stored in the operating system keychain, never in the project folder.</p>`,
          [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', submit: true }],
          (root, close) => { ($('#modalForm', root) as HTMLFormElement).onsubmit = ev => { ev.preventDefault(); close($<HTMLInputElement>('#pw', root).value); }; }) ?? undefined;
        if (secret === undefined) return;
      } else if (c.auth === 'oauth') {
        secret = await modal<string>(`Service key for ${sid}`, `<label class="field"><span>Service key (JSON)</span><textarea id="sk" rows="8" spellcheck="false" placeholder='{ "url": "https://….abap.….hana.ondemand.com", "uaa": { "url": "…", "clientid": "…", "clientsecret": "…" } }'></textarea></label><p class="note">Create it in the BTP cockpit on your ABAP environment instance. It is stored in the operating system keychain. You log in through the browser on first use.</p><p class="form-err" id="skErr" hidden></p>`,
          [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', submit: true }],
          (root, close) => { ($('#modalForm', root) as HTMLFormElement).onsubmit = ev => {
            ev.preventDefault();
            const v = $<HTMLTextAreaElement>('#sk', root).value.trim();
            try { const k = JSON.parse(v); if (!k.uaa?.url || !k.uaa?.clientid) throw new Error('uaa'); if (k.url && !c.url) c.url = k.url; close(v); }
            catch { const e = $('#skErr', root); e.hidden = false; e.textContent = 'This is not a service key. It needs a "uaa" section with url, clientid and clientsecret.'; }
          }; }) ?? undefined;
        if (secret === undefined) return;
      }
      try {
        await backend.saveConnection(c, secret);
        S.conns = await backend.connections();
        toast(`Saved ${sid}`, 'ok');
        renderSide();
      } catch (er) { fail(er); }
    };
  }

  function renderSide() {
    const titles: Record<View, string> = { explorer: 'Project Explorer', search: 'Search', transports: 'Transport Organizer', debug: 'Debug', connections: 'Systems' };
    $('#sideTitle').textContent = titles[S.view];
    $('#sideActions').innerHTML = S.view === 'explorer'
      ? `<button data-cmd="new" title="New ABAP object">${ic('plus')}</button><button data-cmd="refresh" title="Refresh">${ic('refresh')}</button><button data-act="collapse-all" title="Collapse all">${ic('collapse')}</button>`
      : S.view === 'transports' ? `<button data-cmd="refresh" title="Refresh">${ic('refresh')}</button>` : '';
    ({ explorer: renderExplorer, search: renderSearch, transports: renderTransports, debug: renderDebug, connections: renderConnections })[S.view]();
  }

  function renderTabs() {
    const t = cur();
    $('#tabs').innerHTML = tabsHere().map(x => `
      <div class="tab ${t && x.key === t.key ? 'on' : ''} ${x.ref.inactive ? 'inactive' : ''}" role="tab" aria-selected="${!!t && x.key === t.key}" data-act="tab" data-key="${esc(x.key)}" title="${esc(x.ref.desc)}">
        ${glyph(x.ref.type)}<span class="tname">${esc(x.ref.name)}</span>
        ${x.lock ? `<span class="tlock" title="Locked by you">${ic('lock')}</span>` : ''}
        <button class="tclose ${isDirty(x) ? 'dirty' : ''}" data-act="close" data-key="${esc(x.key)}" title="${isDirty(x) ? 'Unsaved changes. Close' : 'Close'}" aria-label="Close ${esc(x.ref.name)}">${ic('close')}</button>
      </div>`).join('');
  }

  function renderCrumbs() {
    const t = cur();
    const el = $('#crumbs');
    if (!t) { el.innerHTML = ''; return; }
    const c = conn();
    const st = t.ref.inactive ? '<span class="pill p-warn">Inactive</span>' : '<span class="pill p-ok">Active</span>';
    el.innerHTML = `<span>${esc(c.sid)}</span>${ic('chev')}<span>${esc(t.ref.pkg)}</span>${ic('chev')}<span>${esc(TYPE_INFO[t.ref.type].folder)}</span>${ic('chev')}<b>${esc(t.ref.name)}</b>
      ${t.ref.type === 'CLAS' ? `${ic('chev')}<span>${esc(INCLUDE_LABEL[t.include])}</span>` : ''}
      <span class="crumb-right">${st}${t.ref.transport ? `<code class="crumb-tr" title="Transport request">${esc(t.ref.transport)}</code>` : ''}<code class="uri">${esc(t.ref.uri)}</code></span>`;
  }

  function renderSubtabs() {
    const t = cur();
    const el = $('#subtabs');
    if (!t || t.ref.type !== 'CLAS') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = backend.includesOf('CLAS').map(inc => `<button class="${inc === t.include ? 'on' : ''}" data-act="inc" data-inc="${inc}">${esc(INCLUDE_LABEL[inc])}${incDirty(t, inc) ? '<i class="ddot"></i>' : ''}</button>`).join('');
  }

  function sevIcon(s: Problem['sev']) { return ic(s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'info', 's-' + s); }
  const locAttrs = (l: Location) => `data-act="goto" data-uri="${esc(l.uri)}" data-inc="${l.include}" data-line="${l.line}"`;

  function renderPanel() {
    app.classList.toggle('panel-closed', !S.panelOpen);
    const errs = S.problems.filter(p => p.sev === 'error').length;
    const warns = S.problems.filter(p => p.sev === 'warning').length;
    const tabs: [PanelTab, string, string][] = [
      ['problems', 'Problems', S.problems.length ? `<i class="cnt ${errs ? 'c-err' : 'c-warn'}">${S.problems.length}</i>` : ''],
      ['atc', 'ATC Findings', S.atc ? `<i class="cnt">${S.atc.findings.length}</i>` : ''],
      ['unit', 'ABAP Unit', S.unit ? `<i class="cnt ${S.unit.methods.some(m => m.status !== 'ok') ? 'c-err' : 'c-ok'}">${S.unit.methods.length}</i>` : ''],
      ['output', 'Output', ''],
      ['where', 'Where-Used', S.where ? `<i class="cnt">${S.where.hits.length}</i>` : ''],
    ];
    $('#panelTabs').innerHTML = tabs.map(([id, label, extra]) => `<button role="tab" class="${S.panel === id ? 'on' : ''}" aria-selected="${S.panel === id}" data-act="panel" data-id="${id}">${label}${extra}</button>`).join('') +
      `<span class="grow"></span>${S.busy ? `<span class="busy"><i class="spin"></i>${esc(S.busy)}</span>` : ''}<button class="icon-btn" data-cmd="panel" title="Hide panel (Ctrl+J)">${ic('close')}</button>`;
    const body = $('#panelBody');
    void warns;
    if (S.panel === 'problems') {
      if (!S.problems.length) { body.innerHTML = '<div class="empty-panel">No problems. Syntax check runs on save, on activation and with Ctrl+F2.</div>'; return; }
      const byObj = new Map<string, Problem[]>();
      for (const p of S.problems) byObj.set(p.uri, [...(byObj.get(p.uri) || []), p]);
      body.innerHTML = [...byObj].map(([uri, ps]) => {
        const o = objByUri(uri);
        return `<div class="pgroup"><div class="pg-head">${o ? glyph(o.type) : ''}<b>${esc(o?.name || uri)}</b><span>${ps.length}</span></div>
          <ul>${ps.map(p => `<li><button class="prow" ${locAttrs(p)}>${sevIcon(p.sev)}<span class="pmsg">${esc(p.msg)}</span><span class="ploc">${p.include !== 'main' ? esc(INCLUDE_LABEL[p.include]) + ' · ' : ''}line ${p.line + 1}</span><span class="psrc">${p.source}</span></button></li>`).join('')}</ul></div>`;
      }).join('');
    } else if (S.panel === 'atc') {
      if (!S.atc) { body.innerHTML = '<div class="empty-panel">Run ATC with Ctrl+Shift+F2 to check the current object.</div>'; return; }
      const f = S.atc.findings;
      const n = (p: number) => f.filter(x => x.prio === p).length;
      body.innerHTML = `<div class="sumline"><b>${esc(S.atc.name)}</b><span class="pill pr1">Priority 1 · ${n(1)}</span><span class="pill pr2">Priority 2 · ${n(2)}</span><span class="pill pr3">Priority 3 · ${n(3)}</span><span class="muted">${esc(S.atc.at)}</span></div>
        <ul>${f.map(x => `<li><button class="prow" ${locAttrs(x.at)}><span class="prio pr${x.prio}">${x.prio}</span><span class="pmsg">${esc(x.msg)}</span><span class="ploc">${esc(x.check)} · ${x.at.include !== 'main' ? esc(INCLUDE_LABEL[x.at.include]) + ' · ' : ''}line ${x.at.line + 1}</span></button></li>`).join('') || '<li class="empty-panel">No findings</li>'}</ul>`;
    } else if (S.panel === 'unit') {
      const u = S.unit;
      if (!u) { body.innerHTML = '<div class="empty-panel">Run ABAP Unit with Ctrl+Shift+F10.</div>'; return; }
      const ok = u.methods.filter(m => m.status === 'ok').length;
      const bad = u.methods.length - ok;
      const ms = u.methods.reduce((a, m) => a + m.ms, 0);
      const pct = u.methods.length ? Math.round(ok * 100 / u.methods.length) : 0;
      body.innerHTML = `<div class="sumline"><b>${esc(u.name)}</b><span>${u.methods.length} tests</span><span class="s-ok">${ok} passed</span>${bad ? `<span class="s-error">${bad} failed</span>` : ''}<span class="muted">${ms} ms · ${esc(u.at)}</span>
          <span class="bar"><i style="width:${pct}%"></i></span></div>
        ${u.note ? `<div class="notice">${ic('info')}${esc(u.note)}</div>` : ''}
        <ul>${u.methods.map(m => `<li><button class="prow" ${m.at ? locAttrs(m.at) : ''}>${ic(m.status === 'ok' ? 'ok' : 'error', m.status === 'ok' ? 's-ok' : 's-error')}<span class="pmsg"><code>${esc(m.cls.toUpperCase())}→${esc(m.method.toUpperCase())}</code>${m.msg ? `<small>${esc(m.msg)}</small>` : ''}</span><span class="ploc">${m.ms} ms</span></button></li>`).join('') || '<li class="empty-panel">No test methods found. Add test classes in the Test Classes tab.</li>'}</ul>`;
    } else if (S.panel === 'output') {
      const o = S.output;
      body.innerHTML = o ? `<div class="sumline"><b>${esc(o.title)}</b><span class="muted">${o.kind === 'list' ? 'ABAP list' : 'Console'} · ${esc(o.at)}</span></div>${o.note ? `<div class="notice">${ic('info')}${esc(o.note)}</div>` : ''}<pre class="out">${esc(o.output)}</pre>`
        : '<div class="empty-panel">Run a program with F8 or a console class (IF_OO_ADT_CLASSRUN) with F9.</div>';
    } else {
      const w = S.where;
      if (!w) { body.innerHTML = '<div class="empty-panel">Place the cursor on a name and press Ctrl+Shift+G.</div>'; return; }
      body.innerHTML = `<div class="sumline"><b>${esc(w.term)}</b><span>${w.hits.length} references</span></div><ul>${w.hits.map(h => `<li><button class="prow" ${locAttrs(h)}>${glyph(h.type)}<span class="pmsg"><code>${esc(h.text)}</code></span><span class="ploc">${esc(h.name)}${h.include !== 'main' ? ' · ' + esc(INCLUDE_LABEL[h.include]) : ''} · line ${h.line + 1}</span></button></li>`).join('')}</ul>`;
    }
  }

  function renderStatus() {
    const c = conn();
    const t = cur();
    const pos = cm.getCursor();
    const errs = S.problems.filter(p => p.sev === 'error').length;
    const warns = S.problems.filter(p => p.sev === 'warning').length;
    const lang = c.abapVersion === 'cloud' ? 'ABAP for Cloud Development' : c.abapVersion === 'runner' ? 'ABAP · runner subset' : 'Standard ABAP';
    app.classList.toggle('debugging', !!(S.debug && !S.debug.done));
    $('#status').innerHTML = `
      <button data-act="pick-conn" title="Switch system">${ic('server')}${esc(c.sid)} ${esc(c.client)} · ${esc(c.user)}</button>
      ${t && t.ref.transport ? `<button data-act="view" data-id="transports" title="Transport request">${ic('transport')}${esc(t.ref.transport)}</button>` : t && t.ref.pkg.startsWith('$') ? `<span>${ic('transport')}Local object</span>` : ''}
      <button data-act="panel" data-id="problems" title="Problems">${ic('error')}${errs} ${ic('warning')}${warns}</button>
      ${S.debug && !S.debug.done ? `<span class="dbg-pill">${ic('bug')}Debugging</span>` : ''}
      <span class="grow"></span>
      <button id="themeStatus" data-act="pick-theme" title="Color theme"></button>
      ${t ? `<span>${t.lock ? ic('lock') + 'Locked' : 'Not locked'}</span><span>Ln ${pos.line + 1}, Col ${pos.ch + 1}</span><span>${t.ref.type === 'DDLS' ? 'CDS' : lang}</span><span>${t.ref.inactive ? 'Inactive' : 'Active'}</span>` : `<span>${esc(lang)}</span>`}`;
    renderThemeBits();
  }

  function renderWelcome() {
    const show = !cur();
    $('#welcome').hidden = !show;
    $('#editor').style.visibility = show ? 'hidden' : 'visible';
    if (!show) return;
    const keys: [string, string][] = [
      ['Open ABAP object', 'Ctrl+Shift+A'], ['All commands', 'Ctrl+Shift+P'], ['Save', 'Ctrl+S'], ['Activate', 'Ctrl+F3'],
      ['Check syntax', 'Ctrl+F2'], ['Pretty printer', 'Shift+F1'], ['Run', 'F8'], ['Code completion', 'Ctrl+Space'],
      ['Navigate to definition', 'F3'], ['Where-used list', 'Ctrl+Shift+G'],
    ];
    $('#welcome').innerHTML = `<div class="wel">${LOGO}<h1>${esc(opts.brand || 'Nusa ADT')}</h1><p>Connected to <b>${esc(conn().sid)}</b>. Open an object from the explorer or search for one.</p>
      <div class="wel-actions"><button class="btn primary" data-act="palette-obj">${ic('search')}Open object</button><button class="btn" data-cmd="new">${ic('plus')}New object</button></div>
      <dl class="keys">${keys.map(([a, k]) => `<dt>${a}</dt><dd><kbd>${k}</kbd></dd>`).join('')}</dl></div>`;
  }

  function renderThemeBits() {
    const eff = effectiveTheme();
    const btn = document.getElementById('themeBtn');
    if (btn) { btn.innerHTML = ic(eff === 'dark' ? 'sun' : 'moon'); btn.title = eff === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'; }
    const sb = document.getElementById('themeStatus');
    if (sb) sb.innerHTML = `${ic(themePref === 'system' ? 'monitor' : themePref === 'dark' ? 'moon' : 'sun')}${themePref === 'system' ? 'System' : themePref === 'dark' ? 'Dark' : 'Light'}`;
  }

  function renderAll() {
    renderTitle(); renderActivity(); renderSide(); renderTabs(); renderCrumbs(); renderSubtabs(); renderPanel(); renderStatus(); renderWelcome(); renderThemeBits();
    $('#debugbar').hidden = !(S.debug && !S.debug.done);
  }

  // ------------------------------------------------------------------ editor binding
  let swapping = false;
  async function ensureDoc(t: Tab, inc: Include): Promise<CM> {
    const k = docKey(t, inc);
    let d = docs.get(k);
    if (!d) {
      const text = await backend.read(t.conn, t.ref, inc, 'inactive');
      d = docs.get(k) || newDoc(text, t.ref.type === 'DDLS' ? 'cds' : 'abap');
      docs.set(k, d);
    }
    return d;
  }

  async function showTab(t: Tab, inc: Include = t.include, line?: number) {
    t.include = inc;
    S.activeByConn[S.conn] = t.key;
    const d = await ensureDoc(t, inc);
    swapping = true;
    if (cm.getDoc() !== d) cm.swapDoc(d);
    swapping = false;
    markProblems();
    markDebugLine();
    if (line !== undefined) {
      cm.setCursor({ line, ch: (cm.getLine(line) || '').search(/\S|$/) });
      cm.scrollIntoView({ line, ch: 0 }, cm.getScrollInfo().clientHeight / 3);
    }
    renderAll();
    if (window.innerWidth < 760 && S.sideOpen && S.view === 'explorer') { S.sideOpen = false; renderActivity(); }
    setTimeout(() => { cm.refresh(); cm.focus(); }, 0);
  }

  async function openObj(ref: ObjRef | ObjState, inc: Include = 'main', line?: number) {
    const key = `${S.conn}|${ref.uri}`;
    let t = S.tabs.find(x => x.key === key);
    if (!t) {
      const st = 'inactive' in ref ? ref as ObjState : await backend.state(S.conn, ref);
      t = { key, conn: S.conn, ref: st, include: inc };
      S.tabs.push(t);
    }
    try { await showTab(t, inc, line); } catch (e) { fail(e); }
  }

  async function gotoLoc(l: Location) {
    const o = objByUri(l.uri) || (await backend.search(S.conn, l.uri.split('/').pop() || '')).find(x => x.uri === l.uri);
    if (!o) { toast('Object is not available in this system', 'warn'); return; }
    await openObj(o, l.include, l.line);
  }

  async function closeTab(key: string) {
    const t = S.tabs.find(x => x.key === key);
    if (!t) return;
    if (isDirty(t)) {
      const r = await modal<string>(`Save changes to ${t.ref.name}?`, '<p>Your changes are lost if you close without saving.</p>',
        [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', kind: 'primary' }]);
      if (!r || r === 'cancel') return;
      if (r === 'save' && !(await save(t))) return;
    }
    if (t.lock) { try { await backend.unlock(t.conn, t.ref, t.lock); } catch { /* lock expires on the server */ } }
    for (const inc of backend.includesOf(t.ref.type)) docs.delete(docKey(t, inc));
    const list = tabsHere();
    const idx = list.findIndex(x => x.key === key);
    S.tabs = S.tabs.filter(x => x.key !== key);
    if (S.activeByConn[S.conn] === key) {
      const next = tabsHere()[Math.max(0, idx - 1)];
      S.activeByConn[S.conn] = next ? next.key : null;
      if (next) { await showTab(next); return; }
      cm.swapDoc(placeholderDoc);
    }
    renderAll();
  }

  const renderDirty = debounce(() => { renderTabs(); renderSubtabs(); }, 120);
  cm.on('changes', async () => {
    if (swapping) return;
    const t = cur();
    if (!t) return;
    renderDirty();
    if (!t.lock && !(S.debug && !S.debug.done)) {
      t.lock = 'pending';
      try { t.lock = await backend.lock(t.conn, t.ref); renderTabs(); renderStatus(); } catch (e) { t.lock = undefined; fail(e); }
    }
  });
  cm.on('cursorActivity', debounce(renderStatus, 60));
  cm.on('gutterClick', (_cm: CM, line: number, gutter: string) => { if (gutter === 'bp-gutter') toggleBp(line); });
  const ABAP_SLOT = /\b(TYPE|REF\s+TO|TABLE\s+OF|LIKE|FROM|JOIN|NEW|CAST|VALUE|CONV|CORRESPONDING|CATCH|RAISING|INTERFACES|INHERITING\s+FROM|INTO|ASSIGNING|METHOD|LOOP\s+AT|READ\s+TABLE|CALL\s+FUNCTION|EXPORTING|IMPORTING|CHANGING|WHERE|AND|OR|IF|ELSEIF|FIELDS|ORDER\s+BY|GROUP\s+BY|ON|TO|SORT\s+\S+\s+BY|EXCEPTION\s+(TYPE|NEW))\s$/i;
  const CDS_SLOT = /\b(from|join|on|to|of|as|define|parent)\s$/i;
  cm.on('inputRead', (_cm: CM, ch: { text: string[] }) => {
    const t = cur();
    if (!t || cm.state.completionActive) return;
    const typed = ch.text.join('');
    if (typed.length > 2) return;                       // paste
    const c = cm.getCursor();
    const type = cm.getTokenTypeAt(c) || '';
    const before: string = cm.getLine(c.line).slice(0, c.ch);
    const cds = t.ref.type === 'DDLS';
    if (/comment/.test(type)) return;
    if (/string/.test(type) && !/CALL\s+FUNCTION\s+'[\w/]*$/i.test(before)) return;
    const word = /\w$/.test(typed) && /(^|[^\w/])[a-z_/$][\w/]{1}$/i.test(before);
    const trigger = cds
      ? /[@#.]$/.test(typed) || (typed === ' ' && CDS_SLOT.test(before)) || word
      : /->$|=>$|~$|[\w>]-$|##$|(^|[\s(])<$/.test(before) || (typed === "'" && /CALL\s+FUNCTION\s+'$/i.test(before)) || (typed === ' ' && (ABAP_SLOT.test(before) || /\(\s$/.test(before) || /=\s$/.test(before) && /\(\s*([\w~]+\s*=\s*\S+\s+)*[\w~]+\s*=\s$/.test(before))) || word;
    if (trigger) complete();
  });

  function markProblems() {
    cm.getAllMarks().forEach((m: { className?: string; clear: () => void }) => { if (/cm-(err|warn)/.test(m.className || '')) m.clear(); });
    const t = cur();
    if (!t) return;
    for (const p of S.problems) {
      if (p.uri !== t.ref.uri || p.include !== t.include || p.line >= cm.lineCount()) continue;
      const text: string = cm.getLine(p.line);
      const from = text.search(/\S/);
      cm.markText({ line: p.line, ch: Math.max(0, from) }, { line: p.line, ch: text.length }, { className: p.sev === 'error' ? 'cm-err' : 'cm-warn', title: p.msg });
    }
  }

  let dbgLine: { doc: CM; line: number } | null = null;
  function markDebugLine() {
    if (dbgLine) { try { dbgLine.doc.removeLineClass(dbgLine.line, 'background', 'cm-dbg-line'); } catch { /* doc gone */ } dbgLine = null; }
    const d = S.debug;
    const t = cur();
    if (!d || d.done || !t) return;
    const f = d.frames[0];
    if (f.uri === t.ref.uri && f.include === t.include) {
      const doc = cm.getDoc();
      doc.addLineClass(f.line, 'background', 'cm-dbg-line');
      dbgLine = { doc, line: f.line };
    }
  }

  function setProblems(uri: string, list: Problem[], include?: Include) {
    S.problems = S.problems.filter(p => p.uri !== uri || (include && p.include !== include && p.source === 'syntax')).concat(list);
    markProblems();
  }

  // ------------------------------------------------------------------ commands
  async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    S.busy = label; renderPanel();
    try { return await fn(); } catch (e) { fail(e); return undefined; } finally { S.busy = ''; renderPanel(); }
  }

  async function chooseTransport(ref: ObjRef, need: TransportNeed): Promise<string | null> {
    const reqs = need.requests;
    const body = `<p><b>${esc(ref.name)}</b> in package <b>${esc(ref.pkg)}</b> must be recorded in a transport request.</p>
      <fieldset class="choices">${reqs.map((r, i) => `<label class="choice"><input type="radio" name="tr" value="${esc(r.id)}" ${i === 0 ? 'checked' : ''}><span><code>${esc(r.id)}</code> ${esc(r.desc)}<small>${esc(r.owner)} · ${r.objects.length} objects</small></span></label>`).join('')}
        <label class="choice"><input type="radio" name="tr" value="__new" ${reqs.length ? '' : 'checked'}><span>New request<input id="trNewDesc" placeholder="Short description" maxlength="60"></span></label>
      </fieldset>`;
    return modal<string>('Select transport request', body, [{ label: 'Cancel', value: null }, { label: 'Use request', kind: 'primary', submit: true }], (root, close) => {
      const form = $('#modalForm', root) as HTMLFormElement;
      $<HTMLInputElement>('#trNewDesc', root).onfocus = () => { (root.querySelector('input[value="__new"]') as HTMLInputElement).checked = true; };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const v = (root.querySelector('input[name="tr"]:checked') as HTMLInputElement | null)?.value;
        if (v !== '__new') { close(v ?? null); return; }
        const desc = $<HTMLInputElement>('#trNewDesc', root).value.trim();
        if (!desc) { $<HTMLInputElement>('#trNewDesc', root).focus(); return; }
        try {
          const id = await backend.createTransport(S.conn, desc, ref);
          S.transports = await backend.transports(S.conn);
          close(id);
        } catch (e) { fail(e); }
      };
    });
  }

  async function save(t = cur()): Promise<boolean> {
    if (!t) return false;
    if (S.debug && !S.debug.done) { toast('Stop the debugger before saving', 'warn'); return false; }
    const incs = backend.includesOf(t.ref.type).filter(inc => incDirty(t, inc));
    if (!incs.length) { toast(`${t.ref.name} has no unsaved changes`); return true; }
    const r = await busy(`Saving ${t.ref.name}`, async () => {
      if (!t.lock || t.lock === 'pending') t.lock = await backend.lock(t.conn, t.ref);
      const need = await backend.transportNeed(t.conn, t.ref);
      let tr = need.current;
      if (need.needed) { tr = (await chooseTransport(t.ref, need)) ?? undefined; if (!tr) return false; }
      for (const inc of incs) {
        const d = docs.get(docKey(t, inc));
        await backend.write(t.conn, t.ref, inc, d.getValue(), t.lock as string, tr);
        d.markClean();
      }
      t.ref = await backend.state(t.conn, t.ref);
      const d = docs.get(docKey(t, t.include));
      if (d) setProblems(t.ref.uri, await backend.syntaxCheck(t.conn, t.ref, t.include, d.getValue()), t.include);
      await loadTree();
      if (conn().transports) S.transports = await backend.transports(S.conn);
      toast(`Saved ${t.ref.name}. It is inactive until you activate it.`, 'ok');
      return true;
    });
    renderAll();
    return !!r;
  }

  async function activate(t = cur()) {
    if (!t) return;
    if (isDirty(t) && !(await save(t))) return;
    const st = await backend.state(t.conn, t.ref);
    if (!st.inactive) { toast(`${t.ref.name} is already active`); return; }
    await busy(`Activating ${t.ref.name}`, async () => {
      const r = await backend.activate(t.conn, [t.ref]);
      setProblems(t.ref.uri, r.problems);
      t.ref = await backend.state(t.conn, t.ref);
      await loadTree();
      const errs = r.problems.filter(p => p.sev === 'error').length;
      if (!r.ok) { S.panel = 'problems'; S.panelOpen = true; toast(`Activation of ${t.ref.name} failed with ${errs} error${errs === 1 ? '' : 's'}`, 'error'); }
      else toast(`Activated ${t.ref.name}`, 'ok');
    });
    renderAll();
  }

  async function activateAll() {
    for (const t of tabsHere()) if (isDirty(t) && !(await save(t))) return;
    const objs = allObjs().filter(o => o.inactive);
    if (!objs.length) { toast('No inactive objects'); return; }
    await busy(`Activating ${objs.length} objects`, async () => {
      const r = await backend.activate(S.conn, objs);
      for (const o of objs) setProblems(o.uri, r.problems.filter(p => p.uri === o.uri));
      await loadTree();
      for (const t of tabsHere()) t.ref = await backend.state(t.conn, t.ref);
      if (r.ok) toast(`Activated ${objs.length} objects`, 'ok');
      else { S.panel = 'problems'; toast('Activation failed. See Problems.', 'error'); }
    });
    renderAll();
  }

  async function check() {
    const t = cur(); if (!t) return;
    await busy('Checking syntax', async () => {
      const list = await backend.syntaxCheck(t.conn, t.ref, t.include, cm.getValue());
      setProblems(t.ref.uri, list, t.include);
      S.panel = 'problems'; S.panelOpen = true;
      const n = list.filter(p => p.sev === 'error').length;
      toast(n ? `${n} syntax error${n === 1 ? '' : 's'} in ${t.ref.name}` : `${t.ref.name}: no syntax errors`, n ? 'error' : 'ok');
    });
    renderAll();
  }

  async function format() {
    const t = cur(); if (!t) return;
    if (t.ref.type === 'DDLS') { toast('The pretty printer formats ABAP source. CDS sources keep their layout.'); return; }
    await busy('Formatting', async () => {
      const src = cm.getValue();
      const out = await backend.prettyPrint(t.conn, src);
      if (out !== src) {
        const pos = cm.getCursor(); const scroll = cm.getScrollInfo();
        cm.operation(() => { cm.replaceRange(out, { line: 0, ch: 0 }, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }); });
        cm.setCursor(pos); cm.scrollTo(scroll.left, scroll.top);
        toast('Formatted with pretty printer', 'ok', 2000);
      } else toast('Already formatted', 'info', 2000);
    });
  }

  async function run() {
    const t = cur(); if (!t) return;
    if (S.debug && !S.debug.done) return step('continue');
    if ((t.ref.type === 'PROG' || t.ref.type === 'CLAS') && allBreakpoints().length && await startDebug(t)) return;
    await busy(`Running ${t.ref.name}`, async () => {
      const r = await backend.run(t.conn, t.ref);
      S.output = { ...r, title: t.ref.name, at: new Date().toLocaleTimeString() };
      S.panel = 'output'; S.panelOpen = true;
    });
    renderAll();
  }

  async function unit() {
    const t = cur(); if (!t) return;
    if (t.ref.type !== 'CLAS') { toast('ABAP Unit runs on classes here. Open a class first.', 'warn'); return; }
    await busy('Running ABAP Unit', async () => {
      const r = await backend.runUnit(t.conn, t.ref);
      S.unit = { ...r, name: t.ref.name, at: new Date().toLocaleTimeString() };
      S.panel = 'unit'; S.panelOpen = true;
      const bad = r.methods.filter(m => m.status !== 'ok').length;
      toast(bad ? `${bad} of ${r.methods.length} tests failed` : `All ${r.methods.length} tests passed`, bad ? 'error' : 'ok');
    });
    renderAll();
  }

  async function atc(silent = false) {
    const t = cur(); if (!t) return;
    await busy('Running ATC', async () => {
      const f = await backend.runAtc(t.conn, t.ref);
      S.atc = { name: t.ref.name, findings: f, at: new Date().toLocaleTimeString() };
      if (!silent) { S.panel = 'atc'; S.panelOpen = true; toast(`ATC: ${f.length} finding${f.length === 1 ? '' : 's'}`, f.some(x => x.prio === 1) ? 'error' : f.length ? 'warn' : 'ok'); }
    });
    renderPanel();
  }

  async function complete() {
    const t = cur(); if (!t) return;
    const c = cm.getCursor();
    try {
      const list = await backend.complete(t.conn, t.ref, t.include, cm.getValue(), c.line, c.ch);
      const now = cm.getCursor();
      if (now.line !== c.line) return;
      showProposals(cm, list);
    } catch (e) { fail(e); }
  }

  async function navigate() {
    const t = cur(); if (!t) return;
    const c = cm.getCursor();
    const loc = await backend.navigate(t.conn, t.ref, t.include, cm.getValue(), c.line, c.ch).catch(e => { fail(e); return null; });
    if (!loc) { toast(`No definition found for "${wordAt(cm)}"`, 'warn'); return; }
    await gotoLoc(loc);
  }

  async function whereUsed() {
    const t = cur(); if (!t) return;
    const c = cm.getCursor();
    const term = wordAt(cm);
    if (!term) { toast('Place the cursor on a name first', 'warn'); return; }
    await busy('Searching references', async () => {
      const hits = await backend.whereUsed(t.conn, t.ref, t.include, cm.getValue(), c.line, c.ch);
      S.where = { term, hits }; S.panel = 'where'; S.panelOpen = true;
    });
    renderPanel();
  }

  function toggleBp(line = cm.getCursor().line) {
    const t = cur(); if (!t) return;
    if (t.ref.type === 'DDLS' || t.ref.type === 'INTF') { toast('Breakpoints need executable code', 'warn'); return; }
    const info = cm.lineInfo(line);
    cm.setGutterMarker(line, 'bp-gutter', info.gutterMarkers && info.gutterMarkers['bp-gutter'] ? null : bpMarker());
    if (S.view === 'debug') renderSide();
  }

  function toggleComment() {
    const t = cur(); if (!t) return;
    const pfx = t.ref.type === 'DDLS' ? '//' : '*';
    const from = cm.getCursor('from').line, to = cm.getCursor('to').line;
    const lines: string[] = []; for (let l = from; l <= to; l++) lines.push(cm.getLine(l));
    const all = lines.every(l => l.startsWith(pfx) || !l.trim());
    cm.operation(() => {
      for (let l = from; l <= to; l++) {
        const s: string = cm.getLine(l);
        if (all && s.startsWith(pfx)) cm.replaceRange('', { line: l, ch: 0 }, { line: l, ch: pfx.length });
        else if (!all && s.trim()) cm.replaceRange(pfx, { line: l, ch: 0 });
      }
    });
  }

  /** Returns false when no debug session started, so the caller runs normally. */
  async function startDebug(t: Tab): Promise<boolean> {
    const r = await busy(t.ref.type === 'PROG' && conn().kind === 's4' ? 'Waiting for the program to hit a breakpoint' : 'Starting debugger', async () => {
      const st = await backend.debugStart(t.conn, t.ref, allBreakpoints());
      if (!st) return false;
      await afterDebug(st);
      return true;
    });
    return !!r;
  }
  async function step(kind: StepKind) {
    if (!S.debug || S.debug.done) return;
    try { await afterDebug(await backend.debugStep(kind, allBreakpoints())); } catch (e) { fail(e); }
  }
  async function stopDebug() {
    if (!S.debug) return;
    await backend.debugStop();
    S.debug = null; markDebugLine(); renderAll();
    toast('Debugger terminated');
  }
  async function afterDebug(st: DebugState) {
    S.debug = st;
    const t = cur();
    S.output = { output: st.outputSoFar, kind: 'list', title: t?.ref.name || '', at: new Date().toLocaleTimeString() };
    if (st.done) {
      S.debug = null; S.panel = 'output'; S.panelOpen = true;
      markDebugLine(); renderAll();
      toast('Program finished', 'ok', 2500);
      return;
    }
    S.view = 'debug'; S.sideOpen = true;
    const f = st.frames[0];
    await gotoLoc({ uri: f.uri, include: f.include, line: f.line });
    markDebugLine(); renderAll();
  }

  async function newObject() {
    const c = conn();
    const pkgs = c.kind === 'runner' ? ['$TMP'] : [...c.favoritePackages, '$TMP'];
    const body = `
      <label class="field"><span>Type</span><select id="noType">${(['CLAS', 'INTF', 'PROG', 'DDLS'] as ObjType[]).filter(t => !(c.abapVersion === 'cloud' && t === 'PROG')).map(t => `<option value="${t}">${TYPE_INFO[t].label}</option>`).join('')}</select></label>
      <label class="field"><span>Name</span><input id="noName" maxlength="30" placeholder="ZCL_NUSA_" autocomplete="off" spellcheck="false" required></label>
      <label class="field"><span>Description</span><input id="noDesc" maxlength="60" required></label>
      <label class="field"><span>Package</span><select id="noPkg">${pkgs.map(p => `<option>${esc(p)}</option>`).join('')}</select></label>
      <p class="form-err" id="noErr" hidden></p>`;
    const res = await modal<{ type: ObjType; name: string; desc: string; pkg: string }>('New ABAP object', body,
      [{ label: 'Cancel', value: null }, { label: 'Create', kind: 'primary', submit: true }], (root, close) => {
        const nameEl = $<HTMLInputElement>('#noName', root);
        const typeEl = $<HTMLSelectElement>('#noType', root);
        const prefix: Record<ObjType, string> = { CLAS: 'ZCL_', INTF: 'ZIF_', PROG: 'ZR_', DDLS: 'ZI_' };
        typeEl.onchange = () => { if (!nameEl.value || /^Z(CL|IF|R|I)_$/.test(nameEl.value)) nameEl.value = prefix[typeEl.value as ObjType]; };
        nameEl.value = 'ZCL_';
        nameEl.oninput = () => { nameEl.value = nameEl.value.toUpperCase(); };
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          const name = nameEl.value.trim();
          const err = $('#noErr', root);
          const type = typeEl.value as ObjType;
          let msg = '';
          if (!/^([YZ]|\/\w+\/)[A-Z0-9_]*$/.test(name)) msg = 'Use the customer namespace: names start with Z, Y or your /namespace/.';
          else if (name.length > (type === 'PROG' ? 40 : 30)) msg = 'The name is too long.';
          else if (allObjs().some(o => o.name === name)) msg = `${name} already exists.`;
          if (msg) { err.hidden = false; err.textContent = msg; return; }
          close({ type, name, desc: $<HTMLInputElement>('#noDesc', root).value.trim(), pkg: $<HTMLSelectElement>('#noPkg', root).value });
        };
      });
    if (!res) return;
    try {
      let tr: string | undefined;
      if (c.transports && !res.pkg.startsWith('$')) {
        const need: TransportNeed = { needed: true, requests: (await backend.transports(S.conn)).filter(t => t.status === 'modifiable') };
        tr = (await chooseTransport({ uri: uriFor(res.type, res.name), name: res.name, type: res.type, pkg: res.pkg, desc: res.desc }, need)) ?? undefined;
        if (!tr) return;
      }
      const ref = await backend.createObject(S.conn, res.type, res.name, res.desc, res.pkg, tr);
      await loadTree();
      if (c.transports) S.transports = await backend.transports(S.conn);
      toast(`Created ${res.name}`, 'ok');
      await openObj(ref);
    } catch (e) { fail(e); }
  }

  async function switchConn(id: string) {
    if (id === S.conn) return;
    if (S.debug && !S.debug.done) await stopDebug();
    S.conn = id; store.set('nusa-adt-conn', id);
    S.problems = []; S.atc = null; S.unit = null; S.where = null; S.output = null;
    renderAll();
    await loadConn();
    const t = cur();
    if (t) await showTab(t); else { cm.swapDoc(placeholderDoc); renderAll(); }
    toast(`Connected to ${conn().sid}`, 'ok', 2000);
  }

  async function releaseTr(id: string) {
    const t = S.transports.find(x => x.id === id);
    if (!t) return;
    const ok = await modal<boolean>(`Release ${id}?`, `<p>${esc(t.desc)}</p><p class="note">After release the ${t.objects.length} objects are exported. New changes need another request.</p>`,
      [{ label: 'Cancel', value: false }, { label: 'Release', value: true, kind: 'primary' }]);
    if (!ok) return;
    await busy(`Releasing ${id}`, async () => {
      await backend.releaseTransport(S.conn, id);
      S.transports = await backend.transports(S.conn);
      await loadTree();
      for (const x of tabsHere()) x.ref = await backend.state(x.conn, x.ref);
      toast(`Released ${id}`, 'ok');
    });
    renderAll();
  }

  interface Cmd { id: string; title: string; key?: string; run: () => unknown; debugOnly?: boolean }
  const CMDS: Cmd[] = [
    { id: 'open', title: 'Open ABAP Development Object…', key: 'Ctrl+Shift+A', run: () => openPalette('obj') },
    { id: 'palette', title: 'Show All Commands', key: 'Ctrl+Shift+P', run: () => openPalette('cmd') },
    { id: 'new', title: 'New ABAP Object…', run: newObject },
    { id: 'save', title: 'Save', key: 'Ctrl+S', run: () => save() },
    { id: 'activate', title: 'Activate', key: 'Ctrl+F3', run: () => activate() },
    { id: 'activate-all', title: 'Activate All Inactive Objects', key: 'Ctrl+Shift+F3', run: activateAll },
    { id: 'check', title: 'Check ABAP Syntax', key: 'Ctrl+F2', run: check },
    { id: 'format', title: 'Format Source (Pretty Printer)', key: 'Shift+F1', run: format },
    { id: 'run', title: 'Run (Program or Console Class)', key: 'F8', run },
    { id: 'run-console', title: 'Run as ABAP Application (Console)', key: 'F9', run },
    { id: 'unit', title: 'Run ABAP Unit Tests', key: 'Ctrl+Shift+F10', run: unit },
    { id: 'atc', title: 'Run ATC Checks', key: 'Ctrl+Shift+F2', run: () => atc() },
    { id: 'complete', title: 'Trigger Code Completion', key: 'Ctrl+Space', run: complete },
    { id: 'navigate', title: 'Navigate to Definition', key: 'F3', run: navigate },
    { id: 'where', title: 'Where-Used List', key: 'Ctrl+Shift+G', run: whereUsed },
    { id: 'bp', title: 'Toggle Breakpoint', key: 'Ctrl+Shift+B', run: () => toggleBp() },
    { id: 'comment', title: 'Toggle Line Comment', key: 'Ctrl+/', run: toggleComment },
    { id: 'conn', title: 'Switch System…', run: () => openPalette('conn') },
    { id: 'sidebar', title: 'Toggle Side Bar', key: 'Ctrl+B', run: () => { S.sideOpen = !S.sideOpen; renderActivity(); renderSide(); setTimeout(() => cm.refresh(), 0); } },
    { id: 'panel', title: 'Toggle Panel', key: 'Ctrl+J', run: () => { S.panelOpen = !S.panelOpen; renderPanel(); setTimeout(() => cm.refresh(), 0); } },
    { id: 'theme', title: 'Preferences: Color Theme…', run: () => openPalette('theme') },
    { id: 'theme-toggle', title: 'Toggle Dark Mode', key: 'Ctrl+Alt+D', run: () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark') },
    { id: 'theme-dark', title: 'Color Theme: Dark', run: () => setTheme('dark') },
    { id: 'theme-light', title: 'Color Theme: Light', run: () => setTheme('light') },
    { id: 'theme-system', title: 'Color Theme: Follow System', run: () => setTheme('system') },
    { id: 'refresh', title: 'Refresh Explorer and Transports', run: async () => { await loadConn(); renderAll(); toast('Refreshed', 'ok', 1500); } },
    { id: 'close-tab', title: 'Close Editor', run: () => { const t = cur(); if (t) closeTab(t.key); } },
    { id: 'dbg-continue', title: 'Debugger: Resume', key: 'F8', run: () => step('continue'), debugOnly: true },
    { id: 'dbg-over', title: 'Debugger: Step Over', key: 'F6', run: () => step('over'), debugOnly: true },
    { id: 'dbg-into', title: 'Debugger: Step Into', key: 'F5', run: () => step('into'), debugOnly: true },
    { id: 'dbg-return', title: 'Debugger: Step Return', key: 'F7', run: () => step('return'), debugOnly: true },
    { id: 'dbg-stop', title: 'Debugger: Terminate', key: 'Shift+F5', run: stopDebug, debugOnly: true },
  ];
  if (opts.prototype && 'reset' in backend) {
    CMDS.push({ id: 'reset', title: 'Reset Sample Data', run: async () => { (backend as unknown as { reset(): void }).reset(); S.tabs = []; S.activeByConn = {}; docs.clear(); cm.swapDoc(placeholderDoc); S.problems = []; await loadConn(); renderAll(); toast('Sample data restored', 'ok'); } });
  }
  const runCmd = (id: string) => { const c = CMDS.find(x => x.id === id); if (c) Promise.resolve(c.run()).catch(fail); };

  // ------------------------------------------------------------------ palette
  type PalMode = 'cmd' | 'obj' | 'conn' | 'theme';
  let palMode: PalMode = 'obj';
  let palItems: { label: string; sub?: string; key?: string; glyph?: string; go: () => unknown }[] = [];
  let palSel = 0;
  const fuzzy = (q: string, s: string) => { q = q.toLowerCase(); s = s.toLowerCase(); let i = 0; for (const ch of s) if (ch === q[i]) i++; return i === q.length; };

  let palFilled = '\u0000';
  async function fillPalette() {
    const raw = $<HTMLInputElement>('#palInput').value;
    palFilled = raw;
    const mode: PalMode = palMode === 'conn' || palMode === 'theme' ? palMode : raw.startsWith('>') ? 'cmd' : 'obj';
    const q = raw.replace(/^>\s*/, '');
    if (mode === 'cmd') {
      const dbg = !!(S.debug && !S.debug.done);
      palItems = CMDS.filter(c => (dbg || !c.debugOnly) && fuzzy(q, c.title)).map(c => ({ label: c.title, key: c.key, go: c.run }));
      $('#palHint').textContent = 'Commands';
    } else if (mode === 'theme') {
      const opts: [ThemePref, string, string][] = [['dark', 'Dark', 'Deep slate with amber accents'], ['light', 'Light', 'Warm paper tones'], ['system', 'Follow System', 'Match the operating system or host']];
      palItems = opts.filter(o => fuzzy(q, o[1])).map(([id, label, sub]) => ({ label: (themePref === id ? '● ' : '') + label, sub, go: () => setTheme(id) }));
      $('#palHint').textContent = 'Color theme';
    } else if (mode === 'conn') {
      palItems = S.conns.filter(c => fuzzy(q, c.sid + ' ' + (c.label || ''))).map(c => ({ label: `${c.sid} · ${c.client}`, sub: `${c.label || ''} · ${c.url}`, go: () => switchConn(c.id) }));
      $('#palHint').textContent = 'Switch system';
    } else {
      const res = q ? await backend.search(S.conn, q) : allObjs();
      palItems = res.map(o => ({ label: o.name, sub: `${TYPE_INFO[o.type].label} · ${o.pkg} · ${o.desc}`, glyph: o.type, go: () => openObj(o) }));
      $('#palHint').innerHTML = `Objects in <b>${esc(conn().sid)}</b> · type <kbd>&gt;</kbd> for commands`;
    }
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    $('#palList').innerHTML = palItems.map((it, i) => `<li role="option" aria-selected="${i === palSel}" class="${i === palSel ? 'on' : ''}" data-i="${i}">
      ${it.glyph ? glyph(it.glyph as ObjType) : ''}<span class="pl">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</li>`).join('') || '<li class="empty">No matches</li>';
    $('#palList .on')?.scrollIntoView({ block: 'nearest' });
  }
  function openPalette(mode: PalMode) {
    palMode = mode; palSel = 0;
    const inp = $<HTMLInputElement>('#palInput');
    inp.value = mode === 'cmd' ? '> ' : '';
    $('#palette').hidden = false;
    inp.focus();
    fillPalette();
  }
  function closePalette() { $('#palette').hidden = true; cm.focus(); }
  const palInput = $<HTMLInputElement>('#palInput');
  palInput.oninput = debounce(() => { palSel = 0; fillPalette(); }, 60);
  palInput.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { palSel = Math.min(palItems.length - 1, palSel + 1); fillPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); fillPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = () => { const it = palItems[palSel]; closePalette(); if (it) Promise.resolve(it.go()).catch(fail); };
      if (palInput.value !== palFilled) { palSel = 0; fillPalette().then(pick); } else pick();
    }
    else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
  };
  $('#palList').onclick = (e) => {
    const li = (e.target as HTMLElement).closest('li[data-i]') as HTMLElement | null;
    if (!li) return;
    const it = palItems[+(li.dataset.i as string)];
    closePalette(); if (it) Promise.resolve(it.go()).catch(fail);
  };
  $('#palette').onclick = (e) => { if (e.target === $('#palette')) closePalette(); };
  $('#modal').onclick = (e) => { if (e.target === $('#modal') && modalResolve) modalResolve(null); };

  // ------------------------------------------------------------------ events
  document.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest('[data-act],[data-cmd],[data-view]') as HTMLElement | null;
    if (!el || el.closest('#palette') || (el.closest('#modal') && !el.dataset.act)) return;
    if (el.dataset.cmd) { runCmd(el.dataset.cmd); return; }
    if (el.dataset.view) {
      const v = el.dataset.view as View;
      if (S.view === v && S.sideOpen) S.sideOpen = false; else { S.view = v; S.sideOpen = true; }
      renderActivity(); renderSide(); setTimeout(() => cm.refresh(), 0);
      return;
    }
    const d = el.dataset;
    switch (d.act) {
      case 'toggle': {
        const id = d.id as string;
        if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
        store.set('nusa-adt-collapsed', JSON.stringify([...S.collapsed]));
        el.closest('.node')?.classList.toggle('closed');
        el.setAttribute('aria-expanded', String(!S.collapsed.has(id)));
        break;
      }
      case 'collapse-all':
        document.querySelectorAll<HTMLElement>('#sideBody .node > .row').forEach(r => S.collapsed.add(r.dataset.id as string));
        store.set('nusa-adt-collapsed', JSON.stringify([...S.collapsed])); renderSide(); break;
      case 'open': {
        const o = objByUri(d.uri as string) || S.searchRes.find(x => x.uri === d.uri);
        if (o) await openObj(o);
        break;
      }
      case 'goto': await gotoLoc({ uri: d.uri as string, include: d.inc as Include, line: +(d.line as string) }); break;
      case 'tab': if (!(e.target as HTMLElement).closest('.tclose')) { const t = S.tabs.find(x => x.key === d.key); if (t) await showTab(t); } break;
      case 'close': e.stopPropagation(); await closeTab(d.key as string); break;
      case 'inc': { const t = cur(); if (t) await showTab(t, d.inc as Include); break; }
      case 'panel':
        if (S.panel === d.id && S.panelOpen && el.closest('#panelTabs')) { /* keep open */ }
        S.panel = d.id as PanelTab; S.panelOpen = true; renderPanel(); setTimeout(() => cm.refresh(), 0); break;
      case 'view': S.view = d.id as View; S.sideOpen = true; renderActivity(); renderSide(); break;
      case 'pick-conn': openPalette('conn'); break;
      case 'pick-theme': openPalette('theme'); break;
      case 'palette-obj': openPalette('obj'); break;
      case 'switch': await switchConn(d.id as string); break;
      case 'release': await releaseTr(d.id as string); break;
    }
  });
  $('#tabs').addEventListener('auxclick', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement | null;
    if (tab && e.button === 1) closeTab(tab.dataset.key as string);
  });

  const keyName = (e: KeyboardEvent) => {
    let k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length === 1) k = k.toUpperCase();
    return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && k.length > 1 ? 'Shift+' : e.shiftKey && /[A-Z]/.test(k) ? 'Shift+' : '') + k;
  };
  document.addEventListener('keydown', (e) => {
    if (!$('#modal').hidden) { if (e.key === 'Escape' && modalResolve) { modalResolve(null); e.preventDefault(); } return; }
    if (!$('#palette').hidden) return;
    const k = keyName(e);
    const dbg = !!(S.debug && !S.debug.done);
    const cmdFor = CMDS.find(c => c.key === k && (dbg ? (c.debugOnly || !CMDS.some(x => x.debugOnly && x.key === k)) : !c.debugOnly));
    if (k === 'F1') { e.preventDefault(); openPalette('cmd'); return; }
    if (!cmdFor) return;
    const inField = (e.target as HTMLElement).matches('input,select,textarea') && !(e.target as HTMLElement).closest('.CodeMirror');
    if (inField && !/^(Ctrl\+Shift\+[AP]|Ctrl\+S)$/.test(k)) return;
    e.preventDefault(); e.stopPropagation();
    runCmd(cmdFor.id);
  }, true);

  // sash resizing
  const dragSash = (sash: HTMLElement, onMove: (e: PointerEvent) => void) => {
    sash.addEventListener('pointerdown', (e) => {
      sash.setPointerCapture(e.pointerId); sash.classList.add('drag');
      const move = (ev: PointerEvent) => onMove(ev);
      const up = () => { sash.classList.remove('drag'); sash.removeEventListener('pointermove', move); sash.removeEventListener('pointerup', up); cm.refresh(); };
      sash.addEventListener('pointermove', move); sash.addEventListener('pointerup', up);
    });
  };
  dragSash($('#sashSide'), (e) => {
    const left = $('.activity').getBoundingClientRect().right;
    app.style.setProperty('--side-w', Math.min(560, Math.max(180, e.clientX - left)) + 'px');
  });
  dragSash($('#sashPanel'), (e) => {
    const bottom = $('#status').getBoundingClientRect().top;
    app.style.setProperty('--panel-h', Math.min(window.innerHeight * 0.7, Math.max(90, bottom - e.clientY)) + 'px');
  });
  window.addEventListener('beforeunload', (e) => { if (S.tabs.some(isDirty)) { e.preventDefault(); } });
  window.addEventListener('resize', debounce(() => cm.refresh(), 100));

  // ------------------------------------------------------------------ boot
  S.conns = await backend.connections();
  if (!S.conns.some(c => c.id === S.conn)) S.conn = S.conns[0]?.id;
  renderAll();
  await loadConn();
  renderAll();
  const first = allObjs();
  const cls = first.find(o => o.type === 'CLAS');
  const prog = first.find(o => o.type === 'PROG');
  if (prog) await openObj(prog);
  if (cls) { await openObj(cls); await atc(true); }
  renderAll();
}
