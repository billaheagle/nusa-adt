// Eclipse-style layouts for form-based objects. A layout names the sections, labels, help
// texts, choices and value helps of a type, and finds its values in the object's XML by
// element name (namespace prefixes differ between releases). Values a layout does not
// mention still show up under "More properties", so nothing is hidden.

import { ObjType } from '../core/types';

export type FieldKind = 'text' | 'number' | 'select' | 'bool' | 'radio';
export type Get = (at: string) => string;
export interface FieldDef {
  /** element path by local names ("typeInformation/length"), optionally "@attr" */
  at: string;
  label: string | ((get: Get) => string);
  kind?: FieldKind;
  options?: [string, string][];
  /** repository value help: object types, e.g. "DOMA" or "DTEL,TABL,TTYP" */
  vh?: string | ((get: Get) => string);
  help?: string;
  width?: 'xs' | 'sm' | 'md' | 'lg';
  when?: (get: Get) => boolean;
  readOnly?: (get: Get) => boolean;
  /** shown under a read-only value */
  note?: (get: Get) => string;
  /** changes re-render the form (fields depend on it) */
  rerender?: boolean;
}
export interface LabelRowsDef { kind: 'labels'; rows: [string, string][] }
export interface TableDef { kind: 'table'; at: string; columns: { at: string; label: string; width?: 'xs' | 'sm' | 'md' | 'lg'; vh?: string }[]; noun: string; number?: string }
export interface SectionDef { title: string; help?: string; half?: boolean; fields?: FieldDef[]; block?: LabelRowsDef | TableDef }
export interface Layout { sections: SectionDef[]; effects?: (at: string, value: string, set: (at: string, v: string) => void, get: Get) => boolean }

/** ABAP Dictionary built-in types: name, description, fixed length (0 = no length), decimals allowed */
export const DDIC_TYPES: [string, string, number | null, boolean][] = [
  ['CHAR', 'Character string', null, false], ['NUMC', 'Numeric text', null, false], ['SSTRING', 'Short character string', null, false],
  ['STRING', 'Character string of variable length', 0, false], ['DATS', 'Date (YYYYMMDD)', 8, false], ['TIMS', 'Time (HHMMSS)', 6, false],
  ['DATN', 'Date (database type)', 8, false], ['TIMN', 'Time (database type)', 6, false], ['UTCL', 'UTC time stamp', 27, false],
  ['DEC', 'Packed number', null, true], ['CURR', 'Currency amount', null, true], ['QUAN', 'Quantity', null, true],
  ['CUKY', 'Currency key', 5, false], ['UNIT', 'Unit of measure', 3, false], ['INT1', '1-byte integer', 3, false],
  ['INT2', '2-byte integer', 5, false], ['INT4', '4-byte integer', 10, false], ['INT8', '8-byte integer', 19, false],
  ['FLTP', 'Floating point number', 16, true], ['D16N', 'Decimal floating point, 16 digits', 16, false], ['D34N', 'Decimal floating point, 34 digits', 34, false],
  ['RAW', 'Byte sequence', null, false], ['RAWSTRING', 'Byte sequence of variable length', 0, false], ['LANG', 'Language key', 1, false],
  ['CLNT', 'Client', 3, false], ['ACCP', 'Posting period (YYYYMM)', 6, false],
];
const typeOptions: [string, string][] = DDIC_TYPES.map(([n, d]) => [n, `${n} · ${d}`]);
const decimalsAllowed = (t: string) => DDIC_TYPES.find(x => x[0] === t)?.[3] ?? false;
const fixedLength = (t: string) => DDIC_TYPES.find(x => x[0] === t)?.[2] ?? null;

const DTEL_KINDS: [string, string][] = [
  ['domain', 'Domain'], ['predefinedAbapType', 'Predefined type'],
  ['refToPredefinedAbapType', 'Reference to predefined type'], ['refToDictionaryType', 'Reference to dictionary type'], ['refToClifType', 'Reference to class or interface'],
];
const usesTypeName = (k: string) => ['domain', 'refToDictionaryType', 'refToClifType'].includes(k);
const usesBuiltIn = (k: string) => ['predefinedAbapType', 'refToPredefinedAbapType'].includes(k);

