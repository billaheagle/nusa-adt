// Bridges to the Rust side of the desktop app (window.__TAURI__ is exposed with withGlobalTauri).
import { Connection } from '../core/types';
import { HttpRequest, HttpResponse, HttpTransport } from './client';
import { ConnStore } from '../backends/adt';
import { logDiag } from '../core/diag';

/** First readable sentence of an error body (SAP returns XML exceptions or HTML pages). */
const shortBody = (b: string) => (b || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke: Invoke = (cmd, args) => {
  const t = (window as unknown as { __TAURI__?: { core: { invoke: Invoke } } }).__TAURI__;
  if (!t) return Promise.reject(new Error('Not running inside the Nusa Studio desktop app'));
  return t.core.invoke(cmd, args);
};

export class TauriTransport implements HttpTransport {
  async request(conn: string, req: HttpRequest): Promise<HttpResponse> {
    const query = Object.fromEntries(Object.entries(req.query || {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const started = performance.now();
    const what = `${req.method} ${req.path}${req.stateful ? ' (stateful)' : ''}`;
    try {
      const r = await invoke<HttpResponse>('adt_request', { conn, req: { ...req, query, headers: req.headers || {}, body: req.body ?? null, stateful: !!req.stateful, timeoutMs: req.timeoutMs ?? null } });
      const ms = Math.round(performance.now() - started);
      const err = r.status >= 400 ? ' ' + (r.headers?.['sap-err-id'] || shortBody(r.body)) : '';
      const size = r.body ? ` ${r.body.length < 1024 ? r.body.length + ' B' : (r.body.length / 1024).toFixed(1) + ' kB'}` : '';
      // transport lists are small and hold no secrets: keep their answer, so an empty list can be explained
      const peek = /\/cts\/transportrequests|\/systeminformation/.test(req.path) && r.body && r.status < 400
        ? ` · ${Object.keys(query).length ? '?' + new URLSearchParams(query).toString() + ' · ' : ''}${r.body.replace(/<\?xml[^>]*\?>/, '').replace(/\s+/g, ' ').trim().slice(0, 900)}` : '';
      logDiag(conn, `${what} → ${r.status} ${ms} ms${size}${err}${peek}`);
      return r;
    } catch (e) {
      logDiag(conn, `${what} ✕ ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
}

export class TauriConnStore implements ConnStore {
  list() { return invoke<Connection[]>('list_connections'); }
  save(c: Connection, secret?: string) { return invoke<void>('save_connection', { conn: c, secret: secret ?? null }); }
  remove(id: string) { return invoke<void>('delete_connection', { id }); }
  resetSession(id: string) { return invoke<void>('reset_session', { id }); }
}

/** Updates: latest release on GitHub, and installing a signed update in place. */
export const desktopUpdates = {
  check: () => invoke<{ version: string; current: string; notes: string; url: string; installable: boolean } | null>('check_update'),
  install: () => invoke<void>('install_update'),
};

/** Browser logon in the desktop app: the link while it waits, and ways to reopen or cancel it. */
export const desktopLogon = {
  listen(cb: (e: { state: 'waiting' | 'done'; url: string }) => void) {
    const ev = (window as unknown as { __TAURI__?: { event?: { listen(n: string, f: (e: { payload: unknown }) => void): Promise<unknown> } } }).__TAURI__?.event;
    ev?.listen('browser-logon', e => cb(e.payload as { state: 'waiting' | 'done'; url: string })).catch(() => undefined);
  },
  cancel() { return invoke<void>('cancel_logon'); },
  reopen() { return invoke<void>('reopen_logon'); },
};
