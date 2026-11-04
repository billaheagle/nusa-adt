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

/**
 * Splits a full SAP GUI route such as `/H/36.92.53.190/S/3299/W/pw/H/10.27.1.2/S/3220` into the
 * SAProuter part and the application server with its instance number (port 32NN or 33NN).
 * A plain SAProuter string is returned unchanged.
 */
export function splitGuiRoute(raw: string): { saprouter: string; ashost?: string; sysnr?: string } {
  const t = raw.trim().replace(/\s+/g, '');
  const hops = t.split(/(?=\/H\/)/i).filter(Boolean);
  const m = /^\/H\/([^/]+)\/S\/(?:sapdp|sapgw)?(3[23]\d\d)$/i.exec(hops[hops.length - 1] || '');
  if (hops.length < 2 || !m || m[2] === '3299') return { saprouter: t };
  return { saprouter: hops.slice(0, -1).join(''), ashost: m[1], sysnr: m[2].slice(2) };
}

/** What to show for an RFC system: server, instance and the SAProuter with its password hidden. */
export function rfcTarget(c: { ashost?: string; sysnr?: string; saprouter?: string }): string {
  const r = (c.saprouter || '').replace(/\/W\/[^/]*/gi, '/W/***');
  return `${c.ashost || '?'} · instance ${c.sysnr || '?'}${r ? ` via ${r}` : ''}`;
}
