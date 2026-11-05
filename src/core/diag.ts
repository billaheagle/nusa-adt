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
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***')
    .replace(/(\/H\/[^\s]*?\/W\/)[^/\s]+/gi, '$1***'); // SAProuter route passwords
}

export function diagReport(info: Record<string, string | undefined>, conn: string, max = 60): string {
  const head = Object.entries(info).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${redact(String(v))}`);
  const lines = diagEntries(conn).slice(-max).map(e => `${e.at}  ${e.line}`);
  return ['Nusa Studio diagnostics', ...head, '', `Last ${lines.length} requests:`, ...(lines.length ? lines : ['(none)'])].join('\n');
}

/**
 * For a public problem report: host names, IP addresses, user names and SAProuter routes
 * become placeholders. `words` are the values of the system (hosts, user, router string).
 */
export function anonymize(s: string, words: (string | undefined)[] = []): string {
  let out = redact(s);
  const list = [...new Set(words.filter((w): w is string => !!w && w.trim().length >= 3).map(w => w.trim()))].sort((a, b) => b.length - a.length);
  for (const w of list) out = out.split(w).join('<hidden>');
  return out
    .replace(/\/H\/[^\s]+/g, '/H/<route>')                                          // SAProuter strings
    .replace(/\b(https?|wss?):\/\/[^/\s:]+/gi, '$1://<host>')                          // URLs
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')                                  // IPv4
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|corp|lan|intra|com|net|org|id|co|io|cloud)\b/gi, m => /^(github|sap|ondemand|hana)\./i.test(m) ? m : '<host>');
}

/** A new GitHub issue with the text filled in. GitHub refuses very long URLs, so the body is cut. */
export function issueUrl(repo: string, title: string, body: string, max = 6000): { url: string; cut: boolean } {
  const cut = body.length > max;
  const text = cut ? body.slice(0, max) + '\n\n… (cut: paste the full diagnostics from the clipboard here)' : body;
  return { url: `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`, cut };
}
