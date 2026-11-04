/** Connection log for "Copy diagnostics": requests without bodies, never credentials. */

export interface DiagEntry { at: string; conn: string; line: string }
const LOG: DiagEntry[] = [];
const MAX = 200;

const time = () => new Date().toISOString().slice(11, 23);

export function logDiag(conn: string, line: string) {
  LOG.push({ at: time(), conn, line: redact(line) });
  if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX);
}

export function diagEntries(conn?: string): DiagEntry[] {
  return conn ? LOG.filter(e => e.conn === conn) : LOG.slice();
}

/** Removes things that look like secrets from a log line. */
export function redact(s: string): string {
  return s
    .replace(/(reentrance-ticket|MYSAPSSO2|access_token|refresh_token|client_secret|password|sap-password)=([^&\s;]+)/gi, '$1=***')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
}

export function diagReport(info: Record<string, string | undefined>, conn: string, max = 60): string {
  const head = Object.entries(info).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${redact(String(v))}`);
  const lines = diagEntries(conn).slice(-max).map(e => `${e.at}  ${e.line}`);
  return ['Nusa Studio diagnostics', ...head, '', `Last ${lines.length} requests:`, ...(lines.length ? lines : ['(none)'])].join('\n');
}
