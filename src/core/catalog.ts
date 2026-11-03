// What code completion knows about a system: DDIC tables/structures/CDS entities and their
// fields, data elements, classes/interfaces/exceptions with members, function modules with
// parameters. A Catalog is asked lazily; implementations: StdCatalog (built-in reference
// data), WorkspaceCatalog (objects in the open system, parsed from source), RemoteCatalog
// (src/adt/catalog.ts, asks a real system).

import { statements } from './abap';

export type EntryKind = 'table' | 'structure' | 'view' | 'cds' | 'dtel' | 'ttyp' | 'class' | 'interface' | 'exception' | 'fm';
export interface CatEntry { name: string; kind: EntryKind; desc: string; released?: boolean }
export interface Field { name: string; type: string; desc?: string; key?: boolean }
export interface Param { name: string; kind: 'importing' | 'exporting' | 'changing' | 'returning' | 'tables'; type: string; optional: boolean }
export interface Member {
  name: string; kind: 'method' | 'attribute' | 'constant' | 'event' | 'type'; static: boolean;
  visibility: 'public' | 'protected' | 'private'; params?: Param[]; raising?: string[]; type?: string; desc?: string;
}
export interface ClassInfo { name: string; kind: 'class' | 'interface'; superClass?: string; interfaces: string[]; members: Member[] }
export interface FmInfo { name: string; params: Param[]; exceptions: string[] }

export interface Catalog {
  find(prefix: string, kinds: EntryKind[], limit?: number): Promise<CatEntry[]>;
  fieldsOf(name: string): Promise<Field[] | null>;
  classInfo(name: string): Promise<ClassInfo | null>;
  fm(name: string): Promise<FmInfo | null>;
  /** Row type of a DDIC table type (TTYP), e.g. STRING_TABLE -> STRING. */
  rowTypeOf(name: string): Promise<string | null>;
}

// ====================================================================== built-in language data

export const BUILTIN_TYPES: [string, string][] = [
  ['string', 'Character string, variable length'], ['xstring', 'Byte string, variable length'],
  ['i', 'Integer, 4 bytes'], ['int8', 'Integer, 8 bytes'], ['p', 'Packed number (LENGTH n DECIMALS m)'],
  ['decfloat16', 'Decimal floating point, 16 digits'], ['decfloat34', 'Decimal floating point, 34 digits'],
  ['f', 'Binary floating point'], ['c', 'Text field (LENGTH n)'], ['n', 'Numeric text (LENGTH n)'],
  ['d', 'Date YYYYMMDD'], ['t', 'Time HHMMSS'], ['x', 'Byte field (LENGTH n)'], ['utclong', 'UTC time stamp'],
  ['abap_bool', 'Boolean (abap_true / abap_false)'], ['data', 'Generic: any data (parameters only)'],
  ['any', 'Generic: any type (parameters only)'], ['clike', 'Generic: character-like'], ['csequence', 'Generic: text-like'],
  ['numeric', 'Generic: numeric'], ['simple', 'Generic: elementary'], ['object', 'Generic object reference (REF TO object)'],
];

export const SY_FIELDS: [string, string][] = [
  ['subrc', 'Return code of the last statement'], ['tabix', 'Current row of an internal table'], ['index', 'Current loop pass (DO/WHILE)'],
  ['dbcnt', 'Rows processed by the last SQL statement'], ['datum', 'Application server date'], ['uzeit', 'Application server time'],
  ['datlo', 'User local date'], ['timlo', 'User local time'], ['zonlo', 'User time zone'], ['uname', 'User name'], ['langu', 'Logon language'],
  ['mandt', 'Client'], ['sysid', 'System ID'], ['host', 'Application server'], ['repid', 'Current program'], ['cprog', 'Calling program'],
  ['tcode', 'Transaction code'], ['ucomm', 'Function code'], ['msgid', 'Message class'], ['msgno', 'Message number'], ['msgty', 'Message type'],
  ['msgv1', 'Message variable 1'], ['msgv2', 'Message variable 2'], ['msgv3', 'Message variable 3'], ['msgv4', 'Message variable 4'],
  ['batch', 'Running in background'], ['fdpos', 'Offset found by CA/CO/CS…'], ['lsind', 'List level'], ['saprl', 'SAP release'],
];

/** name, signature snippet, description */
export const ABAP_FUNCTIONS: [string, string, string][] = [
  ['lines', 'lines( $0 )', 'Number of rows of an internal table'], ['strlen', 'strlen( $0 )', 'Length of a string without trailing blanks'],
  ['numofchar', 'numofchar( $0 )', 'Characters without trailing blanks'], ['xsdbool', 'xsdbool( $0 )', 'abap_true if the condition holds'],
  ['boolc', 'boolc( $0 )', 'X if the condition holds (string)'], ['line_exists', 'line_exists( $0[ ] )', 'Does the table row exist?'],
  ['line_index', 'line_index( $0[ ] )', 'Row number of a table expression'], ['condense', 'condense( val = $0 )', 'Remove surplus blanks'],
  ['to_upper', 'to_upper( $0 )', 'Upper case'], ['to_lower', 'to_lower( $0 )', 'Lower case'], ['to_mixed', 'to_mixed( val = $0 sep = `_` )', 'snake_case to camelCase'],
  ['substring', 'substring( val = $0 off = len = )', 'Part of a string'], ['substring_after', 'substring_after( val = $0 sub = )', 'Text after a substring'],
  ['substring_before', 'substring_before( val = $0 sub = )', 'Text before a substring'], ['replace', 'replace( val = $0 sub = with = occ = 0 )', 'Replace occurrences'],
  ['concat_lines_of', 'concat_lines_of( table = $0 sep = `` )', 'Join table rows'], ['contains', 'contains( val = $0 sub = )', 'Contains a substring?'],
  ['matches', 'matches( val = $0 pcre = `` )', 'Matches a regular expression?'], ['find', 'find( val = $0 sub = )', 'Offset of a substring'],
  ['count', 'count( val = $0 sub = )', 'Occurrences of a substring'], ['shift_left', 'shift_left( val = $0 places = )', 'Shift left'],
  ['shift_right', 'shift_right( val = $0 places = )', 'Shift right'], ['reverse', 'reverse( $0 )', 'Reverse a string'], ['repeat', 'repeat( val = $0 occ = )', 'Repeat a string'],
  ['escape', 'escape( val = $0 format = cl_abap_format=>e_url )', 'Escape special characters'], ['translate', 'translate( val = $0 from = `` to = `` )', 'Translate characters'],
  ['segment', 'segment( val = $0 index = sep = `` )', 'Segment of a separated string'], ['cmax', 'cmax( val1 = $0 val2 = )', 'Largest string'], ['cmin', 'cmin( val1 = $0 val2 = )', 'Smallest string'],
  ['abs', 'abs( $0 )', 'Absolute value'], ['sign', 'sign( $0 )', 'Sign'], ['ceil', 'ceil( $0 )', 'Round up'], ['floor', 'floor( $0 )', 'Round down'],
  ['trunc', 'trunc( $0 )', 'Integer part'], ['frac', 'frac( $0 )', 'Fractional part'], ['round', 'round( val = $0 dec = 2 )', 'Round to decimals'],
  ['rescale', 'rescale( val = $0 dec = )', 'Change decimal places'], ['nmax', 'nmax( val1 = $0 val2 = )', 'Largest number'], ['nmin', 'nmin( val1 = $0 val2 = )', 'Smallest number'],
  ['ipow', 'ipow( base = $0 exp = )', 'Integer power'], ['sqrt', 'sqrt( $0 )', 'Square root'], ['utclong_current', 'utclong_current( )', 'Current UTC time stamp'],
  ['utclong_add', 'utclong_add( val = $0 days = )', 'Add to a UTC time stamp'], ['utclong_diff', 'utclong_diff( high = $0 low = )', 'Seconds between time stamps'],
];

