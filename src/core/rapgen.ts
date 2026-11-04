// "Generate ABAP Repository Objects" for a database table, like the ADT wizard:
// root view entity, projection view, metadata extension, behavior definitions, service
// definition and an OData V4 UI service binding.

import { CreateExtra, ObjType } from './types';
import { Field } from './catalog';

export interface RapPlan { type: ObjType; name: string; desc: string; source: string; extra?: CreateExtra }
export interface RapInput { table: string; fields: Field[]; base: string; label: string; v2?: boolean }

const camel = (s: string) => s.toLowerCase().split(/_+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');

export function rapNames(base: string) {
  const b = base.toUpperCase().replace(/^Z_?/, '');
  return {
    root: `ZR_${b}`, proj: `ZC_${b}`, srvd: `ZUI_${b}`, srvb: `ZUI_${b}_O4`, alias: camel(b.replace(/^NUSA_/, '')) || 'Entity',
  };
}

export function validateRap(base: string): string | null {
  const n = rapNames(base);
  if (!/^[A-Z0-9_]+$/i.test(base)) return 'Use letters, digits and underscores';
  if (n.root.length > 30 || n.proj.length > 30) return `${n.root} is longer than 30 characters. Choose a shorter name.`;
  if (n.srvb.length > 26) return `${n.srvb} is longer than 26 characters. Choose a shorter name.`;
  return null;
}

export function planRap(inp: RapInput): RapPlan[] {
  const n = rapNames(inp.base);
  const table = inp.table.toLowerCase();
  const fields = inp.fields.filter(f => f.name !== '.include' && !/^(client|mandt)$/i.test(f.name) && !/clnt/i.test(f.type));
  const keys = fields.filter(f => f.key);
  const cuky = fields.find(f => /cuky|currency_code|waers/i.test(f.type + ' ' + f.name));
  const unit = fields.find(f => /unit|meins|msehi/i.test(f.type));
  const alias = (f: Field) => camel(f.name);
  const sem = (f: Field): string[] => {
    const t = f.type.toLowerCase();
    if (/curr/.test(t) && cuky) return [`@Semantics.amount.currencyCode: '${alias(cuky)}'`];
    if (/quan/.test(t) && unit) return [`@Semantics.quantity.unitOfMeasure: '${alias(unit)}'`];
    if (/abp_creation_user/.test(t)) return ['@Semantics.user.createdBy: true'];
    if (/abp_creation_tstmpl/.test(t)) return ['@Semantics.systemDateTime.createdAt: true'];
    if (/abp_lastchange_user/.test(t)) return ['@Semantics.user.lastChangedBy: true'];
    if (/abp_lastchange_tstmpl/.test(t)) return ['@Semantics.systemDateTime.lastChangedAt: true'];
    if (/abp_locinst_lastchange_tstmpl/.test(t)) return ['@Semantics.systemDateTime.localInstanceLastChangedAt: true'];
    return [];
  };
  const w = Math.max(...fields.map(f => f.name.length));
  const rootEl = fields.map(f => [...sem(f).map(a => `      ${a}`), `  ${f.key ? 'key' : '   '} ${f.name.padEnd(w)} as ${alias(f)}`].join('\n')).join(',\n');
  const projEl = fields.map(f => `  ${f.key ? 'key' : '   '} ${alias(f)}`).join(',\n');
  const etag = fields.find(f => /abp_lastchange_tstmpl/.test(f.type)) || fields.find(f => /last_changed_at|lastchangedat/i.test(f.name));
  const uuidKey = keys.length === 1 && /sysuuid_x16|raw\(\s*16\s*\)/i.test(keys[0].type);
  const readonlyAdmin = fields.filter(f => /abp_(creation|lastchange|locinst)/.test(f.type)).map(alias);
  const visible = fields.filter(f => !/abp_(creation|lastchange|locinst)/.test(f.type)).slice(0, 8);
  const label = inp.label.replace(/'/g, "''");

  const root = `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${label}'
define root view entity ${n.root}
  as select from ${table}
{
${rootEl}
}
`;
  const proj = `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${label}'
@Metadata.allowExtensions: true
define root view entity ${n.proj}
  provider contract transactional_query
  as projection on ${n.root}
{
${projEl}
}
`;
  const ddlx = `@Metadata.layer: #CORE
@UI.headerInfo: { typeName: '${n.alias}', typeNamePlural: '${n.alias}s', title: { value: '${alias(visible.find(f => !f.key) || visible[0] || keys[0])}' } }
annotate entity ${n.proj} with
{
  @UI.facet: [{ id: 'General', purpose: #STANDARD, type: #IDENTIFICATION_REFERENCE, label: 'General', position: 10 }]
${visible.map((f, i) => `  @UI.lineItem: [{ position: ${(i + 1) * 10} }]
  @UI.identification: [{ position: ${(i + 1) * 10} }]${i < 3 ? `\n  @UI.selectionField: [{ position: ${(i + 1) * 10} }]` : ''}
  ${alias(f)};`).join('\n\n')}
}
`;
  const keyAliases = keys.map(alias).join(', ');
  const fieldRules = [
    uuidKey ? `  field ( readonly, numbering : managed ) ${keyAliases};` : `  field ( mandatory : create, readonly : update ) ${keyAliases};`,
    readonlyAdmin.length ? `  field ( readonly ) ${readonlyAdmin.join(', ')};` : '',
  ].filter(Boolean).join('\n');
  const mw = Math.max(...fields.map(f => alias(f).length));
  const bdef = `managed;

define behavior for ${n.root} alias ${n.alias}
persistent table ${table}
lock master${etag ? `\netag master ${alias(etag)}` : ''}
{
  create;
  update;
  delete;

${fieldRules}

  mapping for ${table}
  {
${fields.map(f => `    ${alias(f).padEnd(mw)} = ${f.name};`).join('\n')}
  }
}
`;
  const bdefProj = `projection;

define behavior for ${n.proj} alias ${n.alias}
{
  use create;
  use update;
  use delete;
}
`;
  const srvd = `@EndUserText.label: '${label}'
define service ${n.srvd} {
  expose ${n.proj} as ${n.alias};
}
`;
  return [
    { type: 'DDLS', name: n.root, desc: label, source: root, extra: { referencedObject: table } },
    { type: 'DDLS', name: n.proj, desc: label, source: proj, extra: { referencedObject: n.root } },
    { type: 'DDLX', name: n.proj, desc: label, source: ddlx, extra: { referencedObject: n.proj } },
    { type: 'BDEF', name: n.root, desc: label, source: bdef, extra: { referencedObject: n.root } },
    { type: 'BDEF', name: n.proj, desc: label, source: bdefProj, extra: { referencedObject: n.proj } },
    { type: 'SRVD', name: n.srvd, desc: label, source: srvd, extra: { referencedObject: n.proj } },
    { type: 'SRVB', name: inp.v2 ? n.srvb.replace(/_O4$/, '_O2') : n.srvb, desc: label, source: '', extra: { serviceDefinition: n.srvd, bindingType: inp.v2 ? 'V2' : 'V4', category: 'UI' } },
  ];
}
