// The Generate RAP service dialog: table, business object name, package and the list of
// objects that will be created.

import type { ObjRef, ObjType } from '../core/types';
import { rapNames, validateRap } from '../core/rapgen';
import { glyph } from './transports-view';
import { $, esc } from './util';

export interface RapFormResult { table: string; base: string; desc: string; pkg: string; v2: boolean; pub: boolean }

export function rapFormDialog(o: { preset?: ObjRef; tables: ObjRef[]; packages: string[]; defaultPkg: string }): {
  body: string;
  mount: (root: HTMLElement, close: (v: unknown) => void) => void;
} {
  const { preset, tables } = o;
  const base0 = (preset?.name || '').replace(/^Z_?|^Y_?/, '');
  const body = `
    <p class="note">Creates a managed RAP business object with an OData V4 UI service for a database table, like <i>Generate ABAP Repository Objects</i> in Eclipse. The sources are starting points to refine.</p>
    <div class="two"><label class="field"><span>Database table</span><input id="rgTable" list="rgTables" value="${esc(preset?.name || '')}" autocomplete="off" spellcheck="false"><datalist id="rgTables">${tables.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist></label>
    <label class="field"><span>Business object name</span><input id="rgBase" value="${esc(base0)}" autocomplete="off" spellcheck="false"></label></div>
    <div class="two"><label class="field"><span>Description</span><input id="rgDesc" value="${esc(preset?.desc || '')}" maxlength="60"></label>
    <label class="field"><span>Package</span><input id="rgPkg" list="rgPkgs" value="${esc(preset?.pkg || o.defaultPkg)}" autocomplete="off" spellcheck="false"><datalist id="rgPkgs">${o.packages.map(p => `<option value="${esc(p)}">`).join('')}</datalist></label></div>
    <label class="check"><input type="checkbox" id="rgV2"><span>OData V2 instead of V4</span></label>
    <label class="check"><input type="checkbox" id="rgPub" checked><span>Publish the service binding after activation</span></label>
    <h4 class="sub">Objects</h4><ul class="plan" id="rgPlan"></ul>
    <p class="form-err" id="rgErr" hidden></p>`;
  const mount = (root: HTMLElement, close: (v: unknown) => void) => {
    const base = $<HTMLInputElement>('#rgBase', root);
    const tbl = $<HTMLInputElement>('#rgTable', root);
    const plan = $('#rgPlan', root);
    const draw = () => {
      base.value = base.value.toUpperCase();
      const n = rapNames(base.value || 'X');
      const v2 = $<HTMLInputElement>('#rgV2', root).checked;
      const rows: [ObjType, string, string][] = [['DDLS', n.root, 'root view entity'], ['DDLS', n.proj, 'projection view'], ['DDLX', n.proj, 'metadata extension'], ['BDEF', n.root, 'behavior definition (managed)'], ['BDEF', n.proj, 'behavior projection'], ['SRVD', n.srvd, 'service definition'], ['SRVB', v2 ? n.srvb.replace(/_O4$/, '_O2') : n.srvb, `service binding, OData ${v2 ? 'V2' : 'V4'} UI`]];
      plan.innerHTML = rows.map(([t, nm, d]) => `<li>${glyph(t)}<code>${esc(nm)}</code><small>${esc(d)}</small></li>`).join('');
      const v = validateRap(base.value);
      const err = $('#rgErr', root); err.hidden = !v; err.textContent = v || '';
    };
    draw();
    base.oninput = draw; ($('#rgV2', root) as HTMLInputElement).onchange = draw;
    tbl.oninput = () => { tbl.value = tbl.value.toUpperCase(); if (!base.dataset.touched) base.value = tbl.value.replace(/^Z_?|^Y_?/, ''); draw(); };
    base.addEventListener('keydown', () => { base.dataset.touched = '1'; });
    ($('#modalForm', root) as HTMLFormElement).onsubmit = (ev) => {
      ev.preventDefault();
      const e = validateRap(base.value) || (!tbl.value ? 'Enter a database table' : '') || (!$<HTMLInputElement>('#rgPkg', root).value ? 'Enter a package' : '');
      if (e) { const err = $('#rgErr', root); err.hidden = false; err.textContent = e; return; }
      close({ table: tbl.value.trim(), base: base.value.trim(), desc: $<HTMLInputElement>('#rgDesc', root).value.trim() || base.value, pkg: $<HTMLInputElement>('#rgPkg', root).value.trim().toUpperCase(), v2: $<HTMLInputElement>('#rgV2', root).checked, pub: $<HTMLInputElement>('#rgPub', root).checked });
    };
  };
  return { body, mount };
}