export const CONSTRUCTORS: [string, string, string][] = [
  ['NEW', 'NEW $0( )', 'Create an object or data reference'], ['VALUE', 'VALUE #( $0 )', 'Construct a structure or table'],
  ['CONV', 'CONV #( $0 )', 'Convert to a type'], ['CORRESPONDING', 'CORRESPONDING #( $0 )', 'Move by component name'],
  ['COND', 'COND #( WHEN $0 THEN  ELSE  )', 'Conditional value'], ['SWITCH', 'SWITCH #( $0 WHEN  THEN  ELSE  )', 'Value by case'],
  ['REDUCE', 'REDUCE #( INIT x = 0 FOR row IN $0 NEXT x = x + 1 )', 'Reduce a table to a value'], ['FILTER', 'FILTER #( $0 WHERE  )', 'Filter a sorted/hashed table'],
  ['CAST', 'CAST $0( )', 'Down cast a reference'], ['REF', 'REF #( $0 )', 'Data reference'], ['EXACT', 'EXACT #( $0 )', 'Lossless conversion'],
];

export const PRAGMAS: [string, string][] = [
  ['##NEEDED', 'Variable is intentionally unused'], ['##NO_TEXT', 'Literal needs no text symbol'], ['##SUBRC_OK', 'sy-subrc is not checked on purpose'],
  ['##FM_SUBRC_OK', 'Function module sy-subrc not checked'], ['##CALLED', 'Method is called dynamically'], ['##NO_HANDLER', 'Empty CATCH block is intended'],
  ['##CATCH_ALL', 'Catching CX_ROOT is intended'], ['##TOO_MANY_ITAB_FIELDS', 'More fields read than target has'], ['##ITAB_KEY_IN_SELECT', 'Key read in SELECT loop'],
  ['##WARN_OK', 'Warning accepted'], ['##NUMBER_OK', 'Number literal is fine'], ['##ENH_OK', 'Enhancement is fine'], ['##RELAX', 'Relax a type check'],
  ['##SELECT_FAE_WITH_LOB', 'FOR ALL ENTRIES with LOB'], ['##DB_FEATURE_MODE', 'Database feature mode'], ['##NO_DB_FEATURE_MODE', 'No DB feature check'],
];

export const SQL_FUNCTIONS: [string, string][] = [
  ['count( * )', 'Number of rows'], ['count( DISTINCT $0 )', 'Distinct values'], ['sum( $0 )', 'Sum'], ['avg( $0 )', 'Average'],
  ['min( $0 )', 'Minimum'], ['max( $0 )', 'Maximum'], ['coalesce( $0, )', 'First non-null'], ['concat( $0, )', 'Concatenate'],
  ['concat_with_space( $0, , 1 )', 'Concatenate with blanks'], ['upper( $0 )', 'Upper case'], ['lower( $0 )', 'Lower case'],
  ['substring( $0, 1, )', 'Substring'], ['length( $0 )', 'Length'], ['lpad( $0, , )', 'Pad left'], ['division( $0, , 2 )', 'Division with decimals'],
  ['round( $0, 2 )', 'Round'], ['cast( $0 AS )', 'Cast'], ['dats_days_between( $0, )', 'Days between dates'], ['dats_add_days( $0, , \'INITIAL\' )', 'Add days'],
  ['CASE WHEN $0 THEN  ELSE  END', 'Case expression'],
];

export const CDS_FUNCTIONS: [string, string][] = [
  ['concat( $0, )', 'Concatenate two strings'], ['concat_with_space( $0, , 1 )', 'Concatenate with blanks'], ['substring( $0, 1, )', 'Substring'],
  ['length( $0 )', 'Length'], ['upper( $0 )', 'Upper case'], ['lower( $0 )', 'Lower case'], ['left( $0, )', 'Left characters'], ['right( $0, )', 'Right characters'],
  ['lpad( $0, , \'0\' )', 'Pad left'], ['rpad( $0, , )', 'Pad right'], ['ltrim( $0, \' \' )', 'Trim left'], ['rtrim( $0, \' \' )', 'Trim right'],
  ['replace( $0, , )', 'Replace'], ['instr( $0, )', 'Position of substring'], ['abs( $0 )', 'Absolute value'], ['ceil( $0 )', 'Round up'], ['floor( $0 )', 'Round down'],
  ['round( $0, 2 )', 'Round'], ['div( $0, )', 'Integer division'], ['division( $0, , 2 )', 'Division with decimals'], ['mod( $0, )', 'Modulo'],
  ['cast( $0 as abap.char( 10 ) )', 'Cast to a type'], ['coalesce( $0, )', 'First non-null'], ['dats_days_between( $0, )', 'Days between dates'],
  ['dats_add_days( $0, , \'INITIAL\' )', 'Add days to a date'], ['dats_add_months( $0, , \'INITIAL\' )', 'Add months to a date'], ['dats_is_valid( $0 )', 'Valid date?'],
  ['tstmp_current_utctimestamp( )', 'Current UTC time stamp'], ['tstmp_to_dats( $0, abap_system_timezone( $session.client, \'NULL\' ), $session.client, \'NULL\' )', 'Time stamp to date'],
  ['currency_conversion( amount => $0, source_currency => , target_currency => , exchange_rate_date => )', 'Convert currency'],
  ['unit_conversion( quantity => $0, source_unit => , target_unit => )', 'Convert unit'], ['bintohex( $0 )', 'Binary to hex'], ['hextobin( $0 )', 'Hex to binary'],
  ['case $0 when  then  else  end', 'Simple case'], ['case when $0 then  else  end', 'Searched case'],
];

export const CDS_TYPES = ['char( 10 )', 'numc( 10 )', 'dec( 15, 2 )', 'curr( 15, 2 )', 'quan( 13, 3 )', 'int1', 'int2', 'int4', 'int8', 'dats', 'tims', 'datn', 'timn', 'utcl',
  'string', 'sstring( 255 )', 'cuky( 5 )', 'unit( 3 )', 'lang', 'fltp', 'decfloat16', 'decfloat34', 'raw( 16 )', 'clnt', 'accp'];

