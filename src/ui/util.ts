// Small helpers shared by the workbench modules: DOM lookup, escaping, storage.

export const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
export const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => { let t = 0; return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); }; };
export const msg = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));
export const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
export const json = <T>(k: string, d: T): T => { try { const v = store.get(k); return v ? { ...d, ...JSON.parse(v) } as T : d; } catch { return d; } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TAURI = (typeof window === 'undefined' ? undefined : (window as any).__TAURI__) as { window?: { getCurrentWindow(): any } } | undefined;
export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

