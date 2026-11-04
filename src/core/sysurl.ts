/**
 * API and UI origins of a system from whatever the user pasted: a Fiori launchpad link
 * (`https://my123456.s4hana.cloud.sap/ui#Shell-home`), the API URL or a BTP host.
 * Mirrors `system_hosts` in src-tauri/src/oauth.rs.
 */
export function systemHosts(raw: string): { api: string; ui: string } {
  const t = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(t); } catch { return { api: t, ui: t }; }
  const host = u.hostname.toLowerCase();
  const port = u.port ? `:${u.port}` : '';
  const dot = host.indexOf('.');
  const first = dot < 0 ? host : host.slice(0, dot);
  const rest = dot < 0 ? '' : host.slice(dot + 1);
  let api = host, ui = host;
  if (rest.startsWith('s4hana.')) {
    const tenant = first.replace(/-api$/, '');
    api = `${tenant}-api.${rest}`; ui = `${tenant}.${rest}`;
  } else if (host.includes('.abap-web.')) {
    api = host.replace('.abap-web.', '.abap.');
  } else if (host.includes('.abap.')) {
    ui = host.replace('.abap.', '.abap-web.');
  }
  return { api: `${u.protocol}//${api}${port}`, ui: `${u.protocol}//${ui}${port}` };
}

/** The URL to store for a system: the ADT origin, without paths such as `/ui#Shell-home`. */
export function systemUrl(kind: 's4' | 's4cloud' | 'btp' | 'runner', raw: string): string {
  const t = raw.trim().replace(/\/+$/, '');
  return kind === 'runner' ? t : systemHosts(t).api;
}