/** Annotation name -> value hint: '#A|#B' enum, "'…'" string, 'true', '[…]' array, number. */
export const CDS_ANNOTATIONS: [string, string, string][] = [
  ['AccessControl.authorizationCheck', '#CHECK|#NOT_REQUIRED|#NOT_ALLOWED|#PRIVILEGED_ONLY|#MANDATORY', 'Is a DCL access control checked?'],
  ['AccessControl.personalData.blocking', '#NOT_REQUIRED|#REQUIRED|#BLOCKED_DATA_EXCLUDED', 'Blocking of personal data'],
  ['EndUserText.label', "''", 'Label shown to users'], ['EndUserText.quickInfo', "''", 'Tooltip'], ['EndUserText.heading', "''", 'Column heading'],
  ['Metadata.allowExtensions', 'true', 'Allow metadata extensions'], ['Metadata.ignorePropagatedAnnotations', 'true', 'Do not inherit element annotations'],
  ['Metadata.layer', '#CORE|#LOCALIZATION|#INDUSTRY|#PARTNER|#CUSTOMER', 'Layer of a metadata extension'],
  ['ObjectModel.usageType.serviceQuality', '#A|#B|#C|#D|#X|#P', 'Performance class'], ['ObjectModel.usageType.sizeCategory', '#S|#M|#L|#XL|#XXL', 'Expected rows'],
  ['ObjectModel.usageType.dataClass', '#TRANSACTIONAL|#MASTER|#ORGANIZATIONAL|#CUSTOMIZING|#META|#MIXED', 'Kind of data'],
  ['ObjectModel.representativeKey', "''", 'Representative key element'], ['ObjectModel.semanticKey', "['']", 'Semantic key elements'],
  ['ObjectModel.text.element', "['']", 'Element that holds the text'], ['ObjectModel.text.association', "''", 'Text association'],
  ['ObjectModel.foreignKey.association', "''", 'Foreign key association'], ['ObjectModel.dataCategory', '#TEXT|#HIERARCHY|#VALUE_HELP', 'Data category'],
  ['ObjectModel.supportedCapabilities', '[#SQL_DATA_SOURCE, #CDS_MODELING_DATA_SOURCE]', 'Supported capabilities'],
  ['ObjectModel.modelingPattern', '#ANALYTICAL_CUBE|#ANALYTICAL_DIMENSION|#LANGUAGE_DEPENDENT_TEXT|#VALUE_HELP_PROVIDER|#NONE', 'Modeling pattern'],
  ['Semantics.amount.currencyCode', "''", 'Currency key element for an amount'], ['Semantics.quantity.unitOfMeasure', "''", 'Unit element for a quantity'],
  ['Semantics.currencyCode', 'true', 'Element is a currency key'], ['Semantics.unitOfMeasure', 'true', 'Element is a unit'], ['Semantics.text', 'true', 'Element is a text'],
  ['Semantics.language', 'true', 'Element is a language key'], ['Semantics.user.createdBy', 'true', 'Created by user'], ['Semantics.user.lastChangedBy', 'true', 'Last changed by user'],
  ['Semantics.user.localInstanceLastChangedBy', 'true', 'Local instance changed by'],
  ['Semantics.systemDateTime.createdAt', 'true', 'Creation time stamp'], ['Semantics.systemDateTime.lastChangedAt', 'true', 'Last change time stamp (ETag)'],
  ['Semantics.systemDateTime.localInstanceLastChangedAt', 'true', 'Local instance change time stamp'], ['Semantics.calendar.year', 'true', 'Calendar year'],
  ['Semantics.businessDate.from', 'true', 'Validity start'], ['Semantics.businessDate.to', 'true', 'Validity end'],
  ['UI.headerInfo.typeName', "''", 'Object type name (singular)'], ['UI.headerInfo.typeNamePlural', "''", 'Object type name (plural)'],
  ['UI.headerInfo.title.value', "''", 'Element shown as title'], ['UI.lineItem', '[{ position: 10 }]', 'Column in a list report'],
  ['UI.identification', '[{ position: 10 }]', 'Field on the object page'], ['UI.selectionField', '[{ position: 10 }]', 'Filter field'],
  ['UI.facet', "[{ id: '', purpose: #STANDARD, type: #IDENTIFICATION_REFERENCE, label: '', position: 10 }]", 'Object page section'],
  ['UI.hidden', 'true', 'Hide the element'], ['UI.textArrangement', '#TEXT_FIRST|#TEXT_LAST|#TEXT_ONLY|#TEXT_SEPARATE', 'Text arrangement'],
  ['UI.presentationVariant', "[{ sortOrder: [{ by: '', direction: #DESC }] }]", 'Default sorting'],
  ['Search.searchable', 'true', 'View supports free-text search'], ['Search.defaultSearchElement', 'true', 'Element is searched'],
  ['Search.fuzzinessThreshold', '0.8', 'Fuzzy search threshold'], ['Search.ranking', '#HIGH|#MEDIUM|#LOW', 'Search ranking'],
  ['Consumption.valueHelpDefinition', "[{ entity: { name: '', element: '' } }]", 'Value help'], ['Consumption.filter.mandatory', 'true', 'Mandatory filter'],
  ['Consumption.filter.selectionType', '#SINGLE|#INTERVAL|#RANGE|#HIERARCHY_NODE', 'Filter selection type'], ['Consumption.semanticObject', "''", 'Navigation target'],
  ['Analytics.dataCategory', '#CUBE|#DIMENSION|#FACT|#AGGREGATION_LEVEL', 'Analytical role'], ['Analytics.query', 'true', 'Analytical query'],
  ['Aggregation.default', '#SUM|#MIN|#MAX|#AVG|#COUNT_DISTINCT|#NONE', 'Default aggregation'],
  ['VDM.viewType', '#BASIC|#COMPOSITE|#CONSUMPTION|#TRANSACTIONAL|#EXTENSION|#DERIVATION_FUNCTION', 'Virtual data model layer'],
  ['AbapCatalog.sqlViewName', "''", 'SQL view name (classic DDIC-based view)'], ['AbapCatalog.compiler.compareFilter', 'true', 'Compare path filters'],
  ['AbapCatalog.preserveKey', 'true', 'Keep key fields'], ['AbapCatalog.viewEnhancementCategory', '[#NONE]', 'Extensibility'],
  ['AbapCatalog.extensibility.extensible', 'true', 'Key user extensible'], ['AbapCatalog.buffering.status', '#ACTIVE|#SWITCHED_OFF|#NOT_ALLOWED', 'Table buffering'],
  ['ClientHandling.type', '#CLIENT_DEPENDENT|#CLIENT_INDEPENDENT|#INHERITED', 'Client handling'], ['OData.entityType.name', "''", 'OData entity type name'],
];

// ====================================================================== standard repository objects

