// F1: ABAP keyword documentation on help.sap.com for the statement at the cursor.

import { segs, statements } from './abap';

const STATEMENT_FILES: [RegExp, string][] = [
  [/^SELECT\b/i, 'abapselect.htm'], [/^LOOP\s+AT\s+GROUP\b/i, 'abaploop_at_group.htm'], [/^LOOP\s+AT\b/i, 'abaploop_at_itab.htm'],
  [/^READ\s+TABLE\b/i, 'abapread_table.htm'], [/^MODIFY\s+(TABLE\s+)?[\w<>-]+\s+(FROM|INDEX|TRANSPORTING)\b/i, 'abapmodify_itab.htm'],
  [/^MODIFY\b/i, 'abapmodify_dbtab.htm'], [/^INSERT\s+.+\bINTO\s+(TABLE\b|[\w<>-]+\s+INDEX)/i, 'abapinsert_itab.htm'], [/^INSERT\b/i, 'abapinsert_dbtab.htm'],
  [/^DELETE\s+(TABLE\s+)?[\w<>-]+\s+(WHERE|INDEX|FROM|ADJACENT)\b/i, 'abapdelete_itab.htm'], [/^DELETE\b/i, 'abapdelete_dbtab.htm'],
  [/^UPDATE\b/i, 'abapupdate.htm'], [/^APPEND\b/i, 'abapappend.htm'], [/^SORT\b/i, 'abapsort_itab.htm'], [/^COLLECT\b/i, 'abapcollect.htm'],
  [/^DATA\b/i, 'abapdata.htm'], [/^FINAL\b/i, 'abapfinal_inline.htm'], [/^TYPES\b/i, 'abaptypes.htm'], [/^CONSTANTS\b/i, 'abapconstants.htm'],
  [/^FIELD-SYMBOLS\b/i, 'abapfield-symbols.htm'], [/^CLASS-DATA\b/i, 'abapclass-data.htm'], [/^CLASS-METHODS\b/i, 'abapclass-methods.htm'],
  [/^METHODS\b/i, 'abapmethods.htm'], [/^METHOD\b/i, 'abapmethod.htm'], [/^CLASS\b.*\bDEFINITION\b/i, 'abapclass_definition.htm'],
  [/^CLASS\b/i, 'abapclass_implementation.htm'], [/^INTERFACES?\b/i, 'abapinterface.htm'], [/^IF\b|^ELSEIF\b|^ELSE\b|^ENDIF\b/i, 'abapif.htm'],
  [/^CASE\s+TYPE\s+OF\b/i, 'abapcase_type.htm'], [/^CASE\b|^WHEN\b|^ENDCASE\b/i, 'abapcase.htm'], [/^DO\b|^ENDDO\b/i, 'abapdo.htm'],
  [/^WHILE\b|^ENDWHILE\b/i, 'abapwhile.htm'], [/^TRY\b|^ENDTRY\b/i, 'abaptry.htm'], [/^CATCH\b/i, 'abapcatch_try.htm'], [/^CLEANUP\b/i, 'abapcleanup.htm'],
  [/^RAISE\s+(RESUMABLE\s+)?EXCEPTION\b/i, 'abapraise_exception_class.htm'], [/^RAISE\b/i, 'abapraise_exception.htm'],
  [/^CALL\s+FUNCTION\b/i, 'abapcall_function_general.htm'], [/^CALL\s+METHOD\b/i, 'abapcall_method_static.htm'], [/^MESSAGE\b/i, 'abapmessage.htm'],
  [/^AUTHORITY-CHECK\b/i, 'abapauthority-check.htm'], [/^COMMIT\b/i, 'abapcommit.htm'], [/^ROLLBACK\b/i, 'abaprollback.htm'], [/^ASSIGN\b/i, 'abapassign.htm'],
  [/^CONCATENATE\b/i, 'abapconcatenate.htm'], [/^SPLIT\b/i, 'abapsplit.htm'], [/^FIND\b/i, 'abapfind.htm'], [/^REPLACE\b/i, 'abapreplace.htm'],
  [/^CONDENSE\b/i, 'abapcondense.htm'], [/^TRANSLATE\b/i, 'abaptranslate.htm'], [/^CLEAR\b/i, 'abapclear.htm'], [/^FREE\b/i, 'abapfree_dataobject.htm'],
  [/^WRITE\b/i, 'abapwrite-.htm'], [/^PARAMETERS\b/i, 'abapparameters.htm'], [/^SELECT-OPTIONS\b/i, 'abapselect-options.htm'], [/^CHECK\b/i, 'abapcheck_processing_blocks.htm'],
  [/^EXIT\b/i, 'abapexit_loop.htm'], [/^CONTINUE\b/i, 'abapcontinue.htm'], [/^RETURN\b/i, 'abapreturn.htm'], [/^REPORT\b/i, 'abapreport.htm'],
  [/^START-OF-SELECTION\b/i, 'abapstart-of-selection.htm'], [/^FORM\b/i, 'abapform.htm'], [/^PERFORM\b/i, 'abapperform.htm'], [/^SUBMIT\b/i, 'abapsubmit.htm'],
  [/^GET\s+TIME\b/i, 'abapget_time-stamp.htm'], [/^ASSERT\b/i, 'abapassert.htm'], [/^SET\s+PARAMETER\b/i, 'abapset_parameter.htm'],
];
const WORD_FILES: Record<string, string> = {
  NEW: 'abenconstructor_expression_new.htm', VALUE: 'abenconstructor_expression_value.htm', CONV: 'abenconstructor_expression_conv.htm',
  CORRESPONDING: 'abenconstructor_expr_corresponding.htm', COND: 'abenconditional_expression_cond.htm', SWITCH: 'abenconditional_expression_switch.htm',
  REDUCE: 'abenconstructor_expression_reduce.htm', FILTER: 'abenconstructor_expression_filter.htm', CAST: 'abenconstructor_expression_cast.htm',
  REF: 'abenconstructor_expression_ref.htm', EXACT: 'abenconstructor_expression_exact.htm', LINES: 'abendescriptive_functions_table.htm',
  XSDBOOL: 'abenxsdbool.htm', STRLEN: 'abenlength_functions.htm', LINE_EXISTS: 'abenline_exists_function.htm', CONDENSE: 'abencondense_functions.htm',
  TO_UPPER: 'abencase_functions.htm', TO_LOWER: 'abencase_functions.htm', SUBSTRING: 'abensubstring_functions.htm', REPLACE: 'abenreplace_functions.htm',
  CONCAT_LINES_OF: 'abenconcatenation_functions.htm', ROUND: 'abendec_floating_point_functions.htm',
};
const CDS_FILES: [RegExp, string][] = [
  [/define\s+root\s+view\s+entity|define\s+view\s+entity/i, 'abencds_define_view_entity.htm'], [/as\s+projection\s+on/i, 'abencds_define_view_as_projection.htm'],
  [/annotate\s+entity/i, 'abencds_meta_data_extension.htm'], [/define\s+role/i, 'abencds_define_role.htm'], [/define\s+service/i, 'abensrvd_define_service.htm'],
  [/define\s+behavior|managed|projection;/i, 'abenbdl.htm'], [/define\s+table/i, 'abenddicddl_define_table.htm'], [/association/i, 'abencds_association_v2.htm'],
];

