// Bridges to the Rust side of the desktop app (window.__TAURI__ is exposed with withGlobalTauri).
import { Connection } from '../core/types';
import { HttpRequest, HttpResponse, HttpTransport } from './client';
import { ConnStore } from '../backends/adt';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const invoke: Invoke = (cmd, args) => {
  const t = (window as unknown as { __TAURI__?: { core: { invoke: Invoke } } }).__TAURI__;
  if (!t) return Promise.reject(new Error('Not running inside the Nusa ADT desktop app'));
  return t.core.invoke(cmd, args);
};

export class TauriTransport implements HttpTransport {
  async request(conn: string, req: HttpRequest): Promise<HttpResponse> {
    const query = Object.fromEntries(Object.entries(req.query || {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
    return invoke<HttpResponse>('adt_request', { conn, req: { ...req, query, headers: req.headers || {}, body: req.body ?? null, stateful: !!req.stateful, timeoutMs: req.timeoutMs ?? null } });
  }
}

export class TauriConnStore implements ConnStore {
  list() { return invoke<Connection[]>('list_connections'); }
  save(c: Connection, secret?: string) { return invoke<void>('save_connection', { conn: c, secret: secret ?? null }); }
  remove(id: string) { return invoke<void>('delete_connection', { id }); }
  resetSession(id: string) { return invoke<void>('reset_session', { id }); }
}