type T = [name: string, desc: string, fields: string, released?: boolean];
/** fields: "name:type:desc" separated by "|", key fields prefixed with "*" */
const TABLES: T[] = [
  ['/DMO/FLIGHT', 'Flight', '*client:mandt|*carrier_id:/dmo/carrier_id:Airline|*connection_id:/dmo/connection_id:Connection|*flight_date:/dmo/flight_date:Flight date|price:/dmo/flight_price:Price|currency_code:/dmo/currency_code:Currency|plane_type_id:/dmo/plane_type_id:Plane type|seats_max:/dmo/plane_seats_max:Seats|seats_occupied:/dmo/plane_seats_occupied:Occupied seats', true],
  ['/DMO/CARRIER', 'Airline', '*client:mandt|*carrier_id:/dmo/carrier_id:Airline|name:/dmo/carrier_name:Name|currency_code:/dmo/currency_code:Currency', true],
  ['/DMO/CONNECTION', 'Flight connection', '*client:mandt|*carrier_id:/dmo/carrier_id|*connection_id:/dmo/connection_id|airport_from_id:/dmo/airport_from_id:From|airport_to_id:/dmo/airport_to_id:To|departure_time:/dmo/flight_departure_time|arrival_time:/dmo/flight_arrival_time|distance:/dmo/flight_distance|distance_unit:msehi', true],
  ['/DMO/TRAVEL', 'Travel', '*client:mandt|*travel_id:/dmo/travel_id|agency_id:/dmo/agency_id|customer_id:/dmo/customer_id|begin_date:/dmo/begin_date|end_date:/dmo/end_date|booking_fee:/dmo/booking_fee|total_price:/dmo/total_price|currency_code:/dmo/currency_code|description:/dmo/description|status:/dmo/travel_status|createdby:syuname|createdat:timestampl|lastchangedby:syuname|lastchangedat:timestampl', true],
  ['/DMO/BOOKING', 'Booking', '*client:mandt|*travel_id:/dmo/travel_id|*booking_id:/dmo/booking_id|booking_date:/dmo/booking_date|customer_id:/dmo/customer_id|carrier_id:/dmo/carrier_id|connection_id:/dmo/connection_id|flight_date:/dmo/flight_date|flight_price:/dmo/flight_price|currency_code:/dmo/currency_code', true],
  ['/DMO/CUSTOMER', 'Customer', '*client:mandt|*customer_id:/dmo/customer_id|first_name:/dmo/first_name|last_name:/dmo/last_name|title:/dmo/title|street:/dmo/street|postal_code:/dmo/postal_code|city:/dmo/city|country_code:land1|phone_number:/dmo/phone_number|email_address:/dmo/email_address', true],
  ['T000', 'Clients', '*mandt:mandt:Client|mtext:mtext_d:Name|ort01:ort01:City|mwaers:mwaers:Currency|cccategory:cccategory:Role'],
  ['T001', 'Company codes', '*mandt:mandt|*bukrs:bukrs:Company code|butxt:butxt:Name|ort01:ort01:City|land1:land1:Country|waers:waers:Currency|spras:spras:Language|ktopl:ktopl:Chart of accounts'],
  ['T005', 'Countries', '*mandt:mandt|*land1:land1:Country|landk:landk:Vehicle code|waers:waers_005:Currency'],
  ['TCURC', 'Currency codes', '*mandt:mandt|*waers:waers:Currency|isocd:isocd:ISO code'],
  ['MARA', 'General material data', '*mandt:mandt|*matnr:matnr:Material|ersda:ersda:Created on|ernam:ernam:Created by|laeda:laeda:Last change|mtart:mtart:Material type|mbrsh:mbrsh:Industry|matkl:matkl:Material group|meins:meins:Base unit|brgew:brgew:Gross weight|ntgew:ntgew:Net weight|gewei:gewei:Weight unit|lvorm:lvoma:Deletion flag'],
  ['MAKT', 'Material descriptions', '*mandt:mandt|*matnr:matnr|*spras:spras:Language|maktx:maktx:Description|maktg:maktg:Description (upper case)'],
  ['MARC', 'Plant data for material', '*mandt:mandt|*matnr:matnr|*werks:werks_d:Plant|pstat:pstat_d|lvorm:lvowk|dispo:dispo:MRP controller|ekgrp:ekgrp:Purchasing group|beskz:beskz:Procurement type'],
  ['KNA1', 'Customer master (general)', '*mandt:mandt|*kunnr:kunnr:Customer|land1:land1_gp:Country|name1:name1_gp:Name|ort01:ort01_gp:City|pstlz:pstlz:Postal code|regio:regio:Region|stras:stras_gp:Street|telf1:telf1:Telephone|erdat:erdat_rf:Created on|ktokd:ktokd:Account group'],
  ['LFA1', 'Supplier master (general)', '*mandt:mandt|*lifnr:lifnr:Supplier|land1:land1_gp|name1:name1_gp:Name|ort01:ort01_gp|pstlz:pstlz|stras:stras_gp|erdat:erdat_rf|ktokk:ktokk:Account group'],
  ['VBAK', 'Sales document header', '*mandt:mandt|*vbeln:vbeln_va:Sales document|erdat:erdat:Created on|erzet:erzet:Time|ernam:ernam:Created by|audat:audat:Document date|vbtyp:vbtypl:Category|auart:auart:Document type|netwr:netwr_ak:Net value|waerk:waerk:Currency|vkorg:vkorg:Sales org.|vtweg:vtweg:Distribution channel|spart:spart:Division|kunnr:kunag:Sold-to party'],
  ['VBAP', 'Sales document item', '*mandt:mandt|*vbeln:vbeln_va|*posnr:posnr_va:Item|matnr:matnr|arktx:arktx:Item text|kwmeng:kwmeng:Order quantity|vrkme:vrkme:Sales unit|netwr:netwr_ap:Net value|waerk:waerk|werks:werks_ext:Plant'],
  ['EKKO', 'Purchasing document header', '*mandt:mandt|*ebeln:ebeln:Purchasing document|bukrs:bukrs|bstyp:ebstyp|bsart:esart:Document type|lifnr:elifn:Supplier|ekorg:ekorg:Purch. org.|ekgrp:bkgrp|waers:waers|bedat:ebdat:Document date'],
  ['EKPO', 'Purchasing document item', '*mandt:mandt|*ebeln:ebeln|*ebelp:ebelp:Item|matnr:matnr|werks:ewerk|menge:bstmg:Quantity|meins:bstme:Unit|netpr:bprei:Net price|netwr:bwert:Net value'],
  ['BKPF', 'Accounting document header', '*mandt:mandt|*bukrs:bukrs|*belnr:belnr_d:Document|*gjahr:gjahr:Fiscal year|blart:blart:Document type|bldat:bldat:Document date|budat:budat:Posting date|monat:monat:Period|cpudt:cpudt:Entry date|usnam:usnam:User|waers:waers|xblnr:xblnr1:Reference'],
  ['BSEG', 'Accounting document segment', '*mandt:mandt|*bukrs:bukrs|*belnr:belnr_d|*gjahr:gjahr|*buzei:buzei:Line item|bschl:bschl:Posting key|koart:koart:Account type|shkzg:shkzg:Debit/credit|dmbtr:dmbtr:Amount in local currency|wrbtr:wrbtr:Amount|hkont:hkont:G/L account|kunnr:kunnr|lifnr:lifnr'],
  ['ACDOCA', 'Universal journal entry line items', '*rclnt:mandt|*rldnr:fins_ledger:Ledger|*rbukrs:bukrs|*gjahr:gjahr|*belnr:belnr_d|*docln:fins_docln6:Line|racct:racct:Account|rhcur:fins_currh:Local currency|hsl:fins_vhcur12:Amount in local currency|tsl:fins_vtcur12:Amount in transaction currency|poper:poper:Period|budat:budat'],
  ['USR02', 'Logon data', '*mandt:mandt|*bname:xubname:User|gltgv:xugltgv:Valid from|gltgb:xugltgb:Valid to|ustyp:xuustyp:User type|class:xuclass:User group|trdat:xuldate:Last logon'],
  ['T100', 'Messages', '*sprsl:spras|*arbgb:arbgb:Message class|*msgnr:msgnr:Number|text:natxt:Text'],
  ['TADIR', 'Repository object directory', '*pgmid:pgmid|*object:trobjtype:Object type|*obj_name:sobj_name:Object name|korrnum:trkorr_old|srcsystem:srcsystem|author:responsibl:Author|devclass:devclass:Package'],
  ['SFLIGHT', 'Flight (training model)', '*mandt:mandt|*carrid:s_carr_id:Airline|*connid:s_conn_id:Connection|*fldate:s_date:Date|price:s_price:Price|currency:s_currcode:Currency|planetype:s_planetye:Plane type|seatsmax:s_seatsmax:Seats|seatsocc:s_seatsocc:Occupied|paymentsum:s_sum:Total bookings'],
  ['SCARR', 'Airline (training model)', '*mandt:mandt|*carrid:s_carr_id|carrname:s_carrname:Name|currcode:s_currcode|url:s_carrurl'],
  ['SPFLI', 'Flight schedule (training model)', '*mandt:mandt|*carrid:s_carr_id|*connid:s_conn_id|countryfr:land1|cityfrom:s_from_cit|airpfrom:s_fromairp|countryto:land1|cityto:s_to_city|airpto:s_toairp|fltime:s_fltime|deptime:s_dep_time|arrtime:s_arr_time|distance:s_distance|distid:s_distid'],
];
const STRUCTURES: T[] = [
  ['BAPIRET2', 'Return parameter', 'type:bapi_mtype:Message type|id:symsgid:Message class|number:symsgno:Number|message:bapi_msg:Text|log_no:balognr|log_msg_no:balmnr|message_v1:symsgv|message_v2:symsgv|message_v3:symsgv|message_v4:symsgv|parameter:bapi_param|row:bapi_line|field:bapi_fld|system:bapilogsys', true],
  ['SYST', 'ABAP system fields', SY_FIELDS.map(([n, d]) => `${n}::${d}`).join('|'), true],
  ['ABP_BEHV_FLAG', 'RAP flag', '', true],
];
const CDS: T[] = [
  ['I_CURRENCY', 'Currency', '*Currency:waers|Decimals:currdec|CurrencyISOCode:isocd|AlternativeCurrencyKey:altwr|_Text:association', true],
  ['I_COUNTRY', 'Country', '*Country:land1|CountryThreeLetterISOCode:intca3|CountryThreeDigitISOCode:intcn3|IsEuropeanUnionMember:xegld|_Text:association', true],
  ['I_UNITOFMEASURE', 'Unit of measure', '*UnitOfMeasure:msehi|UnitOfMeasureSAPCode:msehi|UnitOfMeasureISOCode:isocd_unit|UnitOfMeasureNumberOfDecimals:andec|_Text:association', true],
  ['I_LANGUAGE', 'Language', '*Language:spras|LanguageISOCode:laiso|_Text:association', true],
  ['I_PRODUCT', 'Product', '*Product:matnr|ProductType:mtart|CreationDate:ersda|CreatedByUser:ernam|ProductGroup:matkl|BaseUnit:meins|GrossWeight:brgew|NetWeight:ntgew|WeightUnit:gewei|IsMarkedForDeletion:lvoma|_Text:association', true],
  ['I_CUSTOMER', 'Customer', '*Customer:kunnr|CustomerName:name1_gp|Country:land1_gp|CityName:ort01_gp|PostalCode:pstlz|StreetName:stras_gp|CustomerAccountGroup:ktokd|CreationDate:erdat_rf', true],
  ['I_SUPPLIER', 'Supplier', '*Supplier:lifnr|SupplierName:name1_gp|Country:land1_gp|CityName:ort01_gp|PostalCode:pstlz|SupplierAccountGroup:ktokk|CreationDate:erdat_rf', true],
  ['I_COMPANYCODE', 'Company code', '*CompanyCode:bukrs|CompanyCodeName:butxt|Currency:waers|Country:land1|Language:spras|ChartOfAccounts:ktopl|CityName:ort01', true],
  ['I_SALESORDER', 'Sales order', '*SalesOrder:vbeln_va|SalesOrderType:auart|SalesOrganization:vkorg|DistributionChannel:vtweg|OrganizationDivision:spart|SoldToParty:kunag|CreationDate:erdat|CreatedByUser:ernam|TotalNetAmount:netwr_ak|TransactionCurrency:waerk|_Item:association', true],
  ['/DMO/I_FLIGHT', 'Flight (demo)', '*AirlineID:/dmo/carrier_id|*ConnectionID:/dmo/connection_id|*FlightDate:/dmo/flight_date|Price:/dmo/flight_price|CurrencyCode:/dmo/currency_code|PlaneType:/dmo/plane_type_id|MaximumSeats:/dmo/plane_seats_max|OccupiedSeats:/dmo/plane_seats_occupied', true],
  ['/DMO/I_CARRIER', 'Airline (demo)', '*AirlineID:/dmo/carrier_id|Name:/dmo/carrier_name|CurrencyCode:/dmo/currency_code', true],
];
const DTELS: [string, string, boolean?][] = [
  ['MANDT', 'Client', true], ['BUKRS', 'Company code'], ['MATNR', 'Material number'], ['KUNNR', 'Customer number'], ['LIFNR', 'Supplier number'],
  ['VBELN', 'Sales and distribution document'], ['EBELN', 'Purchasing document'], ['BELNR_D', 'Accounting document'], ['GJAHR', 'Fiscal year'],
  ['WERKS_D', 'Plant'], ['WAERS', 'Currency key', true], ['MEINS', 'Base unit of measure'], ['MENGE_D', 'Quantity'], ['NETWR', 'Net value'],
  ['DMBTR', 'Amount in local currency'], ['SPRAS', 'Language key', true], ['LAND1', 'Country key', true], ['ERDAT', 'Created on'], ['ERNAM', 'Created by'],
  ['ABAP_BOOL', 'Boolean', true], ['XFELD', 'Checkbox'], ['SYSUUID_X16', 'UUID in binary format', true], ['SYSUUID_C32', 'UUID in character format', true],
  ['TIMESTAMP', 'UTC time stamp (short)', true], ['TIMESTAMPL', 'UTC time stamp (long)', true], ['SYUNAME', 'User name', true], ['SYMSGV', 'Message variable', true],
  ['BAPI_MTYPE', 'Message type', true], ['BAPI_MSG', 'Message text', true],
  ['/DMO/CARRIER_ID', 'Airline ID', true], ['/DMO/CONNECTION_ID', 'Connection number', true], ['/DMO/FLIGHT_DATE', 'Flight date', true],
  ['/DMO/FLIGHT_PRICE', 'Flight price', true], ['/DMO/CURRENCY_CODE', 'Currency', true], ['/DMO/PLANE_TYPE_ID', 'Plane type', true],
  ['/DMO/PLANE_SEATS_MAX', 'Maximum seats', true], ['/DMO/PLANE_SEATS_OCCUPIED', 'Occupied seats', true], ['/DMO/TRAVEL_ID', 'Travel ID', true],
  ['/DMO/BOOKING_ID', 'Booking number', true], ['/DMO/CUSTOMER_ID', 'Customer ID', true], ['/DMO/CARRIER_NAME', 'Airline name', true],
];
const TTYPES: [string, string, string, boolean?][] = [
  ['STRING_TABLE', 'Table of strings', 'string', true], ['BAPIRET2_T', 'Return table', 'bapiret2', true], ['STRINGTAB', 'Table of strings', 'string'],
  ['/DMO/T_FLIGHT', 'Flights', '/dmo/flight', true],
];