export function docBase(cloud: boolean): string {
  return cloud ? 'https://help.sap.com/doc/abapdocu_cp_index_htm/CLOUD/en-US/index.htm' : 'https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm';
}

/** Help URL for the keyword or statement at (line, col). */
export function keywordDocUrl(source: string, line: number, col: number, opts: { cloud?: boolean; cds?: boolean } = {}): { url: string; topic: string } {
  const base = docBase(!!opts.cloud);
  const lines = source.split('\n');
  const text = lines[line] ?? '';
  if (opts.cds) {
    const hit = CDS_FILES.find(([re]) => re.test(text)) || CDS_FILES.find(([re]) => re.test(source));
    return hit ? { url: `${base}?file=${hit[1]}`, topic: hit[1].replace(/\.htm$/, '') } : { url: `${base}?file=abencds.htm`, topic: 'ABAP CDS' };
  }
  let a = col, b = col;
  while (a > 0 && /[\w-]/.test(text[a - 1])) a--;
  while (b < text.length && /[\w-]/.test(text[b])) b++;
  const word = text.slice(a, b).toUpperCase();
  if (WORD_FILES[word]) return { url: `${base}?file=${WORD_FILES[word]}`, topic: word };
  const st = statements(lines).find(s => s.start <= line && s.end >= line);
  const stmt = st ? st.text.trim() : segs(text).filter(g => g.t === 'code').map(g => g.s).join('').trim();
  const hit = STATEMENT_FILES.find(([re]) => re.test(stmt));
  if (hit) return { url: `${base}?file=${hit[1]}`, topic: (stmt.match(/^[\w-]+(\s+(AT|TABLE|FUNCTION|METHOD|EXCEPTION|OF))?/i) || [''])[0].toUpperCase() };
  return { url: `${base}?file=abenabap.htm`, topic: 'ABAP keyword documentation' };
}
