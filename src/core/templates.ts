// Starting sources for new objects, close to what the Eclipse ADT wizards generate.

import { CreateExtra, ObjType } from './types';

const lc = (s: string) => s.toLowerCase();
const q = (s: string) => s.replace(/'/g, "''");

export function template(type: ObjType, name: string, desc: string, extra: CreateExtra = {}): string {
  const n = lc(name);
  const ref = extra.referencedObject || '';
  switch (type) {
    case 'CLAS':
      return `CLASS ${n} DEFINITION\n  PUBLIC\n  FINAL\n  CREATE PUBLIC.\n\n  PUBLIC SECTION.\n  PROTECTED SECTION.\n  PRIVATE SECTION.\nENDCLASS.\n\n\nCLASS ${n} IMPLEMENTATION.\nENDCLASS.\n`;
    case 'INTF':
      return `INTERFACE ${n}\n  PUBLIC.\n\nENDINTERFACE.\n`;
    case 'PROG':
      return `REPORT ${n}.\n\nSTART-OF-SELECTION.\n  \n`;
    case 'TABL':
      return `@EndUserText.label : '${q(desc)}'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table ${n} {
  key client            : abap.clnt not null;
  key uuid              : sysuuid_x16 not null;
  description           : abap.char(60);
  created_by            : abp_creation_user;
  created_at            : abp_creation_tstmpl;
  last_changed_by       : abp_lastchange_user;
  last_changed_at       : abp_lastchange_tstmpl;
  local_last_changed_at : abp_locinst_lastchange_tstmpl;
}
`;
    case 'DDLS':
      return `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: '${q(desc)}'
define view entity ${name}
  as select from ${ref || 'data_source_name'}
{
  key ${ref ? 'field_name' : 'field_name'}
}
`;
    case 'DDLX':
      return `@Metadata.layer: #CORE
annotate entity ${ref || name}
  with
{
  @UI.lineItem: [{ position: 10 }]
  @UI.identification: [{ position: 10 }]
  element_name;
}
`;
    case 'DCLS':
      return `@EndUserText.label: '${q(desc)}'
@MappingRole: true
define role ${name} {
  grant
    select
      on
        ${ref || 'entity_name'}
          where
            (field_name) = aspect pfcg_auth(authorization_object, authorization_field, ACTVT = '03');
}
`;
    case 'BDEF':
      return `managed implementation in class zbp_${n.replace(/^z[a-z]_/, '')} unique;
strict ( 2 );

define behavior for ${ref || name} alias ${aliasOf(ref || name)}
persistent table table_name
lock master
authorization master ( instance )
{
  create;
  update;
  delete;
}
`;
    case 'SRVD':
      return `@EndUserText.label: '${q(desc)}'
define service ${name} {
  expose ${ref || 'entity_name'};
}
`;
    case 'SRVB':
      return '';
  }
}

export function aliasOf(entity: string): string {
  const base = entity.replace(/^(\/\w+\/)?[ZY][A-Z]?_/i, '').replace(/^(R|I|C)_/i, '');
  return base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Entity';
}