/** "m:name(params)>returning|static" compact member specs. params: "i:name:type[?]" i=importing e=exporting c=changing */
interface C { name: string; kind: 'class' | 'interface'; desc: string; released?: boolean; members: string[]; super?: string; intf?: string[] }
const CLASSES: C[] = [
  {
    name: 'CL_ABAP_UNIT_ASSERT', kind: 'class', desc: 'ABAP Unit assertions', released: true, members: [
      's:assert_equals(i:act:any|i:exp:any|i:msg:csequence?|i:quit:int1?|i:tol:f?)>assertion_failed:abap_bool', 's:assert_differs(i:act:simple|i:exp:simple|i:msg:csequence?)',
      's:assert_true(i:act:abap_bool|i:msg:csequence?)', 's:assert_false(i:act:abap_bool|i:msg:csequence?)', 's:assert_initial(i:act:any|i:msg:csequence?)',
      's:assert_not_initial(i:act:any|i:msg:csequence?)', 's:assert_bound(i:act:any|i:msg:csequence?)', 's:assert_not_bound(i:act:any|i:msg:csequence?)',
      's:assert_subrc(i:exp:sysubrc?|i:act:sysubrc?|i:msg:csequence?)', 's:assert_char_cp(i:act:csequence|i:exp:csequence|i:msg:csequence?)',
      's:assert_table_contains(i:line:any|i:table:any|i:msg:csequence?)', 's:assert_number_between(i:lower:numeric|i:upper:numeric|i:number:numeric|i:msg:csequence?)',
      's:fail(i:msg:csequence?|i:quit:int1?)', 's:skip(i:msg:csequence)', 's:abort(i:msg:csequence?)',
    ],
  },
  {
    name: 'CL_DEMO_OUTPUT', kind: 'class', desc: 'Simple output of data', members: [
      's:display(i:data:any?|i:name:string?)', 's:write(i:data:any|i:name:string?)>output:REF TO cl_demo_output', 's:new()>output:REF TO cl_demo_output',
      's:next_section(i:title:clike)>output:REF TO cl_demo_output', 's:begin_section(i:title:clike)>output:REF TO cl_demo_output',
    ],
  },
  {
    name: 'CL_SALV_TABLE', kind: 'class', desc: 'ALV for simple tables', members: [
      's:factory(i:list_display:abap_bool?|e:r_salv_table:REF TO cl_salv_table|c:t_table:table)!cx_salv_msg', 'display()', 'get_columns()>value:REF TO cl_salv_columns_table',
      'get_functions()>value:REF TO cl_salv_functions_list', 'get_display_settings()>value:REF TO cl_salv_display_settings', 'get_sorts()>value:REF TO cl_salv_sorts',
      'refresh(i:refresh_mode:salv_de_constant?)',
    ],
  },
  {
    name: 'CL_ABAP_CONTEXT_INFO', kind: 'class', desc: 'System and user context', released: true, members: [
      's:get_system_date()>rv_date:d', 's:get_system_time()>rv_time:t', 's:get_user_technical_name()>rv_technical_name:syuname',
      's:get_user_alias()>rv_alias:string', 's:get_user_formatted_name()>rv_formatted_name:string', 's:get_user_language_abap_format()>rv_language:spras',
      's:get_system_url()>rv_url:string',
    ],
  },
  { name: 'CL_ABAP_RANDOM_INT', kind: 'class', desc: 'Random integers', released: true, members: ['s:create(i:seed:i?|i:min:i?|i:max:i?)>prng:REF TO cl_abap_random_int', 'get_next()>value:i'] },
  {
    name: 'CL_ABAP_TYPEDESCR', kind: 'class', desc: 'Run time type services', released: true, members: [
      's:describe_by_data(i:p_data:any)>p_descr_ref:REF TO cl_abap_typedescr', 's:describe_by_name(i:p_name:any)>p_descr_ref:REF TO cl_abap_typedescr',
      's:describe_by_object_ref(i:p_object_ref:REF TO object)>p_descr_ref:REF TO cl_abap_typedescr', 'a:absolute_name:abap_abstypename', 'a:type_kind:abap_typekind',
    ],
  },
  { name: 'CL_ABAP_CHAR_UTILITIES', kind: 'class', desc: 'Character constants', released: true, members: ['k:cr_lf:abap_cr_lf', 'k:newline:abap_char1', 'k:horizontal_tab:abap_char1', 'k:minchar:abap_char1', 'k:maxchar:abap_char1'] },
  { name: 'CL_SYSTEM_UUID', kind: 'class', desc: 'UUIDs', released: true, members: ['s:create_uuid_x16_static()>uuid:sysuuid_x16!cx_uuid_error', 's:create_uuid_c32_static()>uuid:sysuuid_c32!cx_uuid_error'] },
  { name: 'CL_WEB_HTTP_CLIENT_MANAGER', kind: 'class', desc: 'HTTP client factory (ABAP Cloud)', released: true, members: ['s:create_by_http_destination(i:i_destination:REF TO if_http_destination)>r_client:REF TO if_web_http_client!cx_web_http_client_error'] },
  { name: 'CL_HTTP_DESTINATION_PROVIDER', kind: 'class', desc: 'HTTP destinations', released: true, members: ['s:create_by_url(i:i_url:string)>r_http_destination:REF TO if_http_destination!cx_http_dest_provider_error', 's:create_by_cloud_destination(i:i_name:string|i:i_authn_mode:if_a4c_cp_service=>ty_authn_mode?)>r_http_destination:REF TO if_http_destination!cx_http_dest_provider_error'] },
  { name: 'CL_GUI_FRONTEND_SERVICES', kind: 'class', desc: 'SAP GUI front end services', members: ['s:gui_download(i:filename:string|i:filetype:char10?|c:data_tab:table)', 's:gui_upload(i:filename:string|i:filetype:char10?|c:data_tab:table)', 's:file_open_dialog(i:window_title:string?|c:file_table:filetable|c:rc:i)'] },
  { name: 'XCO_CP', kind: 'class', desc: 'XCO library entry point', released: true, members: ['s:string(i:iv_value:string)>ro_string:REF TO if_xco_string', 'k:sy:REF TO if_xco_cp_sy'] },
  { name: 'IF_OO_ADT_CLASSRUN', kind: 'interface', desc: 'Run a class as console application (F9)', released: true, members: ['main(i:out:REF TO if_oo_adt_classrun_out)'] },
  { name: 'IF_OO_ADT_CLASSRUN_OUT', kind: 'interface', desc: 'Console output', released: true, members: ['write(i:data:any|i:name:string?)>output:REF TO if_oo_adt_classrun_out', 'get(i:data:any?|i:name:string?)>output:string'] },
  { name: 'IF_SERIALIZABLE_OBJECT', kind: 'interface', desc: 'Object can be serialized', released: true, members: [] },
  { name: 'IF_MESSAGE', kind: 'interface', desc: 'Message text access', released: true, members: ['get_text()>result:string', 'get_longtext(i:preserve_newlines:abap_bool?)>result:string'] },
  { name: 'IF_T100_MESSAGE', kind: 'interface', desc: 'T100 message in an exception', released: true, members: ['a:t100key:scx_t100key', 'k:default_textid:scx_t100key'] },
  { name: 'IF_T100_DYN_MSG', kind: 'interface', desc: 'Exception with MESSAGE … RAISING', released: true, members: ['a:msgty:symsgty', 'a:msgv1:symsgv', 'a:msgv2:symsgv', 'a:msgv3:symsgv', 'a:msgv4:symsgv'], intf: ['IF_T100_MESSAGE'] },
  { name: 'IF_WEB_HTTP_CLIENT', kind: 'interface', desc: 'HTTP client', released: true, members: ['get_http_request()>r_http_request:REF TO if_web_http_request', 'execute(i:i_method:string)>r_response:REF TO if_web_http_response!cx_web_http_client_error', 'close()'] },
  { name: 'CX_ROOT', kind: 'class', desc: 'Root of all exceptions', released: true, members: ['get_text()>result:string', 'get_longtext(i:preserve_newlines:abap_bool?)>result:string', 'get_source_position(e:program_name:syrepid|e:include_name:syrepid|e:source_line:i)', 'a:previous:REF TO cx_root', 'a:textid:sotr_conc'], intf: ['IF_MESSAGE', 'IF_SERIALIZABLE_OBJECT'] },
  ...[
    ['CX_STATIC_CHECK', 'Checked exception (must be declared)', 'CX_ROOT'], ['CX_DYNAMIC_CHECK', 'Exception checked at run time', 'CX_ROOT'], ['CX_NO_CHECK', 'Exception that need not be declared', 'CX_ROOT'],
    ['CX_SY_ZERODIVIDE', 'Division by zero', 'CX_DYNAMIC_CHECK'], ['CX_SY_ARITHMETIC_OVERFLOW', 'Arithmetic overflow', 'CX_DYNAMIC_CHECK'],
    ['CX_SY_CONVERSION_NO_NUMBER', 'Text cannot be converted to a number', 'CX_DYNAMIC_CHECK'], ['CX_SY_ITAB_LINE_NOT_FOUND', 'Table row not found (table expression)', 'CX_DYNAMIC_CHECK'],
    ['CX_SY_REF_IS_INITIAL', 'Dereferencing an initial reference', 'CX_DYNAMIC_CHECK'], ['CX_SY_MOVE_CAST_ERROR', 'Down cast failed', 'CX_DYNAMIC_CHECK'],
    ['CX_SY_OPEN_SQL_DB', 'Database error in ABAP SQL', 'CX_DYNAMIC_CHECK'], ['CX_SY_DYN_CALL_ILLEGAL_METHOD', 'Dynamic call of an unknown method', 'CX_DYNAMIC_CHECK'],
    ['CX_UUID_ERROR', 'UUID could not be created', 'CX_STATIC_CHECK'], ['CX_SALV_MSG', 'ALV error', 'CX_STATIC_CHECK'],
    ['CX_WEB_HTTP_CLIENT_ERROR', 'HTTP client error', 'CX_STATIC_CHECK'], ['CX_HTTP_DEST_PROVIDER_ERROR', 'HTTP destination error', 'CX_STATIC_CHECK'],
    ['CX_ABAP_CONTEXT_INFO_ERROR', 'Context info not available', 'CX_STATIC_CHECK'],
  ].map(([name, desc, sup]): C => ({ name, kind: 'class', desc, released: name !== 'CX_SALV_MSG', members: [], super: sup })),
];

