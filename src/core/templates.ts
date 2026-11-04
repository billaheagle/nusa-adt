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
    default:
      return demoXml(type, name, desc, extra.pkg || '$TMP');
  }
}

const xe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * XML documents of form-based objects in the DEMO system. Real systems define their own
 * formats; Nusa Studio reads and writes those as they come and never relies on these shapes.
 */
export interface DtelSpec { kind?: string; typeName?: string; dataType?: string; length?: number; decimals?: number; labels?: [string, string, string, string]; searchHelp?: string; parameter?: string }
const n6 = (n: number) => String(n).padStart(6, '0');

/** Data element in the shape the ADT data element service uses (blue:wbobj with dtel:dataElement). */
export function demoDtel(name: string, desc: string, pkg: string, o: DtelSpec = {}): string {
  const [s, m, l, h] = o.labels || [desc.slice(0, 10), desc.slice(0, 20), desc.slice(0, 40), desc.slice(0, 55)];
  const el = (k: string, v = '') => v ? `    <dtel:${k}>${xe(v)}</dtel:${k}>` : `    <dtel:${k}/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${xe(name.toUpperCase())}" adtcore:type="DTEL/DE" adtcore:description="${xe(desc)}" adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="DEVELOPER">
  <adtcore:packageRef adtcore:name="${xe(pkg.toUpperCase())}"/>
  <dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">
${[
    el('typeKind', o.kind || 'predefinedAbapType'), el('typeName', o.typeName), el('dataType', o.dataType || 'CHAR'),
    el('dataTypeLength', n6(o.length ?? 10)), el('dataTypeDecimals', n6(o.decimals ?? 0)),
    el('shortFieldLabel', s), el('shortFieldLength', '10'), el('shortFieldMaxLength', '10'),
    el('mediumFieldLabel', m), el('mediumFieldLength', '20'), el('mediumFieldMaxLength', '20'),
    el('longFieldLabel', l), el('longFieldLength', '40'), el('longFieldMaxLength', '40'),
    el('headingFieldLabel', h), el('headingFieldLength', '55'), el('headingFieldMaxLength', '55'),
    el('searchHelp', o.searchHelp), el('searchHelpParameter'), el('setGetParameter', o.parameter), el('defaultComponentName'),
    el('deactivateInputHistory', 'false'), el('changeDocument', 'false'), el('leftToRightDirection', 'false'), el('deactivateBIDIFiltering', 'false'),
  ].join('\n')}
  </dtel:dataElement>
</blue:wbobj>
`;
}

