// The Add system / Edit system form: system type, URL or RFC logon values, SDK folder,
// user and secret. Returns the form and the code that runs it inside the dialog.

import type { Connection } from '../core/types';
import { splitGuiRoute, systemUrl } from '../core/sysurl';
import type { ToolsBridge } from './bridges';
import { $, debounce, esc, msg } from './util';

export function systemFormDialog(existing: Connection | undefined, tools: ToolsBridge | undefined, fail: (e: unknown) => void): {
  body: string;
  mount: (root: HTMLElement, close: (v: unknown) => void) => void;
} {
  const e = existing;
  const kind0 = e?.kind || 's4';
  const auth0 = e?.auth || 'basic';
  const body = `
    <label class="field"><span>System type</span><select id="sfKind" ${e ? 'disabled' : ''}>
      <option value="s4" ${kind0 === 's4' ? 'selected' : ''}>S/4HANA or NetWeaver (on-premise)</option>
      <option value="s4cloud" ${kind0 === 's4cloud' ? 'selected' : ''}>S/4HANA Cloud Public Edition</option>
      <option value="btp" ${kind0 === 'btp' ? 'selected' : ''}>SAP BTP ABAP Environment</option>
      <option value="runner" ${kind0 === 'runner' ? 'selected' : ''}>Local ABAP runner</option></select></label>
    <label class="field" id="sfUrlField"><span>System URL</span><input id="sfUrl" value="${esc(e?.url || '')}" autocomplete="off" spellcheck="false"><small class="hint" id="sfUrlHint"></small></label>
    <div class="two" data-k="s4 runner"><label class="field"><span>System ID</span><input id="sfSid" maxlength="8" value="${esc(e?.sid || '')}" placeholder="S4D" autocomplete="off"></label>
      <label class="field" data-k="s4"><span>Client</span><input id="sfClient" maxlength="3" inputmode="numeric" value="${esc(e?.client || '100')}"></label></div>
    <div class="two" data-k="s4 s4cloud btp">
      <label class="field" data-k="s4 btp"><span>Logon</span><select id="sfAuth"></select></label>
      <label class="field"><span>Language</span><input id="sfLang" maxlength="2" value="${esc(e?.language || 'EN')}"></label></div>
    <div data-a="rfc" class="rfc-box">
      <label class="field"><span>Application server</span><input id="sfHost" value="${esc(e?.ashost || '')}" placeholder="10.27.1.2" autocomplete="off" spellcheck="false"></label>
      <div class="two"><label class="field"><span>Instance number</span><input id="sfSysnr" maxlength="2" inputmode="numeric" value="${esc(e?.sysnr || '')}" placeholder="00"></label>
        <label class="field"><span>SAProuter string <small>optional</small></span><input id="sfRouter" value="${esc(e?.saprouter || '')}" placeholder="/H/saprouter.example.com/S/3299" autocomplete="off" spellcheck="false"></label></div>
      <small class="hint">The same values as the entry in SAP GUI Logon (Properties → Connection). A full route that ends with the server, such as /H/router/S/3299/H/10.27.1.2/S/3220, is split for you.</small>
      <label class="field"><span>SAP NW RFC SDK folder</span>
        <div class="with-btn"><input id="sfSdk" value="${esc(e?.rfcSdk || '')}" placeholder="C:\\SAP\\nwrfcsdk" autocomplete="off" spellcheck="false">${tools ? '<button type="button" class="btn" id="sfSdkPick">Browse…</button>' : ''}</div>
        <small class="hint" id="sfSdkState">The folder you extracted from the SAP Software Center download (it contains lib\\sapnwrfc.dll). SAP does not allow apps to ship it.</small></label>
    </div>
    <label class="field" data-a="basic sso rfc"><span id="sfUserLabel">User</span><input id="sfUser" value="${esc(e?.user || '')}" autocomplete="off" spellcheck="false"></label>
    <label class="field" data-a="basic rfc"><span>Password</span><input id="sfPw" type="password" autocomplete="off" placeholder="${e && (e.auth === 'basic' || e.auth === 'rfc') ? 'Leave empty to keep the saved password' : ''}"></label>
    <label class="field" data-a="oauth"><span>Service key (JSON)</span><textarea id="sfKey" rows="6" spellcheck="false" placeholder='${e && e.auth === 'oauth' ? 'Leave empty to keep the saved key' : '{ "url": "…", "uaa": { "url": "…", "clientid": "…", "clientsecret": "…" } }'}'></textarea></label>
    <p class="note" id="sfNote"></p>
    <label class="field"><span>Name in the list <small>optional</small></span><input id="sfLabel" value="${esc(e?.label || '')}" maxlength="60"></label>
    <label class="check" data-k="s4 runner"><input type="checkbox" id="sfSelf" ${e?.allowSelfSigned ? 'checked' : ''}><span>Accept a self-signed certificate (development systems only)</span></label>
    <p class="form-err" id="sfErr" hidden></p>`;
  const mount = (root: HTMLElement, close: (v: unknown) => void) => {
    const kindEl = $<HTMLSelectElement>('#sfKind', root);
    const authEl = $<HTMLSelectElement>('#sfAuth', root);
    const HINT: Record<Connection['kind'], string> = {
      s4: 'For example https://vhcals4hci.dummy.nodomain:44300. The HTTPS port is in transaction SMICM → Services.',
      s4cloud: 'The address you open in the browser, such as https://my123456.s4hana.cloud.sap, or its API URL https://my123456-api.s4hana.cloud.sap. Links with /ui#Shell-home work too.',
      btp: 'The URL of the ABAP environment instance, for example https://1a2b3c4d.abap.eu10.hana.ondemand.com (the abap-web launchpad address works too).',
      runner: 'For example http://localhost:7777.',
    };
    const AUTHS: Record<Connection['kind'], [Connection['auth'], string][]> = {
      s4: [['basic', 'User and password (HTTPS)'], ['rfc', 'SAP GUI / RFC (SAProuter)'], ['sso', 'Browser logon (SAML single sign-on)']],
      s4cloud: [['sso', 'Browser logon']], btp: [['sso', 'Browser logon with the system URL'], ['oauth', 'Service key']], runner: [['none', 'None']],
    };
    const sync = () => {
      const k = kindEl.value as Connection['kind'];
      const prev = authEl.value || auth0;
      authEl.innerHTML = AUTHS[k].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      authEl.value = AUTHS[k].some(([v]) => v === prev) ? prev : AUTHS[k][0][0];
      const a = authEl.value as Connection['auth'];
      root.querySelectorAll<HTMLElement>('[data-k]').forEach(el => { el.hidden = !(el.dataset.k as string).split(' ').includes(k); });
      root.querySelectorAll<HTMLElement>('[data-a]').forEach(el => { el.hidden = !(el.dataset.a as string).split(' ').includes(a) || k === 'runner'; });
      $('#sfUrlHint', root).textContent = HINT[k];
      $('#sfUrlField', root).hidden = a === 'rfc';
      $('#sfSelf', root).closest('label')!.hidden = k === 'runner' ? false : k !== 's4' || a === 'rfc';
      $('#sfUserLabel', root).textContent = a === 'sso' ? 'User ID (optional, shows your transport requests)' : 'User';
      $<HTMLInputElement>('#sfUrl', root).placeholder = k === 's4cloud' ? 'https://my123456.s4hana.cloud.sap' : k === 'btp' ? 'https://<id>.abap.<region>.hana.ondemand.com' : k === 'runner' ? 'http://localhost:7777' : 'https://host:44300';
      $('#sfNote', root).textContent = a === 'sso' ? 'Your browser opens for the logon, the same way Eclipse does it. Nusa Studio receives a logon ticket on http://localhost and keeps it for this session. Your user needs the developer role (SAP_BR_DEVELOPER on SAP cloud systems).'
        : a === 'oauth' ? 'Create the service key in the SAP BTP cockpit on your ABAP environment instance. It is stored in the operating system keychain.'
          : a === 'basic' ? 'The password is stored in the operating system keychain, never in a file.'
            : a === 'rfc' ? 'Eclipse connects to on-premise systems this way: over RFC, through the SAProuter if there is one, so no HTTPS port has to be open. The password is stored in the operating system keychain. Several wrong passwords lock the user, so Nusa Studio stops after the first rejected logon.' : '';
    };
    sync();
    kindEl.onchange = sync; authEl.onchange = sync;
    // RFC SDK folder: find it where people usually put it, check it as it is typed or picked
    const sdkEl = $<HTMLInputElement>('#sfSdk', root);
    const sdkState = $('#sfSdkState', root);
        let sdkSeq = 0;
    const checkSdk = async () => {
      if (!tools) return;
      const dir = sdkEl.value.trim();
      const seq = ++sdkSeq;
      if (!dir) { sdkState.className = 'hint'; sdkState.textContent = 'Choose the folder you extracted the SAP NW RFC SDK to.'; return; }
      try {
        const lib = await tools.checkSdk(dir);
        if (seq !== sdkSeq) return;
        sdkState.className = 'hint ok-hint'; sdkState.textContent = `Found ${lib}`;
      } catch (er) {
        if (seq !== sdkSeq) return;
        sdkState.className = 'hint err-hint'; sdkState.textContent = msg(er);
      }
    };
    sdkEl.addEventListener('input', debounce(checkSdk, 350));
    const pick = document.getElementById('sfSdkPick');
    if (pick && tools) pick.onclick = async () => {
      try { const d = await tools.pickFolder(sdkEl.value.trim() || undefined); if (d) { sdkEl.value = d; await checkSdk(); } }
      catch (er) { fail(er); }
    };
    const prepareSdk = async () => {
      if (!tools || authEl.value !== 'rfc') return;
      if (!sdkEl.value.trim()) { const found = await tools.detectSdk().catch(() => null); if (found && !sdkEl.value.trim()) sdkEl.value = found; }
      await checkSdk();
    };
    authEl.addEventListener('change', prepareSdk);
    prepareSdk();
    const routerEl = $<HTMLInputElement>('#sfRouter', root);
    routerEl.onchange = () => {
      const r = splitGuiRoute(routerEl.value);
      routerEl.value = r.saprouter;
      if (r.ashost) { $<HTMLInputElement>('#sfHost', root).value = r.ashost; $<HTMLInputElement>('#sfSysnr', root).value = r.sysnr || ''; }
    };
    ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
      ev.preventDefault();
      const k = kindEl.value as Connection['kind'];
      const a = authEl.value as Connection['auth'];
      const route = splitGuiRoute($<HTMLInputElement>('#sfRouter', root).value);
      const ashost = (route.ashost || $<HTMLInputElement>('#sfHost', root).value).trim();
      const sysnr = (route.sysnr || $<HTMLInputElement>('#sfSysnr', root).value).trim().padStart(2, '0');
      const rfcSdk = $<HTMLInputElement>('#sfSdk', root).value.trim();
      const url = a === 'rfc' ? `rfc://${ashost}:${sysnr}` : systemUrl(k, $<HTMLInputElement>('#sfUrl', root).value);
      let sid = $<HTMLInputElement>('#sfSid', root).value.trim().toUpperCase();
      const client = $<HTMLInputElement>('#sfClient', root).value.trim();
      const user = $<HTMLInputElement>('#sfUser', root).value.trim().toUpperCase();
      const pw = $<HTMLInputElement>('#sfPw', root).value;
      const key = $<HTMLTextAreaElement>('#sfKey', root).value.trim();
      const err = $('#sfErr', root);
      const bad = (m: string) => { err.hidden = false; err.textContent = m; };
      if (a === 'rfc') {
        if (!/^[\w.-]+$/.test(ashost)) return bad('Enter the application server, for example 10.27.1.2 or a host name.');
        if (!/^\d{2}$/.test(sysnr)) return bad('The instance number has two digits, for example 00 or 20.');
        if (route.saprouter && !/^\/H\//i.test(route.saprouter)) return bad('A SAProuter string starts with /H/, for example /H/saprouter.example.com/S/3299.');
        if (!rfcSdk) return bad('Choose the folder of the SAP NW RFC SDK.');
      } else if (!/^https?:\/\/[^\s/]+/.test(url)) return bad('Enter the system URL, starting with https://');
      if (a !== 'rfc' && k !== 'runner' && /^http:\/\//.test(url) && !/localhost|127\.0\.0\.1/.test(url)) return bad('SAP systems need https:// for logons.');
      if (k === 's4cloud' || k === 'btp') {
        if (!sid) sid = (url.replace(/^https?:\/\//, '').split(/[.:]/)[0].replace(/-api$/i, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)) || (k === 'btp' ? 'BTP' : 'S4HC');
      } else if (!/^[A-Z0-9]{3,8}$/.test(sid)) return bad('Enter the system ID, for example S4D.');
      if (k === 's4' && !/^\d{3}$/.test(client)) return bad('The client has three digits, for example 100.');
      if ((a === 'basic' || a === 'rfc') && !user) return bad('Enter your user.');
      if ((a === 'basic' || a === 'rfc') && !pw && !(e && e.auth === a)) return bad('Enter your password.');
      if (a === 'oauth' && !key && !(e && e.auth === 'oauth')) return bad('Paste the service key.');
      if (a === 'oauth' && key) { try { const j = JSON.parse(key); if (!j.uaa?.url || !j.uaa?.clientid) throw new Error('uaa'); } catch { return bad('This is not a service key. It needs a "uaa" section with url, clientid and clientsecret.'); } }
      const c: Connection = {
        id: e?.id || `${sid.toLowerCase()}-${Date.now().toString(36)}`, kind: k, sid, client: k === 's4' ? client : k === 'runner' ? '000' : '',
        user: a === 'basic' || a === 'sso' || a === 'rfc' ? user : k === 'runner' ? 'NUSA' : '', url, language: ($<HTMLInputElement>('#sfLang', root).value.trim() || 'EN').toUpperCase(),
        auth: a, abapVersion: k === 'runner' ? 'runner' : k === 's4' ? 'standard' : 'cloud',
        favoritePackages: e?.favoritePackages || (k === 'runner' ? ['$TMP'] : []), transports: k !== 'runner', runReports: k === 'runner' ? true : undefined,
        label: $<HTMLInputElement>('#sfLabel', root).value.trim() || undefined,
        allowSelfSigned: a !== 'rfc' && $<HTMLInputElement>('#sfSelf', root).checked || undefined,
        ...(a === 'rfc' ? { ashost, sysnr, saprouter: route.saprouter || undefined, rfcSdk } : {}),
      };
      close({ c, secret: a === 'basic' || a === 'rfc' ? (pw || undefined) : a === 'oauth' ? (key || undefined) : undefined });
    };
  };
  return { body, mount };
}