const FMS: [string, string, string, string, boolean?][] = [
  // name, desc, params "i:name:type[?]|e:…|c:…|t:…", exceptions
  ['BAPI_TRANSACTION_COMMIT', 'Commit after BAPI calls', 'i:wait:bapita-wait?|e:return:bapiret2', ''],
  ['BAPI_TRANSACTION_ROLLBACK', 'Roll back after BAPI calls', 'e:return:bapiret2', ''],
  ['CONVERSION_EXIT_ALPHA_INPUT', 'Add leading zeros', 'i:input:clike|e:output:clike', ''],
  ['CONVERSION_EXIT_ALPHA_OUTPUT', 'Remove leading zeros', 'i:input:clike|e:output:clike', ''],
  ['POPUP_TO_CONFIRM', 'Confirmation popup', 'i:titlebar:clike?|i:text_question:clike|i:text_button_1:clike?|i:text_button_2:clike?|i:default_button:clike?|i:display_cancel_button:clike?|e:answer:clike', 'text_not_found'],
  ['GUI_DOWNLOAD', 'Download a table to a local file', 'i:filename:string|i:filetype:char10?|i:write_field_separator:char01?|t:data_tab:standard table', 'file_write_error|no_batch|gui_refuse_filetransfer|invalid_type|no_authority|unknown_error'],
  ['GUI_UPLOAD', 'Upload a local file into a table', 'i:filename:string|i:filetype:char10?|i:has_field_separator:char01?|t:data_tab:standard table', 'file_open_error|file_read_error|no_batch|unknown_error'],
  ['REUSE_ALV_GRID_DISPLAY', 'Classic ALV grid', 'i:i_callback_program:sy-repid?|i:i_structure_name:dd02l-tabname?|i:is_layout:slis_layout_alv?|i:it_fieldcat:slis_t_fieldcat_alv?|t:t_outtab:standard table', 'program_error'],
  ['BAPI_USER_GET_DETAIL', 'User details', 'i:username:bapibname-bapibname|e:address:bapiaddr3|e:logondata:bapilogond|t:return:bapiret2', ''],
  ['DATE_CHECK_PLAUSIBILITY', 'Is a date valid?', 'i:date:sy-datum', 'plausibility_check_failed'],
  ['RP_CALC_DATE_IN_INTERVAL', 'Add days/months/years to a date', 'i:date:p0001-begda|i:days:t5a4a-dlydy|i:months:t5a4a-dlymo|i:signum:t5a4a-split|i:years:t5a4a-dlyyr|e:calc_date:p0001-begda', ''],
  ['NUMBER_GET_NEXT', 'Next number from a number range', 'i:nr_range_nr:inri-nrrangenr|i:object:inri-object|i:quantity:inri-quantity?|e:number:any|e:returncode:inri-returncode', 'interval_not_found|number_range_not_intern|object_not_found|quantity_is_0|buffer_overflow'],
  ['READ_TEXT', 'Read a long text', 'i:client:sy-mandt?|i:id:thead-tdid|i:language:thead-tdspras|i:name:thead-tdname|i:object:thead-tdobject|e:header:thead|t:lines:tline', 'id|language|name|not_found|object|reference_check|wrong_access_to_archive'],
  ['SPELL_AMOUNT', 'Amount in words', 'i:amount:any?|i:currency:sy-waers?|i:language:sy-langu?|e:in_words:spell', 'not_found|too_large'],
];