export const LAYOUTS: Partial<Record<ObjType, Layout>> = {
  DTEL: {
    sections: [
      {
        title: 'Data Type',
        fields: [
          { at: 'typeKind', label: 'Category', kind: 'radio', options: DTEL_KINDS, rerender: true, help: 'Where the technical type of the data element comes from' },
          {
            at: 'typeName', label: g => g('typeKind') === 'domain' ? 'Domain' : g('typeKind') === 'refToClifType' ? 'Class or interface' : 'Referenced type',
            vh: g => g('typeKind') === 'domain' ? 'DOMA' : g('typeKind') === 'refToClifType' ? 'CLAS,INTF' : 'DTEL,TABL,TTYP', width: 'md',
            when: g => usesTypeName(g('typeKind')), help: 'Press Ctrl+Space or the search button to look it up in the system',
          },
          {
            at: 'dataType', label: 'Data type', kind: 'select', options: typeOptions, width: 'md', rerender: true,
            when: g => g('typeKind') !== 'refToClifType' && g('typeKind') !== 'refToDictionaryType',
            readOnly: g => !usesBuiltIn(g('typeKind')), note: g => g('typeKind') === 'domain' ? 'Comes from the domain' : '',
          },
          {
            at: 'dataTypeLength', label: 'Length', kind: 'number', width: 'xs',
            when: g => g('typeKind') !== 'refToClifType' && g('typeKind') !== 'refToDictionaryType',
            readOnly: g => !usesBuiltIn(g('typeKind')) || fixedLength(g('dataType')) !== null,
          },
          {
            at: 'dataTypeDecimals', label: 'Decimals', kind: 'number', width: 'xs',
            when: g => (g('typeKind') !== 'refToClifType' && g('typeKind') !== 'refToDictionaryType') && decimalsAllowed(g('dataType')),
            readOnly: g => !usesBuiltIn(g('typeKind')),
          },
        ],
      },
      { title: 'Field Labels', help: 'Texts shown for fields of this type in screens, lists and Fiori apps', block: { kind: 'labels', rows: [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long'], ['heading', 'Heading']] } },
      {
        title: 'Additional Properties',
        fields: [
          { at: 'searchHelp', label: 'Search help', vh: 'SHLP', width: 'md', help: 'Value help offered for fields of this type' },
          { at: 'searchHelpParameter', label: 'Search help parameter', width: 'md', when: g => !!g('searchHelp') },
          { at: 'setGetParameter', label: 'Parameter ID', vh: 'PARA', width: 'sm', help: 'SET/GET parameter that prefills fields of this type' },
          { at: 'defaultComponentName', label: 'Default component name', width: 'md', help: 'Proposed name when the data element is used in a structure' },
          { at: 'changeDocument', label: 'Change document', kind: 'bool', help: 'Log changes of fields with this type in change documents' },
          { at: 'deactivateInputHistory', label: 'No input history', kind: 'bool' },
          { at: 'leftToRightDirection', label: 'Write direction left-to-right', kind: 'bool' },
          { at: 'deactivateBIDIFiltering', label: 'No BIDI filtering', kind: 'bool' },
        ],
      },
    ],
    effects(at, v, set, get) {
      if (at === 'typeKind') {
        if (usesBuiltIn(v)) { set('typeName', ''); if (!get('dataType')) set('dataType', 'CHAR'); }
        return true;
      }
      if (at === 'dataType') {
        const fixed = fixedLength(v);
        if (fixed !== null) set('dataTypeLength', String(fixed));
        if (!decimalsAllowed(v)) set('dataTypeDecimals', '0');
        return true;
      }
      return false;
    },
  },
  DOMA: {
    sections: [
      {
        title: 'Format', half: true,
        fields: [
          { at: 'typeInformation/datatype', label: 'Data type', kind: 'select', options: typeOptions, width: 'md', rerender: true },
          { at: 'typeInformation/length', label: 'Number of characters', kind: 'number', width: 'xs', readOnly: g => fixedLength(g('typeInformation/datatype')) !== null },
          { at: 'typeInformation/decimals', label: 'Decimal places', kind: 'number', width: 'xs', when: g => decimalsAllowed(g('typeInformation/datatype')) },
        ],
      },
      {
        title: 'Output Characteristics', half: true,
        fields: [
          { at: 'outputInformation/length', label: 'Output length', kind: 'number', width: 'xs' },
          { at: 'outputInformation/conversionExit', label: 'Conversion routine', width: 'sm', help: 'For example ALPHA: CONVERSION_EXIT_ALPHA_INPUT and _OUTPUT run on input and output' },
          { at: 'outputInformation/signExists', label: 'Sign', kind: 'bool', help: 'Allow negative values' },
          { at: 'outputInformation/lowercase', label: 'Lower case', kind: 'bool', help: 'Keep lower-case letters instead of converting to upper case' },
        ],
      },
      {
        title: 'Value Range', help: 'Fixed values limit the field to a list, a value table proposes values from a table',
        fields: [{ at: 'valueInformation/valueTableRef@name', label: 'Value table', vh: 'TABL', width: 'md' }],
        block: { kind: 'table', at: 'fixValues', noun: 'fixed value', number: 'position', columns: [{ at: 'low', label: 'Fixed value', width: 'sm' }, { at: 'high', label: 'Upper limit', width: 'sm' }, { at: 'text', label: 'Description', width: 'lg' }] },
      },
    ],
    effects(at, v, set) {
      if (at === 'typeInformation/datatype') {
        const fixed = fixedLength(v);
        if (fixed !== null) { set('typeInformation/length', String(fixed)); set('outputInformation/length', String(fixed)); }
        if (!decimalsAllowed(v)) set('typeInformation/decimals', '0');
        return true;
      }
      return false;
    },
  },
};

/** Value helps guessed from a field's name, for types without a layout. */
export function guessValueHelp(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/servicebinding|bindingname/.test(n)) return 'SRVB';
  if (/servicedefinition/.test(n)) return 'SRVD';
  if (/dataelement|rollname/.test(n)) return 'DTEL';
  if (/^domain|domname/.test(n)) return 'DOMA';
  if (/checktable|valuetable|tabname|^table$/.test(n)) return 'TABL';
  if (/searchhelp|shlp/.test(n)) return 'SHLP';
  if (/^class$|classname|implementingclass|clif/.test(n)) return 'CLAS,INTF';
  if (/authobject|authorizationobject|^object$/.test(n)) return 'SUSO';
  if (/authfield|^field$/.test(n)) return 'AUTH';
  if (/iamapp|^app$|appname/.test(n)) return 'SIA6';
  if (/catalog/.test(n)) return 'SIA1';
  if (/scenario/.test(n)) return 'SCO1';
  if (/cdsentity|entityname|ddls/.test(n)) return 'DDLS';
  if (/package|devclass/.test(n)) return 'DEVC';
  return undefined;
}
