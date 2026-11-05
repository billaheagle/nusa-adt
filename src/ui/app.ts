// Nusa Studio workbench: explorer, tabs, editor, panels, palette, transports, debugger,
// systems, settings and the built-in extensions. Everything that talks to a system goes
// through the Backend interface.

import { systemHosts, rfcTarget } from '../core/sysurl';
import { addSnapshot, diffLines, diffStats, hunks, Snapshot } from '../core/diff';
import { anonymize, diagReport, issueUrl, logDiag } from '../core/diag';
import { createHistory } from './history';
import { formatAbap, formatCds, KeywordCase } from '../core/format';
import { addLayoutRow, addMessageRow, addXmlRow, layoutEffects, removeXmlRow, renderXmlForm, setXmlValue } from './xmlform';
import {
  AtcFinding, Backend, BindingInfo, Breakpoint, Connection, CreateExtra, DebugState, DebugVar, GitRepo, GROUPS, Hit, Include,
  INCLUDE_LABEL, isCdsLike, isSourceType, Location, ObjRef, ObjState, ObjType, PkgRef, PreviewResult, Problem, Proposal, RunResult, StepKind,
  SystemInfo, Transport, TransportNeed, TYPE_INFO, UnitResult, uriFor, QuickFix, RefactorPreview, TextEdit, isTextInclude, TraceRun, TraceHit, Dump, newObjectUri,
} from '../core/types';
import { applyEdits, editLines, sortForApply, wordRange } from '../core/edits';
import { bpLines, bpMarker, CM, createEditor, deleteLines, duplicateLines, moveLines, newDoc, selectNextOccurrence, startCompletion, wordAt } from './editor';
import { ic, LOGO } from './icons';
import { cleanAbap, DEFAULT_RULES, RuleId, RULES } from '../core/cleaner';
import { planRap } from '../core/rapgen';
import { keywordDocUrl } from '../core/docs';
import { outline } from '../core/outline';
import { template } from '../core/templates';
import { parseTableSource } from '../core/catalog';

import { systemFormDialog } from './system-form';
import { rapFormDialog, RapFormResult } from './rap-form';
import { glyph, trGroupsHtml, trTabsHtml, TrView } from './transports-view';
import { renderTraces as traceView, renderDumps, ownDumps } from './runtime';
import { $, esc, debounce, msg, store, json, TAURI, IS_MAC } from './util';
import { APP_VERSION, REPORT_REPO, AUTH_LABEL, ECLIPSE_POINTS, EXTENSIONS, ExtId, KIND_LABEL, Settings } from './meta';
import type { LogonBridge, ToolsBridge, UpdateBridge, UpdateInfo } from './bridges';
export type { LogonBridge, ToolsBridge, UpdateBridge, UpdateInfo } from './bridges';

type View = 'explorer' | 'search' | 'outline' | 'transports' | 'git' | 'debug' | 'extensions' | 'connections' | 'settings';
type PanelTab = 'problems' | 'output' | 'unit' | 'atc' | 'where' | 'traces' | 'dumps';
type TabView = 'source' | 'data' | 'binding' | 'diff';
interface DiffState { left: string; right: string; leftLabel: string; rightLabel: string; srcKey: string; inc: Include; all?: boolean }
interface DataState { entity?: string; sql: string; rows: number; result?: PreviewResult; error?: string; running?: boolean }
interface Tab {
  key: string; conn: string; ref: ObjState; include: Include; lock?: string; view: TabView;
  data?: DataState; binding?: BindingInfo | { error: string } | null; diff?: DiffState;
  /** Opened with a single click and not changed yet: the next single click reuses the tab (like VS Code). */
  preview?: boolean;
  /** form-based objects: show the XML text instead of the form */
  raw?: boolean;
}
type PkgData = { packages: PkgRef[]; objects: ObjState[] } | 'loading' | { error: string };

