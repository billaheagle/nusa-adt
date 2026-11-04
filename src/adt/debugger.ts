// ABAP external debugger over ADT, in the order Eclipse ADT uses:
//   breakpoints (external, per user) → listener (long poll) → attach (stateful session)
//   → step / stack / variables → terminate.
// A listener waits until any work process of the user reaches a breakpoint, so a Fiori app,
// an OData call or a console class run from here all stop the same way.

import { AdtClient } from './client';
import { attr, all, encode, parseStart, parseXml, textOf, XEl } from './xml';
import { DebugVar } from '../core/types';

const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();

export interface StackFrame { name: string; uri: string; line: number; stackUri?: string; position: number }
export interface BreakpointResult { line: number; sourceUrl: string; error?: string }

const ASX = 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.';
const ASX_ACCEPT = 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.';
const asxBody = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${inner}</DATA></asx:values></asx:abap>`;

/** The message of an ADT exception document, or null. */
export function debugError(body: string): string | null {
  if (!/<(\w+:)?exception[\s>]/.test(body)) return null;
  const x = parseXml(body);
  const props = Object.fromEntries(all(x, 'entry').map(e => [attr(e, 'key') || '', (e.text || '').trim()]));
  return props.conflictText || textOf(x, 'localizedMessage') || textOf(x, 'message') || 'The debugger reported an error';
}

const GROUP_LABEL: Record<string, string> = { '@PARAMETERS': 'Parameters', '@LOCALS': 'Locals', '@GLOBALS': 'Globals', '@ME': 'Me', '@SYSTEM': 'System fields', '@ROOT': 'Variables' };
const groupLabel = (id: string) => GROUP_LABEL[id] || id.replace(/^@/, '').toLowerCase().replace(/^\w/, c => c.toUpperCase());

/** One variable of a getChildVariables / getVariables answer. */
export function toVar(v: XEl | undefined, id: string): DebugVar {
  const meta = textOf(v, 'META_TYPE');
  const lines = textOf(v, 'TABLE_LINES');
  const isGroup = id.startsWith('@');
  const expandable = isGroup || /structure|table|objectref|dataref|object|class/i.test(meta);
  const value = meta === 'table' ? `${lines || 0} ${lines === '1' ? 'line' : 'lines'}` : textOf(v, 'VALUE') || (meta === 'objectref' ? textOf(v, 'ACTUAL_TYPE_NAME') : '');
  return {
    id, expandable, group: isGroup || undefined,
    name: isGroup ? groupLabel(id) : textOf(v, 'NAME') || id,
    type: textOf(v, 'DECLARED_TYPE_NAME') || textOf(v, 'ACTUAL_TYPE_NAME') || meta,
    value,
  };
}

export function parseChildren(body: string, parent: string): DebugVar[] {
  const x = parseXml(body);
  const vars = all(x, 'STPDA_ADT_VARIABLE');
  const ids = all(x, 'STPDA_ADT_VARIABLE_HIERARCHY').filter(h => textOf(h, 'PARENT_ID') === parent).map(h => textOf(h, 'CHILD_ID'));
  return ids.map(id => toVar(vars.find(e => textOf(e, 'ID') === id), id));
}

export function parseStack(body: string): StackFrame[] {
  return all(parseXml(body), 'stackEntry').map((s, i) => {
    const u = attr(s, 'uri') || '';
    const st = parseStart(u);
    const event = attr(s, 'eventName') || '';
    const prog = attr(s, 'programName') || attr(s, 'includeName') || '';
    return {
      name: event ? `${prog} · ${event}` : prog, uri: st.path,
      line: u.includes('#start=') ? st.line : Math.max(0, +(attr(s, 'line') || 1) - 1),
      stackUri: attr(s, 'stackUri') || undefined,
      position: +(attr(s, 'stackPosition') || attr(s, 'position') || i),
    };
  });
}

export class AdtDebugger {
  readonly terminalId = rnd(32);
  readonly ideId = 'NUSA' + rnd(28);
  private debuggee = '';
  private bpKey = '';

  constructor(private c: AdtClient, private user: string) {}

  private q(extra: Record<string, string> = {}) {
    return { debuggingMode: 'user', requestUser: this.user.toUpperCase(), terminalId: this.terminalId, ideId: this.ideId, ...extra };
  }

  /**
   * Sends the full set of breakpoints (sync mode "full"). Lines the system cannot stop at
   * come back with an error; they are reported instead of failing the whole session.
   */
  async setBreakpoints(bps: { sourceUrl: string; line: number }[], force = false): Promise<BreakpointResult[]> {
    const key = JSON.stringify(bps);
    if (!force && key === this.bpKey) return [];
    const body = `<?xml version="1.0" encoding="UTF-8"?><dbg:breakpoints scope="external" debuggingMode="user" requestUser="${encode(this.user.toUpperCase())}" terminalId="${this.terminalId}" ideId="${this.ideId}" systemDebugging="false" deactivated="false" xmlns:dbg="http://www.sap.com/adt/debugger">
