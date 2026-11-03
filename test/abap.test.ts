import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, caseCode, prettyPrint, segs } from '../src/core/abap';

test('segments keep strings and comments apart', () => {
  const s = segs(`WRITE 'it''s'. " note`);
  assert.deepEqual(s.map(x => x.t), ['code', 'str', 'code', 'com']);
});

test('pretty printer indents blocks and upper-cases keywords only', () => {
  const src = [
    'class zcl_x definition public.',
    'public section.',
    'methods run.',
    'endclass.',
    'class zcl_x implementation.',
    'method run.',
    "if sy-subrc = 0.",
    "out->write( 'x' ).",
    'else.',
    'loop at lt into data(ls).',
    'endloop.',
    'endif.',
    'endmethod.',
    'endclass.',
  ].join('\n');
  const out = prettyPrint(src).split('\n');
  assert.equal(out[0], 'CLASS zcl_x DEFINITION PUBLIC.');
  assert.equal(out[1], '  PUBLIC SECTION.');
  assert.equal(out[2], '    METHODS run.');
  assert.equal(out[3], 'ENDCLASS.');
  assert.equal(out[5], '  METHOD run.');
  assert.equal(out[6], '    IF sy-subrc = 0.');
  assert.equal(out[7], "      out->write( 'x' ).");
  assert.equal(out[8], '    ELSE.');
  assert.equal(out[9], '      LOOP AT lt INTO DATA(ls).');
  assert.equal(out[11], '    ENDIF.');
  assert.equal(out[13], 'ENDCLASS.');
});

test('events and CASE/WHEN indentation', () => {
  const out = prettyPrint('report z.\nstart-of-selection.\ncase x.\nwhen 1.\nwrite 1.\nwhen others.\nendcase.').split('\n');
  assert.deepEqual(out, ['REPORT z.', 'START-OF-SELECTION.', '  CASE x.', '    WHEN 1.', '      WRITE 1.', '    WHEN OTHERS.', '  ENDCASE.']);
});

test('continuation lines keep relative indentation', () => {
  const out = prettyPrint('method m.\ndata(x) = calc(\na = 1\nb = 2 ).\nendmethod.').split('\n');
  assert.equal(out[1], '  DATA(x) = calc(');
  assert.equal(out[2], '    a = 1');
});

test('block errors are reported at the right lines', () => {
  const a = analyze(['IF x = 1.', '  LOOP AT t INTO DATA(l).', 'ENDIF.'].map(s => s));
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0].msg, /ENDLOOP expected before ENDIF/);
  const b = analyze(['IF x = 1.', '  y = 2.']);
  assert.match(b.errors[0].msg, /IF block is not closed/);
  const c = analyze(['DATA x TYPE i']);
  assert.match(c.errors[0].msg, /not terminated/);
});

test('SELECT INTO TABLE is not a loop, SELECT INTO wa is', () => {
  assert.equal(analyze(['SELECT * FROM t INTO TABLE @DATA(r).']).errors.length, 0);
  assert.equal(analyze(['SELECT * FROM t INTO @DATA(r).', 'ENDSELECT.']).errors.length, 0);
});

test('method names after -> stay lower case', () => {
  assert.equal(caseCode("out->write( lv )."), 'out->write( lv ).');
  assert.equal(caseCode("data(x) = new zcl_a( )."), 'DATA(x) = NEW zcl_a( ).');
});

test('structural words stay upper case', () => {
  assert.equal(caseCode('types tt type standard table of /dmo/flight with empty key.'), 'TYPES tt TYPE STANDARD TABLE OF /dmo/flight WITH EMPTY KEY.');
  assert.equal(caseCode('data cut type ref to zcl_x.'), 'DATA cut TYPE REF TO zcl_x.');
  assert.equal(caseCode('if a lt b.'), 'IF a LT b.');
});
