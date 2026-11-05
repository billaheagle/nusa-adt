// Transport Organizer list (SE09/SE10 style): Modifiable/Released tabs, groups by request
// category, object entries with checkboxes for Move and Remove. Pure renderers.

import { ObjState, ObjType, Transport, TYPE_INFO } from '../core/types';
import { ic, typeIcon } from './icons';
import { esc } from './util';

export interface TrView {
  tab: Transport['status'];
  conn: string;
  collapsed: Set<string>;
  /** ticked object entries per request */
  picks: Map<string, Set<string>>;
  /** objects by "TYPE NAME" */
  index: Map<string, ObjState>;
}

export function glyph(type: ObjType | 'DATA') {
  return `<i class="glyph g-${type}" title="${esc(type === 'DATA' ? 'Data preview' : TYPE_INFO[type].label)}">${typeIcon(type)}</i>`;
}

export const TR_CATS: [NonNullable<Transport['category']>, string][] = [['workbench', 'Workbench requests'], ['customizing', 'Customizing requests'], ['copies', 'Transports of copies']];
export function trTabsHtml(list: Transport[], v: TrView): string {
  if (!list.length) return '';
  const n = (st: Transport['status']) => list.filter(t => t.status === st).length;
  return `<div class="seg tr-tabs" role="tablist">${(['modifiable', 'released'] as const).map(st => `<button role="tab" class="${v.tab === st ? 'on' : ''}" aria-selected="${v.tab === st}" data-act="tr-tab" data-id="${st}">${st === 'modifiable' ? 'Modifiable' : 'Released'}<span class="cnt">${n(st)}</span></button>`).join('')}</div>`;
}
export function trGroupsHtml(list: Transport[], v: TrView): string {
  if (!list.length) return `<ul class="trs"><li class="empty">${v.tab === 'released' ? 'No released requests in the period the system returns.' : 'No modifiable requests. Create one above.'}</li></ul>`;
  return TR_CATS.map(([cat, label]) => {
    const items = list.filter(t => (t.category || 'workbench') === cat);
    if (!items.length) return '';
    const id = `tr/${v.conn}/${cat}`;
    return `<section class="tr-group ${v.collapsed.has(id) ? 'closed' : ''}"><button class="tr-gh" data-act="toggle" data-id="${esc(id)}" aria-expanded="${!v.collapsed.has(id)}">${ic('chev', 'twisty')}${label}<span class="cnt">${items.length}</span></button>
      <ul class="trs">${items.map(t => trItem(t, v)).join('')}</ul></section>`;
  }).join('');
}
function trItem(t: Transport, v: TrView): string {
  return `
      <li class="tr ${t.status}">
        <div class="tr-head">
          <code>${esc(t.id)}</code>
          <span class="pill ${t.status === 'modifiable' ? 'p-open' : 'p-done'}">${t.status === 'modifiable' ? 'Modifiable' : 'Released'}</span>
        </div>
        <div class="tr-desc">${esc(t.desc)}</div>
        <div class="tr-meta">Owner ${esc(t.owner)}${t.task ? ` · Task <code>${esc(t.task)}</code>` : ''}</div>
        <ul class="tr-objs">${t.objects.map(e => {
          const [, type, name] = e.split(' ');
          const o = v.index.get(`${type} ${name}`);
          const g = type in TYPE_INFO ? glyph(type as ObjType) : `<i class="glyph g-${type === 'DEVC' ? 'DEVC' : 'XOBJ'}">${typeIcon(type)}</i>`;
          const pick = t.status === 'modifiable' ? `<input type="checkbox" class="tr-pick" data-tr="${esc(t.id)}" data-entry="${esc(e)}" ${v.picks.get(t.id)?.has(e) ? 'checked' : ''} aria-label="Select ${esc(name)}">` : '';
          return `<li title="${esc(e)}">${pick}${o ? `<button class="link" data-act="open" data-uri="${esc(o.uri)}">` : '<span>'}${g}<span class="tr-name">${esc(name)}</span>${o ? '</button>' : '</span>'}<small>${esc(type)}</small></li>`;
        }).join('') || '<li class="empty">No objects recorded</li>'}</ul>
        ${t.status !== 'modifiable' ? '' : v.picks.get(t.id)?.size ? `<div class="tr-actions picked"><span class="muted">${v.picks.get(t.id)!.size} selected</span><button class="btn small" data-act="tr-move" data-id="${esc(t.id)}" title="Move the selected objects to another request">Move…</button><button class="btn ghost small danger-text" data-act="tr-remove" data-id="${esc(t.id)}" title="Remove the selected objects from this request; the objects stay">Remove…</button><button class="btn ghost small" data-act="tr-unpick" data-id="${esc(t.id)}">Clear</button></div>`
          : `<div class="tr-actions"><button class="btn ghost small" data-act="release" data-id="${esc(t.id)}">Release…</button><button class="btn ghost small" data-act="tr-edit" data-id="${esc(t.id)}">Edit description</button><button class="btn ghost small danger-text" data-act="tr-delete" data-id="${esc(t.id)}">Delete…</button></div>`}
      </li>`;
}