<syncScope mode="full"></syncScope>${bps.map((b, i) => `<breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="line" clientId="nusa-${i}" skipCount="0" adtcore:uri="${encode(b.sourceUrl)}#start=${b.line + 1}"/>`).join('')}</dbg:breakpoints>`;
    const r = await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger/breakpoints', contentType: 'application/xml', accept: 'application/xml', body });
    this.bpKey = key;
    const back = all(parseXml(r.body), 'breakpoint');
    return bps.map((b, i) => {
      const e = back.find(x => attr(x, 'clientId') === `nusa-${i}`);
      return { ...b, error: e ? attr(e, 'errorMessage') || undefined : undefined };
    });
  }

  /**
   * Long poll until a work process of this user reaches a breakpoint. Resolves false when the
   * listener was stopped (stop(), or another IDE took over).
   */
  async listen(timeoutMs = 15 * 60_000): Promise<boolean> {
    const r = await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger/listeners', timeoutMs,
      query: this.q({ checkConflict: 'true', isNotifiedOnConflict: 'true' }), accept: 'application/xml',
    });
    if (!r.body.trim()) return false;
    const err = debugError(r.body);
    if (err) throw new Error(err);
    this.debuggee = textOf(parseXml(r.body), 'DEBUGGEE_ID');
    return !!this.debuggee;
  }

  async stopListening(): Promise<void> {
    await this.c.req({ method: 'DELETE', path: '/sap/bc/adt/debugger/listeners', query: this.q({ checkConflict: 'false', notifyConflict: 'true' }) }).catch(() => undefined);
  }

  async attach(): Promise<void> {
    const r = await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger', stateful: true, accept: 'application/xml',
      query: { method: 'attach', debuggeeId: this.debuggee, dynproDebugging: 'true', debuggingMode: 'user', requestUser: this.user.toUpperCase() },
    });
    const err = debugError(r.body);
    if (err) throw new Error(err);
  }

  async step(method: 'stepInto' | 'stepOver' | 'stepReturn' | 'stepContinue' | 'stepRunToLine', uri?: string): Promise<{ ended: boolean }> {
    try {
      const r = await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger', query: { method, ...(uri ? { uri } : {}) }, stateful: true, accept: 'application/xml' });
      const err = debugError(r.body);
      if (err) { if (/ended|terminated|no longer|not attached|debuggee/i.test(err)) return { ended: true }; throw new Error(err); }
      return { ended: /isSteppingPossible="false"/.test(r.body) };
    } catch (e) {
      if (/debuggee|ended|terminated|not attached|no longer/i.test(String((e as Error).message))) return { ended: true };
      throw e;
    }
  }

  async stack(): Promise<StackFrame[]> {
    const r = await this.c.req({ method: 'GET', path: '/sap/bc/adt/debugger/stack', query: { method: 'getStack', emode: '_', semanticURIs: 'true' }, stateful: true, accept: 'application/xml' });
    return parseStack(r.body);
  }

  /** Makes another frame current, so variables show that frame. */
  async gotoFrame(f: StackFrame): Promise<void> {
    if (f.stackUri) await this.c.req({ method: 'PUT', path: f.stackUri, stateful: true });
    else await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'setStackPosition', position: String(f.position) }, stateful: true });
  }

  async children(parent: string): Promise<DebugVar[]> {
    const r = await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'getChildVariables' }, stateful: true,
      contentType: ASX + 'ChildVariables', accept: ASX_ACCEPT + 'ChildVariables',
      body: asxBody(`<HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${encode(parent)}</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY></HIERARCHIES>`),
    });
    return parseChildren(r.body, parent);
  }

  /** Rows of an internal table (`ITAB[1]` …), at most `max`. */
  async rows(v: DebugVar, max = 100): Promise<DebugVar[]> {
    const n = Math.min(max, parseInt(v.value, 10) || 0);
    if (!n || !v.id) return [];
    const base = v.id.replace(/\[\]$/, '');
    const ids = Array.from({ length: n }, (_, i) => `${base}[${i + 1}]`);
    const r = await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'getVariables' }, stateful: true,
      contentType: ASX + 'Variables', accept: ASX_ACCEPT + 'Variables',
      body: asxBody(ids.map(id => `<STPDA_ADT_VARIABLE><ID>${encode(id)}</ID></STPDA_ADT_VARIABLE>`).join('')),
    });
    const vars = all(parseXml(r.body), 'STPDA_ADT_VARIABLE');
    return ids.map((id, i) => {
      const x = vars.find(e => textOf(e, 'ID') === id);
      const row = toVar(x, id);
      return { ...row, name: `[${i + 1}]` };
    });
  }

  /** Expands a variable: a table gives its rows, everything else its components. */
  async expand(v: DebugVar): Promise<DebugVar[]> {
    if (/\d+ lines?$/.test(v.value) && v.id && !v.group) return this.rows(v);
    return v.id ? this.children(v.id) : [];
  }

  /**
   * Groups (Parameters, Locals, …) with their variables, the way the Variables view opens.
   * The members of me and of the globals stay collapsed until opened.
   */
  async variables(): Promise<DebugVar[]> {
    const groups = (await this.children('@ROOT')).filter(g => g.id !== '@DATAAGING');
    for (const g of groups) {
      if (/^@(PARAMETERS|LOCALS)$/.test(g.id || '') || groups.length === 1) g.children = await this.children(g.id as string).catch(() => []);
    }
    return groups;
  }

  async setValue(name: string, value: string): Promise<void> {
    const r = await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'setVariableValue', variableName: name }, stateful: true, contentType: 'text/plain', accept: 'application/xml, text/plain', body: value });
    const err = debugError(r.body);
    if (err) throw new Error(err);
  }

  async stop(): Promise<void> {
    await this.stopListening();
    if (this.debuggee) await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'terminateDebuggee' }, stateful: true }).catch(() => undefined);
    this.debuggee = '';
  }

  /** Removes the breakpoints of this IDE from the system (sync with an empty list). */
  async clearBreakpoints(): Promise<void> {
    await this.setBreakpoints([], true).catch(() => undefined);
  }
}