export async function startApp(backend: Backend, opts: { brand?: string; prototype?: boolean; logon?: LogonBridge; updates?: UpdateBridge; tools?: ToolsBridge } = {}) {
  const settings: Settings = json<Settings>('nusa-adt-settings', {
    editorFont: 13, autoComplete: true, restoreTabs: true, cleanerRules: DEFAULT_RULES,
    ext: { preview: true, abapgit: true, cleaner: true, rapgen: true, docs: true, outline: true },
    formatOnSave: false, cleanOnSave: false, keepDrafts: true, previewTabs: true, formatter: 'nusa', keywordCase: 'upper', checkUpdates: true, autoOpenLogon: false,
  });
  const saveSettings = () => store.set('nusa-adt-settings', JSON.stringify(settings));
  const ext = (id: ExtId) => settings.ext[id] !== false;

  const S = {
    conns: [] as Connection[],
    conn: store.get('nusa-adt-conn') || '',
    sys: {} as Record<string, SystemInfo | { error: string } | undefined>,
    tabs: [] as Tab[],
    activeByConn: {} as Record<string, string | null>,
    pkgs: {} as Record<string, Record<string, PkgData>>,
    collapsed: new Set<string>(JSON.parse(store.get('nusa-adt-collapsed') || '[]')),
    openSub: new Set<string>(JSON.parse(store.get('nusa-adt-open-sub') || '[]')),
    view: 'explorer' as View,
    sideOpen: window.innerWidth >= 760,
    panel: 'problems' as PanelTab,
    panelOpen: false,
    problems: [] as Problem[],
    output: null as (RunResult & { title: string; at: string }) | null,
    unit: null as (UnitResult & { name: string; at: string }) | null,
    atc: null as { name: string; findings: AtcFinding[]; at: string } | null,
    where: null as { term: string; hits: Hit[] } | null,
    transports: [] as Transport[],
    git: null as GitRepo[] | { error: string } | null,
    debug: null as DebugState | null,
    /** waiting for a process to reach a breakpoint (Eclipse: debugger listener) */
    listening: false,
    trTab: 'modifiable' as Transport['status'],
    traces: null as TraceRun[] | { error: string } | null,
    traceSel: null as { run: TraceRun; hits: TraceHit[] } | null,
    dumps: null as Dump[] | { error: string } | null,
    dumpSel: null as { dump: Dump; html?: string; text?: string } | null,
    dumpsMine: store.get('nusa-adt-dumps-all') !== '1',
    searchQ: '',
    searchType: '' as ObjType | '',
    searchPkg: '',
    searchRes: [] as ObjRef[],
    searchErr: '',
    busy: '' as string,
  };
  const docs = new Map<string, CM>();

  // ------------------------------------------------------------------ theme
  type ThemePref = 'dark' | 'light' | 'system';
  const html = document.documentElement;
  let hostTheme = html.getAttribute('data-theme');
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
    if (S.view === 'settings') renderSide();
    toast(p === 'system' ? `Theme follows the system (${effectiveTheme()})` : `${p === 'dark' ? 'Dark' : 'Light'} theme`, 'info', 1600);
  }
  applyTheme();
  html.style.setProperty('--editor-size', settings.editorFont + 'px');

  const conn = () => (S.conns.find(c => c.id === S.conn) || S.conns[0]) as Connection;
  const tabsHere = () => S.tabs.filter(t => t.conn === S.conn);
  const cur = (): Tab | undefined => S.tabs.find(t => t.key === S.activeByConn[S.conn]);
  const curSrc = (): Tab | undefined => { const t = cur(); return t && t.view === 'source' ? t : undefined; };
  const docKey = (t: Tab, inc: Include = t.include) => `${t.key}|${inc}`;
  const isDirty = (t: Tab) => t.view === 'source' && backend.includesOf(t.ref.type).some(inc => { const d = docs.get(docKey(t, inc)); return d && !d.isClean(); });
  const incDirty = (t: Tab, inc: Include) => { const d = docs.get(docKey(t, inc)); return !!d && !d.isClean(); };
  const sysOk = () => { const s = S.sys[S.conn]; return !!s && !('error' in s); };

  // ------------------------------------------------------------------ shell markup
  const root = document.getElementById('nusa-root') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'nusa-root' }));
  root.innerHTML = `
  <div id="app" class="${opts.prototype ? 'is-proto' : ''} ${IS_MAC && TAURI ? 'mac' : ''}">
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>${LOGO}<span data-tauri-drag-region>${esc(opts.brand || 'Nusa Studio')}</span></div>
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
      <div class="drag-fill" data-tauri-drag-region></div>
      <button class="icon-btn theme-btn" id="themeBtn" data-cmd="theme-toggle" title="Toggle dark mode"></button>
      <button class="omnibox" id="omni" data-act="palette-obj" title="Open ABAP development object (Ctrl+Shift+A)">
        ${ic('search')}<span class="omni-text">Open object or run a command</span><kbd>Ctrl+Shift+A</kbd>
      </button>
      <div class="win-ctl" id="winCtl" hidden>
        <button data-act="win-min" title="Minimize" aria-label="Minimize">${ic('winmin')}</button>
        <button data-act="win-max" title="Maximize" aria-label="Maximize">${ic('winmax')}</button>
        <button data-act="win-close" class="close" title="Close" aria-label="Close">${ic('close')}</button>
      </div>
    </header>
    <div class="main">
      <nav class="activity" aria-label="Views" id="activity"></nav>
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
          <div class="pane" id="pane" hidden></div>
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
  <div class="ctx" id="ctx" hidden role="menu"></div>
  <div class="info-pop" id="infoPop" hidden></div>
  <div class="toasts" id="toasts" aria-live="polite"></div>`;

  const app = $('#app');
  const cm: CM = createEditor($('#editor'));
  const placeholderDoc = newDoc('', 'abap');
  cm.swapDoc(placeholderDoc);

  // custom title bar on Windows and Linux; macOS keeps its traffic lights over our bar
  const win = TAURI?.window?.getCurrentWindow?.();
  if (win && !IS_MAC) {
    Promise.resolve(win.setDecorations(false)).then(() => { $('#winCtl').hidden = false; app.classList.add('frameless'); }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ toasts, modal, context menu
  function toast(text: string, kind: 'info' | 'ok' | 'warn' | 'error' = 'info', ms = 3800, action?: { label: string; run: () => unknown }) {
    const el = document.createElement('div');
    el.className = `toast t-${kind}`;
    el.innerHTML = `${ic(kind === 'ok' ? 'ok' : kind === 'warn' ? 'warning' : kind === 'error' ? 'error' : 'info')}<span></span>`;
    (el.querySelector('span') as HTMLElement).textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.className = 'link toast-act'; b.textContent = action.label;
      b.onclick = () => { el.remove(); Promise.resolve(action.run()).catch(e => fail(e)); };
      el.appendChild(b);
    }
    const box = $('#toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild?.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
  }
  // ------------------------------------------------------------------ browser logon card
  // While the system waits for the browser, show the link so it can be copied into another
  // browser or profile on this computer, opened again, or cancelled.
  opts.logon?.autoOpen(settings.autoOpenLogon).catch(() => undefined);
  opts.logon?.listen(ev => {
    document.getElementById('logonCard')?.remove();
    if (ev.state !== 'waiting') return;
    const c = conn();
    const card = document.createElement('div');
    card.id = 'logonCard';
    card.className = 'logon-card';
    card.setAttribute('role', 'status');
    card.innerHTML = `<div class="lc-ic">${ic('lock')}</div>
      <div class="lc-main"><b>Log on to ${esc(c.sid)} in your browser</b>
        <p>${ev.opened ? 'The logon page opened in your default browser. For another browser or profile, copy the link and open it there.'
          : 'Open the logon page in your default browser, or copy the link and open it in the browser or profile you log on with.'} Nusa Studio continues once you are logged on.</p>
        <code class="lc-url" title="${esc(ev.url)}">${esc(ev.url)}</code>
        <div class="lc-actions"><button class="btn small ${ev.opened ? '' : 'primary'}" data-lc="open">${ev.opened ? 'Open again' : 'Open in browser'}</button><button class="btn small ${ev.opened ? 'primary' : ''}" data-lc="copy">Copy link</button><button class="btn small ghost" data-lc="cancel">Cancel</button></div>
      </div>`;
    card.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest('[data-lc]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.lc === 'copy') await copy(ev.url, 'Copied the logon link');
      if (b.dataset.lc === 'open') opts.logon!.reopen().catch(er => fail(er, 'Opening the logon page'));
      if (b.dataset.lc === 'cancel') { await opts.logon!.cancel().catch(() => undefined); card.remove(); }
    };
    document.body.appendChild(card);
  });

  const fail = (e: unknown, what?: string) => toast(what ? `${what} failed: ${msg(e)}` : msg(e), 'error', 7000);
  window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fail(e.reason); });

  let modalResolve: ((v: unknown) => void) | null = null;
  function modal<T>(title: string, body: string, actions: { label: string; value?: unknown; kind?: string; submit?: boolean }[], onMount?: (root: HTMLElement, close: (v: unknown) => void) => void, wide = false): Promise<T | null> {
    const scrim = $('#modal');
    const root = $('.modal', scrim);
    root.classList.toggle('wide', wide);
    root.innerHTML = `<h3>${esc(title)}</h3><form class="modal-body" id="modalForm" novalidate>${body}<div class="modal-actions">${actions.map((a, i) =>
      `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></form>`;
    scrim.hidden = false;
    return new Promise<T | null>(resolve => {
      const close = (v: unknown) => { scrim.hidden = true; modalResolve = null; resolve(v as T | null); setTimeout(() => { if (curSrc() && canFocusEditor()) cm.focus(); }, 0); };
      modalResolve = close;
      root.querySelectorAll<HTMLButtonElement>('.modal-actions button').forEach(b => {
        b.onclick = (ev) => { const a = actions[+(b.dataset.i as string)]; if (a.submit) return; ev.preventDefault(); close(a.value ?? null); };
      });
      root.addEventListener('input', () => root.querySelectorAll<HTMLElement>('.form-err').forEach(x => { if (!x.id.startsWith('rg')) x.hidden = true; }));
      onMount?.(root, close);
      const first = root.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]),select,textarea,button.primary');
      first?.focus();
    });
  }
  const confirmBox = (title: string, text: string, ok: string, danger = false) =>
    modal<boolean>(title, `<p>${text}</p>`, [{ label: 'Cancel', value: false }, { label: ok, value: true, kind: danger ? 'danger' : 'primary' }]);

  interface MenuItem { label?: string; key?: string; run?: () => unknown; danger?: boolean; disabled?: boolean; sep?: boolean }
  function showMenu(x: number, y: number, items: MenuItem[]) {
    const el = $('#ctx');
    const list = items.filter((it, i) => !it.sep || (i > 0 && i < items.length - 1 && !items[i - 1].sep));
    el.innerHTML = list.map((it, i) => it.sep ? '<div class="ctx-sep"></div>'
      : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}><span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`).join('');
    el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    el.onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLElement | null;
      if (!b) return;
      hideMenu();
      const it = list[+(b.dataset.i as string)];
      Promise.resolve(it.run?.()).catch(err => fail(err, it.label));
    };
    (el.querySelector('button:not([disabled])') as HTMLElement | null)?.focus();
  }
  const hideMenu = () => { $('#ctx').hidden = true; };
  const hidePop = () => { $('#infoPop').hidden = true; };

  /** The editor takes the focus after loading only when nothing else has it: never from the palette or a dialog. */
  const canFocusEditor = () => $('#palette').hidden && $('#modal').hidden;
  function openUrl(url: string) {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function copy(text: string, what = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(what, 'ok', 1500); } catch { toast('Copying is not allowed here. Select the text and press Ctrl+C.', 'warn'); }
  }

  // ------------------------------------------------------------------ packages and objects
  const pkgCache = () => (S.pkgs[S.conn] ||= {});
  const topPackages = () => {
    const c = conn();
    const favs = [...c.favoritePackages];
    if (c.kind !== 'runner' && !favs.includes('$TMP')) favs.push('$TMP');
    return favs;
  };
  const pkgId = (name: string) => `${S.conn}/pkg/${name}`;
  const isFav = (name: string) => topPackages().includes(name);
  const pkgOpen = (name: string, fav: boolean) => fav ? !S.collapsed.has(pkgId(name)) : S.openSub.has(pkgId(name));
  const persistTree = () => { store.set('nusa-adt-collapsed', JSON.stringify([...S.collapsed])); store.set('nusa-adt-open-sub', JSON.stringify([...S.openSub])); };

  /** Package contents from the last session: shown at once, then replaced by the system's answer. */
  const pkgStoreKey = (c: string, name: string) => `nusa-adt-pkg-${c}-${name}`;
  function storedPkg(c: string, name: string): { packages: PkgRef[]; objects: ObjState[] } | null {
    try {
      const v = JSON.parse(store.get(pkgStoreKey(c, name)) || 'null');
      return v && Array.isArray(v.packages) && Array.isArray(v.objects) ? v : null;
    } catch { return null; }
  }
  function keepPkg(c: string, name: string, r: { packages: PkgRef[]; objects: ObjState[] }) {
    if (r.objects.length + r.packages.length > 2000) return;     // very large packages are not kept
    store.set(pkgStoreKey(c, name), JSON.stringify({ packages: r.packages, objects: r.objects.map(o => ({ ...o, lockedBy: undefined })) }));
  }
  const pkgLoads = new Map<string, Promise<void>>();
  async function loadPkg(name: string, force = false) {
    const cache = pkgCache();
    const have = cache[name];
    if (!force && have && have !== 'loading' && !('error' in have)) return;
    const c = S.conn, k = `${c}/${name}`;
    if (!force && pkgLoads.has(k)) return pkgLoads.get(k);
    const stale = !force && !have ? storedPkg(c, name) : null;
    cache[name] = stale || (have && have !== 'loading' && !('error' in have) ? have : 'loading');
    if (S.view === 'explorer') renderSide();
    const job = (async () => {
      try { const r = await backend.packageContents(c, name); (S.pkgs[c] ||= {})[name] = r; keepPkg(c, name, r); }
      catch (e) { if (!stale) (S.pkgs[c] ||= {})[name] = { error: msg(e) }; else logDiag(c, `package ${name}: showing the last known contents, refresh failed: ${msg(e)}`); }
      if (S.view === 'explorer' && c === S.conn) renderSide();
    })();
    pkgLoads.set(k, job);
    try { await job; } finally { if (pkgLoads.get(k) === job) pkgLoads.delete(k); }
  }
  async function loadTree() {
    const old = pkgCache();
    S.pkgs[S.conn] = {};
    const want = new Set<string>();
    for (const p of topPackages()) if (pkgOpen(p, true)) want.add(p);
    for (const k of Object.keys(old)) if (S.openSub.has(pkgId(k)) || want.has(k)) want.add(k);
    await Promise.all([...want].map(p => loadPkg(p)));
  }
  async function refreshPkg(name: string) { if (pkgCache()[name]) await loadPkg(name, true); }
  /** Opens the package in the explorer and reloads it, so new objects show up. */
  async function revealPkg(name: string) {
    if (!name) return;
    const id = pkgId(name);
    if (isFav(name)) S.collapsed.delete(id); else S.openSub.add(id);
    persistTree();
    await loadPkg(name, true);
  }
  const allObjs = (): ObjState[] => {
    const out = new Map<string, ObjState>();
    for (const d of Object.values(pkgCache())) if (d !== 'loading' && !('error' in d)) for (const o of d.objects) out.set(o.uri, o);
    for (const t of tabsHere()) if (t.view === 'source' || t.view === 'binding') out.set(t.ref.uri, t.ref);
    return [...out.values()];
  };
  const knownPackages = (): string[] => {
    const set = new Set(topPackages());
    for (const [k, d] of Object.entries(pkgCache())) { set.add(k); if (d !== 'loading' && !('error' in d)) d.packages.forEach(p => set.add(p.name)); }
    return [...set];
  };
  const objByUri = (uri: string): ObjRef | undefined => allObjs().find(o => o.uri === uri)
    ?? [...progIncl.values()].flatMap(v => Array.isArray(v) ? v : []).find(o => o.uri === uri);
  async function updateObjInCache(ref: ObjState) {
    for (const d of Object.values(pkgCache())) if (d !== 'loading' && !('error' in d)) { const i = d.objects.findIndex(o => o.uri === ref.uri); if (i >= 0) d.objects[i] = { ...ref }; }
  }

  // ------------------------------------------------------------------ rendering
  const isForm = (t: Tab | undefined) => !!t && t.view === 'source' && TYPE_INFO[t.ref.type].editor === 'xml';
  const typeLabel = (o: ObjRef) => o.type === 'XOBJ' ? (o.typeLabel || o.adtType || 'Object') : TYPE_INFO[o.type].label;
  const tabGlyph = (t: Tab) => glyph(t.view === 'data' ? 'DATA' : t.ref.type);
  const tabName = (t: Tab) => t.view === 'data' ? (t.data?.entity || 'SQL Console') : t.view === 'diff' ? `${t.ref.name} ↔ ${t.diff?.leftLabel || ''}` : t.ref.name;

  /** Why the run command is not available for the open object, or '' when it is. */
  function runBlocker(t: Tab | undefined): string {
    if (!t) return 'Open an object first';
    if (t.view === 'data') return '';
    if (t.view !== 'source') return 'Nothing to run here';
    if ((t.ref.type === 'TABL' || t.ref.type === 'DDLS') && ext('preview')) return '';
    if (t.ref.type === 'PROG') {
      if (conn().runReports || (opts.tools && conn().kind === 's4')) return '';
      return conn().kind === 's4' ? 'Reports run in SAP GUI. The Nusa Studio desktop app opens them there with F8.'
        : 'This system has no SAP GUI. Use a class that implements IF_OO_ADT_CLASSRUN and press F9.';
    }
    if (t.ref.type === 'INCL') return 'An include does not run on its own. Run the program that includes it.';
    if (t.ref.type === 'FUNC') return opts.tools && conn().kind === 's4' ? '' : 'Function modules are tested in SE37 in SAP GUI. The desktop app opens it with F8.';
    if (t.ref.type === 'CLAS') {
      const src = docs.get(`${t.key}|main`)?.getValue() ?? '';
      return /if_oo_adt_classrun/i.test(src) ? '' : 'This class does not implement IF_OO_ADT_CLASSRUN, so it cannot run as a console application.';
    }
    return `${TYPE_INFO[t.ref.type].label}s cannot be executed`;
  }

  function renderTitle() {
    const c = conn();
    const sys = S.sys[S.conn];
    const state = !sys ? 'wait' : 'error' in sys ? 'bad' : 'good';
    $('#connChip').innerHTML = `<i class="dot ${state}"></i><b>${esc(c.sid)}</b><span>${c.kind === 's4' || c.kind === 'runner' ? esc(c.client) + ' · ' : ''}${esc(c.user || KIND_LABEL[c.kind])}</span>${ic('chev', 'rot90')}`;
    const t = cur();
    const src = t?.view === 'source';
    app.querySelectorAll<HTMLButtonElement>('.toolbar button').forEach(b => {
      const cmd = b.dataset.cmd as string;
      let why = '';
      if (!t) why = 'Open an object first';
      else if (cmd === 'run') why = runBlocker(t);
      else if (!src) why = 'Not available here';
      else if (!isSourceType(t.ref.type) && ['check', 'format', 'unit', 'atc', 'run'].includes(cmd)) why = `Not available for ${typeLabel(t.ref)}s`;
      else if (cmd === 'unit' && t.ref.type !== 'CLAS') why = 'ABAP Unit runs on classes';
      else if (cmd === 'format' && !['abap', 'cds'].includes(TYPE_INFO[t.ref.type].editor)) why = 'Nothing to format here';
      else if (cmd === 'atc' && TYPE_INFO[t.ref.type].editor === 'form') why = 'Not available for service bindings';
      b.disabled = !!why;
      const base = b.dataset.title || b.title;
      b.dataset.title = base;
      b.title = why ? `${base.replace(/\s*\(.*\)$/, '')}: ${why}` : base;
    });
  }

  function renderActivity() {
    const items: [View, string, string][] = [
      ['explorer', 'files', 'Project Explorer'], ['search', 'search', 'Search objects'],
      ...(ext('outline') ? [['outline', 'outline', 'Outline'] as [View, string, string]] : []),
      ['transports', 'transport', 'Transport Organizer'],
      ...(ext('abapgit') ? [['git', 'git', 'abapGit Repositories'] as [View, string, string]] : []),
      ['debug', 'bug', 'Debugger'], ['extensions', 'blocks', 'Extensions'],
    ];
    const bottom: [View, string, string][] = [['connections', 'server', 'Systems'], ['settings', 'gear', 'Settings']];
    const btn = ([v, icon, title]: [View, string, string]) => `<button data-view="${v}" title="${title}" aria-label="${title}" class="${S.sideOpen && S.view === v ? 'on' : ''}" aria-pressed="${S.sideOpen && S.view === v}">${ic(icon)}${v === 'transports' ? '<i class="badge" id="trBadge" hidden></i>' : ''}</button>`;
    $('#activity').innerHTML = items.map(btn).join('') + '<span class="grow"></span>' + bottom.map(btn).join('');
    const open = S.transports.filter(t => t.status === 'modifiable').length;
    const badge = document.getElementById('trBadge');
    if (badge) { badge.hidden = !open; badge.textContent = String(open); }
    app.classList.toggle('side-closed', !S.sideOpen);
  }

  function treeNode(id: string, label: string, inner: string, extra = '', depth = 0, attrs = '') {
    const closed = S.collapsed.has(id);
    return `<li class="node ${closed ? 'closed' : ''}" style="--d:${depth}">
      <button class="row" data-act="toggle" data-id="${esc(id)}" aria-expanded="${!closed}" ${attrs}>${ic('chev', 'twisty')}<span class="lbl">${label}</span>${extra}</button>
      <ul>${inner}</ul></li>`;
  }
  function objRow(o: ObjState, depth: number) {
    const t = cur();
    const on = t && t.ref.uri === o.uri;
    return `<li style="--d:${depth}"><button class="row leaf ${on ? 'on' : ''}" data-act="open" data-uri="${esc(o.uri)}" data-ctx="obj" title="${esc(o.name)}${o.desc ? ' · ' + esc(o.desc) : ''}">
      ${glyph(o.type)}<span class="lbl">${esc(o.name)}</span>${o.inactive ? '<em class="inact" title="Inactive version exists">inactive</em>' : ''}</button></li>`;
  }
  let searchSeq = 0;
  /** Programs open like in SE80: the program, and under it the includes it uses. */
  const progIncl = new Map<string, ObjRef[] | 'loading' | { error: string }>();
  function includesIn(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/^[ \t]*INCLUDE[ \t]+(?!TYPE\b|STRUCTURE\b)([\w/<>]+)[ \t]*(?:IF[ \t]+FOUND[ \t]*)?\./gim)) {
      const n = m[1].toUpperCase();
      if (!out.includes(n)) out.push(n);
    }
    return out;
  }
  async function loadIncludes(o: ObjRef, id: string) {
    if (progIncl.get(id) === 'loading') return;
    progIncl.set(id, 'loading');
    try {
      if (o.type === 'FUGR') progIncl.set(id, await backend.groupContents(S.conn, o));
      else {
        const src = await backend.read(S.conn, o, 'main', 'inactive');
        progIncl.set(id, includesIn(src).map(n => allObjs().find(x => x.name === n && (x.type === 'INCL' || x.type === 'PROG'))
          ?? { uri: uriFor('INCL', n), name: n, type: 'INCL' as ObjType, pkg: '', desc: '' }));
      }
    } catch (e) { progIncl.set(id, { error: msg(e) }); }
    if (S.view === 'explorer') renderSide();
  }
  function progRow(o: ObjState, depth: number) {
    const id = `prog:${S.conn}:${o.uri}`;
    const open = S.openSub.has(id);
    const t = cur();
    let inner = '';
    if (open) {
      const inc = progIncl.get(id);
      if (!inc) queueMicrotask(() => loadIncludes(o, id));
      inner = !inc || inc === 'loading' ? `<li class="empty" style="--d:${depth + 1}"><i class="spin"></i>Loading</li>`
        : 'error' in inc ? `<li class="empty err" style="--d:${depth + 1}">${esc(inc.error)}</li>`
          : inc.length ? inc.map(r => `<li style="--d:${depth + 1}"><button class="row leaf ${t && t.ref.uri === r.uri ? 'on' : ''}" data-act="open-ref" data-uri="${esc(r.uri)}" data-name="${esc(r.name)}" data-type="${r.type}" data-ctx="obj" title="${esc(TYPE_INFO[r.type].label)} ${esc(r.name)}${r.desc ? ' · ' + esc(r.desc) : ''}">${glyph(r.type)}<span class="lbl">${esc(r.name)}</span></button></li>`).join('')
            : `<li class="empty" style="--d:${depth + 1}">${o.type === 'FUGR' ? 'No function modules' : 'No includes'}</li>`;
    }
    return `<li class="node prog-node ${open ? '' : 'closed'}" style="--d:${depth}">
      <button class="twist-btn" data-act="prog-toggle" data-id="${esc(id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} the ${o.type === 'FUGR' ? 'function modules' : 'includes'} of ${esc(o.name)}">${ic('chev', 'twisty')}</button>
      <button class="row leaf ${t && t.ref.uri === o.uri ? 'on' : ''}" data-act="open" data-uri="${esc(o.uri)}" data-ctx="obj" title="${esc(o.name)}${o.desc ? ' · ' + esc(o.desc) : ''}">${glyph(o.type)}<span class="lbl">${esc(o.name)}</span>${o.inactive ? '<em class="inact" title="Inactive version exists">inactive</em>' : ''}</button>
      <ul>${inner}</ul></li>`;
  }

  function pkgNode(name: string, desc: string, depth: number, fav: boolean): string {
    const open = pkgOpen(name, fav);
    const data = pkgCache()[name];
    let inner = '';
    if (open) {
      // open from an earlier session but not read yet: read it now
      if (!data) queueMicrotask(() => { if (!pkgCache()[name]) loadPkg(name); });
      if (!data || data === 'loading') inner = `<li class="empty" style="--d:${depth + 1}"><i class="spin"></i>Loading</li>`;
      else if ('error' in data) inner = `<li class="empty err" style="--d:${depth + 1}">${esc(data.error)} <button class="link" data-act="pkg-retry" data-pkg="${esc(name)}">Try again</button></li>`;
      else {
        const parts: string[] = data.packages.map(p => pkgNode(p.name, p.desc, depth + 1, false));
        for (const g of GROUPS) {
          const objs = data.objects.filter(o => TYPE_INFO[o.type].group === g.id);
          if (!objs.length) continue;
          const folders = g.types.flatMap(ty => {
            const list = objs.filter(o => o.type === ty).sort((a, b) => a.name.localeCompare(b.name));
            if (!list.length) return [];
            // objects of types Nusa Studio has no editor for: one folder per type, named by the system
            const sets: [string, string, ObjState[]][] = ty === 'XOBJ'
              ? [...new Set(list.map(o => o.typeLabel || 'Other'))].sort().map(l => [`XOBJ-${l}`, l, list.filter(o => (o.typeLabel || 'Other') === l)])
              : [[ty, TYPE_INFO[ty].folder, list]];
            return sets.map(([id, label, l]) => treeNode(`${pkgId(name)}/${id}`, label, l.map(o => o.type === 'PROG' || o.type === 'FUGR' ? progRow(o, depth + 3) : objRow(o, depth + 3)).join(''), `<span class="cnt">${l.length}</span>`, depth + 2));
          }).join('');
          parts.push(treeNode(`${pkgId(name)}/${g.id}`, g.label, folders, '', depth + 1));
        }
        inner = parts.join('') || `<li class="empty" style="--d:${depth + 1}">Empty package · <button class="link" data-act="new-in" data-pkg="${esc(name)}">New object</button></li>`;
      }
    }
    const local = name.startsWith('$');
    return `<li class="node ${open ? '' : 'closed'}" style="--d:${depth}">
      <button class="row" data-act="pkg-toggle" data-pkg="${esc(name)}" data-fav="${fav ? 1 : 0}" data-ctx="pkg" aria-expanded="${open}" title="${esc(name)}${desc ? ' · ' + esc(desc) : ''}">${ic('chev', 'twisty')}<i class="pkg-ic ${local ? 'local' : ''}"></i><span class="lbl">${esc(name === '$TMP' ? 'Local Objects ($TMP)' : name)}</span></button>
      <ul>${inner}</ul></li>`;
  }

  function sysCard(): string {
    const c = conn();
    const sys = S.sys[S.conn];
    const line = !sys ? '<span class="muted"><i class="spin"></i>Connecting</span>' : 'error' in sys
      ? `<span class="sys-err">${esc(sys.error)}</span><div class="sys-actions"><button class="btn small" data-cmd="reconnect">Try again</button>${c.builtin ? '' : '<button class="btn small ghost" data-act="edit-conn" data-id="' + esc(c.id) + '">Edit system</button>'}</div>`
      : esc(sys.release);
    return `<div class="sys-card ${sys && 'error' in sys ? 'bad' : ''}">
      <div class="sys-top"><b>${esc(c.sid)}</b><span class="pill k-${c.kind}">${c.builtin ? 'Demo' : KIND_LABEL[c.kind]}</span></div>
      <div class="sys-sub">${line}</div></div>`;
  }

  function renderExplorer() {
    const c = conn();
    const favs = c.favoritePackages.filter(p => p !== '$TMP' || c.kind === 'runner');
    const favHtml = favs.map(p => pkgNode(p, '', 1, true)).join('')
      || `<li class="empty" style="--d:1">No favorite packages yet · <button class="link" data-act="add-fav">Add a package</button></li>`;
    const tmp = c.kind !== 'runner' ? pkgNode('$TMP', 'Local objects', 0, true) : '';
    $('#sideBody').innerHTML = `${sysCard()}
      <ul class="tree" role="tree">
        ${treeNode(`${S.conn}/fav`, 'Favorite Packages', favHtml, `<span class="row-acts"><span class="mini" role="button" data-act="add-fav" title="Add package to favorites">${ic('plus')}</span></span>`, 0)}
        ${tmp}
      </ul>`;
  }

  const SEARCH_TYPES: ObjType[] = ['CLAS', 'INTF', 'PROG', 'INCL', 'FUGR', 'FUNC', 'DDLS', 'BDEF', 'DDLX', 'DCLS', 'SRVD', 'SRVB', 'TABL', 'DTEL', 'DOMA', 'TTYP', 'MSAG'];
  function renderSearch() {
    const res = S.searchRes;
    $('#sideBody').innerHTML = `
      <div class="side-pad">
        <label class="field"><span>Object name or description</span>
          <input id="searchInput" value="${esc(S.searchQ)}" placeholder="ZCL_NUSA*" autocomplete="off" spellcheck="false"></label>
        <div class="two search-filters">
          <label class="field"><span>Type</span><select id="searchType"><option value="">All types</option>${SEARCH_TYPES.map(t => `<option value="${t}" ${S.searchType === t ? 'selected' : ''}>${esc(TYPE_INFO[t].label)}</option>`).join('')}</select></label>
          <label class="field"><span>Package</span><input id="searchPkg" value="${esc(S.searchPkg)}" placeholder="ZNUSA*" autocomplete="off" spellcheck="false"></label>
        </div>
      </div>
      ${S.searchErr ? `<div class="side-pad sys-err">${esc(S.searchErr)}</div>` : ''}
      <ul class="list">${res.map(o => `<li><button class="row leaf" data-act="open-search" data-uri="${esc(o.uri)}" data-ctx="obj">${glyph(o.type)}<span class="lbl">${esc(o.name)}<small>${esc(typeLabel(o))}${o.pkg ? ' · ' + esc(o.pkg) : ''}${o.desc ? ' · ' + esc(o.desc) : ''}</small></span></button></li>`).join('') ||
        (S.searchErr ? '' : `<li class="empty">${S.searchQ || S.searchType || S.searchPkg ? 'No objects match' : 'Type to search the repository of ' + esc(conn().sid)}</li>`)}</ul>`;
    const inp = $<HTMLInputElement>('#searchInput');
    const run = async (focusId: string) => {
      S.searchQ = inp.value;
      S.searchType = $<HTMLSelectElement>('#searchType').value as ObjType | '';
      S.searchPkg = $<HTMLInputElement>('#searchPkg').value.trim().toUpperCase();
      const q = S.searchQ || (S.searchType || S.searchPkg ? '*' : '');
      // only the newest search shows its result: an older, slower answer never overwrites it
      const seq = ++searchSeq;
      let res: ObjRef[] = [], err = '';
      try { res = q ? await backend.search(S.conn, q, { type: S.searchType || undefined, pkg: S.searchPkg || undefined }) : []; }
      catch (e) { err = `Search failed: ${msg(e)}`; }
      if (seq !== searchSeq || S.view !== 'search') return;
      S.searchRes = res; S.searchErr = err;
      const el = document.activeElement as HTMLInputElement | null;
      // keep the cursor in the search field, but never take the focus from the palette, a dialog or the editor
      const inSearch = !el || el === document.body || !!el.closest('#sideBody');
      const pos = el && 'selectionStart' in el ? el.selectionStart : null;
      renderSearch();
      if (!inSearch) return;
      const again = document.getElementById(focusId) as HTMLInputElement | null;
      again?.focus(); if (again && pos !== null && again.tagName === 'INPUT') again.setSelectionRange(pos, pos);
    };
    inp.oninput = debounce(() => run('searchInput'), 200);
    $<HTMLSelectElement>('#searchType').onchange = () => run('searchType');
    $<HTMLInputElement>('#searchPkg').oninput = debounce(() => run('searchPkg'), 300);
  }

  function renderOutline() {
    const t = curSrc();
    if (!t || !isSourceType(t.ref.type)) { $('#sideBody').innerHTML = '<div class="side-pad note">Open a source object to see its structure.</div>'; return; }
    const items = outline(cm.getValue(), isCdsLike(t.ref.type));
    const KIC: Record<string, string> = { class: 'C', interface: 'I', method: 'm', attribute: 'a', constant: 'k', type: 't', event: 'e', form: 'f', section: '§', element: '·', entity: 'E', association: '→' };
    $('#sideBody').innerHTML = `<ul class="list outline">${items.map(i => `<li style="--d:${i.depth}"><button class="row leaf" data-act="goline" data-line="${i.line}"><i class="ol-k ol-${i.kind}">${KIC[i.kind]}</i><span class="lbl">${esc(i.name)}${i.detail ? `<small>${esc(i.detail)}</small>` : ''}</span><span class="cnt">${i.line + 1}</span></button></li>`).join('') || '<li class="empty">Nothing to outline</li>'}</ul>`;
  }

  /** SE09/SE10 view: open and released requests on two tabs, grouped by request type. */
  /** objects by "TYPE NAME", built once per render instead of once per transport entry */
  let trIndex = new Map<string, ObjState>();
  const trView = (): TrView => ({ tab: S.trTab, conn: S.conn, collapsed: S.collapsed, picks: trPick, index: trIndex });
  const trTabs = (list: Transport[]) => trTabsHtml(list, trView());
  const trGroups = (list: Transport[]) => trGroupsHtml(list, trView());
  /** Object entries ticked in the Transport Organizer, per request */
  const trPick = new Map<string, Set<string>>();
  function renderTransports() {
    const c = conn();
    for (const [id, set] of trPick) { const t = S.transports.find(x => x.id === id); if (!t || t.status !== 'modifiable') trPick.delete(id); else for (const e of set) if (!t.objects.includes(e)) set.delete(e); }
    if (!c.transports) {
      $('#sideBody').innerHTML = `<div class="side-pad note">${esc(c.label || c.sid)} keeps objects local. Nothing here needs a transport request.</div>`;
      return;
    }
    const list = S.transports;
    trIndex = new Map(allObjs().map(o => [`${o.type} ${o.name}`, o]));
    $('#sideBody').innerHTML = `
      <form class="side-pad new-tr" id="newTr">
        <label class="field"><span>New request</span><input id="newTrDesc" placeholder="Short description" maxlength="60" required></label>
        <button class="btn" type="submit">${ic('plus')}Create</button>
      </form>
      ${trTabs(list)}
      ${list.length ? trGroups(list.filter(t => t.status === S.trTab)) : (c.user ? `<ul class="trs"><li class="empty">No requests of ${esc(c.user)} on ${esc(c.sid)}.<br>Eclipse shows requests you expect here? <button class="link" data-act="diag" data-id="${esc(c.id)}">Open the connection log</button> and send it with your issue.</li></ul>` : '')}
      ${!list.length && !c.user ? `<form class="side-pad tr-user" id="trUser">
        <p class="note">Nusa Studio lists the requests of your user. With browser logon it could not read your user ID from ${esc(c.sid)}; enter it once (shown in Eclipse or in the Fiori launchpad under your profile, for example CB9980000000).</p>
        <label class="field"><span>Your user ID</span><input id="trUserId" autocomplete="off" spellcheck="false" required></label>
        <button class="btn small primary" type="submit">Show my requests</button></form>` : ''}`;
    $('#sideBody').querySelectorAll<HTMLInputElement>('.tr-pick').forEach(cb => {
      cb.onchange = () => {
        const set = trPick.get(cb.dataset.tr as string) ?? new Set<string>();
        if (cb.checked) set.add(cb.dataset.entry as string); else set.delete(cb.dataset.entry as string);
        trPick.set(cb.dataset.tr as string, set);
        const y = $('#sideBody').scrollTop; renderSide(); $('#sideBody').scrollTop = y;
      };
    });
    const uf = document.getElementById('trUser') as HTMLFormElement | null;
    if (uf) uf.onsubmit = async (e) => {
      e.preventDefault();
      const u = $<HTMLInputElement>('#trUserId').value.trim().toUpperCase();
      if (!u) return;
      try {
        await backend.saveConnection({ ...conn(), user: u });
        S.conns = await backend.connections();
        S.transports = await backend.transports(S.conn);
        renderAll();
      } catch (er) { fail(er, 'Reading the requests'); }
    };
    ($('#newTr') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const desc = $<HTMLInputElement>('#newTrDesc').value.trim();
      if (!desc) return;
      const t = cur();
      try {
        const id = await backend.createTransport(S.conn, desc, t?.ref ?? { uri: '', name: '', type: 'CLAS', pkg: conn().favoritePackages[0] || '', desc: '' });
        S.transports = await backend.transports(S.conn);
        toast(`Created request ${id}`, 'ok');
        renderSide(); renderActivity();
      } catch (er) { fail(er, 'Creating the request'); }
    };
  }

  function renderGit() {
    const g = S.git;
    if (!g) { $('#sideBody').innerHTML = '<div class="side-pad muted"><i class="spin"></i>Loading repositories</div>'; loadGit(); return; }
    if ('error' in g) {
      $('#sideBody').innerHTML = `<div class="side-pad"><p class="sys-err">${esc(g.error)}</p><p class="note">The abapGit view uses the ADT abapGit service. It exists on SAP BTP ABAP Environment, S/4HANA Cloud and on-premise systems with the abapGit plugin for ADT.</p><button class="btn small" data-act="git-refresh">Try again</button></div>`;
      return;
    }
    $('#sideBody').innerHTML = `<ul class="repos">${g.map(r => `
      <li class="repo">
        <div class="repo-head"><i class="pkg-ic"></i><b>${esc(r.pkg)}</b>${r.status === 'E' ? '<span class="pill p-warn">Error</span>' : ''}</div>
        <a class="repo-url" href="${esc(r.url.replace(/\.git$/, ''))}" target="_blank" rel="noopener">${esc(r.url.replace(/^https:\/\//, ''))}</a>
        <div class="tr-meta">${esc(r.branch.replace('refs/heads/', ''))}${r.statusText ? ' · ' + esc(r.statusText) : ''}${r.createdBy ? ' · ' + esc(r.createdBy) : ''}</div>
        <div class="tr-actions"><button class="btn small" data-act="git-pull" data-key="${esc(r.key)}">${ic('download')}Pull</button><button class="btn small ghost" data-act="git-show" data-pkg="${esc(r.pkg)}">Show package</button><button class="btn small ghost danger-text" data-act="git-unlink" data-key="${esc(r.key)}">Unlink</button></div>
      </li>`).join('') || '<li class="empty">No linked repositories. Link a package to a Git repository with +.</li>'}</ul>`;
  }
  async function loadGit() {
    try { S.git = await backend.gitRepos(S.conn); } catch (e) { S.git = { error: `abapGit is not available on ${conn().sid}: ${msg(e)}` }; }
    if (S.view === 'git') renderSide();
  }

  /** Variables like Eclipse: groups open, structures and tables load their parts when opened. */
  const varKids = new Map<string, DebugVar[]>();
  function varTree(vs: DebugVar[], depth = 0): string {
    return vs.map(v => {
      const kids = v.children ?? (v.id ? varKids.get(v.id) : undefined);
      const edit = !v.group && !v.expandable ? ` data-act="dbg-set" data-name="${esc(v.name)}" data-value="${esc(v.value)}" title="Double-click to change the value"` : '';
      const row = v.group ? `<span class="vg">${esc(v.name)}</span>` : `<span class="vn">${esc(v.name)}</span><span class="vv"${edit}>${esc(v.value)}</span><span class="vt">${esc(v.type)}</span>`;
      if (kids?.length || v.expandable) {
        const open = v.group && (kids?.length ?? 0) > 0 && depth === 0;
        return `<li><details ${open ? 'open' : ''} ${v.id && !kids ? `data-load="${esc(v.id)}"` : ''}><summary>${row}</summary><ul>${kids ? varTree(kids, depth + 1) || '<li class="empty">empty</li>' : '<li class="empty"><i class="spin"></i></li>'}</ul></details></li>`;
      }
      return `<li class="leafvar">${row}</li>`;
    }).join('');
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
    const t = curSrc();
    const canDebug = t && (t.ref.type === 'PROG' || t.ref.type === 'CLAS') && !runBlocker(t);
    const c = conn();
    const canListen = !c.builtin && c.kind !== 'runner';
    const sel = d?.frame ?? 0;
    const body = $('#sideBody');
    body.innerHTML = d && !d.done ? `
      ${d.note ? `<div class="side-pad note warn-note">${esc(d.note)}</div>` : ''}
      <section class="dsec"><h3>Variables${sel ? ` <small>of ${esc(d.frames[sel]?.name || '')}</small>` : ''}</h3><ul class="vars">${varTree(d.vars) || '<li class="empty">No variables here</li>'}</ul></section>
      <section class="dsec"><h3>Call stack</h3><ol class="stack">${d.frames.map((f, i) => `<li><button class="row leaf ${i === sel ? 'on' : ''}" data-act="dbg-frame" data-i="${i}"><span class="lbl">${esc(f.name)}<small>line ${f.line + 1}</small></span></button></li>`).join('')}</ol></section>
      <section class="dsec"><h3>Breakpoints</h3><ul class="list">${bpHtml}</ul></section>`
      : S.listening ? `<div class="side-pad listen-card"><p><i class="spin"></i><b>Waiting for a breakpoint</b></p>
          <p class="note">Run the code now: open the Fiori app or service preview, call the OData or HTTP service, or start the report in SAP GUI as <b>${esc(c.user || 'your user')}</b>. The first process that reaches a breakpoint stops here, like the Eclipse debugger.</p>
          <button class="btn block" data-act="dbg-unlisten">Stop waiting</button></div>
        <section class="dsec"><h3>Breakpoints</h3><ul class="list">${bpHtml}</ul></section>`
      : `<div class="side-pad note">${canDebug ? `Set a breakpoint in <b>${esc(t!.ref.name)}</b> or in a class it calls, then press <kbd>F8</kbd>.` : 'Open a program or a console class, set a breakpoint and press <kbd>F8</kbd> to debug it.'}
          ${canDebug ? `<button class="btn primary block" data-cmd="run">${ic('play')}Debug ${esc(t!.ref.name)}</button>` : ''}</div>
        ${canListen ? `<div class="side-pad"><button class="btn block" data-act="dbg-listen" ${bps.length ? '' : 'disabled'}>${ic('bug')}Wait for any process to stop…</button>
          <p class="note">For code that runs elsewhere, such as a RAP behavior called by a Fiori app or an OData request. ${bps.length ? '' : 'Set a breakpoint first.'}</p></div>` : ''}
        <section class="dsec"><h3>Breakpoints</h3><ul class="list">${bpHtml}</ul></section>`;
    body.querySelectorAll<HTMLDetailsElement>('details[data-load]').forEach(det => {
      det.addEventListener('toggle', async () => {
        if (!det.open || !S.debug || S.debug.done) return;
        const id = det.dataset.load as string;
        if (varKids.has(id)) return;
        try {
          varKids.set(id, await backend.debugChildren(id));
          det.removeAttribute('data-load');
          const ul = det.querySelector(':scope > ul') as HTMLElement;
          ul.innerHTML = varTree(varKids.get(id) as DebugVar[], 1) || '<li class="empty">empty</li>';
        } catch (e) { fail(e, 'Reading the variable'); }
      }, { once: false });
    });
  }

  function renderExtensions() {
    $('#sideBody').innerHTML = `<ul class="exts">${EXTENSIONS.map(e => `
      <li class="ext ${ext(e.id) ? '' : 'off'}">
        <div class="ext-ic">${ic(e.icon)}</div>
        <div class="ext-main">
          <div class="ext-head"><b>${esc(e.name)}</b><label class="switch" title="${ext(e.id) ? 'Disable' : 'Enable'} ${esc(e.name)}"><input type="checkbox" data-ext="${e.id}" ${ext(e.id) ? 'checked' : ''}><i></i></label></div>
          <div class="ext-by">Built in · Nusa Studio</div>
          <p>${esc(e.desc)}</p>
          <div class="ext-keys">${esc(e.keys)}</div>
        </div>
      </li>`).join('')}</ul>
      <p class="side-pad note">These extensions ship with Nusa Studio and work on every connected system. Tools that need their own runtime, such as SAP's ABAP Cleaner plugin or abaplint, are not included.</p>`;
    $('#sideBody').querySelectorAll<HTMLInputElement>('input[data-ext]').forEach(inp => {
      inp.onchange = () => {
        settings.ext[inp.dataset.ext as ExtId] = inp.checked; saveSettings();
        toast(`${EXTENSIONS.find(x => x.id === inp.dataset.ext)?.name} ${inp.checked ? 'enabled' : 'disabled'}`, 'info', 1600);
        renderAll();
      };
    });
  }

  function renderConnections() {
    $('#sideBody').innerHTML = `
      <ul class="conns">${S.conns.map(c => {
        const sys = S.sys[c.id];
        const state = c.id === S.conn ? (!sys ? '<span class="muted"><i class="spin"></i>Connecting</span>' : 'error' in sys ? '<span class="sys-err">Not connected</span>' : '<span class="conn-state">Connected</span>') : '';
        return `<li class="conn ${c.id === S.conn ? 'on' : ''}">
          <div class="conn-head"><b>${esc(c.sid)}</b><span class="pill k-${c.kind}">${c.builtin ? 'Demo' : KIND_LABEL[c.kind]}</span></div>
          ${c.label ? `<div class="conn-sub">${esc(c.label)}</div>` : ''}
          <dl>
            ${c.auth === 'rfc' ? `<dt>Server</dt><dd><code>${esc(rfcTarget(c))}</code></dd>` : `<dt>URL</dt><dd><code>${esc(c.url)}</code></dd>`}
            ${c.kind === 's4' ? `<dt>Client</dt><dd>${esc(c.client)} · ${esc(c.language)}</dd>` : ''}
            ${c.user ? `<dt>User</dt><dd>${esc(c.user)}</dd>` : ''}
            <dt>Login</dt><dd>${AUTH_LABEL[c.auth]}</dd>
            <dt>ABAP</dt><dd>${c.abapVersion === 'cloud' ? 'ABAP for Cloud Development' : c.abapVersion === 'runner' ? 'Runner subset' : 'Standard ABAP'}</dd>
            ${sys && 'error' in sys ? `<dt>Error</dt><dd class="sys-err">${esc(sys.error)}</dd>` : sys ? `<dt>System</dt><dd>${esc(sys.release)}</dd>` : ''}
          </dl>
          <div class="conn-actions">${state}
            ${c.id !== S.conn ? `<button class="btn small primary" data-act="switch" data-id="${esc(c.id)}">Connect</button>` : ''}
            <button class="btn small ghost" data-act="test-conn" data-id="${esc(c.id)}">Test</button>
            ${c.auth === 'sso' || c.auth === 'oauth' || c.auth === 'rfc' ? `<button class="btn small ghost" data-act="relogin" data-id="${esc(c.id)}">Log in again</button>` : ''}
            ${c.builtin ? '' : `<button class="btn small ghost" data-act="diag" data-id="${esc(c.id)}">Log</button>`}
            ${c.builtin ? '' : `<button class="btn small ghost" data-act="edit-conn" data-id="${esc(c.id)}">Edit</button><button class="btn small ghost danger-text" data-act="del-conn" data-id="${esc(c.id)}">Remove</button>`}
          </div>
        </li>`;
      }).join('')}</ul>
      <div class="side-pad"><button class="btn primary block" data-act="add-conn">${ic('plus')}Add system</button></div>`;
  }

  function renderSettings() {
    const opt = (v: number) => `<option value="${v}" ${settings.editorFont === v ? 'selected' : ''}>${v}px</option>`;
    $('#sideBody').innerHTML = `
      <section class="set">
        <h3>Appearance</h3>
        <div class="seg" role="group" aria-label="Color theme">${(['dark', 'light', 'system'] as ThemePref[]).map(p => `<button class="${themePref === p ? 'on' : ''}" data-act="set-theme" data-id="${p}">${ic(p === 'dark' ? 'moon' : p === 'light' ? 'sun' : 'monitor')}${p === 'dark' ? 'Dark' : p === 'light' ? 'Light' : 'System'}</button>`).join('')}</div>
        <label class="field"><span>Editor font size</span><select id="setFont">${[12, 13, 14, 15, 16, 18, 20].map(opt).join('')}</select></label>
      </section>
      <section class="set">
        <h3>Editor</h3>
        <label class="check"><input type="checkbox" id="setAuto" ${settings.autoComplete ? 'checked' : ''}><span>Show code completion while typing</span></label>
        <label class="check"><input type="checkbox" id="setRestore" ${settings.restoreTabs ? 'checked' : ''}><span>Reopen the editors of the last session</span></label>
        <label class="check"><input type="checkbox" id="setPreview" ${settings.previewTabs ? 'checked' : ''}><span>Preview tabs<small class="txt">A single click opens a temporary tab that the next click replaces, until you edit or double-click it</small></span></label>
        <label class="check"><input type="checkbox" id="setDrafts" ${settings.keepDrafts ? 'checked' : ''}><span>Keep unsaved changes as drafts<small class="txt">Restored after a crash or restart</small></span></label>
      </section>
      <section class="set">
        <h3>Formatting <small>Shift+Alt+F · Shift+F1</small></h3>
        <label class="field"><span>ABAP formatter</span><select id="setFormatter"><option value="nusa" ${settings.formatter === 'nusa' ? 'selected' : ''}>Nusa formatter: indentation, aligned parameters, works offline</option><option value="sap" ${settings.formatter === 'sap' ? 'selected' : ''}>Pretty printer of the system (its user settings)</option></select></label>
        <label class="field"><span>Keywords</span><select id="setKwCase"><option value="upper" ${settings.keywordCase === 'upper' ? 'selected' : ''}>UPPER CASE</option><option value="lower" ${settings.keywordCase === 'lower' ? 'selected' : ''}>lower case</option><option value="keep" ${settings.keywordCase === 'keep' ? 'selected' : ''}>Keep as written</option></select></label>
        <p class="note">CDS sources are indented by braces with either setting.</p>
      </section>
      <section class="set">
        <h3>On save</h3>
        <label class="check"><input type="checkbox" id="setFmtSave" ${settings.formatOnSave ? 'checked' : ''}><span>Format with the pretty printer</span></label>
        ${ext('cleaner') ? `<label class="check"><input type="checkbox" id="setCleanSave" ${settings.cleanOnSave ? 'checked' : ''}><span>Clean up with ABAP Cleaner<small class="txt">Uses the rules below</small></span></label>` : ''}
      </section>
      ${ext('cleaner') ? `<section class="set">
        <h3>ABAP Cleaner rules <small>Ctrl+4</small></h3>
        ${RULES.map(r => `<label class="check"><input type="checkbox" data-rule="${r.id}" ${settings.cleanerRules.includes(r.id) ? 'checked' : ''}><span>${esc(r.label)}${r.example ? `<small>${esc(r.example)}</small>` : ''}</span></label>`).join('')}
      </section>` : ''}
      ${opts.logon ? `<section class="set">
        <h3>Browser logon</h3>
        <label class="check"><input type="checkbox" id="setAutoLogon" ${settings.autoOpenLogon ? 'checked' : ''}><span>Open the logon page in the default browser at once<small>Off: the window shows the link with Open in browser and Copy link, so you choose the browser or profile.</small></span></label>
      </section>` : ''}
      ${opts.updates ? `<section class="set">
        <h3>Updates</h3>
        <label class="check"><input type="checkbox" id="setUpd" ${settings.checkUpdates ? 'checked' : ''}><span>Look for a new version once a day<small>Reads the latest release on GitHub; nothing about you or your systems is sent.</small></span></label>
        <button class="btn small" data-cmd="update">Check for updates now</button>
      </section>` : ''}
      <section class="set">
        <h3>About</h3>
        <p class="note">Nusa Studio ${APP_VERSION} · open-source ABAP workbench by ABAP Nusantara. Systems are stored in your user profile (or next to the portable exe); passwords and tickets in the operating system keychain.</p>
        <button class="btn small" data-cmd="report">Report a problem…</button>
      </section>`;
    const al = document.getElementById('setAutoLogon') as HTMLInputElement | null;
    if (al) al.onchange = () => { settings.autoOpenLogon = al.checked; saveSettings(); opts.logon?.autoOpen(al.checked).catch(() => undefined); };
    const upd = document.getElementById('setUpd') as HTMLInputElement | null;
    if (upd) upd.onchange = () => { settings.checkUpdates = upd.checked; saveSettings(); };
    $<HTMLSelectElement>('#setFont').onchange = (e) => {
      settings.editorFont = +(e.target as HTMLSelectElement).value; saveSettings();
      html.style.setProperty('--editor-size', settings.editorFont + 'px'); cm.refresh();
    };
    $<HTMLInputElement>('#setAuto').onchange = (e) => { settings.autoComplete = (e.target as HTMLInputElement).checked; saveSettings(); };
    $<HTMLInputElement>('#setRestore').onchange = (e) => { settings.restoreTabs = (e.target as HTMLInputElement).checked; saveSettings(); };
    $<HTMLInputElement>('#setDrafts').onchange = (e) => { settings.keepDrafts = (e.target as HTMLInputElement).checked; saveSettings(); };
    $<HTMLInputElement>('#setPreview').onchange = (e) => { settings.previewTabs = (e.target as HTMLInputElement).checked; if (!settings.previewTabs) S.tabs.forEach(t => { t.preview = false; }); saveSettings(); renderTabs(); };
    $<HTMLSelectElement>('#setFormatter').onchange = (e) => { settings.formatter = (e.target as HTMLSelectElement).value as Settings['formatter']; saveSettings(); };
    $<HTMLSelectElement>('#setKwCase').onchange = (e) => { settings.keywordCase = (e.target as HTMLSelectElement).value as KeywordCase; saveSettings(); };
    $<HTMLInputElement>('#setFmtSave').onchange = (e) => { settings.formatOnSave = (e.target as HTMLInputElement).checked; saveSettings(); };
    const cs = document.getElementById('setCleanSave') as HTMLInputElement | null;
    if (cs) cs.onchange = () => { settings.cleanOnSave = cs.checked; saveSettings(); };
    $('#sideBody').querySelectorAll<HTMLInputElement>('input[data-rule]').forEach(inp => {
      inp.onchange = () => {
        const id = inp.dataset.rule as RuleId;
        settings.cleanerRules = inp.checked ? [...new Set([...settings.cleanerRules, id])] : settings.cleanerRules.filter(r => r !== id);
        saveSettings();
      };
    });
  }

  function renderSide() {
    if ((S.view === 'git' && !ext('abapgit')) || (S.view === 'outline' && !ext('outline'))) S.view = 'explorer';
    const titles: Record<View, string> = { explorer: 'Project Explorer', search: 'Search', outline: 'Outline', transports: 'Transport Organizer', git: 'abapGit Repositories', debug: 'Debug', extensions: 'Extensions', connections: 'Systems', settings: 'Settings' };
    $('#sideTitle').textContent = titles[S.view];
    const a = (act: string, icon: string, title: string, isCmd = false) => `<button ${isCmd ? 'data-cmd' : 'data-act'}="${act}" title="${title}" aria-label="${title}">${ic(icon)}</button>`;
    $('#sideActions').innerHTML = S.view === 'explorer'
      ? a('new', 'plus', 'New ABAP object', true) + a('new-package', 'pkgplus', 'New package', true) + a('refresh', 'refresh', 'Refresh', true) + a('collapse-all', 'collapse', 'Collapse all')
      : S.view === 'transports' ? a('refresh', 'refresh', 'Refresh', true)
        : S.view === 'git' ? a('git-link', 'plus', 'Link repository') + a('git-refresh', 'refresh', 'Refresh')
          : S.view === 'connections' ? a('add-conn', 'plus', 'Add system') : '';
    ({ explorer: renderExplorer, search: renderSearch, outline: renderOutline, transports: renderTransports, git: renderGit, debug: renderDebug, extensions: renderExtensions, connections: renderConnections, settings: renderSettings })[S.view]();
  }

  function renderTabs() {
    const t = cur();
    $('#tabs').innerHTML = tabsHere().map(x => `
      <div class="tab ${t && x.key === t.key ? 'on' : ''} ${x.ref.inactive && x.view === 'source' ? 'inactive' : ''} ${x.preview ? 'preview' : ''}" role="tab" aria-selected="${!!t && x.key === t.key}" data-act="tab" data-key="${esc(x.key)}" data-ctx="tab" title="${esc(x.ref.name)}${x.ref.desc ? ' · ' + esc(x.ref.desc) : ''}">
        ${tabGlyph(x)}<span class="tname">${esc(tabName(x))}</span>
        ${x.lock ? `<span class="tlock" title="Locked by you">${ic('lock')}</span>` : ''}
        <button class="tclose ${isDirty(x) ? 'dirty' : ''}" data-act="close" data-key="${esc(x.key)}" title="${isDirty(x) ? 'Unsaved changes. Close' : 'Close'}" aria-label="Close ${esc(x.ref.name)}">${ic('close')}</button>
      </div>`).join('');
    saveSession();
  }

  function renderCrumbs() {
    const t = cur();
    const el = $('#crumbs');
    if (!t) { el.innerHTML = ''; return; }
    const c = conn();
    if (t.view === 'diff') { el.innerHTML = `<span>${esc(c.sid)}</span>${ic('chev')}<span>${esc(t.ref.pkg)}</span>${ic('chev')}<b>${esc(t.ref.name)}</b>${t.ref.type === 'CLAS' && t.diff ? `${ic('chev')}<span>${esc(INCLUDE_LABEL[t.diff.inc])}</span>` : ''}${ic('chev')}<span>Compare</span>`; return; }
    if (t.view === 'data') { el.innerHTML = `<span>${esc(c.sid)}</span>${ic('chev')}<b>${t.data?.entity ? 'Data Preview' : 'SQL Console'}</b>${t.data?.entity ? `${ic('chev')}<span>${esc(t.data.entity)}</span>` : ''}`; return; }
    const st = t.view === 'binding' ? '' : t.ref.inactive ? '<span class="pill p-warn">Inactive</span>' : '<span class="pill p-ok">Active</span>';
    el.innerHTML = `<span>${esc(c.sid)}</span>${ic('chev')}<span>${esc(t.ref.pkg)}</span>${ic('chev')}<span>${esc(TYPE_INFO[t.ref.type].folder)}</span>${ic('chev')}<b>${esc(t.ref.name)}</b>
      ${t.ref.type === 'CLAS' ? `${ic('chev')}<span>${esc(INCLUDE_LABEL[t.include])}</span>` : ''}
      <span class="crumb-right">${st}${t.ref.transport ? `<code class="crumb-tr" title="Transport request">${esc(t.ref.transport)}</code>` : ''}<code class="uri">${esc(t.ref.uri)}</code></span>`;
  }

  function renderSubtabs() {
    const t = cur();
    const el = $('#subtabs');
    if (isForm(t)) {
      el.hidden = false;
      el.innerHTML = `<button class="${!t!.raw ? 'on' : ''}" data-act="xml-mode" data-id="form">Form</button><button class="${t!.raw ? 'on' : ''}" data-act="xml-mode" data-id="xml">XML${incDirty(t!, 'main') ? '<i class="ddot"></i>' : ''}</button>`;
      return;
    }
    if (!t || t.view !== 'source' || (t.ref.type !== 'CLAS' && t.ref.type !== 'PROG')) { el.hidden = true; return; }
    el.hidden = false;
    // classes: their includes; programs: the source and its text elements (SE38 → Goto → Text Elements)
    el.innerHTML = backend.includesOf(t.ref.type).map(inc => `<button class="${inc === t.include ? 'on' : ''}" data-act="inc" data-inc="${inc}">${esc(inc === 'main' && t.ref.type === 'PROG' ? 'Source' : INCLUDE_LABEL[inc])}${incDirty(t, inc) ? '<i class="ddot"></i>' : ''}</button>`).join('');
  }

  function sevIcon(s: Problem['sev']) { return ic(s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'info', 's-' + s); }
  const locAttrs = (l: Location) => `data-act="goto" data-uri="${esc(l.uri)}" data-inc="${l.include}" data-line="${l.line}"`;

  function renderPanel() {
    app.classList.toggle('panel-closed', !S.panelOpen);
    const errs = S.problems.filter(p => p.sev === 'error').length;
    const tabs: [PanelTab, string, string][] = [
      ['problems', 'Problems', S.problems.length ? `<i class="cnt ${errs ? 'c-err' : 'c-warn'}">${S.problems.length}</i>` : ''],
      ['atc', 'ATC Findings', S.atc ? `<i class="cnt">${S.atc.findings.length}</i>` : ''],
      ['unit', 'ABAP Unit', S.unit ? `<i class="cnt ${S.unit.methods.some(m => m.status !== 'ok') ? 'c-err' : 'c-ok'}">${S.unit.methods.length}</i>` : ''],
      ['output', 'Output', ''],
      ['where', 'Where-Used', S.where ? `<i class="cnt">${S.where.hits.length}</i>` : ''],
      ['traces', 'Profiler', ''],
      ['dumps', 'Runtime Errors', Array.isArray(S.dumps) && ownDumps(S.dumps, conn().user, S.dumpsMine).length ? `<i class="cnt c-err">${ownDumps(S.dumps, conn().user, S.dumpsMine).length}</i>` : ''],
    ];
    $('#panelTabs').innerHTML = tabs.map(([id, label, extra]) => `<button role="tab" class="${S.panel === id ? 'on' : ''}" aria-selected="${S.panel === id}" data-act="panel" data-id="${id}">${label}${extra}</button>`).join('') +
      `<span class="grow"></span>${S.busy ? `<span class="busy"><i class="spin"></i>${esc(S.busy)}</span>` : ''}<button class="icon-btn" data-cmd="panel" title="Hide panel (Ctrl+J)">${ic('close')}</button>`;
    const body = $('#panelBody');
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
    } else if (S.panel === 'traces') {
      body.innerHTML = renderTraces();
    } else if (S.panel === 'dumps') {
      body.innerHTML = renderDumps({ user: conn().user || 'your user', list: S.dumps, mine: S.dumpsMine, sel: S.dumpSel });
    } else {
      const w = S.where;
      if (!w) { body.innerHTML = '<div class="empty-panel">Place the cursor on a name and press Ctrl+Shift+G.</div>'; return; }
      body.innerHTML = `<div class="sumline"><b>${esc(w.term)}</b><span>${w.hits.length} references</span></div><ul>${w.hits.map(h => `<li><button class="prow" ${locAttrs(h)}>${glyph(h.type)}<span class="pmsg"><code>${esc(h.text)}</code></span><span class="ploc">${esc(h.name)}${h.include !== 'main' ? ' · ' + esc(INCLUDE_LABEL[h.include]) : ''} · line ${h.line + 1}</span></button></li>`).join('')}</ul>`;
    }
  }
  const openPanel = (p: PanelTab) => { S.panel = p; S.panelOpen = true; if (p === 'traces' && !S.traces) loadTraces(); if (p === 'dumps' && !S.dumps) loadDumps(); };

  // ------------------------------------------------------------------ runtime errors (ST22)
  async function loadDumps() {
    S.dumps = null; S.dumpSel = null; if (S.panel === 'dumps') renderPanel();
    const c = S.conn;
    let r: Dump[] | { error: string };
    try { r = await backend.dumps(c); } catch (e) { r = { error: `Reading the runtime errors failed: ${msg(e)}` }; }
    if (c !== S.conn) return;
    S.dumps = r; renderPanel();
  }
  async function openDump(id: string) {
    const dump = Array.isArray(S.dumps) ? S.dumps.find(d => d.id === id) : undefined;
    if (!dump) return;
    S.dumpSel = { dump }; renderPanel();
    try {
      const r = await backend.dumpDetail(S.conn, dump);
      if (S.dumpSel?.dump !== dump) return;
      S.dumpSel = { dump, ...r };
      if (r.html === undefined && r.text === undefined) S.dumpSel.text = '(the system sent no description)';
    } catch (e) { if (S.dumpSel?.dump === dump) S.dumpSel = { dump, text: `Reading the description failed: ${msg(e)}` }; }
    renderPanel();
  }
  const showDumps = () => { S.dumpSel = null; S.panel = 'dumps'; S.panelOpen = true; loadDumps(); renderPanel(); };

  // ------------------------------------------------------------------ version history and other systems
  const versions = createHistory({
    backend,
    conns: () => S.conns,
    sys: id => S.sys[id],
    setSys: (id, v) => { S.sys[id] = v; },
    editorText: async () => { const t = curSrc(); return t ? (await ensureDoc(t, t.include)).getValue() : ''; },
    openDiff: (left, ll, right, rl) => { const t = curSrc(); if (t) openDiff(t, t.include, left, ll, right, rl); },
    modal: (title, body, buttons, init) => modal(title, body, buttons, init),
    working: async (label, fn) => { S.busy = label; renderPanel(); try { return await fn(); } finally { S.busy = ''; renderPanel(); } },
    toast: (text, kind, ms) => toast(text, kind, ms),
  });
  const compareRevision = () => { const t = curSrc(); if (!t) { toast('Open a source first'); return; } return versions.compareRevision({ conn: t.conn, ref: t.ref, include: t.include }); };
  const compareSystem = () => { const t = curSrc(); if (!t) { toast('Open a source first'); return; } return versions.compareSystem({ conn: t.conn, ref: t.ref, include: t.include }); };

  // ------------------------------------------------------------------ profiler (ABAP traces, like ABAP Profiling in Eclipse)
  function renderTraces(): string {
    const t = curSrc();
    const canProfile = t && (t.ref.type === 'CLAS' || t.ref.type === 'PROG') && !runBlocker(t);
    return traceView({ user: conn().user || 'your user', profile: canProfile ? t!.ref.name : undefined, sel: S.traceSel, list: S.traces });
  }
  async function loadTraces() {
    S.traces = null; if (S.panel === 'traces') renderPanel();
    try { S.traces = await backend.traces(S.conn); } catch (e) { S.traces = { error: `Reading the traces failed: ${msg(e)}` }; }
    renderPanel();
  }
  async function openTrace(id: string) {
    const run = Array.isArray(S.traces) ? S.traces.find(r => r.id === id) : undefined;
    if (!run) return;
    await busy('Reading the hit list', async () => { S.traceSel = { run, hits: await backend.traceHitList(S.conn, id) }; });
    renderPanel();
  }
  async function traceNextRun(quiet = false) {
    await busy('Requesting a trace', () => backend.traceRequest(S.conn, `Nusa Studio ${new Date().toLocaleString()}`));
    if (!quiet) toast(`The next run of ${conn().user || 'your user'} is traced (for one hour). Run your code, then press Refresh in the Profiler.`, 'ok', 8000);
  }
  /** Profile As ABAP Application: trace, run, then show the hit list. */
  async function profile() {
    const t = curSrc(); if (!t) return;
    const why = runBlocker(t);
    if (why) { toast(why, 'warn', 6000); return; }
    S.traceSel = null; openPanel('traces');
    await traceNextRun(true);
    if (t.ref.type === 'PROG' && !conn().runReports) {
      if (await runInGui(t)) toast('Traced in SAP GUI. When the report has finished, press Refresh in the Profiler.', 'info', 9000);
      renderAll();
      return;
    }
    const before = Array.isArray(S.traces) ? S.traces.map(r => r.id) : [];
    await busy(`Profiling ${t.ref.name}`, async () => {
      const r = await backend.run(t.conn, t.ref);
      S.output = { ...r, title: t.ref.name, at: new Date().toLocaleTimeString() };
      // the trace file is written after the run; give the system a moment
      for (let i = 0; i < 6; i++) {
        const list = await backend.traces(S.conn);
        S.traces = list;
        const fresh = list.find(x => !before.includes(x.id));
        if (fresh) { S.traceSel = { run: fresh, hits: await backend.traceHitList(S.conn, fresh.id) }; break; }
        await new Promise(res => setTimeout(res, 1500));
      }
    });
    if (!S.traceSel) toast('The run finished but its trace is not there yet. Press Refresh in the Profiler in a moment.', 'info', 7000);
    renderAll();
  }

  function renderStatus() {
    const c = conn();
    const t = cur();
    const pos = cm.getCursor();
    const errs = S.problems.filter(p => p.sev === 'error').length;
    const warns = S.problems.filter(p => p.sev === 'warning').length;
    const lang = c.abapVersion === 'cloud' ? 'ABAP for Cloud Development' : c.abapVersion === 'runner' ? 'ABAP · runner subset' : 'Standard ABAP';
    app.classList.toggle('debugging', !!(S.debug && !S.debug.done));
    const src = t?.view === 'source';
    $('#status').innerHTML = `
      <button data-act="pick-conn" title="Switch system">${ic('server')}${esc(c.sid)}${c.kind === 's4' ? ' ' + esc(c.client) : ''}${c.user ? ' · ' + esc(c.user) : ''}</button>
      ${t && t.ref.transport ? `<button data-act="view" data-id="transports" title="Transport request">${ic('transport')}${esc(t.ref.transport)}</button>` : t && t.ref.pkg.startsWith('$') ? `<span>${ic('transport')}Local object</span>` : ''}
      <button data-act="panel" data-id="problems" title="Problems">${ic('error')}${errs} ${ic('warning')}${warns}</button>
      ${S.debug && !S.debug.done ? `<span class="dbg-pill">${ic('bug')}Debugging</span>` : ''}
      <span class="grow"></span>
      <button id="themeStatus" data-act="pick-theme" title="Color theme"></button>
      ${t && src && !isSourceType(t.ref.type) ? `<span>${t.lock ? ic('lock') + 'Locked' : 'Not locked'}</span><span>${esc(typeLabel(t.ref))}</span><span>${t.ref.inactive ? 'Inactive' : 'Active'}</span>` : t && src ? `<span>${t.lock ? ic('lock') + 'Locked' : 'Not locked'}</span><span>Ln ${pos.line + 1}, Col ${pos.ch + 1}</span><span>${isCdsLike(t.ref.type) ? TYPE_INFO[t.ref.type].label : lang}</span><span>${t.ref.inactive ? 'Inactive' : 'Active'}</span>` : `<span>${esc(lang)}</span>`}`;
    renderThemeBits();
  }

  function renderWelcome() {
    const t = cur();
    const show = !t;
    $('#welcome').hidden = !show;
    const paneOn = !!t && (t.view !== 'source' || (isForm(t) && !t.raw));
    $('#pane').hidden = !paneOn;
    $('#editor').style.visibility = show || paneOn ? 'hidden' : 'visible';
    if (paneOn) renderPane();
    if (!show) return;
    const c = conn();
    const sys = S.sys[S.conn];
    const demo = S.conns.find(x => x.builtin && x.id !== c.id);
    if (!sys) { $('#welcome').innerHTML = `<div class="wel">${LOGO}<h1>${esc(opts.brand || 'Nusa Studio')}</h1><p><i class="spin"></i>Connecting to <b>${esc(c.sid)}</b>${c.auth === 'sso' ? '. Finish the logon in your browser.' : ''}</p></div>`; return; }
    if ('error' in sys) {
      $('#welcome').innerHTML = `<div class="wel wel-err"><div class="err-ic">${ic('plug')}</div><h1>Can't connect to ${esc(c.sid)}</h1><p class="err-msg">${esc(sys.error)}</p>
        <div class="wel-actions">
          <button class="btn primary" data-cmd="reconnect">${ic('refresh')}Try again</button>
          ${c.auth === 'sso' || c.auth === 'oauth' || c.auth === 'basic' || c.auth === 'rfc' ? `<button class="btn" data-act="relogin" data-id="${esc(c.id)}">Log in again</button>` : ''}
          ${c.builtin ? '' : `<button class="btn" data-act="edit-conn" data-id="${esc(c.id)}">Edit system</button>`}
        </div>
        ${c.builtin ? '' : `<p class="wel-diag">Still stuck? <button class="link" data-act="diag-copy" data-id="${esc(c.id)}">Copy diagnostics</button> and paste them into an issue or a chat. Passwords and tickets are never included.</p>`}
        <div class="wel-alt">${demo ? `<button class="link" data-act="switch" data-id="${esc(demo.id)}">Open the DEMO system</button> · ` : ''}<button class="link" data-act="add-conn">Add another system</button></div></div>`;
      return;
    }
    const keys: [string, string][] = [
      ['Open ABAP object', 'Ctrl+Shift+A'], ['All commands', 'Ctrl+Shift+P'], ['Save · Activate', 'Ctrl+S · Ctrl+F3'], ['Check syntax', 'Ctrl+F2'],
      ['Pretty printer · Clean up', 'Shift+F1 · Ctrl+4'], ['Run · Data preview', 'F8'], ['Code completion', 'Ctrl+Space'],
      ['Definition · Element info · Docs', 'F3 · F2 · F1'], ['Where-used list', 'Ctrl+Shift+G'],
    ];
    $('#welcome').innerHTML = `<div class="wel">${LOGO}<h1>${esc(opts.brand || 'Nusa Studio')}</h1><p>Connected to <b>${esc(c.sid)}</b> · ${esc(sys.release)}</p>
      <div class="wel-actions"><button class="btn primary" data-act="palette-obj">${ic('search')}Open object</button><button class="btn" data-cmd="new">${ic('plus')}New object</button><button class="btn" data-cmd="new-package">${ic('pkgplus')}New package</button></div>
      <dl class="keys">${keys.map(([a, k]) => `<dt>${a}</dt><dd><kbd>${k}</kbd></dd>`).join('')}</dl>
      ${store.get('nusa-adt-eclipse-seen') ? '' : `<section class="eclipse-card">
        <h2>Coming from Eclipse ADT?</h2>
        <ul>${ECLIPSE_POINTS.slice(0, 4).map(([h, p]) => `<li><b>${esc(h)}</b><span>${esc(p)}</span></li>`).join('')}</ul>
        <div class="eclipse-actions"><button class="btn small" data-act="eclipse">See all differences</button><button class="btn small ghost" data-act="eclipse-hide">Got it</button></div>
      </section>`}</div>`;
  }

  /** "On this page" marks the section being read, like a docs site. */
  function tocFollow() {
    const pane = $('#pane');
    const toc = pane.querySelector('.of-toc');
    if (!toc) return;
    const cards = [...pane.querySelectorAll<HTMLElement>('.of-main > [id^="of-sec"]')];
    if (!cards.length) return;
    const line = pane.getBoundingClientRect().top + 120;
    let at = cards[0];
    for (const c of cards) if (c.getBoundingClientRect().top <= line) at = c;
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4) at = cards[cards.length - 1];
    toc.querySelectorAll<HTMLElement>('button').forEach(b => { const on = b.dataset.id === at.id; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  }

  function renderPane() {
    const t = cur();
    if (!t) return;
    const pane = $('#pane');
    // a different object starts at the top; re-rendering the same one keeps the position
    const paneKey = `${t.key}|${t.view}`;
    if (pane.dataset.key !== paneKey) { pane.dataset.key = paneKey; requestAnimationFrame(() => { pane.scrollTop = 0; }); }
    if (isForm(t)) {
      const d = docs.get(docKey(t, 'main'));
      if (!d) { pane.innerHTML = '<div class="form-loading"><p class="muted"><i class="spin"></i>Loading</p></div>'; return; }
      const ro = !!TYPE_INFO[t.ref.type].readOnly || !!t.ref.lockedBy;
      pane.innerHTML = renderXmlForm(d.getValue(), {
        type: t.ref.type, readOnly: ro, typeLabel: typeLabel(t.ref), glyph: glyph(t.ref.type).replace('class="glyph', 'class="glyph big'),
        status: isDirty(t) ? { text: 'Unsaved changes', tone: 'warn' } : t.ref.inactive ? { text: 'Inactive', tone: 'warn' } : { text: 'Active', tone: 'ok' },
        note: TYPE_INFO[t.ref.type].readOnly ? 'Nusa Studio shows this object type read-only. Change it in Eclipse ADT or SAP GUI.'
          : t.ref.lockedBy ? `${t.ref.lockedBy} is editing this object, so it is read-only for you.` : undefined,
      });
      type Ctl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const apply = (el: Ctl) => {
        const isBox = el instanceof HTMLInputElement && el.type === 'checkbox';
        if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) return;
        let v = isBox ? String((el as HTMLInputElement).checked) : el.value;
        if (isBox && el.dataset.invert) v = String(!(el as HTMLInputElement).checked);   // "Active" switch over an "inactive" flag
        if (isBox) { const lbl = el.parentElement?.querySelector('span'); if (lbl) lbl.textContent = el.dataset.invert ? ((el as HTMLInputElement).checked ? 'Active' : 'Inactive') : (el as HTMLInputElement).checked ? 'On' : 'Off'; }
        // numbers keep the zero-padded width the system uses ("000010")
        const w = +(el.dataset.pad || 0);
        if (w && /^\d+$/.test(v)) v = v.padStart(w, '0');
        let rerender = !!el.dataset.rr;
        try {
          let xml = setXmlValue(d.getValue(), el.dataset.xpath as string, v);
          if (el.dataset.at) { const r = layoutEffects(t.ref.type, xml, el.dataset.at, v); xml = r.xml; rerender = rerender || r.rerender; }
          d.setValue(xml);
        } catch (e) { fail(e); return; }
        // field label counters follow the text and the chosen length
        if (el.dataset.labelOf || el.parentElement?.classList.contains('of-counted')) {
          const cnt = el.parentElement?.querySelector('.of-counter');
          const max = +(el.getAttribute('maxlength') || 0);
          if (cnt) { cnt.textContent = `${el.value.length}${max ? ' / ' + max : ''}`; cnt.classList.toggle('over', !!max && el.value.length > max); }
        }
        if (el.dataset.lenFor) {
          const lab = pane.querySelector<HTMLInputElement>(`[data-label-of="${el.dataset.lenFor}"]`);
          if (lab && /^\d+$/.test(el.value) && +el.value > 0) { lab.maxLength = +el.value; lab.dispatchEvent(new Event('counter')); const cnt = lab.parentElement?.querySelector('.of-counter'); if (cnt) { cnt.textContent = `${lab.value.length} / ${el.value}`; cnt.classList.toggle('over', lab.value.length > +el.value); } }
        }
        if (rerender) { const y = pane.scrollTop; renderPane(); pane.scrollTop = y; return; }
        const badge = pane.querySelector('.of-badges .pill');
        if (badge) { badge.textContent = 'Unsaved changes'; badge.className = 'pill p-warn'; }
      };
      pane.onscroll = tocFollow;
      requestAnimationFrame(tocFollow);
      pane.querySelectorAll<Ctl>('input[data-xpath], textarea[data-xpath], select[data-xpath]').forEach(el => {
        const box = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
        if (box || el instanceof HTMLSelectElement) el.onchange = () => apply(el);
        else el.oninput = () => apply(el);
        if (el.dataset.vh) el.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); valueHelp(el as HTMLInputElement); } };
      });
      return;
    }
    if (t.view === 'diff') {
      const df = t.diff as DiffState;
      const ops = diffLines(df.left.split('\n'), df.right.split('\n'));
      const st = diffStats(ops);
      const groups = df.all ? [{ ops, aStart: 0, bStart: 0 }] : hunks(ops, 3);
      const row = (o: typeof ops[number]) => `<tr class="d-${o.t}"><td class="ln">${o.a !== undefined ? o.a + 1 : ''}</td><td class="ln">${o.b !== undefined ? o.b + 1 : ''}</td><td class="sg">${o.t === 'add' ? '+' : o.t === 'del' ? '−' : ''}</td><td class="tx">${esc(o.text) || ' '}</td></tr>`;
      let prevEnd = 0;
      const body = groups.map(g => {
        const first = ops.indexOf(g.ops[0]);
        const gap = first - prevEnd;
        prevEnd = first + g.ops.length;
        return (gap > 0 ? `<tr class="d-gap"><td colspan="4">⋯ ${gap} unchanged line${gap === 1 ? '' : 's'}</td></tr>` : '') + g.ops.map(row).join('');
      }).join('') + (!df.all && ops.length - prevEnd > 0 && groups.length ? `<tr class="d-gap"><td colspan="4">⋯ ${ops.length - prevEnd} unchanged line${ops.length - prevEnd === 1 ? '' : 's'}</td></tr>` : '');
      pane.innerHTML = `<div class="df">
        <header class="df-bar">
          <span class="df-side"><i class="d-del-dot"></i>${esc(df.leftLabel)}</span><span class="df-arrow">→</span><span class="df-side"><i class="d-add-dot"></i>${esc(df.rightLabel)}</span>
          <span class="df-stats">${st.added || st.removed ? `<b class="s-ok">+${st.added}</b> <b class="s-error">−${st.removed}</b>` : 'No differences'}</span>
          <span class="grow"></span>
          <label class="check small"><input type="checkbox" data-act="df-all" ${df.all ? 'checked' : ''}><span>Whole file</span></label>
          ${st.added || st.removed ? `<button class="btn small" data-act="df-restore">${ic('download')}Use ${esc(df.leftLabel.toLowerCase())}</button>` : ''}
          <button class="btn small ghost" data-act="df-edit">Back to editor</button>
        </header>
        ${st.added || st.removed ? `<div class="df-body"><table>${body}</table></div>` : `<div class="empty-panel">The editor matches the ${esc(df.leftLabel.toLowerCase())}.</div>`}
      </div>`;
      return;
    }
    if (t.view === 'data') {
      const d = t.data as DataState;
      const r = d.result;
      pane.innerHTML = `<div class="dp">
        <div class="dp-bar">
          <textarea id="dpSql" spellcheck="false" rows="3" aria-label="ABAP SQL">${esc(d.sql)}</textarea>
          <div class="dp-actions">
            <label class="dp-rows">Rows <select id="dpRows">${[100, 500, 1000, 5000].map(n => `<option ${d.rows === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
            <button class="btn primary" data-act="dp-run" ${d.running ? 'disabled' : ''}>${d.running ? '<i class="spin"></i>Running' : ic('play') + 'Run'}<kbd>Ctrl+Enter</kbd></button>
            <button class="btn" data-act="dp-copy" ${r ? '' : 'disabled'}>Copy rows</button>
          </div>
        </div>
        ${d.error ? `<div class="notice err">${ic('error')}${esc(d.error)}</div>` : ''}
        ${r ? `<div class="dp-meta">${r.rows.length} of ${r.totalRows} rows · ${r.ms} ms${r.rows.length < r.totalRows ? ' · raise the row limit to see more' : ''}</div>
        <div class="dp-grid"><table><thead><tr><th class="rn">#</th>${r.columns.map(c => `<th title="${esc(c.desc || c.name)}${c.type ? ' · ' + esc(c.type) : ''}" class="${c.key ? 'key' : ''}">${esc(c.name)}${c.desc ? `<small>${esc(c.desc)}</small>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${r.rows.map((row, i) => `<tr><td class="rn">${i + 1}</td>${row.map(v => `<td class="${/^-?\d+(\.\d+)?$/.test(v) ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${r.columns.length + 1}" class="empty">No rows</td></tr>`}</tbody></table></div>`
        : d.running ? '' : '<div class="empty-panel">Press Run or Ctrl+Enter to read the data.</div>'}
      </div>`;
      const ta = $<HTMLTextAreaElement>('#dpSql');
      ta.oninput = () => { d.sql = ta.value; };
      ta.onkeydown = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runPreview(); } };
      $<HTMLSelectElement>('#dpRows').onchange = (e) => { d.rows = +(e.target as HTMLSelectElement).value; };
      return;
    }
    // service binding
    const b = t.binding;
    if (!b) { pane.innerHTML = '<div class="of"><p class="of-none"><i class="spin"></i>Reading the service binding</p></div>'; return; }
    if ('error' in b) { pane.innerHTML = `<div class="of"><div class="of-banner err">${esc(b.error)}<button class="btn small" data-act="sb-reload">Try again</button></div></div>`; return; }
    const svc = b.services[0];
    const sd = svc ? allObjs().find(o => o.type === 'SRVD' && o.name === svc.serviceDefinition) : undefined;
    const ro = (label: string, value: string, mono = true) => `<div class="of-field ro"><span class="of-label">${label}</span><div class="of-value ${mono ? 'mono' : ''}">${value || '<span class="of-empty">Not set</span>'}</div></div>`;
    pane.innerHTML = `<div class="of">
      <header class="of-head">
        <div class="of-id">${glyph('SRVB').replace('class="glyph', 'class="glyph big')}<div class="of-titles"><div class="of-kicker">Service Binding</div><h1>${esc(b.name)}</h1></div>
          <div class="of-badges"><span class="pill ${b.published ? 'p-ok' : 'p-warn'}">${b.published ? 'Published' : 'Not published'}</span></div></div>
        <p class="of-lead">${esc(b.desc || t.ref.desc)}</p>
        <div class="of-actions">
          ${b.published ? `<button class="btn" data-act="sb-publish" data-id="0">Unpublish</button>` : `<button class="btn primary" data-act="sb-publish" data-id="1">${ic('upload')}Publish</button>`}
          <button class="btn ghost" data-act="sb-reload">${ic('refresh')}Refresh</button>
        </div>
      </header>
      <div class="of-body"><div class="of-main">
        <section class="of-card"><header><h2>Service</h2></header><div class="of-grid">
          ${ro('Binding type', esc(b.bindingType === 'ODATA' ? `OData ${b.odataVersion}` : b.bindingType), false)}
          ${ro('Category', esc(b.category || ''), false)}
          ${ro('Service definition', svc ? (sd ? `<button class="link mono" data-act="open" data-uri="${esc(sd.uri)}">${esc(svc.serviceDefinition)}</button>` : esc(svc.serviceDefinition)) : '')}
          ${ro('Version', esc(svc?.version || '0001'))}
          ${ro('Package', esc(t.ref.pkg))}
        </div></section>
        <section class="of-card"><header><h2>Local service endpoint</h2></header>
          ${b.serviceUrl ? `<div class="of-url"><code>${esc(b.serviceUrl)}</code><button class="btn small" data-act="sb-copy">Copy</button></div>`
            : `<p class="of-none">${b.published ? 'Published. Refresh to see the URL.' : 'Publish the binding to create the service URL.'}</p>`}
          <p class="of-hint">Publishing makes the OData service available on ${esc(conn().sid)}. The Fiori elements preview opens from the SAP system; Nusa Studio does not include one yet.</p>
        </section>
      </div></div>
    </div>`;
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

  // ------------------------------------------------------------------ session (open editors per system)
  const saveSession = debounce(() => {
    const list = tabsHere().filter(t => t.view !== 'diff').map(t => ({ preview: t.preview || undefined, uri: t.ref.uri, name: t.ref.name, type: t.ref.type, pkg: t.ref.pkg, desc: t.ref.desc, include: t.include, view: t.view, entity: t.data?.entity, sql: t.data?.sql }));
    const act = cur();
    store.set('nusa-adt-session-' + S.conn, JSON.stringify({ tabs: list, active: act && act.view !== 'diff' ? act.key : null }));
  }, 400);
  async function restoreSession(): Promise<boolean> {
    if (!settings.restoreTabs || tabsHere().length) return false;
    let saved: { tabs: { preview?: boolean; uri: string; name: string; type: ObjType; pkg: string; desc: string; include: Include; view: TabView; entity?: string; sql?: string }[]; active: string | null } | null = null;
    try { saved = JSON.parse(store.get('nusa-adt-session-' + S.conn) || 'null'); } catch { saved = null; }
    if (!saved || !saved.tabs.length) return false;
    for (const s of saved.tabs) {
      try {
        if (s.view === 'data') openPreview(s.entity, s.sql, false);
        else {
          const st = await backend.state(S.conn, { uri: s.uri, name: s.name, type: s.type, pkg: s.pkg, desc: s.desc });
          addTab(st, s.include, !!s.preview);
        }
      } catch { /* the object may be gone */ }
    }
    const act = tabsHere().find(t => t.key === saved!.active) || tabsHere()[tabsHere().length - 1];
    if (act) await showTab(act); else renderAll();
    return tabsHere().length > 0;
  }

  // ------------------------------------------------------------------ editor binding
  let swapping = false;
  // ------------------------------------------------------------------ local history and drafts
  // Every save keeps a snapshot (like Eclipse's local history, but one click away), and unsaved
  // changes are written to a draft so a crash or a closed laptop never loses work.
  const histKey = (t: Tab, inc: Include) => `nusa-adt-hist|${t.conn}|${t.ref.uri}|${inc}`;
  const draftKey = (t: Tab, inc: Include) => `nusa-adt-draft|${t.conn}|${t.ref.uri}|${inc}`;
  const history = (t: Tab, inc: Include): Snapshot[] => { try { return JSON.parse(store.get(histKey(t, inc)) || '[]'); } catch { return []; } };
  const remember = (t: Tab, inc: Include, text: string, note: string) => {
    const list = addSnapshot(history(t, inc), { at: Date.now(), text, note });
    store.set(histKey(t, inc), JSON.stringify(list));
  };
  const dropDraft = (t: Tab, inc: Include) => { try { localStorage.removeItem(draftKey(t, inc)); } catch { /* ignore */ } };
  const base = new Map<string, string>();       // server text each doc was loaded from
  const writeDrafts = debounce(() => {
    if (!settings.keepDrafts) return;
    for (const t of S.tabs) {
      if (t.view !== 'source') continue;
      for (const inc of backend.includesOf(t.ref.type)) {
        const d = docs.get(docKey(t, inc));
        if (!d) continue;
        if (d.isClean()) dropDraft(t, inc);
        else store.set(draftKey(t, inc), JSON.stringify({ at: Date.now(), base: base.get(docKey(t, inc)) ?? '', text: d.getValue() }));
      }
    }
  }, 800);
  const ago = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ms).toLocaleString();
  };

  async function ensureDoc(t: Tab, inc: Include): Promise<CM> {
    const k = docKey(t, inc);
    let d = docs.get(k);
    if (!d) {
      const text = await backend.read(t.conn, t.ref, inc, 'inactive');
      if (docs.get(k)) return docs.get(k);
      d = newDoc(text, isTextInclude(inc) ? 'text' : isCdsLike(t.ref.type) ? 'cds' : isSourceType(t.ref.type) ? 'abap' : 'text');
      docs.set(k, d);
      base.set(k, text);
      let draft: { at: number; base: string; text: string } | null = null;
      try { draft = JSON.parse(store.get(draftKey(t, inc)) || 'null'); } catch { draft = null; }
      if (draft && settings.keepDrafts && draft.text !== text) {
        if (draft.base === text) {
          d.setValue(draft.text);                     // Ctrl+Z goes back to the system version
          const doc = d;
          toast(`Restored your unsaved changes to ${t.ref.name} from ${ago(draft.at)}.`, 'info', 9000,
            { label: 'Show changes', run: () => openDiff(t, inc, text, 'System version', doc.getValue(), 'Editor') });
        } else {
          remember(t, inc, draft.text, 'Unsaved draft');
          dropDraft(t, inc);
          toast(`${t.ref.name} changed on the system since your unsaved draft from ${ago(draft.at)}. The draft is kept in Local History.`, 'warn', 10000,
            { label: 'Compare', run: () => compareHistory(t) });
        }
      } else if (draft) dropDraft(t, inc);
    }
    return d;
  }

  // ------------------------------------------------------------------ compare
  function openDiff(src: Tab, inc: Include, left: string, leftLabel: string, right: string, rightLabel: string) {
    const key = `${src.key}|diff`;
    let t = S.tabs.find(x => x.key === key);
    if (!t) { t = { key, conn: src.conn, ref: src.ref, include: inc, view: 'diff' }; S.tabs.push(t); }
    t.diff = { left, right, leftLabel, rightLabel, srcKey: src.key, inc };
    t.ref = src.ref;
    showTab(t);
  }

  async function compareActive(t = curSrc()) {
    if (!t) { toast('Open a source first'); return; }
    const inc = t.include;
    await busy('Reading the active version', async () => {
      const active = await backend.read(t.conn, t.ref, inc, 'active');
      const d = await ensureDoc(t, inc);
      openDiff(t, inc, active, 'Active version', d.getValue(), 'Editor');
    });
  }

  async function compareHistory(t = curSrc()) {
    if (!t) { toast('Open a source first'); return; }
    const inc = t.include;
    const list = history(t, inc);
    if (!list.length) { toast(`No local history for ${t.ref.name} yet. Every save adds a version.`); return; }
    const pick = await modal<string>(`Local history · ${t.ref.name}`, `<p class="note">Versions saved from this computer, newest first. Choose one to compare with the editor.</p>
      <ul class="pick hist">${list.map((h, i) => { const n = h.text.split('\n').length; return `<li><button type="button" data-hist="${i}"><b>${esc(new Date(h.at).toLocaleString())}</b><span>${esc(h.note)} · ${n} lines · ${esc(ago(h.at))}</span></button></li>`; }).join('')}</ul>`,
      [{ label: 'Cancel', value: null }], (root, close) => {
        root.querySelectorAll<HTMLButtonElement>('[data-hist]').forEach(b => { b.onclick = () => close(b.dataset.hist); });
      });
    if (pick === null || pick === undefined) return;
    const h = list[+pick];
    const d = await ensureDoc(t, inc);
    openDiff(t, inc, h.text, `Local ${new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, d.getValue(), 'Editor');
  }

  async function restoreLeft(t: Tab) {
    const df = t.diff; if (!df) return;
    const src = S.tabs.find(x => x.key === df.srcKey);
    if (!src) { toast('The editor of this object is closed. Open it first.', 'warn'); return; }
    const d = await ensureDoc(src, df.inc);
    if (d.getValue() === df.left) { toast('The editor already has this version'); return; }
    d.setValue(df.left);
    writeDrafts();
    await closeTab(t.key, false);
    await showTab(src, df.inc);
    toast(`Replaced the editor content with the ${df.leftLabel.toLowerCase()}. Save to keep it, or Ctrl+Z to undo.`, 'ok', 6000);
  }

  function addTab(ref: ObjState, inc: Include = 'main', preview = false): Tab {
    const key = `${S.conn}|${ref.uri}`;
    let t = S.tabs.find(x => x.key === key);
    if (t) { if (!preview) t.preview = false; return t; }
    t = { key, conn: S.conn, ref, include: inc, view: TYPE_INFO[ref.type].editor === 'form' ? 'binding' : 'source', preview: preview && settings.previewTabs };
    // a single click replaces the current preview tab, unless it was changed
    const old = t.preview ? tabsHere().find(x => x.preview && !isDirty(x)) : undefined;
    if (old) {
      const at = S.tabs.indexOf(old);
      dropTab(old);
      S.tabs.splice(at, 0, t);
    } else S.tabs.push(t);
    return t;
  }
  /** Removes a tab without asking (it has no unsaved changes) and releases its lock. */
  function dropTab(t: Tab) {
    if (t.lock && t.lock !== 'pending') backend.unlock(t.conn, t.ref, t.lock).catch(() => undefined);
    if (t.view === 'source') for (const inc of backend.includesOf(t.ref.type)) docs.delete(docKey(t, inc));
    S.tabs = S.tabs.filter(x => x !== t);
  }
  const pin = (t: Tab | undefined) => { if (t && t.preview) { t.preview = false; renderTabs(); } };

  async function showTab(t: Tab, inc: Include = t.include, line?: number) {
    hidePop();
    S.activeByConn[S.conn] = t.key;
    if (t.view !== 'source') {
      swapping = true; if (cm.getDoc() !== placeholderDoc) cm.swapDoc(placeholderDoc); swapping = false;
      if (t.view === 'binding' && !t.binding) loadBinding(t);
      renderAll();
      return;
    }
    t.include = inc;
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
    setTimeout(() => { cm.refresh(); if (canFocusEditor()) cm.focus(); }, 0);
  }

  async function openObj(ref: ObjRef | ObjState, inc: Include = 'main', line?: number, preview = false) {
    try {
      const st = 'inactive' in ref ? ref as ObjState : await backend.state(S.conn, ref);
      await showTab(addTab(st, inc, preview), inc, line);
    } catch (e) { fail(e, `Opening ${ref.name}`); }
  }

  async function gotoLoc(l: Location) {
    let o: ObjRef | undefined = objByUri(l.uri);
    if (!o) {
      try { o = (await backend.search(S.conn, decodeURIComponent(l.uri.split('/').pop() || ''))).find(x => x.uri === l.uri); } catch { o = undefined; }
    }
    if (!o) { toast('Object is not available in this system', 'warn'); return; }
    await openObj(o, l.include, l.line);
  }

  async function closeTab(key: string, ask = true): Promise<boolean> {
    const t = S.tabs.find(x => x.key === key);
    if (!t) return true;
    if (ask && isDirty(t)) {
      const r = await modal<string>(`Save changes to ${t.ref.name}?`, '<p>Your changes are lost if you close without saving.</p>',
        [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', kind: 'primary' }]);
      if (!r || r === 'cancel') return false;
      if (r === 'save' && !(await save(t))) return false;
      if (r === 'discard') for (const inc of backend.includesOf(t.ref.type)) dropDraft(t, inc);
    }
    if (t.lock && t.lock !== 'pending') { try { await backend.unlock(t.conn, t.ref, t.lock); } catch { /* lock expires on the server */ } }
    if (t.view === 'source') for (const inc of backend.includesOf(t.ref.type)) docs.delete(docKey(t, inc));
    const list = tabsHere();
    const idx = list.findIndex(x => x.key === key);
    S.tabs = S.tabs.filter(x => x.key !== key);
    if (S.activeByConn[S.conn] === key) {
      const next = tabsHere()[Math.max(0, idx - 1)];
      S.activeByConn[S.conn] = next ? next.key : null;
      if (next) { await showTab(next); return true; }
      swapping = true; cm.swapDoc(placeholderDoc); swapping = false;
    }
    renderAll();
    return true;
  }
  async function closeTabs(keys: string[]) { for (const k of keys) if (!(await closeTab(k))) return; }

  const renderDirty = debounce(() => { renderTabs(); renderSubtabs(); if (S.view === 'outline') renderOutline(); }, 150);
  cm.on('changes', async () => {
    if (swapping) return;
    const t = curSrc();
    if (!t) return;
    if (t.preview) { t.preview = false; }
    renderDirty();
    writeDrafts();
    if (!t.lock && !(S.debug && !S.debug.done)) {
      t.lock = 'pending';
      try { t.lock = await backend.lock(t.conn, t.ref); renderTabs(); renderStatus(); }
      catch (e) { t.lock = undefined; fail(e, `Locking ${t.ref.name}`); }
    }
  });
  cm.on('cursorActivity', debounce(() => { renderStatus(); hidePop(); }, 60));
  cm.on('gutterClick', (_cm: CM, line: number, gutter: string) => { if (gutter === 'bp-gutter') toggleBp(line); });
  const ABAP_SLOT = /\b(TYPE|REF\s+TO|TABLE\s+OF|LIKE|FROM|JOIN|NEW|CAST|VALUE|CONV|CORRESPONDING|CATCH|RAISING|INTERFACES|INHERITING\s+FROM|INTO|ASSIGNING|METHOD|LOOP\s+AT|READ\s+TABLE|CALL\s+FUNCTION|EXPORTING|IMPORTING|CHANGING|WHERE|AND|OR|IF|ELSEIF|FIELDS|ORDER\s+BY|GROUP\s+BY|ON|TO|SORT\s+\S+\s+BY|EXCEPTION\s+(TYPE|NEW))\s$/i;
  const CDS_SLOT = /\b(from|join|on|to|of|as|define|parent|expose|projection\s+on|for)\s$/i;
  cm.on('inputRead', (_cm: CM, ch: { text: string[] }) => {
    const t = curSrc();
    if (!t || !isSourceType(t.ref.type) || !settings.autoComplete || cm.state.completionActive) return;
    const typed = ch.text.join('');
    if (typed.length > 2) return;                       // paste
    const c = cm.getCursor();
    const type = cm.getTokenTypeAt(c) || '';
    const before: string = cm.getLine(c.line).slice(0, c.ch);
    const cds = isCdsLike(t.ref.type);
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
    const t = curSrc();
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
    const t = curSrc();
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
    try { return await fn(); } catch (e) { fail(e, label); return undefined; } finally { S.busy = ''; renderPanel(); }
  }

  async function chooseTransport(ref: { name: string; pkg: string; uri: string }, need: TransportNeed, what = 'must be recorded in a transport request'): Promise<string | null> {
    const reqs = need.requests;
    const body = `<p><b>${esc(ref.name)}</b>${ref.pkg ? ` in package <b>${esc(ref.pkg)}</b>` : ''} ${esc(what)}.</p>
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
          const id = await backend.createTransport(S.conn, desc, { ...ref, type: 'CLAS', desc: '' });
          S.transports = await backend.transports(S.conn);
          close(id);
        } catch (e) { fail(e, 'Creating the request'); }
      };
    });
  }
  /** Transport for something new in `pkg`; undefined = not needed, null = cancelled. */
  async function transportForNew(name: string, pkg: string, uri: string): Promise<string | undefined | null> {
    const c = conn();
    if (!c.transports || pkg.startsWith('$') || !pkg) return undefined;
    const requests = (await backend.transports(S.conn)).filter(t => t.status === 'modifiable');
    return chooseTransport({ name, pkg, uri }, { needed: true, requests });
  }

  async function save(t = curSrc()): Promise<boolean> {
    if (!t || t.view !== 'source') return false;
    pin(t);
    if (S.debug && !S.debug.done) { toast('Stop the debugger before saving', 'warn'); return false; }
    const incs = backend.includesOf(t.ref.type).filter(inc => incDirty(t, inc));
    if (!incs.length) { toast(`${t.ref.name} has no unsaved changes`); return true; }
    if ((TYPE_INFO[t.ref.type].editor === 'abap' || (TYPE_INFO[t.ref.type].editor === 'cds' && settings.formatOnSave)) && (settings.cleanOnSave || settings.formatOnSave)) {
      for (const inc of incs.filter(i => !isTextInclude(i))) {
        const d = docs.get(docKey(t, inc));
        let text: string = d.getValue();
        if (settings.cleanOnSave && ext('cleaner') && TYPE_INFO[t.ref.type].editor === 'abap') text = cleanAbap(text, settings.cleanerRules).text;
        if (settings.formatOnSave) text = await formatText(t, text).catch(() => text);
        if (text !== d.getValue()) {
          if (d === cm.getDoc()) replaceAll(text);
          else d.setValue(text);
        }
      }
    }
    const r = await busy(`Saving ${t.ref.name}`, async () => {
      if (!t.lock || t.lock === 'pending') t.lock = await backend.lock(t.conn, t.ref);
      const need = await backend.transportNeed(t.conn, t.ref);
      let tr = need.current;
      if (need.needed) { tr = (await chooseTransport(t.ref, need)) ?? undefined; if (!tr) return false; }
      for (const inc of incs) {
        const d = docs.get(docKey(t, inc));
        const text = d.getValue();
        await backend.write(t.conn, t.ref, inc, text, t.lock as string, tr);
        d.markClean();
        base.set(docKey(t, inc), text);
        remember(t, inc, text, tr ? `Saved · ${tr}` : 'Saved');
        dropDraft(t, inc);
      }
      // Like Eclipse, give the lock back after saving: activation runs in its own session and
      // fails with "is currently editing" while this editor still holds the enqueue lock.
      // The next change locks the object again.
      const held = t.lock;
      t.lock = undefined;
      if (held && held !== 'pending') await backend.unlock(t.conn, t.ref, held).catch(() => undefined);
      t.ref = await backend.state(t.conn, t.ref);
      await updateObjInCache(t.ref);
      const d = docs.get(docKey(t, t.include));
      if (d) setProblems(t.ref.uri, await backend.syntaxCheck(t.conn, t.ref, t.include, d.getValue()).catch(() => []), t.include);
      if (conn().transports) S.transports = await backend.transports(S.conn).catch(() => S.transports);
      const trUsed = tr || t.ref.transport;
      toast(`Saved ${t.ref.name}${trUsed ? ` in ${trUsed}` : ''}. It is inactive until you activate it.`, 'ok');
      return true;
    });
    renderAll();
    return !!r;
  }

  async function activate(t = cur()) {
    if (!t || t.view === 'data') return;
    if (isDirty(t) && !(await save(t))) return;
    // a lock left from an edit that was undone would block the activation
    if (!isDirty(t) && t.lock && t.lock !== 'pending') { const l = t.lock; t.lock = undefined; await backend.unlock(t.conn, t.ref, l).catch(() => undefined); }
    const st = await backend.state(t.conn, t.ref).catch(() => t.ref);
    if (!st.inactive) { toast(`${t.ref.name} is already active`); return; }
    await busy(`Activating ${t.ref.name}`, async () => {
      const r = await backend.activate(t.conn, [t.ref]);
      setProblems(t.ref.uri, r.problems);
      t.ref = await backend.state(t.conn, t.ref);
      await updateObjInCache(t.ref);
      const errs = r.problems.filter(p => p.sev === 'error').length;
      if (!r.ok) { openPanel('problems'); toast(`Activation of ${t.ref.name} failed with ${errs} error${errs === 1 ? '' : 's'}`, 'error'); }
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
      for (const t of tabsHere()) if (t.view !== 'data') t.ref = await backend.state(t.conn, t.ref).catch(() => t.ref);
      if (r.ok) toast(`Activated ${objs.length} objects`, 'ok');
      else { openPanel('problems'); toast('Activation failed. See Problems.', 'error'); }
    });
    renderAll();
  }

  async function check() {
    const t = curSrc(); if (!t) return;
    if (!isSourceType(t.ref.type)) { toast(`${typeLabel(t.ref)}s are checked by the system when you activate them`); return; }
    await busy('Checking syntax', async () => {
      const list = await backend.syntaxCheck(t.conn, t.ref, t.include, cm.getValue());
      setProblems(t.ref.uri, list, t.include);
      openPanel('problems');
      const n = list.filter(p => p.sev === 'error').length;
      toast(n ? `${n} syntax error${n === 1 ? '' : 's'} in ${t.ref.name}` : `${t.ref.name}: no syntax errors`, n ? 'error' : 'ok');
    });
    renderAll();
  }

  function replaceAll(text: string) {
    const pos = cm.getCursor(); const scroll = cm.getScrollInfo();
    cm.operation(() => { cm.replaceRange(text, { line: 0, ch: 0 }, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length }); });
    cm.setCursor(pos); cm.scrollTo(scroll.left, scroll.top);
  }

  /** Formats a source the way the settings say: Nusa formatter (offline) or the system's pretty printer. */
  async function formatText(t: Tab, src: string): Promise<string> {
    const ed = TYPE_INFO[t.ref.type].editor;
    if (ed === 'cds') return formatCds(src);
    if (ed !== 'abap') return src;
    if (settings.formatter === 'sap' && !conn().builtin && conn().kind !== 'runner') return backend.prettyPrint(t.conn, src);
    return formatAbap(src, { keywordCase: settings.keywordCase });
  }
  async function format() {
    const t = curSrc(); if (!t) return;
    const ed = TYPE_INFO[t.ref.type].editor;
    if ((ed !== 'abap' && ed !== 'cds') || isTextInclude(t.include)) { toast('Nothing to format in this editor'); return; }
    await busy('Formatting', async () => {
      const src = cm.getValue();
      const out = await formatText(t, src);
      if (out !== src) { replaceAll(out); toast(settings.formatter === 'sap' && ed === 'abap' ? 'Formatted with the pretty printer of the system' : 'Formatted. Ctrl+Z undoes it.', 'ok', 2000); }
      else toast('Already formatted', 'info', 2000);
    });
  }

  function cleanUp() {
    const t = curSrc(); if (!t) return;
    if (!ext('cleaner')) { toast('Enable the ABAP Cleaner extension first', 'warn'); return; }
    if (TYPE_INFO[t.ref.type].editor !== 'abap' || isTextInclude(t.include)) { toast('ABAP Cleaner works on ABAP source', 'warn'); return; }
    const r = cleanAbap(cm.getValue(), settings.cleanerRules);
    if (!r.changes.length) { toast('Nothing to clean up', 'ok', 2000); return; }
    replaceAll(r.text);
    const total = r.changes.reduce((a, c) => a + c.count, 0);
    const names = r.changes.map(c => RULES.find(x => x.id === c.rule)?.short || c.rule).slice(0, 3).join(', ');
    toast(`Cleaned up ${total} place${total === 1 ? '' : 's'}: ${names}${r.changes.length > 3 ? ' and more' : ''}. Ctrl+Z undoes it.`, 'ok', 5000);
  }

  async function run() {
    const t = cur(); if (!t) return;
    if (S.debug && !S.debug.done) return step('continue');
    if (t.view === 'data') return runPreview();
    if (t.view === 'source' && (t.ref.type === 'TABL' || t.ref.type === 'DDLS') && ext('preview')) { openPreview(t.ref.name); return; }
    const why = runBlocker(t);
    if (why) { toast(why, 'warn', 6000); return; }
    if ((t.ref.type === 'PROG' || t.ref.type === 'CLAS' || t.ref.type === 'FUNC') && allBreakpoints().length && await startDebug(t)) return;
    if ((t.ref.type === 'PROG' && !conn().runReports) || t.ref.type === 'FUNC') { await runInGui(t); return; }
    await busy(`Running ${t.ref.name}`, async () => {
      const r = await backend.run(t.conn, t.ref);
      S.output = { ...r, title: t.ref.name, at: new Date().toLocaleTimeString() };
      openPanel('output');
    });
    renderAll();
  }

  async function unit() {
    const t = curSrc(); if (!t) return;
    if (t.ref.type !== 'CLAS') { toast('ABAP Unit runs on classes here. Open a class first.', 'warn'); return; }
    await busy('Running ABAP Unit', async () => {
      const r = await backend.runUnit(t.conn, t.ref);
      S.unit = { ...r, name: t.ref.name, at: new Date().toLocaleTimeString() };
      openPanel('unit');
      const bad = r.methods.filter(m => m.status !== 'ok').length;
      toast(bad ? `${bad} of ${r.methods.length} tests failed` : `All ${r.methods.length} tests passed`, bad ? 'error' : 'ok');
    });
    renderAll();
  }

  async function atc(ref?: ObjRef) {
    const t = cur();
    const target = ref || (t && t.view !== 'data' ? t.ref : undefined);
    if (!target) return;
    await busy(`Running ATC on ${target.name}`, async () => {
      const f = await backend.runAtc(S.conn, target);
      S.atc = { name: target.name, findings: f, at: new Date().toLocaleTimeString() };
      openPanel('atc');
      toast(`ATC: ${f.length} finding${f.length === 1 ? '' : 's'}`, f.some(x => x.prio === 1) ? 'error' : f.length ? 'warn' : 'ok');
    });
    renderAll();
  }

  function complete() {
    const t = curSrc(); if (!t || !isSourceType(t.ref.type)) return;
    startCompletion(cm, async () => {
      const c = cm.getCursor();
      return backend.complete(t.conn, t.ref, t.include, cm.getValue(), c.line, c.ch);
    });
  }

  async function navigate() {
    const t = curSrc(); if (!t || !isSourceType(t.ref.type)) return;
    const c = cm.getCursor();
    const loc = await backend.navigate(t.conn, t.ref, t.include, cm.getValue(), c.line, c.ch).catch(e => { fail(e, 'Navigation'); return null; });
    if (!loc) { toast(`No definition found for "${wordAt(cm)}"`, 'warn'); return; }
    await gotoLoc(loc);
  }

  async function whereUsed() {
    const t = curSrc(); if (!t || !isSourceType(t.ref.type)) return;
    const c = cm.getCursor();
    const term = wordAt(cm);
    if (!term) { toast('Place the cursor on a name first', 'warn'); return; }
    await busy('Searching references', async () => {
      const hits = await backend.whereUsed(t.conn, t.ref, t.include, cm.getValue(), c.line, c.ch);
      S.where = { term, hits }; openPanel('where');
    });
    renderPanel();
  }

  function keywordDocs() {
    const t = curSrc(); if (!t) { openPalette('cmd'); return; }
    if (!ext('docs')) { toast('Enable the ABAP Keyword Documentation extension first', 'warn'); return; }
    const c = cm.getCursor();
    const d = keywordDocUrl(cm.getValue(), c.line, c.ch, { cloud: conn().abapVersion === 'cloud', cds: isCdsLike(t.ref.type) });
    openUrl(d.url);
    toast(`Opening the documentation for ${d.topic}`, 'info', 2000);
  }

  async function elementInfo() {
    const t = curSrc(); if (!t || !isSourceType(t.ref.type)) return;
    if (!ext('docs')) { toast('Enable the ABAP Keyword Documentation extension first', 'warn'); return; }
    const c = cm.getCursor();
    const line: string = cm.getLine(c.line);
    let b = c.ch;
    while (b < line.length && /[\w/~]/.test(line[b])) b++;
    const word = wordAt(cm);
    if (!word) { toast('Place the cursor on a name first', 'warn'); return; }
    const list = await backend.complete(t.conn, t.ref, t.include, cm.getValue(), c.line, b).catch(() => [] as Proposal[]);
    const p = list.find(x => x.label.toLowerCase().replace(/^##/, '') === word.toLowerCase().replace(/^##/, ''));
    const pop = $('#infoPop');
    if (!p) { toast(`No element information for "${word}"`, 'info', 2500); return; }
    pop.innerHTML = `<div class="ip-head"><span class="ip-kind">${esc(p.kind)}</span><b>${esc(p.label)}</b></div>${p.detail ? `<div class="ip-detail">${esc(p.detail)}</div>` : ''}${p.doc ? `<pre class="ip-doc">${esc(p.doc)}</pre>` : ''}`;
    pop.hidden = false;
    const at = typeof cm.cursorCoords === 'function' ? cm.cursorCoords(true, 'window') : { left: 200, bottom: 200 };
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(at.left, window.innerWidth - r.width - 8)) + 'px';
    pop.style.top = Math.min(at.bottom + 6, window.innerHeight - r.height - 8) + 'px';
  }

  function toggleBp(line = cm.getCursor().line) {
    const t = curSrc(); if (!t) return;
    if (TYPE_INFO[t.ref.type].editor !== 'abap' || t.ref.type === 'INTF' || isTextInclude(t.include)) { toast('Breakpoints need executable ABAP code', 'warn'); return; }
    const info = cm.lineInfo(line);
    cm.setGutterMarker(line, 'bp-gutter', info.gutterMarkers && info.gutterMarkers['bp-gutter'] ? null : bpMarker());
    if (S.view === 'debug') renderSide();
  }

  function toggleComment() {
    const t = curSrc(); if (!t) return;
    const pfx = isCdsLike(t.ref.type) ? '//' : '*';
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

  // ------------------------------------------------------------------ quick fixes and refactorings
  /** Applies text changes to the editors, opening objects that are not open yet. Returns the count. */
  async function applyTextEdits(edits: TextEdit[]): Promise<number> {
    const groups = new Map<string, TextEdit[]>();
    for (const e of edits) groups.set(`${e.uri}|${e.include}`, [...(groups.get(`${e.uri}|${e.include}`) || []), e]);
    let n = 0;
    for (const list of groups.values()) {
      const e0 = list[0];
      let tab = S.tabs.find(x => x.key === `${S.conn}|${e0.uri}` && x.view === 'source');
      if (!tab) {
        const st = await backend.state(S.conn, objByUri(e0.uri) || { uri: e0.uri, name: e0.name, type: e0.type, pkg: '', desc: '' }).catch(() => null);
        if (!st) { toast(`${e0.name} could not be opened; its change was skipped`, 'warn'); continue; }
        tab = addTab(st, e0.include);
      }
      const d = await ensureDoc(tab, e0.include);
      const go = () => { for (const e of sortForApply(list)) d.replaceRange(e.newText, e.from, e.to); };
      if (d === cm.getDoc()) cm.operation(go); else go();
      tab.preview = false;
      n += list.length;
    }
    renderAll();
    return n;
  }

  async function quickFix() {
    const t = curSrc(); if (!t) return;
    if (!isSourceType(t.ref.type)) { toast('Quick fixes work on source code', 'warn'); return; }
    const c = cm.getCursor();
    const src: string = cm.getValue();
    const fixes = await busy('Looking for quick fixes', () => backend.quickFixes(t.conn, t.ref, t.include, src, c.line, c.ch));
    if (!fixes) return;
    if (!fixes.length) { toast('No quick fix here. Press Ctrl+1 on a line with an error or on a name.', 'info', 3500); return; }
    const at = typeof cm.cursorCoords === 'function' ? cm.cursorCoords(true, 'window') : { left: 240, bottom: 240 };
    showMenu(at.left, at.bottom + 4, fixes.map(f => ({ label: f.title, run: () => applyFix(t, f, src, c) })));
  }
  async function applyFix(t: Tab, f: QuickFix, src: string, c: { line: number; ch: number }) {
    const edits = await busy(f.title, () => backend.applyQuickFix(t.conn, t.ref, t.include, src, c.line, c.ch, f));
    if (!edits) return;
    if (curSrc() === t && cm.getValue() !== src) { toast('The source changed meanwhile. Press Ctrl+1 again.', 'warn'); return; }
    if (!edits.length) { toast('The quick fix changes nothing here', 'info'); return; }
    await applyTextEdits(edits);
    if (curSrc() !== t) await showTab(t, t.include);
    toast(`${f.title}. Ctrl+Z undoes it.`, 'ok', 3000);
  }

  /** Before/after lines of every change, grouped by object, then run it once confirmed. */
  async function confirmRefactoring(p: RefactorPreview): Promise<boolean> {
    const groups = new Map<string, TextEdit[]>();
    for (const e of p.edits) groups.set(`${e.uri}|${e.include}`, [...(groups.get(`${e.uri}|${e.include}`) || []), e]);
    const parts: string[] = [];
    let shown = 0;
    for (const list of groups.values()) {
      const e0 = list[0];
      const tab = S.tabs.find(x => x.key === `${S.conn}|${e0.uri}`);
      const open = tab ? docs.get(docKey(tab, e0.include)) : undefined;
      const text: string = open ? open.getValue() : await backend.read(S.conn, { uri: e0.uri, name: e0.name, type: e0.type, pkg: '', desc: '' }, e0.include, 'inactive').catch(() => '');
      // changes on the same line show as one line before and after
      const byLine = new Map<number, TextEdit[]>();
      for (const e of [...list].sort((a, b) => a.from.line - b.from.line || a.from.ch - b.from.ch)) {
        const k = e.from.line === e.to.line ? e.from.line : -1 - byLine.size;
        byLine.set(k, [...(byLine.get(k) || []), e]);
      }
      const rows = [...byLine.values()].slice(0, Math.max(0, 300 - shown)).map(es => {
        shown += es.length;
        const e = es[0];
        const l = !text ? { line: e.from.line, before: es.map(x => x.oldText), after: es.map(x => x.newText) }
          : es.length === 1 ? editLines(text, e)
            : { line: e.from.line, before: [text.split('\n')[e.from.line] ?? ''], after: [applyEdits(text.split('\n')[e.from.line] ?? '', es.map(x => ({ ...x, from: { line: 0, ch: x.from.ch }, to: { line: 0, ch: x.to.ch } })))] };
        return `<div class="rf-edit"><span class="rf-ln">${l.line + 1}</span><div><pre class="rf-del">${esc(l.before.join('\n'))}</pre><pre class="rf-add">${esc(l.after.join('\n'))}</pre></div></div>`;
      }).join('');
      parts.push(`<section class="rf-obj"><h4>${glyph(e0.type)}<b>${esc(e0.name)}</b>${e0.include !== 'main' ? `<small>${esc(INCLUDE_LABEL[e0.include])}</small>` : ''}<span class="muted">${list.length} change${list.length === 1 ? '' : 's'}</span></h4>${rows}</section>`);
    }
    const objs = new Set(p.edits.map(e => e.uri)).size;
    return !!(await modal<boolean>(p.title, `<p class="note">${p.edits.length} change${p.edits.length === 1 ? '' : 's'} in ${objs} object${objs === 1 ? '' : 's'}. The system makes them when you confirm; the objects are then inactive until you activate them.</p><div class="rf-prev">${parts.join('')}${shown < p.edits.length ? `<p class="note">and ${p.edits.length - shown} more</p>` : ''}</div>`,
      [{ label: 'Cancel', value: false }, { label: 'Change', value: true, kind: 'primary' }], undefined, true));
  }

  async function reloadObjects(refs: ObjRef[]) {
    for (const r of refs) {
      for (const tab of S.tabs.filter(x => x.key === `${S.conn}|${r.uri}` && x.view === 'source')) {
        for (const inc of backend.includesOf(tab.ref.type)) {
          const k = docKey(tab, inc);
          const d = docs.get(k);
          if (!d) continue;
          const text = await backend.read(tab.conn, tab.ref, inc, 'inactive');
          const at = d.getCursor();
          d.setValue(text); d.markClean(); d.setCursor(at);
          base.set(k, text);
          remember(tab, inc, text, 'Changed by refactoring');
        }
        tab.ref = await backend.state(tab.conn, tab.ref).catch(() => tab.ref);
        await updateObjInCache(tab.ref);
      }
    }
  }

  async function activateRefs(refs: ObjRef[]) {
    await busy('Activating', async () => {
      const r = await backend.activate(S.conn, refs);
      for (const ref of refs) setProblems(ref.uri, r.problems.filter(p => p.uri === ref.uri));
      for (const tab of S.tabs.filter(x => refs.some(r2 => x.key === `${S.conn}|${r2.uri}`))) { tab.ref = await backend.state(tab.conn, tab.ref).catch(() => tab.ref); await updateObjInCache(tab.ref); }
      toast(r.ok ? `Activated ${refs.map(x => x.name).join(', ')}` : 'Activation found errors. See Problems.', r.ok ? 'ok' : 'error');
      if (!r.ok) openPanel('problems');
    });
    renderAll();
  }

  /** Shared by Rename and Extract Method: transport, preview, confirm, execute, reload. */
  async function runRefactoring(t: Tab, label: string, build: (transport?: string) => Promise<RefactorPreview>) {
    const need = await backend.transportNeed(t.conn, t.ref).catch(() => ({ needed: false, requests: [] } as TransportNeed));
    let tr = need.current;
    if (need.needed) { tr = (await chooseTransport(t.ref, need, 'is changed by this refactoring and must be recorded in a transport request')) ?? undefined; if (!tr) return; }
    const p = await busy(label, () => build(tr));
    if (!p) return;
    if (!p.edits.length) { toast('Nothing to change', 'info'); return; }
    const dirty = p.objects.map(o => S.tabs.find(x => x.key === `${S.conn}|${o.uri}`)).filter((x): x is Tab => !!x && isDirty(x));
    if (dirty.length) { toast(`Save ${dirty.map(x => x.ref.name).join(', ')} first: the system changes the saved version`, 'warn', 6000); return; }
    if (!(await confirmRefactoring(p))) return;
    const ok = await busy(p.title, async () => {
      for (const o of p.objects) {
        const x = S.tabs.find(y => y.key === `${S.conn}|${o.uri}`);
        if (x?.lock && x.lock !== 'pending') { const l = x.lock; x.lock = undefined; await backend.unlock(x.conn, x.ref, l).catch(() => undefined); }
      }
      await backend.refactorExecute(t.conn, p);
      await reloadObjects(p.objects);
      if (conn().transports) S.transports = await backend.transports(S.conn).catch(() => S.transports);
      return true;
    });
    renderAll();
    if (ok) toast(`${p.title}: ${p.edits.length} change${p.edits.length === 1 ? '' : 's'}${tr ? ` in ${tr}` : ''}. Activate to finish.`, 'ok', 9000, { label: 'Activate', run: () => activateRefs(p.objects) });
  }

  async function renameSymbol() {
    const t = curSrc(); if (!t) return;
    if (TYPE_INFO[t.ref.type].editor !== 'abap') { toast('Rename works on ABAP source', 'warn'); return; }
    if (isDirty(t) && !(await save(t))) return;
    const c = cm.getCursor();
    const line: string = cm.getLine(c.line);
    const r = wordRange(line, c.ch);
    if (!r) { toast('Place the cursor on a name to rename it', 'warn'); return; }
    const start = await busy('Checking the name', () => backend.renameStart(t.conn, t.ref, t.include, c.line, r[0], r[1]));
    if (!start) return;
    const old = start.oldName || line.slice(r[0], r[1]);
    const name = await modal<string>(`Rename ${old}`, `<label class="field"><span>New name</span><input id="rnIn" value="${esc(line.slice(r[0], r[1]))}" spellcheck="false" autocomplete="off" required></label>
      <p class="note">The system renames every use it knows of, in other objects too, like Eclipse. You see all changes before anything happens.</p><p class="form-err" id="rnErr" hidden></p>`,
      [{ label: 'Cancel', value: null }, { label: 'Preview', kind: 'primary', submit: true }], (root, close) => {
        const inp = $<HTMLInputElement>('#rnIn', root);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          const v = inp.value.trim();
          const err = $('#rnErr', root);
          if (!/^[A-Za-z_/][\w/]*$/.test(v)) { err.hidden = false; err.textContent = 'Use letters, digits and _ (and / for a namespace).'; return; }
          close(v);
        };
      });
    if (!name || name.toLowerCase() === old.toLowerCase()) return;
    await runRefactoring(t, `Rename ${old}`, tr => backend.renamePreview(t.conn, start, name, tr));
  }

  async function extractMethod() {
    const t = curSrc(); if (!t) return;
    if (TYPE_INFO[t.ref.type].editor !== 'abap') { toast('Extract Method works on ABAP source', 'warn'); return; }
    if (!cm.somethingSelected()) { toast('Select the statements to move into a new method first', 'warn'); return; }
    const sel = cm.getSelection();
    if (isDirty(t) && !(await save(t))) return;
    if (cm.getSelection() !== sel) { toast('Saving changed the layout. Select the statements again.', 'warn'); return; }
    const from = cm.getCursor('from'), to = cm.getCursor('to');
    const start = await busy('Analyzing the selection', () => backend.extractStart(t.conn, t.ref, t.include, from, to));
    if (!start) return;
    const params = start.params.map((p, i) => `<tr><td><input data-p="${i}" value="${esc(p.name)}" spellcheck="false"></td><td>${esc(p.direction)}</td><td><code>${esc(p.type)}</code></td></tr>`).join('');
    const ok = await modal<boolean>('Extract Method', `
      <div class="two"><label class="field"><span>Method name</span><input id="exName" value="${esc(start.name)}" spellcheck="false" autocomplete="off" maxlength="30" required></label>
        <label class="field"><span>Visibility</span><select id="exVis">${['PUBLIC', 'PROTECTED', 'PRIVATE'].map(v => `<option ${v === start.visibility.toUpperCase() ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
      <label class="check"><input type="checkbox" id="exStatic" ${start.isStatic ? 'checked' : ''}><span>Static method (CLASS-METHODS)</span></label>
      ${start.params.length ? `<table class="ex-params"><thead><tr><th>Parameter</th><th>Kind</th><th>Type</th></tr></thead><tbody>${params}</tbody></table>` : '<p class="note">The selection needs no parameters.</p>'}
      <p class="form-err" id="exErr" hidden></p>`,
      [{ label: 'Cancel', value: false }, { label: 'Preview', kind: 'primary', submit: true }], (root, close) => {
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          const name = $<HTMLInputElement>('#exName', root).value.trim();
          const err = $('#exErr', root);
          if (!/^[A-Za-z_][\w]*$/.test(name)) { err.hidden = false; err.textContent = 'The method name uses letters, digits and _.'; return; }
          start.name = name;
          start.visibility = $<HTMLSelectElement>('#exVis', root).value;
          start.isStatic = $<HTMLInputElement>('#exStatic', root).checked;
          root.querySelectorAll<HTMLInputElement>('input[data-p]').forEach(inp => { start.params[+(inp.dataset.p as string)].name = inp.value.trim() || start.params[+(inp.dataset.p as string)].name; });
          close(true);
        };
      });
    if (!ok) return;
    await runRefactoring(t, `Extract method ${start.name}`, tr => backend.extractPreview(t.conn, start, tr));
  }

  /** Starts a report in SAP GUI (SE38, F8), like Run As → ABAP Application in Eclipse. */
  async function runInGui(t: Tab, forDebug = false): Promise<boolean> {
    const tools = opts.tools;
    if (!tools) { toast(runBlocker(t) || 'SAP GUI is only available in the desktop app', 'warn', 6000); return false; }
    if (isDirty(t) && !(await save(t))) return false;
    const st = await backend.state(t.conn, t.ref).catch(() => t.ref);
    if (st.inactive) {
      const ok = await confirmBox(`Activate ${t.ref.name} first?`, `SAP GUI runs the active version of ${esc(t.ref.name)}; your saved changes are not active yet.`, 'Activate and run');
      if (!ok) return false;
      await activate(t);
      if ((await backend.state(t.conn, t.ref).catch(() => t.ref)).inactive) return false;
    }
    try {
      // reports: SE38 and execute; function modules: SE37 and its test screen
      await tools.openSapGui(conn(), t.ref.type === 'FUNC' ? `*SE37 RS38L-NAME=${t.ref.name};DYNP_OKCODE=WB_EXEC` : `*SE38 RS38M-PROGRAMM=${t.ref.name};DYNP_OKCODE=STRT`);
      toast(forDebug ? `Opened ${t.ref.name} in SAP GUI. It stops here at your breakpoint.` : `Opened ${t.ref.name} in SAP GUI`, 'ok', 5000);
      return true;
    } catch (e) { fail(e, 'Opening SAP GUI'); return false; }
  }

  /** Returns false when no debug session started, so the caller runs normally. */
  async function startDebug(t: Tab): Promise<boolean> {
    if ((t.ref.type === 'PROG' && !conn().runReports) || t.ref.type === 'FUNC') {
      // a report or function module on a real system runs in SAP GUI: listen like Eclipse does, then start it there
      const waiting = listenForDebug(() => backend.debugStart(t.conn, t.ref, allBreakpoints()));
      if (opts.tools && conn().kind === 's4') setTimeout(() => { if (S.listening) runInGui(t, true); }, 700);
      return !!(await waiting);
    }
    const r = await busy('Starting debugger', async () => {
      const st = await backend.debugStart(t.conn, t.ref, allBreakpoints());
      if (!st) return false;
      await afterDebug(st);
      return true;
    });
    return !!r;
  }
  /** Shows the waiting state until a process stops at a breakpoint or the user stops waiting. */
  async function listenForDebug(wait: () => Promise<DebugState | null> = () => backend.debugListen(S.conn, allBreakpoints())): Promise<boolean> {
    if (S.listening) return false;
    S.listening = true; S.view = 'debug'; S.sideOpen = true; renderAll();
    try {
      const st = await wait();
      S.listening = false;
      if (!st) { renderAll(); return false; }
      await afterDebug(st);
      return true;
    } catch (e) {
      S.listening = false; renderAll();
      fail(e, 'Debugger');
      return false;
    }
  }
  async function step(kind: StepKind, target?: Breakpoint) {
    if (!S.debug || S.debug.done) return;
    try { await afterDebug(await backend.debugStep(kind, allBreakpoints(), target)); } catch (e) { fail(e, 'Debugger step'); }
  }
  function runToLine() {
    const t = curSrc();
    if (!t || !S.debug || S.debug.done) return;
    step('continue', { uri: t.ref.uri, include: t.include, line: cm.getCursor().line });
  }
  async function stopDebug() {
    if (!S.debug && !S.listening) return;
    const was = !!S.debug;
    await backend.debugStop();
    S.debug = null; S.listening = false; markDebugLine(); renderAll();
    toast(was ? 'Debugger terminated' : 'Stopped waiting for breakpoints');
  }
  async function afterDebug(st: DebugState, goto = true) {
    S.debug = st;
    varKids.clear();
    const t = cur();
    if (st.done) {
      S.debug = null;
      if (st.outputSoFar) { S.output = { output: st.outputSoFar, kind: 'list', title: t?.ref.name || '', at: new Date().toLocaleTimeString() }; openPanel('output'); }
      markDebugLine(); renderAll();
      toast(st.note || 'Program finished', st.note ? 'info' : 'ok', 3500);
      return;
    }
    S.view = 'debug'; S.sideOpen = true;
    const f = st.frames[st.frame ?? 0] || st.frames[0];
    if (goto && f) await gotoLoc({ uri: f.uri, include: f.include, line: f.line });
    markDebugLine(); renderAll();
  }
  async function debugFrame(i: number) {
    if (!S.debug || S.debug.done) return;
    try { await afterDebug(await backend.debugFrame(i)); } catch (e) { fail(e, 'Switching the stack frame'); }
  }
  async function debugSetValue(name: string, value: string) {
    if (!S.debug || S.debug.done) return;
    const v = await modal<string>(`Change ${name}`, `<label class="field"><span>New value</span><input id="dvIn" value="${esc(value)}" spellcheck="false" autocomplete="off"></label><p class="note">Text without quotes; the debugger converts it to the type of ${esc(name)}.</p>`,
      [{ label: 'Cancel', value: null }, { label: 'Change', kind: 'primary', submit: true }], (root, close) => {
        const inp = $<HTMLInputElement>('#dvIn', root);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => { ev.preventDefault(); close(inp.value); };
      });
    if (v === null || v === undefined) return;
    try { await afterDebug(await backend.debugSetValue(name, v), false); } catch (e) { fail(e, `Changing ${name}`); }
  }

  // ------------------------------------------------------------------ data preview and service bindings
  function openPreview(entity?: string, sql?: string, show = true) {
    const key = `${S.conn}|data|${entity || 'console-' + Date.now()}`;
    let t = S.tabs.find(x => x.key === key);
    if (!t) {
      const ent = entity?.toUpperCase();
      t = {
        key, conn: S.conn, include: 'main', view: 'data',
        ref: { uri: `data:${ent || 'console'}`, name: ent || 'SQL Console', type: 'TABL', pkg: '', desc: ent ? 'Data preview' : 'ABAP SQL console', inactive: false },
        data: { entity: ent, sql: sql || (ent ? `SELECT * FROM ${ent}` : 'SELECT * FROM /dmo/flight\n  WHERE carrier_id = \'GA\''), rows: 100 },
      };
      S.tabs.push(t);
    }
    if (show) { showTab(t).then(() => { if (entity && !t!.data!.result) runPreview(); }); }
  }
  async function runPreview() {
    const t = cur();
    if (!t || t.view !== 'data' || !t.data) return;
    const d = t.data;
    d.running = true; d.error = undefined; renderPane();
    try {
      const sql = d.sql.trim();
      const plain = d.entity && new RegExp(`^SELECT\\s+\\*\\s+FROM\\s+${d.entity.replace(/\//g, '\\/')}\\s*$`, 'i').test(sql);
      d.result = await backend.dataPreview(S.conn, plain ? { entity: d.entity, rows: d.rows } : { sql, entity: d.entity, rows: d.rows });
    } catch (e) { d.error = msg(e); }
    d.running = false;
    if (cur() === t) renderPane();
  }
  async function loadBinding(t: Tab) {
    t.binding = null;
    try { t.binding = await backend.bindingInfo(t.conn, t.ref); } catch (e) { t.binding = { error: `Reading ${t.ref.name} failed: ${msg(e)}` }; }
    if (cur() === t) renderPane();
  }
  async function publish(t: Tab, on: boolean) {
    if (!on && !(await confirmBox(`Unpublish ${t.ref.name}?`, 'Apps and clients that use this OData service stop working until you publish it again.', 'Unpublish'))) return;
    await busy(`${on ? 'Publishing' : 'Unpublishing'} ${t.ref.name}`, async () => {
      const text = await backend.publishBinding(t.conn, t.ref, on);
      toast(text, 'ok', 4000);
      await loadBinding(t);
    });
  }

  // ------------------------------------------------------------------ create, delete, packages
  const NEW_TYPES: { group: string; types: ObjType[] }[] = [
    { group: 'Source Code', types: ['CLAS', 'INTF', 'PROG', 'FUGR', 'FUNC'] },
    { group: 'Dictionary', types: ['TABL', 'DTEL', 'DOMA', 'TTYP'] },
    { group: 'Core Data Services', types: ['DDLS', 'DDLX', 'DCLS', 'BDEF'] },
    { group: 'Business Services', types: ['SRVD', 'SRVB', 'HTTP', 'EVTB'] },
    { group: 'Texts', types: ['MSAG'] },
    { group: 'Authorizations', types: ['AUTH', 'SUSO', 'SUSH', 'SUCO'] },
    { group: 'Identity and Access Management', types: ['SIA6', 'SIA1', 'SIA7', 'SIA8', 'SIA9', 'SIA2', 'SIA5', 'SIA3'] },
    { group: 'Cloud Communication Management', types: ['SCO1', 'SCO2', 'SCO3', 'COTA'] },
    { group: 'Business Configuration Management', types: ['SMBC'] },
    { group: 'Application Jobs', types: ['SAJC', 'SAJT'] },
    { group: 'Others', types: ['NROB', 'APLO'] },
  ];
  async function newObject(pkgPreset?: string, typePreset?: ObjType, refPreset?: string) {
    const c = conn();
    if (!sysOk()) { toast(`Connect to ${c.sid} first`, 'warn'); return; }
    const cloud = c.abapVersion === 'cloud';
    const pkgs = knownPackages();
    const defPkg = pkgPreset || c.favoritePackages.find(p => !p.startsWith('$')) || pkgs[0] || '$TMP';
    const body = `
      <label class="field"><span>Type</span><select id="noType">${NEW_TYPES.map(g => `<optgroup label="${g.group}">${g.types.filter(t => !(cloud && t === 'PROG')).map(t => `<option value="${t}" ${t === typePreset ? 'selected' : ''}>${TYPE_INFO[t].label}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <div class="two"><label class="field"><span>Name</span><input id="noName" autocomplete="off" spellcheck="false" required></label>
      <label class="field"><span>Package</span><input id="noPkg" list="noPkgs" value="${esc(defPkg)}" autocomplete="off" spellcheck="false" required><datalist id="noPkgs">${pkgs.map(p => `<option value="${esc(p)}">`).join('')}</datalist></label></div>
      <label class="field"><span>Description</span><input id="noDesc" maxlength="60" required></label>
      <label class="field" id="noRefRow"><span id="noRefLabel">Referenced object</span><input id="noRef" autocomplete="off" spellcheck="false" value="${esc(refPreset || '')}"></label>
      <p class="note" id="noFormNote" hidden></p>
      <label class="field" id="noBindRow"><span>Binding type</span><select id="noBind"><option value="V4|UI">OData V4 · UI</option><option value="V4|Web API">OData V4 · Web API</option><option value="V2|UI">OData V2 · UI</option><option value="V2|Web API">OData V2 · Web API</option></select></label>
      <p class="form-err" id="noErr" hidden></p>`;
    const REF_LABEL: Partial<Record<ObjType, string>> = { DDLS: 'Data source (table or view)', DDLX: 'Annotated CDS entity', DCLS: 'Protected CDS entity', BDEF: 'Root CDS entity', SRVD: 'CDS entity to expose', SRVB: 'Service definition', FUNC: 'Function group' };
    const res = await modal<{ type: ObjType; name: string; desc: string; pkg: string; extra: CreateExtra }>('New ABAP object', body,
      [{ label: 'Cancel', value: null }, { label: 'Create', kind: 'primary', submit: true }], (root, close) => {
        const nameEl = $<HTMLInputElement>('#noName', root);
        const typeEl = $<HTMLSelectElement>('#noType', root);
        const refEl = $<HTMLInputElement>('#noRef', root);
        const sync = (first = false) => {
          const ty = typeEl.value as ObjType;
          const info = TYPE_INFO[ty];
          if (first || !nameEl.value || Object.values(TYPE_INFO).some(x => x.prefix === nameEl.value)) nameEl.value = refPreset && ty === 'BDEF' ? refPreset : info.prefix;
          nameEl.maxLength = info.maxLen;
          ($('#noRefRow', root) as HTMLElement).hidden = !REF_LABEL[ty];
          $('#noRefLabel', root).textContent = REF_LABEL[ty] || '';
          ($('#noBindRow', root) as HTMLElement).hidden = ty !== 'SRVB';
          const note = $('#noFormNote', root) as HTMLElement;
          note.hidden = info.editor !== 'xml';
          note.textContent = info.editor === 'xml' ? `You edit the ${info.label.toLowerCase()} in a form after creating it.${c.builtin ? '' : ' Nusa Studio takes the format from an existing object of this type in ' + c.sid + '.'}` : '';
        };
        sync(true);
        typeEl.onchange = () => sync();
        nameEl.oninput = () => { nameEl.value = nameEl.value.toUpperCase(); };
        const groupPkg = () => {
          // a function module is in the package of its function group
          if (typeEl.value !== 'FUNC') return;
          const g = allObjs().find(o => o.type === 'FUGR' && o.name === refEl.value.trim());
          if (g?.pkg) $<HTMLInputElement>('#noPkg', root).value = g.pkg;
        };
        refEl.oninput = () => { refEl.value = refEl.value.toUpperCase(); groupPkg(); };
        typeEl.addEventListener('change', groupPkg);
        groupPkg();
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          const type = typeEl.value as ObjType;
          const name = nameEl.value.trim().toUpperCase();
          const pkg = $<HTMLInputElement>('#noPkg', root).value.trim().toUpperCase();
          const desc = $<HTMLInputElement>('#noDesc', root).value.trim();
          const ref = refEl.value.trim();
          const err = $('#noErr', root);
          let m = '';
          if (!/^([YZ]|\/\w+\/)[A-Z0-9_]*$/.test(name) || name.length < 3) m = 'Use the customer namespace: names start with Z, Y or your /namespace/.';
          else if (name.length > TYPE_INFO[type].maxLen) m = `${TYPE_INFO[type].label} names can have at most ${TYPE_INFO[type].maxLen} characters.`;
          else if (allObjs().some(o => o.name === name && o.type === type)) m = `${name} already exists.`;
          else if (!pkg) m = 'Enter a package.';
          else if (!desc) m = 'Enter a description.';
          else if (type === 'SRVB' && !ref) m = 'Enter the service definition the binding exposes.';
          else if (type === 'FUNC' && !ref) m = 'Enter the function group the function module goes into.';
          else if (type === 'FUNC' && allObjs().some(o => o.type === 'FUNC' && o.name === name)) m = `${name} already exists.`;
          if (m) { err.hidden = false; err.textContent = m; return; }
          const [v, cat] = $<HTMLSelectElement>('#noBind', root).value.split('|');
          close({ type, name, desc, pkg, extra: { referencedObject: ref || undefined, serviceDefinition: type === 'SRVB' ? ref : undefined, functionGroup: type === 'FUNC' ? ref : undefined, bindingType: v as 'V2' | 'V4', category: cat as 'UI' | 'Web API' } });
        };
      });
    if (!res) return;
    try {
      const uri = newObjectUri(res.type, res.name, res.extra);
      const tr = await transportForNew(res.name, res.pkg, uri);
      if (tr === null) return;
      const ref = await busy(`Creating ${res.name}`, () => backend.createObject(S.conn, res.type, res.name, res.desc, res.pkg, tr, res.extra));
      if (!ref) return;
      if (res.type === 'FUNC') {
        // shown under its function group: read the group's parts again
        for (const k of [...progIncl.keys()]) if (k.endsWith(`:${uriFor('FUGR', res.extra.functionGroup || '')}`)) progIncl.delete(k);
      }
      await revealPkg(res.pkg);
      if (c.transports) S.transports = await backend.transports(S.conn).catch(() => S.transports);
      toast(`Created ${res.name}`, 'ok');
      await openObj(ref);
      const t = curSrc();
      if (t && t.ref.uri === ref.uri && !cm.getValue().trim()) {
        const tpl = template(res.type, res.name, res.desc, res.extra);
        if (tpl) cm.setValue(tpl);
      }
    } catch (e) { fail(e, `Creating ${res.name}`); }
  }

  async function newPackage(superPreset?: string) {
    const c = conn();
    if (!sysOk()) { toast(`Connect to ${c.sid} first`, 'warn'); return; }
    const [swcs, layers] = await Promise.all([backend.valueHelp(S.conn, 'softwarecomponents'), backend.valueHelp(S.conn, 'transportlayers')]);
    const cloud = c.abapVersion === 'cloud';
    const body = `
      <div class="two"><label class="field"><span>Name</span><input id="npName" maxlength="30" autocomplete="off" spellcheck="false" value="Z"></label>
      <label class="field"><span>Package type</span><select id="npType"><option value="development">Development</option><option value="structure">Structure</option><option value="main">Main</option></select></label></div>
      <label class="field"><span>Description</span><input id="npDesc" maxlength="60"></label>
      <label class="field"><span>Superpackage</span><input id="npSuper" list="npSupers" value="${esc(superPreset || '')}" placeholder="${cloud ? 'ZLOCAL or your structure package' : 'optional'}" autocomplete="off" spellcheck="false"><datalist id="npSupers">${knownPackages().filter(p => !p.startsWith('$')).map(p => `<option value="${esc(p)}">`).join('')}</datalist></label>
      <div class="two"><label class="field"><span>Software component</span><input id="npSwc" list="npSwcs" value="${esc(swcs[0]?.name || (cloud ? 'ZLOCAL' : 'HOME'))}" autocomplete="off" spellcheck="false"><datalist id="npSwcs">${swcs.map(s => `<option value="${esc(s.name)}">${esc(s.desc)}</option>`).join('')}</datalist></label>
      <label class="field"><span>Transport layer</span><input id="npLayer" list="npLayers" value="${esc(layers[0]?.name || '')}" autocomplete="off" spellcheck="false"><datalist id="npLayers">${layers.map(s => `<option value="${esc(s.name)}">${esc(s.desc)}</option>`).join('')}</datalist></label></div>
      <label class="check"><input type="checkbox" id="npFav" ${superPreset ? '' : 'checked'}><span>Add to favorite packages</span></label>
      <p class="form-err" id="npErr" hidden></p>`;
    const res = await modal<{ name: string; desc: string; sup: string; swc: string; layer: string; type: 'development' | 'structure' | 'main'; fav: boolean }>('New package', body,
      [{ label: 'Cancel', value: null }, { label: 'Create', kind: 'primary', submit: true }], (root, close) => {
        const nm = $<HTMLInputElement>('#npName', root);
        nm.oninput = () => { nm.value = nm.value.toUpperCase(); };
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          const name = nm.value.trim();
          const desc = $<HTMLInputElement>('#npDesc', root).value.trim();
          const err = $('#npErr', root);
          let m = '';
          if (!/^([YZ$]|\/\w+\/)[A-Z0-9_]{1,29}$/.test(name)) m = 'Package names start with Z, Y, $ or your /namespace/.';
          else if (!desc) m = 'Enter a description.';
          if (m) { err.hidden = false; err.textContent = m; return; }
          close({ name, desc, sup: $<HTMLInputElement>('#npSuper', root).value.trim().toUpperCase(), swc: $<HTMLInputElement>('#npSwc', root).value.trim().toUpperCase(), layer: $<HTMLInputElement>('#npLayer', root).value.trim().toUpperCase(), type: $<HTMLSelectElement>('#npType', root).value as 'development', fav: $<HTMLInputElement>('#npFav', root).checked });
        };
      });
    if (!res) return;
    const local = res.name.startsWith('$') || /^(LOCAL|ZLOCAL)$/.test(res.swc);
    const tr = local ? undefined : await transportForNew(res.name, res.sup || res.name, `/sap/bc/adt/packages/${encodeURIComponent(res.name.toLowerCase())}`);
    if (tr === null) return;
    const p = await busy(`Creating package ${res.name}`, () => backend.createPackage(S.conn, { name: res.name, desc: res.desc, superPackage: res.sup, softwareComponent: res.swc, transportLayer: res.layer, packageType: res.type }, tr));
    if (!p) return;
    toast(`Created package ${p.name}`, 'ok');
    if (res.fav) await addFavorite(p.name, false);
    if (res.sup) { await revealPkg(res.sup); S.openSub.add(pkgId(p.name)); persistTree(); await loadPkg(p.name, true); }
    S.view = 'explorer'; S.sideOpen = true;
    renderAll();
  }

  async function addFavorite(name?: string, notify = true) {
    let pkg = name;
    if (!pkg) {
      pkg = await modal<string>('Add package to favorites', `<label class="field"><span>Package</span><input id="fpQ" placeholder="ZNUSA*" autocomplete="off" spellcheck="false"></label><ul class="pick" id="fpList"><li class="empty">Type to search packages</li></ul>`,
        [{ label: 'Cancel', value: null }], (root, close) => {
          const q = $<HTMLInputElement>('#fpQ', root);
          const list = $('#fpList', root);
          q.oninput = debounce(async () => {
            const v = q.value.trim();
            if (!v) { list.innerHTML = '<li class="empty">Type to search packages</li>'; return; }
            try {
              const r = await backend.searchPackages(S.conn, v);
              list.innerHTML = r.map(p => `<li><button type="button" class="row leaf" data-pkg="${esc(p.name)}"><i class="pkg-ic"></i><span class="lbl">${esc(p.name)}<small>${esc(p.desc)}</small></span></button></li>`).join('') || '<li class="empty">No packages found</li>';
            } catch (e) { list.innerHTML = `<li class="empty sys-err">${esc(msg(e))}</li>`; }
          }, 200);
          list.onclick = (e) => { const b = (e.target as HTMLElement).closest('button[data-pkg]') as HTMLElement | null; if (b) close(b.dataset.pkg); };
          ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => { ev.preventDefault(); const first = list.querySelector('button[data-pkg]') as HTMLElement | null; if (first) close(first.dataset.pkg); };
        }) ?? undefined;
    }
    if (!pkg) return;
    const c = conn();
    if (c.favoritePackages.includes(pkg)) { toast(`${pkg} is already a favorite`); return; }
    c.favoritePackages = [...c.favoritePackages, pkg];
    try { await backend.saveConnection(c); } catch (e) { fail(e, 'Saving the favorites'); }
    S.collapsed.delete(pkgId(pkg)); persistTree();
    await loadPkg(pkg);
    if (notify) toast(`Added ${pkg} to favorite packages`, 'ok', 2000);
    renderAll();
  }
  async function removeFavorite(pkg: string) {
    const c = conn();
    c.favoritePackages = c.favoritePackages.filter(p => p !== pkg);
    try { await backend.saveConnection(c); } catch (e) { fail(e, 'Saving the favorites'); }
    renderAll();
  }

  async function deleteObj(o: ObjRef) {
    if (!(await confirmBox(`Delete ${o.name}?`, `The ${TYPE_INFO[o.type].label.toLowerCase()} is deleted in ${esc(conn().sid)}. This cannot be undone.`, 'Delete', true))) return;
    const st = await backend.state(S.conn, o).catch(() => null);
    let tr: string | undefined;
    if (st) {
      const need = await backend.transportNeed(S.conn, o).catch(() => ({ needed: false, requests: [] } as TransportNeed));
      tr = need.current;
      if (need.needed) { const pick = await chooseTransport(o, need, 'must record the deletion in a transport request'); if (!pick) return; tr = pick; }
    }
    const tab = S.tabs.find(t => t.key === `${S.conn}|${o.uri}`);
    if (tab?.lock && tab.lock !== 'pending') { await backend.unlock(S.conn, tab.ref, tab.lock).catch(() => undefined); tab.lock = undefined; }
    const ok = await busy(`Deleting ${o.name}`, async () => { await backend.deleteObject(S.conn, o, tr); return true; });
    if (!ok) return;
    if (tab) await closeTab(tab.key, false);
    S.problems = S.problems.filter(p => p.uri !== o.uri);
    await refreshPkg(o.pkg);
    toast(`Deleted ${o.name}`, 'ok');
    renderAll();
  }

  // ------------------------------------------------------------------ RAP generator
  async function rapGenerator(table?: ObjRef) {
    if (!ext('rapgen')) { toast('Enable the RAP Generator extension first', 'warn'); return; }
    const tables = allObjs().filter(o => o.type === 'TABL');
    const preset = table || tables[0];
    const form = rapFormDialog({ preset, tables, packages: knownPackages(), defaultPkg: conn().favoritePackages[0] || '' });
    const res = await modal<RapFormResult>('Generate RAP service', form.body,
      [{ label: 'Cancel', value: null }, { label: 'Generate', kind: 'primary', submit: true }], form.mount, true);
    if (!res) return;
    const tref = allObjs().find(o => o.type === 'TABL' && o.name === res.table.toUpperCase()) || { uri: uriFor('TABL', res.table), name: res.table.toUpperCase(), type: 'TABL' as ObjType, pkg: res.pkg, desc: '' };
    let fields;
    try { fields = parseTableSource(await backend.read(S.conn, tref, 'main', 'active')); } catch (e) { fail(e, `Reading table ${res.table}`); return; }
    if (!fields.length) { toast(`No fields found in ${res.table}. Activate the table first.`, 'error'); return; }
    const plan = planRap({ table: res.table, fields, base: res.base, label: res.desc, v2: res.v2 });
    const tr = await transportForNew(plan[0].name, res.pkg, uriFor('DDLS', plan[0].name));
    if (tr === null) return;
    const created: ObjRef[] = [];
    const ok = await busy(`Generating ${plan.length} objects`, async () => {
      for (const p of plan) {
        S.busy = `Creating ${p.name} (${created.length + 1}/${plan.length})`; renderPanel();
        const ref = await backend.createObject(S.conn, p.type, p.name, p.desc, res.pkg, tr, p.extra);
        if (p.type !== 'SRVB') {
          const lock = await backend.lock(S.conn, ref);
          try { await backend.write(S.conn, ref, 'main', p.source, lock, tr); } finally { await backend.unlock(S.conn, ref, lock).catch(() => undefined); }
        }
        created.push(ref);
      }
      S.busy = 'Activating the generated objects'; renderPanel();
      const act = await backend.activate(S.conn, created.filter(r => r.type !== 'SRVB'));
      for (const r of created) setProblems(r.uri, act.problems.filter(p => p.uri === r.uri));
      if (!act.ok) { openPanel('problems'); throw new Error('activation reported errors. Fix them in the Problems panel, then activate again.'); }
      if (res.pub) { S.busy = 'Publishing the service binding'; renderPanel(); await backend.publishBinding(S.conn, created[created.length - 1], true); }
      return true;
    });
    await revealPkg(res.pkg);
    if (ok) toast(`Generated ${created.length} objects for ${res.table}${res.pub ? ' and published the service' : ''}`, 'ok', 6000);
    if (created.length) await openObj(created[created.length - 1]);
    renderAll();
  }

  // ------------------------------------------------------------------ systems
  // ------------------------------------------------------------------ value help (F4 / Ctrl+Space)
  const VH_LABEL: Record<string, string> = {
    DOMA: 'Domains', DTEL: 'Data elements', TABL: 'Tables and structures', TTYP: 'Table types', SHLP: 'Search helps', PARA: 'SET/GET parameters',
    CLAS: 'Classes', INTF: 'Interfaces', SRVB: 'Service bindings', SRVD: 'Service definitions', SUSO: 'Authorization objects', AUTH: 'Authorization fields',
    SIA6: 'IAM apps', SIA1: 'Business catalogs', SCO1: 'Communication scenarios', DDLS: 'CDS entities', DEVC: 'Packages',
  };
  function valueHelp(input: HTMLInputElement) {
    document.getElementById('vhPop')?.remove();
    const types = (input.dataset.vh || '').split(',').filter(Boolean);
    if (!types.length) return;
    const pop = document.createElement('div');
    pop.id = 'vhPop';
    pop.className = 'vh-pop';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML = `<div class="vh-head">${ic('search')}<input class="vh-q" aria-label="Search" spellcheck="false" autocomplete="off" value="${esc(input.value)}" placeholder="Name or pattern, e.g. Z*"><span class="vh-kind">${esc(types.map(t => VH_LABEL[t] || t).join(' · '))}</span></div>
      <ul class="vh-list" role="listbox"></ul><div class="vh-foot"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> take · <kbd>Esc</kbd> close</div>`;
    document.body.appendChild(pop);
    const r = input.getBoundingClientRect();
    const w = Math.max(r.width, 380);
    pop.style.width = `${Math.min(w, window.innerWidth - 24)}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    const below = window.innerHeight - r.bottom > 300;
    pop.style.top = below ? `${r.bottom + 4}px` : '';
    pop.style.bottom = below ? '' : `${window.innerHeight - r.top + 4}px`;
    const q = pop.querySelector('.vh-q') as HTMLInputElement;
    const list = pop.querySelector('.vh-list') as HTMLElement;
    let items: { name: string; desc: string; type: string; pkg?: string }[] = [];
    let sel = 0;
    let seq = 0;
    const draw = () => {
      list.innerHTML = items.map((o, i) => `<li role="option" aria-selected="${i === sel}" class="${i === sel ? 'on' : ''}" data-i="${i}"><span class="vh-name mono">${esc(o.name)}</span><span class="vh-desc">${esc(o.desc)}</span>${types.length > 1 ? `<span class="vh-type">${esc(o.type)}</span>` : ''}</li>`).join('')
        || `<li class="vh-empty">${q.value ? 'Nothing found. Use * as a wildcard, for example Z*' : 'Type a name or a pattern'}</li>`;
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    };
    const search = debounce(async () => {
      const my = ++seq;
      list.innerHTML = '<li class="vh-empty"><i class="spin"></i>Searching</li>';
      try { const res = await backend.valueHelpObjects(S.conn, q.value, types); if (my === seq) { items = res; sel = 0; draw(); } }
      catch (e) { if (my === seq) list.innerHTML = `<li class="vh-empty sys-err">${esc(msg(e))}</li>`; }
    }, 180);
    const take = (i: number) => {
      const o = items[i]; if (!o) return;
      input.value = o.name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      close(); input.focus();
    };
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
    const outside = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', outside, true);
    q.oninput = search;
    q.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter') { take(sel); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); input.focus(); e.preventDefault(); e.stopPropagation(); }
    };
    list.onmousedown = (e) => { const li = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null; if (li) { e.preventDefault(); take(+(li.dataset.i as string)); } };
    q.focus(); q.select();
    search();
  }

  // ------------------------------------------------------------------ diagnostics
  function diagText(id: string): string {
    const c = S.conns.find(x => x.id === id) || conn();
    const sys = S.sys[id];
    const hosts = c.kind === 'runner' || c.auth === 'rfc' ? null : systemHosts(c.url);
    return diagReport({
      'Nusa Studio': APP_VERSION,
      Platform: navigator.userAgent,
      System: `${c.sid} (${KIND_LABEL[c.kind]})`,
      Logon: AUTH_LABEL[c.auth],
      'URL entered': c.auth === 'rfc' ? undefined : c.url,
      'Application server': c.auth === 'rfc' ? `${c.ashost} (instance ${c.sysnr})` : undefined,
      SAProuter: c.auth === 'rfc' ? (c.saprouter || 'none') : undefined,
      'RFC SDK folder': c.auth === 'rfc' ? c.rfcSdk : undefined,
      User: c.auth === 'rfc' || c.auth === 'basic' ? c.user : undefined,
      'ADT host': hosts?.api,
      'Logon page host': c.auth === 'sso' ? hosts?.ui : undefined,
      Client: c.kind === 's4' ? c.client : undefined,
      Language: c.language,
      Status: !sys ? 'connecting' : 'error' in sys ? `error: ${sys.error}` : `connected · ${sys.release}`,
      Time: new Date().toISOString(),
    }, id);
  }
  /** A GitHub issue with the version and an anonymized connection log, checked by the user before it opens. */
  async function reportProblem() {
    const c = conn();
    const hosts = c.kind === 'runner' || c.auth === 'rfc' ? null : systemHosts(c.url);
    const words = [c.url, hosts?.api, hosts?.ui, c.ashost, c.saprouter, c.user, c.rfcSdk, c.label, c.builtin ? undefined : c.sid];
    const body = anonymize([
      '**What happened**', '', '(Describe what you did and what you expected.)', '',
      '**Environment**', '',
      `- Nusa Studio ${APP_VERSION}${opts.prototype ? ' (browser prototype)' : ''}`,
      `- ${navigator.userAgent}`,
      `- System: ${KIND_LABEL[c.kind]}, logon: ${AUTH_LABEL[c.auth]}`,
      '', '**Diagnostics** (host names, user and routes are hidden)', '', '```', diagText(S.conn), '```',
    ].join('\n'), words);
    const res = await modal<{ text: string; title: string }>('Report a problem', `<p class="note">This opens a new issue on GitHub. The issue is public: check the text below and remove anything you do not want to share. Host names, your user and the SAProuter route are already replaced.</p>
      <label class="field"><span>Title</span><input id="rpTitle" maxlength="120" placeholder="Short summary" autocomplete="off"></label>
      <label class="field"><span>Text</span><textarea id="rpBody" rows="14" spellcheck="false">${esc(body)}</textarea></label>`,
      [{ label: 'Cancel', value: null }, { label: 'Copy text', kind: 'ghost', value: 'copy' }, { label: 'Open GitHub issue', kind: 'primary', submit: true }], (root, close) => {
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          close({ title: $<HTMLInputElement>('#rpTitle', root).value.trim(), text: $<HTMLTextAreaElement>('#rpBody', root).value });
        };
        root.querySelector<HTMLButtonElement>('.modal-actions [data-i="1"]')!.onclick = (ev) => { ev.preventDefault(); copy($<HTMLTextAreaElement>('#rpBody', root).value, 'Copied the report'); };
      }, true);
    if (!res || typeof res !== 'object') return;
    const { url, cut } = issueUrl(REPORT_REPO, res.title || 'Problem report', res.text);
    if (cut) await copy(res.text, 'The report is long: the full text is on the clipboard, paste it into the issue');
    openUrl(url);
  }

  async function showDiag(id: string) {
    const text = diagText(id);
    const r = await modal<string>('Connection log', `<p class="note">Requests to this system since the app started. Passwords, tickets and tokens are never recorded.</p><pre class="diag">${esc(text)}</pre>`,
      [{ label: 'Close', value: null }, { label: 'Report a problem…', value: 'report', kind: 'ghost' }, { label: 'Copy', value: 'copy', kind: 'primary' }], undefined, true);
    if (r === 'copy') await copy(text, 'Copied the diagnostics');
    if (r === 'report') await reportProblem();
  }
  async function eclipseGuide() {
    store.set('nusa-adt-eclipse-seen', '1');
    await modal('Coming from Eclipse ADT', `<p class="note">Nusa Studio talks to the same ADT services as Eclipse, so nothing changes on the SAP side, and the Eclipse shortcuts you know still work.</p>
      <ul class="eclipse-list">${ECLIPSE_POINTS.map(([h, p]) => `<li><b>${esc(h)}</b><span>${esc(p)}</span></li>`).join('')}</ul>
      <div class="eclipse-keys"><div><h4>Same keys as Eclipse</h4><dl class="keys">${[['Open object', 'Ctrl+Shift+A'], ['Activate', 'Ctrl+F3'], ['Check', 'Ctrl+F2'], ['Pretty printer', 'Shift+F1'], ['Definition · Element info', 'F3 · F2'], ['Where-used', 'Ctrl+Shift+G'], ['Run', 'F8 / F9'], ['Quick fix · Rename', 'Ctrl+1 · Alt+Shift+R'], ['Extract method', 'Alt+Shift+M'], ['ABAP Unit · ATC', 'Ctrl+Shift+F10 · Ctrl+Shift+F2']].map(([a, k]) => `<dt>${a}</dt><dd><kbd>${k}</kbd></dd>`).join('')}</dl></div>
      <div><h4>New here</h4><dl class="keys">${[['Command palette', 'Ctrl+Shift+P'], ['Next match (multi-cursor)', 'Ctrl+D'], ['Move · copy line', 'Alt+↑↓ · Shift+Alt+↓'], ['Delete line', 'Ctrl+Shift+K'], ['Clean up', 'Ctrl+4'], ['Keyword docs', 'F1']].map(([a, k]) => `<dt>${a}</dt><dd><kbd>${k}</kbd></dd>`).join('')}</dl></div></div>`,
      [{ label: 'Close', value: null, kind: 'primary' }], (root) => { setTimeout(() => { const m = root.closest('.modal'); if (m) m.scrollTop = 0; }, 0); }, true);
    renderWelcome();
  }

  async function systemForm(existing?: Connection): Promise<void> {
    const e = existing;
    const form = systemFormDialog(e, opts.tools, er => fail(er, 'Choosing the folder'));
    const result = await modal<{ c: Connection; secret?: string }>(e ? `Edit ${e.sid}` : 'Add system', form.body,
      [{ label: 'Cancel', value: null }, { label: e ? 'Save' : 'Add and connect', kind: 'primary', submit: true }], form.mount);
    if (!result) return;
    try {
      await backend.saveConnection(result.c, result.secret);
      S.conns = await backend.connections();
      toast(e ? `Saved ${result.c.sid}` : `Added ${result.c.sid}`, 'ok', 2000);
      if (!e || e.id === S.conn) { S.sys[result.c.id] = undefined; if (e) await reconnect(); else await switchConn(result.c.id); }
      else renderAll();
    } catch (er) { fail(er, `Saving ${result.c.sid}`); }
  }

  async function testConn(id: string) {
    const c = S.conns.find(x => x.id === id);
    if (!c) return;
    await busy(`Testing ${c.sid}`, async () => {
      const info = await backend.connect(id);
      S.sys[id] = info;
      toast(`${c.sid} answers: ${info.release}`, 'ok');
    });
    if (S.view === 'connections') renderSide();
  }
  async function relogin(id: string) {
    await backend.resetSession(id).catch(() => undefined);
    if (id === S.conn) await reconnect(); else await testConn(id);
  }
  async function deleteConn(id: string) {
    const c = S.conns.find(x => x.id === id);
    if (!c || c.builtin) return;
    if (!(await confirmBox(`Remove ${c.sid}?`, 'The system and its saved password or key are removed from this computer. Nothing changes in the system itself.', 'Remove', true))) return;
    try {
      for (const t of S.tabs.filter(x => x.conn === id)) if (!(await closeTab(t.key))) return;
      await backend.deleteConnection(id);
      S.conns = await backend.connections();
      delete S.sys[id];
      toast(`Removed ${c.sid}`, 'ok', 2000);
      if (id === S.conn && S.conns.length) await switchConn(S.conns[0].id, true); else renderAll();
    } catch (e) { fail(e, `Removing ${c.sid}`); }
  }

  async function reconnect() {
    S.sys[S.conn] = undefined;
    renderAll();
    await connectCurrent();
  }

  async function connectCurrent() {
    const id = S.conn;
    try { S.sys[id] = await backend.connect(id); } catch (e) { S.sys[id] = { error: msg(e) }; logDiag(id, `connect failed: ${msg(e)}`); }
    if (id !== S.conn) return;
    S.git = null;
    if (sysOk()) {
      await loadTree();
      try { S.transports = conn().transports ? await backend.transports(S.conn) : []; } catch { S.transports = []; }
      const restored = await restoreSession();
      if (!restored && !tabsHere().length && (conn().builtin || opts.prototype) && !store.get('nusa-adt-session-' + S.conn)) {
        const objs = allObjs();
        const prog = objs.find(o => o.type === 'PROG');
        const cls = objs.find(o => o.type === 'CLAS');
        if (prog) await openObj(prog);
        if (cls) await openObj(cls);
      }
    }
    renderAll();
  }

  async function switchConn(id: string, force = false) {
    if (id === S.conn && !force) return;
    if (S.debug && !S.debug.done) await stopDebug();
    S.conn = id; store.set('nusa-adt-conn', id);
    S.problems = []; S.atc = null; S.unit = null; S.where = null; S.output = null; S.searchRes = []; S.searchQ = ''; S.git = null;
    S.traces = null; S.traceSel = null; S.dumps = null; S.dumpSel = null;
    S.sys[id] = undefined;
    const t = cur();
    if (t && t.view === 'source') await showTab(t); else { swapping = true; cm.swapDoc(placeholderDoc); swapping = false; renderAll(); }
    await connectCurrent();
    if (sysOk()) toast(`Connected to ${conn().sid}`, 'ok', 2000);
  }
  async function checkUpdates(manual = false) {
    const u = opts.updates;
    if (!u) return;
    if (!manual) {
      if (!settings.checkUpdates) return;
      const last = +(store.get('nusa-adt-update-check') || 0);
      if (Date.now() - last < 20 * 3600_000) return;
    }
    store.set('nusa-adt-update-check', String(Date.now()));
    let info: UpdateInfo | null;
    try { info = await u.check(); } catch (e) { if (manual) fail(e, 'Checking for updates'); return; }
    if (!info) { if (manual) toast(`Nusa Studio ${APP_VERSION} is the latest version`, 'ok'); return; }
    const v = info;
    if (store.get('nusa-adt-update-skip') === v.version && !manual) return;
    toast(`Nusa Studio ${v.version} is available (you have ${v.current}).`, 'info', 15000, v.installable
      ? { label: 'Install and restart', run: () => installUpdate(v) }
      : { label: 'Download', run: () => { store.set('nusa-adt-update-skip', v.version); openUrl(v.url); } });
  }
  async function installUpdate(v: UpdateInfo) {
    if (S.tabs.some(isDirty) && !(await confirmBox('Unsaved changes', 'Some editors have unsaved changes. They are kept as drafts and come back after the restart. Install now?', 'Install and restart'))) return;
    await busy(`Installing Nusa Studio ${v.version}`, () => (opts.updates as UpdateBridge).install());
  }

  function eclipseTip() {
    if (store.get('nusa-adt-eclipse-seen') || store.get('nusa-adt-eclipse-tip')) return;
    store.set('nusa-adt-eclipse-tip', '1');
    toast('Used to Eclipse ADT? Your shortcuts work here, plus a few new ones.', 'info', 12000, { label: 'What is different', run: eclipseGuide });
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
      for (const x of tabsHere()) if (x.view === 'source') x.ref = await backend.state(x.conn, x.ref).catch(() => x.ref);
      toast(`Released ${id}`, 'ok');
    });
    renderAll();
  }

  async function editTrDesc(id: string) {
    const t = S.transports.find(x => x.id === id);
    if (!t) return;
    const desc = await modal<string>(`Description of ${id}`, `<label class="field"><span>Short description</span><input id="trDescIn" maxlength="60" value="${esc(t.desc)}" required></label>`,
      [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', submit: true }], (root, close) => {
        const inp = $<HTMLInputElement>('#trDescIn', root);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => { ev.preventDefault(); const v = inp.value.trim(); if (v) close(v); };
      });
    if (!desc || desc === t.desc) return;
    await busy(`Changing ${id}`, async () => {
      await backend.changeTransportDesc(S.conn, id, desc);
      S.transports = await backend.transports(S.conn);
      toast(`${id} is now “${desc}”`, 'ok');
    });
    renderAll();
  }

  const entryName = (e: string) => e.split(' ').slice(2).join(' ').trim();
  async function afterTrChange(ids: string[]) {
    S.transports = await backend.transports(S.conn);
    for (const id of ids) trPick.delete(id);
    for (const x of tabsHere()) if (x.view === 'source') x.ref = await backend.state(x.conn, x.ref).catch(() => x.ref);
  }

  async function removeTrObjects(id: string) {
    const entries = [...(trPick.get(id) ?? [])];
    if (!entries.length) return;
    const ok = await confirmBox(`Remove ${entries.length} object${entries.length === 1 ? '' : 's'} from ${id}?`,
      `<code>${entries.map(e => esc(entryName(e))).join('</code>, <code>')}</code></p><p class="note">The objects stay in the system; only their entries leave the request, so these changes are no longer transported with ${esc(id)}. The next change to them asks for a request again.`, 'Remove from request', true);
    if (!ok) return;
    await busy(`Removing objects from ${id}`, async () => {
      await backend.removeFromTransport(S.conn, id, entries);
      await afterTrChange([id]);
      toast(`Removed ${entries.length} object${entries.length === 1 ? '' : 's'} from ${id}`, 'ok');
    });
    renderAll();
  }

  async function moveTrObjects(id: string) {
    const entries = [...(trPick.get(id) ?? [])];
    if (!entries.length) return;
    const targets = S.transports.filter(t => t.status === 'modifiable' && t.id !== id);
    const body = `<p><code>${entries.map(e => esc(entryName(e))).join('</code>, <code>')}</code> from <b>${esc(id)}</b> to:</p>
      <fieldset class="choices">${targets.map((t, i) => `<label class="choice"><input type="radio" name="mv" value="${esc(t.id)}" ${i === 0 ? 'checked' : ''}><span><code>${esc(t.id)}</code> ${esc(t.desc)}<small>${esc(t.owner)} · ${t.objects.length} objects</small></span></label>`).join('')}
        <label class="choice"><input type="radio" name="mv" value="__new" ${targets.length ? '' : 'checked'}><span>New request<input id="mvNewDesc" placeholder="Short description" maxlength="60"></span></label>
      </fieldset>`;
    const to = await modal<string>(`Move ${entries.length} object${entries.length === 1 ? '' : 's'}`, body, [{ label: 'Cancel', value: null }, { label: 'Move', kind: 'primary', submit: true }], (root, close) => {
      $<HTMLInputElement>('#mvNewDesc', root).onfocus = () => { (root.querySelector('input[value="__new"]') as HTMLInputElement).checked = true; };
      ($('#modalForm', root) as HTMLFormElement).onsubmit = async (ev) => {
        ev.preventDefault();
        const v = (root.querySelector('input[name="mv"]:checked') as HTMLInputElement | null)?.value;
        if (v !== '__new') { close(v ?? null); return; }
        const desc = $<HTMLInputElement>('#mvNewDesc', root).value.trim();
        if (!desc) { $<HTMLInputElement>('#mvNewDesc', root).focus(); return; }
        const first = entries.map(e => { const [, type] = e.split(' '); return allObjs().find(o => o.type === type && o.name === entryName(e)); }).find(Boolean) || cur()?.ref;
        try { close(await backend.createTransport(S.conn, desc, first ?? { uri: '', name: '', type: 'CLAS', pkg: conn().favoritePackages[0] || '', desc: '' })); }
        catch (e) { fail(e, 'Creating the request'); }
      };
    });
    if (!to) return;
    await busy(`Moving objects to ${to}`, async () => {
      await backend.moveToTransport(S.conn, id, to, entries);
      await afterTrChange([id, to]);
      toast(`Moved ${entries.length} object${entries.length === 1 ? '' : 's'} from ${id} to ${to}`, 'ok');
    });
    renderAll();
  }

  async function deleteTr(id: string) {
    const t = S.transports.find(x => x.id === id);
    if (!t) return;
    const ok = await confirmBox(`Delete ${id}?`, `<p>${esc(t.desc)}</p><p class="note">${t.objects.length ? `The ${t.objects.length} object entries are removed from the request; the objects themselves stay. Their next change needs a request again.` : 'The request has no objects.'} This cannot be undone.</p>`, 'Delete request', true);
    if (!ok) return;
    await busy(`Deleting ${id}`, async () => {
      await backend.deleteTransport(S.conn, id);
      S.transports = await backend.transports(S.conn);
      for (const x of tabsHere()) if (x.view === 'source') x.ref = await backend.state(x.conn, x.ref).catch(() => x.ref);
      toast(`Deleted ${id}`, 'ok');
    });
    renderAll();
  }

  // ------------------------------------------------------------------ abapGit
  async function gitLink(pkgPreset?: string) {
    const body = `
      <label class="field"><span>Package</span><input id="glPkg" list="glPkgs" value="${esc(pkgPreset || '')}" autocomplete="off" spellcheck="false"><datalist id="glPkgs">${knownPackages().map(p => `<option value="${esc(p)}">`).join('')}</datalist></label>
      <label class="field"><span>Repository URL</span><input id="glUrl" placeholder="https://github.com/your-org/your-repo.git" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Branch</span><input id="glBranch" value="main" autocomplete="off" spellcheck="false"></label>
      <details class="adv"><summary>Private repository</summary>
        <div class="two"><label class="field"><span>User</span><input id="glUser" autocomplete="off"></label><label class="field"><span>Token</span><input id="glPw" type="password" autocomplete="off"></label></div>
        <p class="note">Used for this request only and not stored.</p></details>
      <p class="form-err" id="glErr" hidden></p>`;
    const r = await modal<{ pkg: string; url: string; branch: string; user?: string; password?: string }>('Link package to abapGit repository', body,
      [{ label: 'Cancel', value: null }, { label: 'Link', kind: 'primary', submit: true }], (root, close) => {
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
          ev.preventDefault();
          const pkg = $<HTMLInputElement>('#glPkg', root).value.trim().toUpperCase();
          const url = $<HTMLInputElement>('#glUrl', root).value.trim();
          const err = $('#glErr', root);
          if (!pkg) { err.hidden = false; err.textContent = 'Enter the package to link.'; return; }
          if (!/^https:\/\/.+/.test(url)) { err.hidden = false; err.textContent = 'Enter the HTTPS URL of the repository.'; return; }
          const b = $<HTMLInputElement>('#glBranch', root).value.trim() || 'main';
          close({ pkg, url: /\.git$/.test(url) ? url : url + '.git', branch: b.startsWith('refs/') ? b : `refs/heads/${b}`, user: $<HTMLInputElement>('#glUser', root).value.trim() || undefined, password: $<HTMLInputElement>('#glPw', root).value || undefined });
        };
      });
    if (!r) return;
    const tr = await transportForNew(r.pkg, r.pkg, `/sap/bc/adt/packages/${encodeURIComponent(r.pkg.toLowerCase())}`);
    if (tr === null) return;
    await busy(`Linking ${r.pkg}`, async () => { await backend.gitLink(S.conn, { ...r, transport: tr }); toast(`Linked ${r.pkg} to ${r.url}`, 'ok'); });
    S.git = null; S.view = 'git'; S.sideOpen = true; renderAll();
  }
  async function gitPull(key: string) {
    const g = S.git && !('error' in S.git) ? S.git.find(r => r.key === key) : undefined;
    if (!g) return;
    const tr = await transportForNew(g.pkg, g.pkg, `/sap/bc/adt/packages/${encodeURIComponent(g.pkg.toLowerCase())}`);
    if (tr === null) return;
    await busy(`Pulling ${g.url.split('/').pop()}`, async () => {
      const text = await backend.gitPull(S.conn, key, tr);
      toast(text, 'ok', 6000);
      S.git = null; await refreshPkg(g.pkg);
    });
    renderAll();
  }
  async function gitUnlink(key: string) {
    const g = S.git && !('error' in S.git) ? S.git.find(r => r.key === key) : undefined;
    if (!g || !(await confirmBox(`Unlink ${g.pkg}?`, `The package stays in ${esc(conn().sid)}; only the link to ${esc(g.url)} is removed.`, 'Unlink', true))) return;
    await busy(`Unlinking ${g.pkg}`, async () => { await backend.gitUnlink(S.conn, key); toast(`Unlinked ${g.pkg}`, 'ok'); });
    S.git = null; renderAll();
  }

  // ------------------------------------------------------------------ command table
  interface Cmd { id: string; title: string; key?: string; run: () => unknown; debugOnly?: boolean; when?: () => boolean }
  const CMDS: Cmd[] = [
    { id: 'open', title: 'Open ABAP Development Object…', key: 'Ctrl+Shift+A', run: () => openPalette('obj') },
    { id: 'palette', title: 'Show All Commands', key: 'Ctrl+Shift+P', run: () => openPalette('cmd') },
    { id: 'new', title: 'New ABAP Object…', key: 'Ctrl+N', run: () => newObject() },
    { id: 'new-package', title: 'New Package…', run: () => newPackage() },
    { id: 'add-fav', title: 'Add Package to Favorites…', run: () => addFavorite() },
    { id: 'save', title: 'Save', key: 'Ctrl+S', run: () => save() },
    { id: 'activate', title: 'Activate', key: 'Ctrl+F3', run: () => activate() },
    { id: 'activate-all', title: 'Activate All Inactive Objects', key: 'Ctrl+Shift+F3', run: activateAll },
    { id: 'check', title: 'Check ABAP Syntax', key: 'Ctrl+F2', run: check },
    { id: 'format', title: 'Format Document (Pretty Printer)', key: 'Shift+F1', run: format },
    { id: 'format-vs', title: 'Format Document', key: 'Alt+Shift+F', run: format },
    { id: 'cleanup', title: 'ABAP Cleaner: Clean Up Source', key: 'Ctrl+4', run: cleanUp, when: () => ext('cleaner') },
    { id: 'run', title: 'Run (Program, Console Class or Data Preview)', key: 'F8', run },
    { id: 'run-console', title: 'Run as ABAP Application (Console)', key: 'F9', run },
    { id: 'preview', title: 'Data Preview of Table or CDS View…', run: () => previewPrompt(), when: () => ext('preview') },
    { id: 'sql', title: 'Open SQL Console', key: 'Ctrl+Alt+F8', run: () => openPreview(), when: () => ext('preview') },
    { id: 'unit', title: 'Run ABAP Unit Tests', key: 'Ctrl+Shift+F10', run: unit },
    { id: 'profile', title: 'Profile As ABAP Application (Trace and Run)', key: 'Ctrl+Shift+F9', run: profile },
    { id: 'traces', title: 'Profiler: Show ABAP Traces', run: () => { S.traceSel = null; openPanel('traces'); renderPanel(); } },
    { id: 'trace-next', title: 'Profiler: Trace My Next Run', run: () => traceNextRun() },
    { id: 'dumps', title: 'Runtime Errors (ST22)', run: () => showDumps() },
    { id: 'atc', title: 'Run ATC Checks', key: 'Ctrl+Shift+F2', run: () => atc() },
    { id: 'complete', title: 'Trigger Code Completion', key: 'Ctrl+Space', run: complete },
    { id: 'navigate', title: 'Navigate to Definition', key: 'F3', run: navigate },
    { id: 'info', title: 'Show Element Info', key: 'F2', run: elementInfo, when: () => ext('docs') },
    { id: 'docs', title: 'ABAP Keyword Documentation', key: 'F1', run: keywordDocs, when: () => ext('docs') },
    { id: 'where', title: 'Where-Used List', key: 'Ctrl+Shift+G', run: whereUsed },
    { id: 'quickfix', title: 'Quick Fix', key: 'Ctrl+1', run: quickFix },
    { id: 'quickfix-vs', title: 'Quick Fix (VS Code key)', key: 'Ctrl+.', run: quickFix },
    { id: 'rename', title: 'Rename…', key: 'Alt+Shift+R', run: renameSymbol },
    { id: 'extract', title: 'Extract Method…', key: 'Alt+Shift+M', run: extractMethod },
    { id: 'compare-active', title: 'Compare With: Active Version', run: () => compareActive() },
    { id: 'compare-history', title: 'Compare With: Local History…', run: () => compareHistory() },
    { id: 'compare-revision', title: 'Compare With: Version History in the System…', run: () => compareRevision() },
    { id: 'compare-system', title: 'Compare With: Other System…', run: () => compareSystem() },
    { id: 'next-match', title: 'Add Selection to Next Match', key: 'Ctrl+D', run: () => { if (curSrc()) { selectNextOccurrence(cm); cm.focus(); } } },
    { id: 'line-up', title: 'Move Line Up', key: 'Alt+Up', run: () => { if (curSrc()) moveLines(cm, -1); } },
    { id: 'line-down', title: 'Move Line Down', key: 'Alt+Down', run: () => { if (curSrc()) moveLines(cm, 1); } },
    { id: 'line-copy', title: 'Copy Line Down', key: 'Shift+Alt+Down', run: () => { if (curSrc()) duplicateLines(cm, 1); } },
    { id: 'line-delete', title: 'Delete Line', key: 'Ctrl+Shift+K', run: () => { if (curSrc()) deleteLines(cm); } },
    { id: 'diag', title: 'Show Connection Log (Diagnostics)', run: () => showDiag(S.conn) },
    { id: 'report', title: 'Help: Report a Problem…', run: () => reportProblem() },
    { id: 'eclipse', title: 'Help: Coming from Eclipse ADT', run: () => eclipseGuide() },
    { id: 'update', title: 'Check for Updates…', run: () => checkUpdates(true), when: () => !!opts.updates },
    { id: 'rapgen', title: 'Generate RAP Service from Table…', run: () => rapGenerator(), when: () => ext('rapgen') },
    { id: 'git', title: 'abapGit: Show Repositories', run: () => { S.view = 'git'; S.sideOpen = true; renderAll(); }, when: () => ext('abapgit') },
    { id: 'git-link', title: 'abapGit: Link Package to Repository…', run: () => gitLink(), when: () => ext('abapgit') },
    { id: 'bp', title: 'Toggle Breakpoint', key: 'Ctrl+Shift+B', run: () => toggleBp() },
    { id: 'comment', title: 'Toggle Line Comment', key: 'Ctrl+/', run: toggleComment },
    { id: 'conn', title: 'Switch System…', run: () => openPalette('conn') },
    { id: 'add-conn', title: 'Add System…', run: () => systemForm() },
    { id: 'reconnect', title: 'Reconnect to the Current System', run: reconnect },
    { id: 'relogin', title: 'Log In Again', run: () => relogin(S.conn) },
    { id: 'sidebar', title: 'Toggle Side Bar', key: 'Ctrl+B', run: () => { S.sideOpen = !S.sideOpen; renderActivity(); renderSide(); setTimeout(() => cm.refresh(), 0); } },
    { id: 'panel', title: 'Toggle Panel', key: 'Ctrl+J', run: () => { S.panelOpen = !S.panelOpen; renderPanel(); setTimeout(() => cm.refresh(), 0); } },
    { id: 'settings', title: 'Preferences: Open Settings', key: 'Ctrl+,', run: () => { S.view = 'settings'; S.sideOpen = true; renderAll(); } },
    { id: 'extensions', title: 'Show Extensions', run: () => { S.view = 'extensions'; S.sideOpen = true; renderAll(); } },
    { id: 'theme', title: 'Preferences: Color Theme…', run: () => openPalette('theme') },
    { id: 'theme-toggle', title: 'Toggle Dark Mode', key: 'Ctrl+Alt+D', run: () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark') },
    { id: 'theme-dark', title: 'Color Theme: Dark', run: () => setTheme('dark') },
    { id: 'theme-light', title: 'Color Theme: Light', run: () => setTheme('light') },
    { id: 'theme-system', title: 'Color Theme: Follow System', run: () => setTheme('system') },
    { id: 'refresh', title: 'Refresh Explorer and Transports', run: async () => { await loadTree(); S.transports = conn().transports ? await backend.transports(S.conn).catch(() => S.transports) : []; S.git = null; renderAll(); toast('Refreshed', 'ok', 1500); } },
    { id: 'close-tab', title: 'Close Editor', key: 'Ctrl+W', run: () => { const t = cur(); if (t) closeTab(t.key); } },
    { id: 'close-all', title: 'Close All Editors', run: () => closeTabs(tabsHere().map(t => t.key)) },
    { id: 'dbg-continue', title: 'Debugger: Resume', key: 'F8', run: () => step('continue'), debugOnly: true },
    { id: 'dbg-over', title: 'Debugger: Step Over', key: 'F6', run: () => step('over'), debugOnly: true },
    { id: 'dbg-into', title: 'Debugger: Step Into', key: 'F5', run: () => step('into'), debugOnly: true },
    { id: 'dbg-return', title: 'Debugger: Step Return', key: 'F7', run: () => step('return'), debugOnly: true },
    { id: 'dbg-stop', title: 'Debugger: Terminate', key: 'Shift+F5', run: stopDebug, debugOnly: true },
    { id: 'dbg-line', title: 'Debugger: Run to Line', key: 'Ctrl+R', run: runToLine, debugOnly: true },
    { id: 'dbg-listen', title: 'Debugger: Wait for Any Process to Reach a Breakpoint', run: () => listenForDebug(), when: () => !conn().builtin && conn().kind !== 'runner' && !S.listening },
  ];
  if ('reset' in backend) {
    CMDS.push({
      id: 'reset', title: opts.prototype ? 'Reset Sample Data' : 'Reset DEMO System', run: async () => {
        (backend as unknown as { reset(): void }).reset();
        S.tabs = S.tabs.filter(t => !conn().builtin && !opts.prototype ? true : t.conn !== S.conn); S.activeByConn[S.conn] = null; docs.clear();
        swapping = true; cm.swapDoc(placeholderDoc); swapping = false; S.problems = [];
        store.set('nusa-adt-session-' + S.conn, '');
        S.conns = await backend.connections();
        await connectCurrent(); toast('Sample data restored', 'ok');
      },
    });
  }
  const runCmd = (id: string) => { const c = CMDS.find(x => x.id === id); if (c) Promise.resolve(c.run()).catch(e => fail(e, c.title)); };

  async function previewPrompt() {
    const name = await modal<string>('Data preview', `<label class="field"><span>Database table or CDS view</span><input id="dpName" list="dpNames" placeholder="/DMO/FLIGHT" autocomplete="off" spellcheck="false"><datalist id="dpNames">${allObjs().filter(o => o.type === 'TABL' || o.type === 'DDLS').map(o => `<option value="${esc(o.name)}">`).join('')}</datalist></label>`,
      [{ label: 'Cancel', value: null }, { label: 'Open', kind: 'primary', submit: true }], (root, close) => {
        ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => { ev.preventDefault(); const v = $<HTMLInputElement>('#dpName', root).value.trim(); if (v) close(v.toUpperCase()); };
      });
    if (name) openPreview(name);
  }

  // ------------------------------------------------------------------ palette
  type PalMode = 'cmd' | 'obj' | 'conn' | 'theme';
  let palMode: PalMode = 'obj';
  let palItems: { label: string; sub?: string; key?: string; glyph?: string; go: () => unknown }[] = [];
  let palSel = 0;
  const fuzzy = (q: string, s: string) => { q = q.toLowerCase(); s = s.toLowerCase(); let i = 0; for (const ch of s) if (ch === q[i]) i++; return i === q.length; };

  let palFilled = '\u0000';
  let palSeq = 0;
  async function fillPalette() {
    const raw = $<HTMLInputElement>('#palInput').value;
    palFilled = raw;
    const mode: PalMode = palMode === 'conn' || palMode === 'theme' ? palMode : raw.startsWith('>') ? 'cmd' : 'obj';
    const q = raw.replace(/^>\s*/, '');
    if (mode === 'cmd') {
      const dbg = !!(S.debug && !S.debug.done);
      palItems = CMDS.filter(c => (dbg || !c.debugOnly) && (!c.when || c.when()) && fuzzy(q, c.title)).map(c => ({ label: c.title, key: c.key, go: c.run }));
      $('#palHint').textContent = 'Commands';
    } else if (mode === 'theme') {
      const list: [ThemePref, string, string][] = [['dark', 'Dark', 'Deep slate with amber accents'], ['light', 'Light', 'Warm paper tones'], ['system', 'Follow System', 'Match the operating system or host']];
      palItems = list.filter(o => fuzzy(q, o[1])).map(([id, label, sub]) => ({ label: (themePref === id ? '● ' : '') + label, sub, go: () => setTheme(id) }));
      $('#palHint').textContent = 'Color theme';
    } else if (mode === 'conn') {
      palItems = S.conns.filter(c => fuzzy(q, c.sid + ' ' + (c.label || ''))).map(c => ({ label: `${c.sid}${c.kind === 's4' ? ' · ' + c.client : ''}`, sub: `${c.builtin ? 'Demo' : KIND_LABEL[c.kind]} · ${c.label || c.url}`, go: () => switchConn(c.id) }));
      palItems.push({ label: 'Add system…', sub: 'S/4HANA, S/4HANA Cloud, BTP ABAP or local runner', go: () => systemForm() });
      $('#palHint').textContent = 'Switch system';
    } else {
      let res: ObjRef[] = [];
      let err = '';
      const seq = ++palSeq;
      try { res = q ? await backend.search(S.conn, q) : allObjs(); } catch (e) { err = msg(e); }
      if (seq !== palSeq || $<HTMLInputElement>('#palInput').value !== raw) return;   // typed on: a newer search is running
      palItems = res.map(o => ({ label: o.name, sub: `${TYPE_INFO[o.type].label} · ${o.pkg} · ${o.desc}`, glyph: o.type, go: () => openObj(o) }));
      $('#palHint').innerHTML = err ? `<span class="sys-err">Search failed: ${esc(err)}</span>` : `Objects in <b>${esc(conn().sid)}</b> · type <kbd>&gt;</kbd> for commands`;
    }
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    $('#palList').innerHTML = palItems.map((it, i) => `<li role="option" aria-selected="${i === palSel}" class="${i === palSel ? 'on' : ''}" data-i="${i}">
      ${it.glyph ? glyph(it.glyph as ObjType) : ''}<span class="pl">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</li>`).join('') || '<li class="empty">No matches</li>';
    $('#palList .on')?.scrollIntoView({ block: 'nearest' });
  }
  function openPalette(mode: PalMode) {
    hideMenu(); hidePop();
    palMode = mode; palSel = 0;
    const inp = $<HTMLInputElement>('#palInput');
    inp.value = mode === 'cmd' ? '> ' : '';
    $('#palette').hidden = false;
    inp.focus();
    fillPalette();
  }
  function closePalette() { $('#palette').hidden = true; if (curSrc()) cm.focus(); }
  const palInput = $<HTMLInputElement>('#palInput');
  palInput.oninput = debounce(() => { palSel = 0; fillPalette(); }, 80);
  palInput.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { palSel = Math.min(palItems.length - 1, palSel + 1); fillPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); fillPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = () => { const it = palItems[palSel]; closePalette(); if (it) Promise.resolve(it.go()).catch(err => fail(err, it.label)); };
      if (palInput.value !== palFilled) { palSel = 0; fillPalette().then(pick); } else pick();
    }
    else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
  };
  $('#palList').onclick = (e) => {
    const li = (e.target as HTMLElement).closest('li[data-i]') as HTMLElement | null;
    if (!li) return;
    const it = palItems[+(li.dataset.i as string)];
    closePalette(); if (it) Promise.resolve(it.go()).catch(err => fail(err, it.label));
  };
  $('#palette').onclick = (e) => { if (e.target === $('#palette')) closePalette(); };
  $('#modal').onclick = (e) => { if (e.target === $('#modal') && modalResolve) modalResolve(null); };

  // ------------------------------------------------------------------ context menus
  function objMenu(o: ObjRef): MenuItem[] {
    const data = (o.type === 'TABL' || o.type === 'DDLS') && ext('preview');
    return [
      { label: 'Open', run: () => openObj(o) },
      ...(data ? [{ label: 'Data Preview', key: 'F8', run: () => openPreview(o.name) }] : []),
      ...(o.type === 'TABL' && ext('rapgen') ? [{ label: 'Generate RAP Service…', run: () => rapGenerator(o) }] : []),
      ...(o.type === 'SRVB' ? [{ label: 'Open Service Binding', run: () => openObj(o) }] : []),
      ...(o.type === 'DDLS' ? [{ label: 'New Metadata Extension…', run: () => newObject(o.pkg, 'DDLX', o.name) }, { label: 'New Service Definition…', run: () => newObject(o.pkg, 'SRVD', o.name) }] : []),
      ...(o.type === 'SRVD' ? [{ label: 'New Service Binding…', run: () => newObject(o.pkg, 'SRVB', o.name) }] : []),
      ...(o.type === 'FUGR' ? [{ label: 'New Function Module…', run: () => newObject(o.pkg, 'FUNC', o.name) }] : []),
      { sep: true },
      { label: 'Activate', run: async () => { const st = await backend.state(S.conn, o); if (!st.inactive) { toast(`${o.name} is already active`); return; } await busy(`Activating ${o.name}`, async () => { const r = await backend.activate(S.conn, [o]); setProblems(o.uri, r.problems); if (!r.ok) { openPanel('problems'); throw new Error('see Problems'); } toast(`Activated ${o.name}`, 'ok'); }); await refreshPkg(o.pkg); renderAll(); } },
      ...(TYPE_INFO[o.type].editor !== 'form' ? [{ label: 'Run ATC Checks', run: () => atc(o) }] : []),
      { sep: true },
      { label: 'Copy Name', run: () => copy(o.name, `Copied ${o.name}`) },
      { label: 'Copy ADT Link', run: () => copy(`adt://${conn().sid}${o.uri}`, 'Copied the ADT link') },
      { sep: true },
      { label: 'Delete…', danger: true, run: () => deleteObj(o) },
    ];
  }
  function pkgMenu(pkg: string, fav: boolean): MenuItem[] {
    const local = pkg.startsWith('$');
    return [
      { label: 'New ABAP Object…', run: () => newObject(pkg) },
      ...(!local ? [{ label: 'New Subpackage…', run: () => newPackage(pkg) }] : []),
      { sep: true },
      { label: 'Refresh', run: () => loadPkg(pkg, true) },
      ...(fav && !local ? [{ label: 'Remove from Favorites', run: () => removeFavorite(pkg) }] : !fav ? [{ label: 'Add to Favorites', run: () => addFavorite(pkg) }] : []),
      ...(ext('abapgit') && !local ? [{ label: 'Link to abapGit Repository…', run: () => gitLink(pkg) }] : []),
      { sep: true },
      { label: 'Copy Name', run: () => copy(pkg, `Copied ${pkg}`) },
    ];
  }
  function tabMenu(key: string): MenuItem[] {
    const t = S.tabs.find(x => x.key === key);
    if (!t) return [];
    const others = tabsHere().filter(x => x.key !== key).map(x => x.key);
    return [
      ...(t.preview ? [{ label: 'Keep Open', run: () => pin(t) }, { sep: true } as MenuItem] : []),
      { label: 'Close', key: 'Ctrl+W', run: () => closeTab(key) },
      { label: 'Close Others', disabled: !others.length, run: () => closeTabs(others) },
      { label: 'Close All', run: () => closeTabs(tabsHere().map(x => x.key)) },
      { sep: true },
      ...(t.view !== 'data' ? [{ label: 'Copy Name', run: () => copy(t.ref.name, `Copied ${t.ref.name}`) }, { label: 'Show in Explorer', run: async () => { if (!pkgCache()[t.ref.pkg]) { S.openSub.add(pkgId(t.ref.pkg)); await loadPkg(t.ref.pkg); } S.view = 'explorer'; S.sideOpen = true; renderAll(); } }] : []),
    ];
  }
  function editorMenu(): MenuItem[] {
    const t = curSrc();
    if (!t) return [];
    const abap = TYPE_INFO[t.ref.type].editor === 'abap';
    return [
      { label: 'Navigate to Definition', key: 'F3', run: navigate },
      ...(ext('docs') ? [{ label: 'Element Info', key: 'F2', run: elementInfo }, { label: 'Keyword Documentation', key: 'F1', run: keywordDocs }] : []),
      { label: 'Where-Used List', key: 'Ctrl+Shift+G', run: whereUsed },
      { sep: true },
      { label: 'Quick Fix', key: 'Ctrl+1', run: quickFix },
      ...(abap ? [{ label: 'Rename…', key: 'Alt+Shift+R', run: renameSymbol }, { label: 'Extract Method…', key: 'Alt+Shift+M', run: extractMethod, disabled: !cm.somethingSelected() }] : []),
      { sep: true },
      { label: 'Compare With Active Version', run: () => compareActive() },
      { label: 'Compare With Local History…', run: () => compareHistory() },
      { label: 'Compare With Version History…', run: () => compareRevision(), disabled: isTextInclude(t.include) },
      { label: 'Compare With Other System…', run: () => compareSystem() },
      { sep: true },
      { label: 'Format Document', key: 'Shift+Alt+F', run: format },
      ...(abap && ext('cleaner') ? [{ label: 'Clean Up', key: 'Ctrl+4', run: cleanUp }] : []),
      { label: 'Toggle Comment', key: 'Ctrl+/', run: toggleComment },
      ...(abap ? [{ label: 'Toggle Breakpoint', key: 'Ctrl+Shift+B', run: () => toggleBp() }] : []),
    ];
  }
  // double-click keeps a preview tab open (VS Code: "Keep Open")
  document.addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    const dv = target.closest('[data-act="dbg-set"]') as HTMLElement | null;
    if (dv) { debugSetValue(dv.dataset.name as string, dv.dataset.value as string); return; }
    const tab = target.closest('.tab') as HTMLElement | null;
    if (tab) { pin(S.tabs.find(x => x.key === tab.dataset.key)); return; }
    const row = target.closest('[data-act="open"],[data-act="open-search"]') as HTMLElement | null;
    if (row) setTimeout(() => pin(S.tabs.find(x => x.key === `${S.conn}|${row.dataset.uri}`)), 120);
  });
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    const el = target.closest('[data-ctx]') as HTMLElement | null;
    let items: MenuItem[] = [];
    if (el?.dataset.ctx === 'obj') {
      const uri = el.dataset.uri as string;
      const o = objByUri(uri) || S.searchRes.find(x => x.uri === uri);
      if (o) items = objMenu(o);
    } else if (el?.dataset.ctx === 'pkg') items = pkgMenu(el.dataset.pkg as string, el.dataset.fav === '1');
    else if (el?.dataset.ctx === 'tab') items = tabMenu(el.dataset.key as string);
    else if (target.closest('.CodeMirror')) items = editorMenu();
    if (!items.length) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, items);
  });
  document.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('#ctx')) hideMenu();
    if (!(e.target as HTMLElement).closest('#infoPop')) hidePop();
  });
  window.addEventListener('blur', hideMenu);

  // ------------------------------------------------------------------ clicks
  document.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest('[data-act],[data-cmd],[data-view]') as HTMLElement | null;
    if (!el || el.closest('#palette') || el.closest('#ctx') || (el.closest('#modal') && !el.dataset.act)) return;
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
        persistTree();
        el.closest('.node, .tr-group')?.classList.toggle('closed');
        el.setAttribute('aria-expanded', String(!S.collapsed.has(id)));
        break;
      }
      case 'pkg-toggle': {
        const pkg = d.pkg as string, fav = d.fav === '1', id = pkgId(pkg);
        const open = pkgOpen(pkg, fav);
        if (fav) { if (open) S.collapsed.add(id); else S.collapsed.delete(id); }
        else { if (open) S.openSub.delete(id); else S.openSub.add(id); }
        persistTree();
        // already loaded packages only need a redraw; loadPkg returns early for them
        if (!open) await loadPkg(pkg);
        renderSide();
        break;
      }
      case 'pkg-retry': await loadPkg(d.pkg as string, true); break;
      case 'new-in': await newObject(d.pkg); break;
      case 'add-fav': e.stopPropagation(); await addFavorite(); break;
      case 'collapse-all':
        for (const p of Object.keys(pkgCache())) { S.collapsed.add(pkgId(p)); S.openSub.delete(pkgId(p)); }
        S.collapsed.add(`${S.conn}/fav`);
        persistTree(); renderSide(); break;
      // single click: preview tab; double click (second click of it): keep the tab open
      case 'open': { const o = objByUri(d.uri as string) || S.searchRes.find(x => x.uri === d.uri); if (o) await openObj(o, 'main', undefined, el.classList.contains('row') && (e as MouseEvent).detail < 2); break; }
      case 'prog-toggle': {
        const id = d.id as string;
        if (S.openSub.has(id)) S.openSub.delete(id); else { S.openSub.add(id); progIncl.delete(id); }
        persistTree();
        renderSide();
        break;
      }
      case 'open-ref': {
        const ref = objByUri(d.uri as string) || { uri: d.uri as string, name: d.name as string, type: d.type as ObjType, pkg: '', desc: '' };
        await openObj(ref, 'main', undefined, (e as MouseEvent).detail < 2);
        break;
      }
      case 'open-search': { const o = S.searchRes.find(x => x.uri === d.uri); if (o) await openObj(o, 'main', undefined, (e as MouseEvent).detail < 2); break; }
      case 'goto': await gotoLoc({ uri: d.uri as string, include: d.inc as Include, line: +(d.line as string) }); break;
      case 'dbg-frame': await debugFrame(+(d.i as string)); break;
      case 'dbg-listen': await listenForDebug(); break;
      case 'dbg-unlisten': await stopDebug(); break;
      case 'goline': { const t = curSrc(); if (t) await showTab(t, t.include, +(d.line as string)); break; }
      case 'tab': if (!(e.target as HTMLElement).closest('.tclose')) {
        const t = S.tabs.find(x => x.key === d.key);
        if (t && (e as MouseEvent).detail >= 2) pin(t);
        else if (t && t !== cur()) await showTab(t);
      } break;
      case 'close': e.stopPropagation(); await closeTab(d.key as string); break;
      case 'inc': { const t = curSrc(); if (t) await showTab(t, d.inc as Include); break; }
      case 'panel': S.panel = d.id as PanelTab; S.panelOpen = true; renderPanel(); setTimeout(() => cm.refresh(), 0); break;
      case 'view': S.view = d.id as View; S.sideOpen = true; renderActivity(); renderSide(); break;
      case 'pick-conn': openPalette('conn'); break;
      case 'pick-theme': openPalette('theme'); break;
      case 'set-theme': setTheme(d.id as ThemePref); break;
      case 'palette-obj': openPalette('obj'); break;
      case 'switch': await switchConn(d.id as string); break;
      case 'of-vh': { const inp = document.getElementById(d.for as string) as HTMLInputElement | null; if (inp) valueHelp(inp); break; }
      case 'xf-add-row': {
        const t = cur(); const doc = t && docs.get(docKey(t, 'main'));
        if (doc) { try { doc.setValue(addLayoutRow(doc.getValue(), d.at as string, d.row as string, (d.cols as string).split(','), (d.num as string) || undefined)); renderPane(); } catch (er) { fail(er); } }
        break;
      }
      case 'xf-add-msg': {
        const t = cur(); const doc = t && docs.get(docKey(t, 'main'));
        if (doc) { try { doc.setValue(addMessageRow(doc.getValue())); renderPane(); setTimeout(() => { const ins = document.querySelectorAll<HTMLInputElement>('.of-table.msgs tbody tr:last-child input[maxlength="73"]'); ins[ins.length - 1]?.focus(); }, 0); } catch (er) { fail(er); } }
        break;
      }
      case 'of-goto': document.getElementById(d.id as string)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
      case 'xml-mode': { const t = cur(); if (t && isForm(t)) { t.raw = d.id === 'xml'; renderAll(); if (t.raw) setTimeout(() => { cm.refresh(); cm.focus(); }, 0); } break; }
      case 'xf-add': case 'xf-del': {
        const t = cur(); const doc = t && docs.get(docKey(t, 'main'));
        if (doc) { try { doc.setValue((d.act === 'xf-add' ? addXmlRow : removeXmlRow)(doc.getValue(), d.xpath as string)); renderPane(); } catch (er) { fail(er); } }
        break;
      }
      case 'diag': await showDiag(d.id as string); break;
      case 'diag-copy': await copy(diagText(d.id as string), 'Copied the diagnostics. Passwords and tickets are not included.'); break;
      case 'eclipse': await eclipseGuide(); break;
      case 'eclipse-hide': store.set('nusa-adt-eclipse-seen', '1'); renderWelcome(); break;
      case 'df-all': { const t = cur(); if (t?.diff) { t.diff.all = (el as HTMLInputElement).checked; renderPane(); } break; }
      case 'df-restore': { const t = cur(); if (t) await restoreLeft(t); break; }
      case 'df-edit': { const t = cur(); const src = t?.diff && S.tabs.find(x => x.key === t.diff!.srcKey); if (src) await showTab(src, t!.diff!.inc); break; }
      case 'add-conn': await systemForm(); break;
      case 'edit-conn': { const c = S.conns.find(x => x.id === d.id); if (c) await systemForm(c); break; }
      case 'test-conn': await testConn(d.id as string); break;
      case 'relogin': await relogin(d.id as string); break;
      case 'del-conn': await deleteConn(d.id as string); break;
      case 'release': await releaseTr(d.id as string); break;
      case 'tr-edit': await editTrDesc(d.id as string); break;
      case 'tr-delete': await deleteTr(d.id as string); break;
      case 'tr-remove': await removeTrObjects(d.id as string); break;
      case 'tr-move': await moveTrObjects(d.id as string); break;
      case 'tr-unpick': trPick.delete(d.id as string); renderSide(); break;
      case 'trc-request': await traceNextRun(); break;
      case 'trc-profile': await profile(); break;
      case 'trc-refresh': S.traceSel = null; await loadTraces(); break;
      case 'trc-back': S.traceSel = null; renderPanel(); break;
      case 'dmp-refresh': await loadDumps(); break;
      case 'dmp-open': await openDump(d.id as string); break;
      case 'dmp-back': S.dumpSel = null; renderPanel(); break;
      case 'dmp-mine': S.dumpsMine = (el as HTMLInputElement).checked; store.set('nusa-adt-dumps-all', S.dumpsMine ? '' : '1'); renderPanel(); break;
      case 'trc-open': await openTrace(d.id as string); break;
      case 'trc-del': { const id = d.id as string; if (await confirmBox('Delete this trace?', 'The trace file is removed from the system.', 'Delete', true)) { await busy('Deleting the trace', () => backend.traceDelete(S.conn, id)); await loadTraces(); } break; }
      case 'tr-tab': S.trTab = d.id as Transport['status']; renderSide(); break;
      case 'dp-run': await runPreview(); break;
      case 'dp-copy': { const r = cur()?.data?.result; if (r) await copy([r.columns.map(c => c.name).join('\t'), ...r.rows.map(x => x.join('\t'))].join('\n'), `Copied ${r.rows.length} rows`); break; }
      case 'sb-publish': { const t = cur(); if (t) await publish(t, d.id === '1'); break; }
      case 'sb-reload': { const t = cur(); if (t) await loadBinding(t); break; }
      case 'sb-copy': { const t = cur(); const b = t?.binding; if (b && !('error' in b) && b.serviceUrl) await copy(b.serviceUrl, 'Copied the service URL'); break; }
      case 'git-link': await gitLink(); break;
      case 'git-refresh': S.git = null; renderSide(); break;
      case 'git-pull': await gitPull(d.key as string); break;
      case 'git-unlink': await gitUnlink(d.key as string); break;
      case 'git-show': { const p = d.pkg as string; if (!isFav(p)) await addFavorite(p); S.view = 'explorer'; renderAll(); break; }
      case 'win-min': win?.minimize(); break;
      case 'win-max': win?.toggleMaximize(); break;
      case 'win-close': if (S.tabs.some(isDirty) && !(await confirmBox('Close Nusa Studio?', 'Some editors have unsaved changes. They are lost if you close now.', 'Close', true))) break; win?.close(); break;
    }
  });
  $('#tabs').addEventListener('auxclick', (e) => {
    const tab = (e.target as HTMLElement).closest('.tab') as HTMLElement | null;
    if (tab && e.button === 1) closeTab(tab.dataset.key as string);
  });

  // ------------------------------------------------------------------ keyboard
  const keyName = (e: KeyboardEvent) => {
    let k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length === 1) k = k.toUpperCase();
    return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && k.length > 1 ? 'Shift+' : e.shiftKey && /[A-Z]/.test(k) ? 'Shift+' : '') + k;
  };
  document.addEventListener('keydown', (e) => {
    if (!$('#ctx').hidden && e.key === 'Escape') { hideMenu(); e.preventDefault(); return; }
    if (!$('#infoPop').hidden && e.key === 'Escape') { hidePop(); e.preventDefault(); return; }
    if (!$('#modal').hidden) { if (e.key === 'Escape' && modalResolve) { modalResolve(null); e.preventDefault(); } return; }
    if (!$('#palette').hidden) return;
    const k = keyName(e);
    const inEditor = !!(e.target as HTMLElement).closest('.CodeMirror');
    if (k === 'F1') { e.preventDefault(); if (inEditor && ext('docs')) keywordDocs(); else openPalette('cmd'); return; }
    const dbg = !!(S.debug && !S.debug.done);
    const cmdFor = CMDS.find(c => c.key === k && (!c.when || c.when()) && (dbg ? (c.debugOnly || !CMDS.some(x => x.debugOnly && x.key === k)) : !c.debugOnly));
    if (!cmdFor) return;
    const inField = (e.target as HTMLElement).matches('input,select,textarea') && !inEditor;
    if (inField && !/^(Ctrl\+Shift\+[AP]|Ctrl\+S|F8|Ctrl\+W)$/.test(k)) return;
    if (inField && k === 'F8' && cur()?.view !== 'data') return;
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
    app.style.setProperty('--side-w', Math.min(600, Math.max(200, e.clientX - left)) + 'px');
  });
  dragSash($('#sashPanel'), (e) => {
    const bottom = $('#status').getBoundingClientRect().top;
    app.style.setProperty('--panel-h', Math.min(window.innerHeight * 0.7, Math.max(90, bottom - e.clientY)) + 'px');
  });
  window.addEventListener('beforeunload', (e) => { if (S.tabs.some(isDirty)) { e.preventDefault(); } });
  window.addEventListener('resize', debounce(() => cm.refresh(), 100));

  // ------------------------------------------------------------------ boot
  S.conns = await backend.connections();
  if (!S.conns.some(c => c.id === S.conn)) S.conn = S.conns[0]?.id || '';
  if (!S.conn) { renderAll(); return; }
  renderAll();
  await connectCurrent();
  setTimeout(eclipseTip, 1500);
  setTimeout(() => { checkUpdates().catch(() => undefined); }, 8000);
}
