// Fixed texts and settings of the workbench.
import type { Connection } from '../core/types';
import type { KeywordCase } from '../core/format';
import type { RuleId } from '../core/cleaner';

export const APP_VERSION = '0.3.0';
/** Where Help > Report a Problem opens an issue. */
export const REPORT_REPO = 'billaheagle/nusa-adt';
export type ExtId = 'preview' | 'abapgit' | 'cleaner' | 'rapgen' | 'docs' | 'outline';
export interface Settings { autoOpenLogon: boolean; editorFont: number; autoComplete: boolean; restoreTabs: boolean; cleanerRules: RuleId[]; ext: Record<ExtId, boolean>; formatOnSave: boolean; cleanOnSave: boolean; keepDrafts: boolean; previewTabs: boolean; formatter: 'nusa' | 'sap'; keywordCase: KeywordCase; checkUpdates: boolean }

export const EXTENSIONS: { id: ExtId; name: string; icon: string; desc: string; keys: string }[] = [
  { id: 'preview', name: 'Data Preview & SQL Console', icon: 'grid', desc: 'Browse the content of database tables and CDS views and run ABAP SQL, like F8 on a table in Eclipse.', keys: 'F8 on a table or CDS view · Ctrl+Enter runs the query' },
  { id: 'abapgit', name: 'abapGit Repositories', icon: 'git', desc: 'Link packages to Git repositories and pull them through the ADT abapGit service (SAP BTP, S/4HANA Cloud and recent on-premise releases).', keys: 'abapGit view in the left rail' },
  { id: 'cleaner', name: 'ABAP Cleaner', icon: 'sparkle', desc: 'Rewrites obsolete statements to modern ABAP: MOVE, CREATE OBJECT, CALL METHOD, EQ/NE, NOT … IS, chained declarations, alignment and keyword case.', keys: 'Ctrl+4 cleans the open source' },
  { id: 'rapgen', name: 'RAP Generator', icon: 'layers', desc: 'Generates a RAP business object with UI service from a database table: views, metadata extension, behavior definitions, service definition and binding.', keys: 'Right-click a database table' },
  { id: 'docs', name: 'ABAP Keyword Documentation & Element Info', icon: 'book', desc: 'Opens the SAP keyword documentation for the statement at the cursor and shows signatures and field details.', keys: 'F1 documentation · F2 element info' },
  { id: 'outline', name: 'Outline', icon: 'outline', desc: 'Structure of the open object: classes, sections, methods, attributes, events and CDS elements.', keys: 'Outline view in the left rail' },
];

/** What changes for someone used to Eclipse ADT. */
export const ECLIPSE_POINTS: [string, string][] = [
  ['No workspace, no projects', 'Add a system and start. Switching systems is one click, and every system keeps its own open editors.'],
  ['Never lose work', 'Unsaved changes survive a crash or restart, every save goes into local history, and Compare shows what changed against the active version.'],
  ['Editing like VS Code', 'Command palette, Ctrl+D for the next match with several cursors, Alt+Up/Down to move lines, Ctrl+Shift+K to delete them.'],
  ['Built in, not plugins', 'Data preview and SQL console, ABAP Cleaner (also on save), RAP generator, abapGit, keyword documentation. Turn each on or off.'],
  ['Clear errors', 'When a system cannot be reached you see why and what to do, with diagnostics you can copy.'],
  ['Small and portable', 'Uses the system web view instead of a Java runtime. The portable build runs from any folder without installing.'],
];

export const KIND_LABEL: Record<Connection['kind'], string> = { s4: 'On-premise', s4cloud: 'S/4HANA Cloud', btp: 'BTP ABAP', runner: 'Runner' };
export const AUTH_LABEL: Record<Connection['auth'], string> = { basic: 'User and password (keychain)', sso: 'Browser logon (single sign-on)', oauth: 'Service key (OAuth)', rfc: 'SAP GUI logon (RFC, SAProuter)', none: 'No login' };