// ====================================================================== parsing helpers

function parseFields(spec: string): Field[] {
  if (!spec) return [];
  return spec.split('|').map(s => {
    const key = s.startsWith('*');
    const [name, type = '', desc = ''] = (key ? s.slice(1) : s).split(':');
    return { name, type, desc, key };
  });
}
function parseParamSpec(s: string): Param {
  const [k, name, typ] = s.split(':');
  const optional = typ.endsWith('?');
  const kind = ({ i: 'importing', e: 'exporting', c: 'changing', t: 'tables', r: 'returning' } as const)[k as 'i' | 'e' | 'c' | 't' | 'r'];
  return { name, kind, type: optional ? typ.slice(0, -1) : typ, optional };
}
function parseMemberSpec(spec: string): Member {
  let s = spec, isStatic = false;
  if (s.startsWith('a:')) { const [, n, t] = s.split(':'); return { name: n, kind: 'attribute', static: false, visibility: 'public', type: s.slice(3 + n.length) || t }; }
  if (s.startsWith('k:')) { const [, n] = s.split(':'); return { name: n, kind: 'constant', static: true, visibility: 'public', type: s.slice(3 + n.length) }; }
  if (s.startsWith('s:')) { isStatic = true; s = s.slice(2); }
  const m = s.match(/^(\w+)\(([^)]*)\)(?:>(\w+):([^!]+))?(?:!(.+))?$/);
  if (!m) return { name: s, kind: 'method', static: isStatic, visibility: 'public', params: [] };
  const params = m[2] ? m[2].split('|').map(parseParamSpec) : [];
  if (m[3]) params.push({ name: m[3], kind: 'returning', type: m[4], optional: false });
  return { name: m[1], kind: 'method', static: isStatic, visibility: 'public', params, raising: m[5] ? m[5].split(',') : [] };
}

/** Parameters in METHODS / FUNCTION signatures. */
export function parseSignature(text: string): { params: Param[]; raising: string[]; exceptions: string[] } {
  const params: Param[] = [];
  const raising: string[] = [];
  const exceptions: string[] = [];
  const re = /\b(IMPORTING|EXPORTING|CHANGING|RETURNING|TABLES|RAISING|EXCEPTIONS)\b([\s\S]*?)(?=\b(?:IMPORTING|EXPORTING|CHANGING|RETURNING|TABLES|RAISING|EXCEPTIONS)\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const sec = m[1].toUpperCase(), body = m[2];
    if (sec === 'RAISING') { raising.push(...body.trim().split(/\s+/).filter(w => w && !/^RESUMABLE$/i.test(w)).map(w => w.replace(/^RESUMABLE\(|\)$/gi, ''))); continue; }
    if (sec === 'EXCEPTIONS') { exceptions.push(...body.trim().split(/\s+/).filter(Boolean)); continue; }
    const kind = sec.toLowerCase() as Param['kind'];
    if (sec === 'TABLES') {
      // TABLES t1 [STRUCTURE s | TYPE t | LIKE l] [OPTIONAL] t2 …
      const tok = body.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < tok.length; i++) {
        if (/^(TYPE|LIKE|STRUCTURE|OPTIONAL|STANDARD|TABLE|OF)$/i.test(tok[i])) continue;
        if (i > 0 && /^(TYPE|LIKE|STRUCTURE|OF)$/i.test(tok[i - 1])) continue;
        const typed = /^(TYPE|LIKE|STRUCTURE)$/i.test(tok[i + 1] || '') ? tok[i + 2] : '';
        const optional = tok.slice(i + 1, i + 4).some(t => /^OPTIONAL$/i.test(t));
        params.push({ name: tok[i].toLowerCase(), kind, type: (typed || 'standard table').toLowerCase(), optional });
      }
      continue;
    }
    const pr = /(?:VALUE\(|REFERENCE\()?([\w/]+)\)?\s+(?:TYPE|LIKE)\s+((?:REF\s+TO\s+)?(?:(?:STANDARD\s+|SORTED\s+|HASHED\s+|ANY\s+|INDEX\s+)?TABLE(?:\s+OF\s+[\w/=>~-]+)?|[\w/=>~-]+))(\s+OPTIONAL|\s+DEFAULT\s+\S+)?/gi;
    let p: RegExpExecArray | null;
    while ((p = pr.exec(body))) {
      params.push({ name: p[1].toLowerCase(), kind, type: p[2].toLowerCase().replace(/\s+/g, ' '), optional: !!p[3] || kind === 'exporting' });
    }
  }
  return { params, raising, exceptions };
}

