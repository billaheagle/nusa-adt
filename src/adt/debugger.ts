// ABAP external debugger over ADT. EXPERIMENTAL: follows the request sequence ADT clients
// use (listener -> breakpoints -> attach -> step/stack/variables) but has only been
// exercised against recorded payloads, not a live system. Expect to adjust payloads.

import { AdtClient } from './client';
import { attr, all, encode, parseStart, parseXml, textOf } from './xml';
import { DebugVar } from '../core/types';

const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();

export interface StackFrame { name: string; uri: string; line: number }

export class AdtDebugger {
  readonly terminalId = rnd(32);
  readonly ideId = 'NUSA' + rnd(28);
  private debuggee = '';

  constructor(private c: AdtClient, private user: string) {}

  private q(extra: Record<string, string> = {}) {
    return { debuggingMode: 'user', requestUser: this.user.toUpperCase(), terminalId: this.terminalId, ideId: this.ideId, ...extra };
  }

  async setBreakpoints(bps: { sourceUrl: string; line: number }[]): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><dbg:breakpoints scope="external" debuggingMode="user" requestUser="${encode(this.user.toUpperCase())}" terminalId="${this.terminalId}" ideId="${this.ideId}" systemDebugging="false" deactivated="false" xmlns:dbg="http://www.sap.com/adt/debugger">
<syncScope mode="full"></syncScope>${bps.map((b, i) => `<breakpoint kind="line" clientId="bp${i}" skipCount="0" adtcore:uri="${encode(b.sourceUrl)}#start=${b.line + 1}" xmlns:adtcore="http://www.sap.com/adt/core"/>`).join('')}</dbg:breakpoints>`;
    const r = await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger/breakpoints', contentType: 'application/xml', accept: 'application/xml', body });
    const errs = all(parseXml(r.body), 'breakpoint').filter(b => attr(b, 'errorMessage'));
    if (errs.length) throw new Error(attr(errs[0], 'errorMessage'));
  }

  /** Long-poll until a work process hits a breakpoint. Returns false on timeout. */
  async listen(timeoutMs = 60000): Promise<boolean> {
    const r = await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger/listeners', timeoutMs,
      query: this.q({ checkConflict: 'true', isNotifiedOnConflict: 'true' }), accept: 'application/xml',
    });
    if (!r.body.trim()) return false;
    const x = parseXml(r.body);
    if (all(x, 'CONFLICT_TEXT').length) throw new Error(textOf(x, 'CONFLICT_TEXT'));
    this.debuggee = textOf(x, 'DEBUGGEE_ID');
    return !!this.debuggee;
  }

  async attach(): Promise<void> {
    await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger', stateful: true, accept: 'application/xml',
      query: { method: 'attach', debuggeeId: this.debuggee, dynproDebugging: 'false', debuggingMode: 'user', requestUser: this.user.toUpperCase() },
    });
  }

  async step(method: 'stepInto' | 'stepOver' | 'stepReturn' | 'stepContinue'): Promise<{ ended: boolean }> {
    try {
      const r = await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger', query: { method }, stateful: true, accept: 'application/xml' });
      return { ended: /isSteppingPossible="false"/.test(r.body) };
    } catch (e) {
      if (/debuggee|ended|terminated|not attached/i.test(String((e as Error).message))) return { ended: true };
      throw e;
    }
  }

  async stack(): Promise<StackFrame[]> {
    const r = await this.c.req({ method: 'GET', path: '/sap/bc/adt/debugger/stack', query: { method: 'getStack', emode: '_', semanticURIs: 'true' }, stateful: true, accept: 'application/xml' });
    return all(parseXml(r.body), 'stackEntry').map(s => {
      const u = attr(s, 'uri') || '';
      const st = parseStart(u);
      return { name: `${attr(s, 'programName') || ''} · ${attr(s, 'eventName') || ''}`, uri: st.path, line: st.line || Math.max(0, +(attr(s, 'line') || 1) - 1) };
    });
  }

  private async children(parent: string): Promise<{ id: string; v: DebugVar; expandable: boolean }[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${encode(parent)}</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY></HIERARCHIES></DATA></asx:values></asx:abap>`;
    const r = await this.c.req({
      method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'getChildVariables' }, stateful: true,
      contentType: 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.ChildVariables',
      accept: 'application/xml, application/vnd.sap.as+xml', body,
    });
    const x = parseXml(r.body);
    const hier = all(x, 'STPDA_ADT_VARIABLE_HIERARCHY').filter(h => textOf(h, 'PARENT_ID') === parent).map(h => textOf(h, 'CHILD_ID'));
    const vars = all(x, 'STPDA_ADT_VARIABLE');
    return hier.map(id => {
      const v = vars.find(e => textOf(e, 'ID') === id);
      const meta = textOf(v, 'META_TYPE');
      return {
        id, expandable: /structure|table|objectref|dataref/i.test(meta) || id.startsWith('@'),
        v: { name: textOf(v, 'NAME') || id.replace(/^@/, ''), type: textOf(v, 'DECLARED_TYPE_NAME') || meta, value: textOf(v, 'VALUE') || (meta === 'table' ? `Table [${textOf(v, 'TABLE_LINES')}]` : '') },
      };
    });
  }

  /** Top-level groups (@PARAMETERS, @LOCALS, …) expanded one level. */
  async variables(): Promise<DebugVar[]> {
    const groups = await this.children('@ROOT');
    const out: DebugVar[] = [];
    for (const g of groups) {
      const kids = await this.children(g.id);
      for (const k of kids) {
        if (k.expandable && !k.id.startsWith('@')) {
          const sub = await this.children(k.id).catch(() => []);
          k.v.children = sub.slice(0, 50).map(s => s.v);
        }
        out.push(k.v);
      }
    }
    return out;
  }

  async stop(): Promise<void> {
    await this.c.req({ method: 'DELETE', path: '/sap/bc/adt/debugger/listeners', query: this.q({ checkConflict: 'false', notifyConflict: 'true' }) }).catch(() => undefined);
    await this.c.req({ method: 'POST', path: '/sap/bc/adt/debugger', query: { method: 'terminateDebuggee' }, stateful: true }).catch(() => undefined);
  }
}