/** Domain in the shape the ADT domain service uses (doma:domain with doma:content). */
export function demoDoma(name: string, desc: string, pkg: string, o: { dataType?: string; length?: number; decimals?: number; values?: [string, string][]; valueTable?: string; lowercase?: boolean } = {}): string {
  const len = o.length ?? 1;
  const fix = (o.values || []).map(([low, text], i) => `        <doma:fixValue>
          <doma:position>${String(i + 1).padStart(4, '0')}</doma:position>
          <doma:low>${xe(low)}</doma:low>
          <doma:high/>
          <doma:text>${xe(text)}</doma:text>
        </doma:fixValue>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${xe(name.toUpperCase())}" adtcore:type="DOMA/DD" adtcore:description="${xe(desc)}" adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="DEVELOPER">
  <adtcore:packageRef adtcore:name="${xe(pkg.toUpperCase())}"/>
  <doma:content>
    <doma:typeInformation>
      <doma:datatype>${xe(o.dataType || 'CHAR')}</doma:datatype>
      <doma:length>${n6(len)}</doma:length>
      <doma:decimals>${n6(o.decimals ?? 0)}</doma:decimals>
    </doma:typeInformation>
    <doma:outputInformation>
      <doma:length>${n6(len)}</doma:length>
      <doma:style>00</doma:style>
      <doma:conversionExit/>
      <doma:signExists>false</doma:signExists>
      <doma:lowercase>${o.lowercase ? 'true' : 'false'}</doma:lowercase>
      <doma:ampmFormat>false</doma:ampmFormat>
    </doma:outputInformation>
    <doma:valueInformation>
      <doma:valueTableRef adtcore:name="${xe(o.valueTable || '')}"/>
      <doma:appendExists>false</doma:appendExists>
      <doma:fixValues>${fix ? '\n' + fix + '\n      ' : ''}</doma:fixValues>
    </doma:valueInformation>
  </doma:content>
</doma:domain>
`;
}

export function demoXml(type: ObjType, name: string, desc: string, pkg: string, body?: string): string {
  if (type === 'DTEL' && !body) return demoDtel(name, desc, pkg);
  if (type === 'DOMA' && !body) return demoDoma(name, desc, pkg);
  const p = type.toLowerCase();
  const BODY: Partial<Record<ObjType, string>> = {
    DTEL: `<${p}:typeInformation ${p}:category="Predefined type" ${p}:dataType="CHAR" ${p}:length="10" ${p}:decimals="0"/>
  <${p}:fieldLabels>
    <${p}:label ${p}:kind="Short" ${p}:length="10" ${p}:text="${xe(desc.slice(0, 10))}"/>
    <${p}:label ${p}:kind="Medium" ${p}:length="20" ${p}:text="${xe(desc.slice(0, 20))}"/>
    <${p}:label ${p}:kind="Long" ${p}:length="40" ${p}:text="${xe(desc.slice(0, 40))}"/>
    <${p}:label ${p}:kind="Heading" ${p}:length="55" ${p}:text="${xe(desc.slice(0, 55))}"/>
  </${p}:fieldLabels>`,
    DOMA: `<${p}:format ${p}:dataType="CHAR" ${p}:length="1" ${p}:outputLength="1" ${p}:lowercase="false"/>
  <${p}:fixedValues>
    <${p}:fixedValue ${p}:low="A" ${p}:text="Active"/>
    <${p}:fixedValue ${p}:low="I" ${p}:text="Inactive"/>
  </${p}:fixedValues>`,
    MSAG: `<${p}:messages>
    <${p}:message ${p}:number="001" ${p}:text="&amp;1 was saved" ${p}:selfExplanatory="true"/>
  </${p}:messages>`,
    AUTH: `<${p}:general ${p}:dataElement="${xe(name)}" ${p}:checkTable="" ${p}:orgLevel="false"/>`,
    SUSO: `<${p}:general ${p}:objectClass="ZNUS" ${p}:accessCategory="Read and write"/>
  <${p}:fields>
    <${p}:field ${p}:name="ACTVT"/>
  </${p}:fields>
  <${p}:activities>
    <${p}:activity ${p}:code="01" ${p}:text="Create or generate"/>
    <${p}:activity ${p}:code="02" ${p}:text="Change"/>
    <${p}:activity ${p}:code="03" ${p}:text="Display"/>
  </${p}:activities>`,
    SIA6: `<${p}:general ${p}:appType="External App" ${p}:launchpadAppId=""/>
  <${p}:services>
    <${p}:service ${p}:type="OData V4" ${p}:name="" ${p}:version="0001"/>
  </${p}:services>
  <${p}:authorizations>
    <${p}:authorization ${p}:object="S_START" ${p}:field="AUTHOBJTYP" ${p}:value="G4BA"/>
  </${p}:authorizations>`,
    SIA1: `<${p}:apps>
    <${p}:app ${p}:name="" ${p}:assignment=""/>
  </${p}:apps>`,
    SCO1: `<${p}:general ${p}:scenarioType="Customer managed" ${p}:allowedInstances="One instance per scenario and communication system"/>
  <${p}:inbound ${p}:basicAuthentication="true" ${p}:x509="true" ${p}:oauth="false">
    <${p}:service ${p}:name="" ${p}:type="OData V4"/>
  </${p}:inbound>
  <${p}:outbound>
    <${p}:service ${p}:name="" ${p}:type="HTTP"/>
  </${p}:outbound>`,
    SMBC: `<${p}:general ${p}:configurationType="Table maintenance" ${p}:serviceBinding="" ${p}:serviceName="" ${p}:entitySet="" ${p}:recordTransport="true"/>`,
  };
  const inner = body ?? BODY[type] ?? `<${p}:general ${p}:status="Fill in the details of this object"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<${p}:object xmlns:${p}="urn:nusa-adt:demo:${p}" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${xe(name.toUpperCase())}" adtcore:description="${xe(desc)}" adtcore:type="${type}" adtcore:masterLanguage="EN" adtcore:responsible="DEVELOPER">
  <adtcore:packageRef adtcore:name="${xe(pkg.toUpperCase())}"/>
  ${inner}
</${p}:object>
`;
}

export function aliasOf(entity: string): string {
  const base = entity.replace(/^(\/\w+\/)?[ZY][A-Z]?_/i, '').replace(/^(R|I|C)_/i, '');
  return base.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('') || 'Entity';
}