/** Members of a class or interface from its definition source. */
export function parseClassSource(source: string, name: string): ClassInfo {
  const st = statements(source.split('\n'));
  let vis: Member['visibility'] = 'public';
  let inDef = false, kind: ClassInfo['kind'] = 'class', superClass: string | undefined;
  const interfaces: string[] = [];
  const members: Member[] = [];
  let structDepth = 0;
  const lname = name.toLowerCase();
  for (const s of st) {
    const w = s.words, k = s.kw, text = s.text.trim();
    if ((k === 'CLASS' && w.includes('DEFINITION')) || (k === 'INTERFACE' && !w.includes('DEFERRED') && !w.includes('LOAD'))) {
      inDef = (w[1] || '').toLowerCase() === lname || !lname;
      kind = k === 'INTERFACE' ? 'interface' : 'class';
      const inh = text.match(/INHERITING\s+FROM\s+([\w/]+)/i);
      if (inh) superClass = inh[1].toUpperCase();
      vis = kind === 'interface' ? 'public' : 'public';
      continue;
    }
    if (k === 'ENDCLASS' || k === 'ENDINTERFACE') { inDef = false; continue; }
    if (!inDef) continue;
    if (/^(PUBLIC|PROTECTED|PRIVATE)$/.test(k) && w[1] === 'SECTION') { vis = k.toLowerCase() as Member['visibility']; continue; }
    const chainHead = text.match(/^([\w-]+)\s*:\s*/);
    const head = (chainHead ? chainHead[1] : k).toUpperCase();
    const bodies = chainHead ? text.slice(chainHead[0].length).split(',') : [text.slice(k.length)];
    for (const b of bodies) {
      const body = b.trim();
      const n = (body.match(/^(?:VALUE\()?([\w/~]+)/) || [])[1];
      if (!n) continue;
      if (head === 'INTERFACES') { interfaces.push(n.toUpperCase()); continue; }
      if ((head === 'TYPES' || head === 'DATA' || head === 'CLASS-DATA' || head === 'CONSTANTS') && /^BEGIN\s+OF\b/i.test(body)) {
        structDepth++;
        if (structDepth === 1) {
          const sn = (body.match(/^BEGIN\s+OF\s+([\w/]+)/i) || [])[1];
          if (sn) members.push({ name: sn.toLowerCase(), kind: head === 'TYPES' ? 'type' : head === 'CONSTANTS' ? 'constant' : 'attribute', static: head !== 'DATA', visibility: vis, type: 'structure' });
        }
        continue;
      }
      if (/^END\s+OF\b/i.test(body)) { structDepth = Math.max(0, structDepth - 1); continue; }
      if (structDepth > 0) continue;
      const typ = (body.match(/\b(?:TYPE|LIKE)\s+(.+?)(?:\s+(?:VALUE|READ-ONLY|OPTIONAL)\b.*)?$/i) || [])[1]?.toLowerCase().replace(/\s+/g, ' ');
      if (head === 'METHODS' || head === 'CLASS-METHODS') {
        const sig = parseSignature(body.slice(n.length));
        members.push({ name: n.toLowerCase(), kind: 'method', static: head === 'CLASS-METHODS', visibility: vis, params: sig.params, raising: sig.raising });
      } else if (head === 'DATA' || head === 'CLASS-DATA') {
        members.push({ name: n.toLowerCase(), kind: 'attribute', static: head === 'CLASS-DATA', visibility: vis, type: typ });
      } else if (head === 'CONSTANTS') {
        members.push({ name: n.toLowerCase(), kind: 'constant', static: true, visibility: vis, type: typ });
      } else if (head === 'TYPES') {
        members.push({ name: n.toLowerCase(), kind: 'type', static: true, visibility: vis, type: typ });
      } else if (head === 'EVENTS' || head === 'CLASS-EVENTS') {
        members.push({ name: n.toLowerCase(), kind: 'event', static: head === 'CLASS-EVENTS', visibility: vis });
      }
    }
  }
  return { name: name.toUpperCase(), kind, superClass, interfaces, members };
}

/** Element names of a CDS view, including associations (names starting with _). */
export function parseCdsSource(source: string): Field[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const open = noComments.indexOf('{');
  const close = noComments.lastIndexOf('}');
  if (open < 0 || close < open) return [];
  const body = noComments.slice(open + 1, close).replace(/@[\w.]+\s*:\s*(\[[^\]]*\]|\{[^}]*\}|'[^']*'|[^\s,]+)/g, '').replace(/@[\w.]+/g, '');
  const out: Field[] = [];
  let depth = 0, cur = '';
  const flush = () => {
    const t = cur.trim(); cur = '';
    if (!t) return;
    const key = /^key\s+/i.test(t);
    const clean = t.replace(/^key\s+/i, '').replace(/^virtual\s+/i, '');
    const alias = clean.match(/\bas\s+([\w]+)\s*$/i);
    const nm = alias ? alias[1] : (clean.match(/([\w$]+)\s*$/) || [])[1];
    if (nm) out.push({ name: nm, type: /^_/.test(nm) ? 'association' : '', key });
  };
  for (const ch of body) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { flush(); continue; }
    cur += ch;
  }
  flush();
  return out;
}

/** "define table" / "define structure" source (DDIC objects in ADT on newer releases). */
export function parseTableSource(source: string): Field[] {
  const body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
  const out: Field[] = [];
  for (const raw of body.split(';')) {
    const t = raw.replace(/@[\w.]+\s*:\s*('[^']*'|[^\s]+)/g, '').trim();
    const m = t.match(/^(key\s+)?([\w/]+)\s*:\s*([\w/.]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i);
    if (m) out.push({ name: m[2].toLowerCase(), type: m[3].toLowerCase(), key: !!m[1] });
    const inc = t.match(/^include\s+([\w/]+)/i);
    if (inc) out.push({ name: '.include', type: inc[1].toLowerCase() });
  }
  return out;
}

/** FUNCTION statement as shown by ADT: FUNCTION name IMPORTING … EXPORTING … */
export function parseFmSource(source: string, name: string): FmInfo {
  const st = statements(source.split('\n'));
  const fn = st.find(s => s.kw === 'FUNCTION');
  const sig = parseSignature(fn ? fn.text.replace(/^\s*FUNCTION\s+[\w/]+/i, '') : '');
  return { name: name.toUpperCase(), params: sig.params, exceptions: sig.exceptions };
}

// ====================================================================== catalogs

export class StdCatalog implements Catalog {
  private entries: CatEntry[] = [];
  private fields = new Map<string, Field[]>();
  private classes = new Map<string, ClassInfo>();
  private fms = new Map<string, FmInfo>();
  private rows = new Map<string, string>();

  constructor(private cloud = false) {
    const add = (e: CatEntry) => { if (!cloud || e.released) this.entries.push(e); };
    for (const [n, d, f, r] of TABLES) { add({ name: n, kind: 'table', desc: d, released: r }); this.fields.set(n, parseFields(f)); }
    for (const [n, d, f, r] of STRUCTURES) { add({ name: n, kind: 'structure', desc: d, released: r }); this.fields.set(n, parseFields(f)); }
    for (const [n, d, f, r] of CDS) { add({ name: n, kind: 'cds', desc: d, released: r }); this.fields.set(n, parseFields(f)); }
    for (const [n, d, r] of DTELS) add({ name: n, kind: 'dtel', desc: d, released: r });
    for (const [n, d, row, r] of TTYPES) { add({ name: n, kind: 'ttyp', desc: d, released: r }); this.rows.set(n, row); }
    for (const c of CLASSES) {
      const kind: EntryKind = c.kind === 'interface' ? 'interface' : /^CX_/.test(c.name) ? 'exception' : 'class';
      add({ name: c.name, kind, desc: c.desc, released: c.released });
      this.classes.set(c.name, { name: c.name, kind: c.kind, superClass: c.super, interfaces: c.intf || [], members: c.members.map(parseMemberSpec) });
    }
    for (const [n, d, p, ex, r] of FMS) {
      add({ name: n, kind: 'fm', desc: d, released: r });
      this.fms.set(n, { name: n, params: p.split('|').filter(Boolean).map(parseParamSpec), exceptions: ex ? ex.split('|') : [] });
    }
  }

  async find(prefix: string, kinds: EntryKind[], limit = 60): Promise<CatEntry[]> {
    const p = prefix.toUpperCase();
    return this.entries.filter(e => kinds.includes(e.kind) && (!p || e.name.startsWith(p) || (p.length > 2 && e.name.includes(p)))).slice(0, limit);
  }
  async fieldsOf(name: string) { return this.fields.get(name.toUpperCase()) ?? null; }
  async classInfo(name: string) { const c = this.classes.get(name.toUpperCase()); return c && (!this.cloud || this.entries.some(e => e.name === c.name)) ? c : null; }
  async fm(name: string) { return this.fms.get(name.toUpperCase()) ?? null; }
  async rowTypeOf(name: string) { return this.rows.get(name.toUpperCase()) ?? null; }
}

/** Objects of the open system (parsed from their source) layered over a base catalog. */
export class WorkspaceCatalog implements Catalog {
  constructor(private base: Catalog, private objects: () => { name: string; type: string; desc: string; source: string }[]) {}

  async find(prefix: string, kinds: EntryKind[], limit = 60): Promise<CatEntry[]> {
    const p = prefix.toUpperCase();
    const own: CatEntry[] = [];
    for (const o of this.objects()) {
      const kind: EntryKind | null = o.type === 'CLAS' ? (/^[ZY]?CX_|\/CX_/.test(o.name) ? 'exception' : 'class') : o.type === 'INTF' ? 'interface' : o.type === 'DDLS' ? 'cds' : null;
      if (kind && kinds.includes(kind) && (!p || o.name.startsWith(p) || (p.length > 2 && o.name.includes(p)))) own.push({ name: o.name, kind, desc: o.desc, released: true });
    }
    const base = await this.base.find(prefix, kinds, limit);
    return [...own, ...base.filter(b => !own.some(o => o.name === b.name))].slice(0, limit);
  }
  async fieldsOf(name: string) {
    const o = this.objects().find(x => x.name === name.toUpperCase() && x.type === 'DDLS');
    return o ? parseCdsSource(o.source) : this.base.fieldsOf(name);
  }
  async classInfo(name: string) {
    const o = this.objects().find(x => x.name === name.toUpperCase() && (x.type === 'CLAS' || x.type === 'INTF'));
    return o ? parseClassSource(o.source, o.name) : this.base.classInfo(name);
  }
  fm(name: string) { return this.base.fm(name); }
  rowTypeOf(name: string) { return this.base.rowTypeOf(name); }
}
