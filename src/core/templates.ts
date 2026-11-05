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
    case 'FUGR':
      return `*******************************************************************
*   System-defined Include-files.                                 *
*******************************************************************
  INCLUDE l${n}top.                 " Global Declarations
  INCLUDE l${n}uxx.                 " Function Modules
`;
    case 'FUNC':
      return `FUNCTION ${n}\n  IMPORTING\n    VALUE(iv_input) TYPE string OPTIONAL\n  EXPORTING\n    VALUE(ev_output) TYPE string.\n\n  ev_output = iv_input.\n\nENDFUNCTION.\n`;
    case 'INCL':
      return `*&---------------------------------------------------------------------*\n*& Include ${name}\n*&---------------------------------------------------------------------*\n`;
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

/** IAM app in the shape the ADT IAM app service uses (sia6:sia6 with sia6:content). */
export function demoSia6(name: string, desc: string, pkg: string, o: { appType?: string; service?: string; table?: string } = {}): string {
  const svc = o.service ? `<sia6:service><sia6:srvcType>HT</sia6:srvcType><sia6:srvcName>${xe(o.service.slice(0, 24))}0001</sia6:srvcName><sia6:relServiceName>${xe(o.service)}</sia6:relServiceName><sia6:relServiceType>G4BA</sia6:relServiceType><sia6:typeText>OData V4</sia6:typeText><sia6:srvcDescription>${xe(desc)}</sia6:srvcDescription><sia6:uiadSource/><sia6:transactionCodeSource/></sia6:service>` : '';
  const auth = o.table ? `<commonAuthorization:auth><commonAuthorization:authObject>S_TABU_NAM</commonAuthorization:authObject><commonAuthorization:status>U</commonAuthorization:status><commonAuthorization:text>Table Access by Generic Standard Tools</commonAuthorization:text><commonAuthorization:authItems><commonAuthorization:authItem><commonAuthorization:authObjectInstID>0001</commonAuthorization:authObjectInstID><commonAuthorization:authObject>S_TABU_NAM</commonAuthorization:authObject><commonAuthorization:ibsSource/><commonAuthorization:ibsSourceType/><commonAuthorization:text>Table Access by Generic Standard Tools</commonAuthorization:text><commonAuthorization:status>U</commonAuthorization:status><commonAuthorization:inactive>false</commonAuthorization:inactive><commonAuthorization:values><commonAuthorization:value><commonAuthorization:field>ACTVT</commonAuthorization:field><commonAuthorization:val>Display change documents,Display,Change</commonAuthorization:val><commonAuthorization:status>U</commonAuthorization:status><commonAuthorization:text>Activity</commonAuthorization:text><commonAuthorization:isActvt>true</commonAuthorization:isActvt><commonAuthorization:fieldValues><commonAuthorization:fieldValue><commonAuthorization:lowValue>08</commonAuthorization:lowValue><commonAuthorization:highValue/></commonAuthorization:fieldValue><commonAuthorization:fieldValue><commonAuthorization:lowValue>03</commonAuthorization:lowValue><commonAuthorization:highValue/></commonAuthorization:fieldValue><commonAuthorization:fieldValue><commonAuthorization:lowValue>02</commonAuthorization:lowValue><commonAuthorization:highValue/></commonAuthorization:fieldValue></commonAuthorization:fieldValues></commonAuthorization:value><commonAuthorization:value><commonAuthorization:field>TABLE</commonAuthorization:field><commonAuthorization:val>${xe(o.table)}</commonAuthorization:val><commonAuthorization:status>U</commonAuthorization:status><commonAuthorization:text>Table Name</commonAuthorization:text><commonAuthorization:isActvt>false</commonAuthorization:isActvt><commonAuthorization:fieldValues><commonAuthorization:fieldValue><commonAuthorization:lowValue>${xe(o.table)}</commonAuthorization:lowValue><commonAuthorization:highValue/></commonAuthorization:fieldValue></commonAuthorization:fieldValues></commonAuthorization:value></commonAuthorization:values></commonAuthorization:authItem></commonAuthorization:authItems></commonAuthorization:auth>` : '';
  const plug = (ui: string, invisible: boolean, inactive: boolean) => `<sia6:pluginConfig><sia6:uiObject>${ui}</sia6:uiObject><sia6:invisble>${invisible}</sia6:invisble><sia6:inactive>${inactive}</sia6:inactive></sia6:pluginConfig>`;
  return `<?xml version="1.0" encoding="utf-8"?><sia6:sia6 adtcore:responsible="DEVELOPER" adtcore:masterLanguage="EN" adtcore:masterSystem="S4D" adtcore:abapLanguageVersion="cloudDevelopment" adtcore:name="${xe(name.toUpperCase())}" adtcore:type="SIA6" adtcore:changedAt="2026-11-03T13:23:10Z" adtcore:createdAt="2026-11-03T13:08:22Z" adtcore:changedBy="DEVELOPER" adtcore:createdBy="DEVELOPER" adtcore:description="${xe(desc)}" adtcore:language="EN" xmlns:sia6="http://www.sap.com/iam/sia6" xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/${xe(pkg.toLowerCase())}" adtcore:type="DEVC/K" adtcore:name="${xe(pkg.toUpperCase())}"/><sia6:content><sia6:appID>${xe(name.toUpperCase())}</sia6:appID><sia6:appType>${xe(o.appType || 'EXT')}</sia6:appType><sia6:ui5AppId/><sia6:transactionCode/><sia6:scopeDependent>false</sia6:scopeDependent><sia6:providerClass/><sia6:secondaryID/><sia6:services>${svc}</sia6:services><commonAuthorization:auths xmlns:commonAuthorization="http://www.sap.com/aps/common/authorization">${auth}</commonAuthorization:auths><commonAuthorization:restrictions xmlns:commonAuthorization="http://www.sap.com/aps/common/authorization"/><sia6:appconfigs/><sia6:pluginConfigs>${plug('appconfig_tab', true, false)}${plug('auth_tab', false, false)}${plug('scope_checkbox', true, false)}${plug('type_selectbox', false, true)}${plug('ui_app_id', false, false)}${plug('ui_publishing_status', false, false)}${plug('ui_tcode', true, true)}</sia6:pluginConfigs><sia6:publishStatus>p</sia6:publishStatus><sia6:migrationStatus/><sia6:abapLanguageVersion>5</sia6:abapLanguageVersion></sia6:content></sia6:sia6>
`;
}

/** A message class the way ADT returns it (one mc:messages element per message). */
export function demoMsag(name: string, desc: string, pkg: string, messages: [string, string, boolean][]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom" adtcore:name="${xe(name)}" adtcore:type="MSAG/N" adtcore:description="${xe(desc)}" adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:responsible="DEVELOPER" adtcore:changedBy="DEVELOPER" adtcore:changedAt="2026-11-03T09:12:44Z" adtcore:createdAt="2026-10-28T02:20:10Z">
  <adtcore:packageRef adtcore:name="${xe(pkg)}" adtcore:type="DEVC/K"/>
${messages.map(([no, text, self]) => `  <mc:messages mc:msgno="${no}" mc:msgtext="${xe(text)}" mc:selfexplainatory="${self}" mc:documented="${!self}">
    <atom:link href="/sap/bc/adt/messageclass/${xe(name.toLowerCase())}/messages/${no}" rel="self"/>
  </mc:messages>`).join('\n')}
</mc:messageClass>
`;
}

export function demoXml(type: ObjType, name: string, desc: string, pkg: string, body?: string): string {
  if (type === 'SIA6' && !body) return demoSia6(name, desc, pkg);
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
