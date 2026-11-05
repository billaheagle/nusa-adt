// In-browser simulation of an ABAP system, used by the prototype and by tests.
// It behaves like the real backends from the UI's point of view: inactive/active
// versions, locks, transports, activation with syntax errors, ABAP Unit, ATC and a
// scripted debugger session for the sample program.

import { analyze, declaredMethods, implementedMethods, KWSET as KW, lineOf, prettyPrint, statements } from '../core/abap';
import { applyEdits, offsetOf, wordRange } from '../core/edits';
import { extractMethodEdits, LocalEdit, quickFixesAt, renameEdits } from '../core/localrefactor';
import { Catalog, StdCatalog, WorkspaceCatalog } from '../core/catalog';
import { demoDoma, demoDtel, demoMsag, demoSia6, demoXml, template } from '../core/templates';
import { completeAbap, completeCds } from '../core/complete';
import {
  AtcFinding, Backend, BindingInfo, Breakpoint, Connection, CreateExtra, DebugState, DebugVar, ExtractStart, GitRepo, Hit, Include, isCdsLike, Location,
  NewPackage, ObjRef, ObjState, ObjType, PkgRef, PreviewResult, Problem, Proposal, QuickFix, RefactorPreview, RenameStart, RunResult, StepKind, SystemInfo, TextEdit, Transport,
  TransportNeed, TYPE_INFO, UnitResult, uriFor, fmUri, fgIncludeUri, ValueHelpItem, TEXT_INCLUDES, isTextInclude, TraceRun, TraceHit, SearchFilter, pkgMatches, Dump, Revision, newObjectUri,
} from '../core/types';

const wait = (ms = 90) => new Promise(r => setTimeout(r, ms));

const FLIGHTS = [
  { carrier_id: 'GA', connection_id: '0401', flight_date: '2026-11-10', price: '1850000.00', currency_code: 'IDR', plane_type_id: '737-800', seats_max: 162, seats_occupied: 146 },
  { carrier_id: 'GA', connection_id: '0402', flight_date: '2026-11-10', price: '1790000.00', currency_code: 'IDR', plane_type_id: '737-800', seats_max: 162, seats_occupied: 118 },
  { carrier_id: 'GA', connection_id: '0880', flight_date: '2026-11-12', price: '9450000.00', currency_code: 'IDR', plane_type_id: 'A330-300', seats_max: 393, seats_occupied: 350 },
];
export const FLIGHT_FIELDS = ['client', 'carrier_id', 'connection_id', 'flight_date', 'price', 'currency_code', 'plane_type_id', 'seats_max', 'seats_occupied'];

const SRC: Record<string, Partial<Record<Include, string>>> = {
  ZCL_NUSA_FLIGHT_SERVICE: {
    main: `CLASS zcl_nusa_flight_service DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    TYPES tt_flights TYPE STANDARD TABLE OF /dmo/flight WITH EMPTY KEY.

    METHODS get_flights
      IMPORTING iv_carrier_id     TYPE /dmo/carrier_id
      RETURNING VALUE(rt_flights) TYPE tt_flights.

    METHODS calc_load_factor
      IMPORTING iv_seats_max      TYPE /dmo/plane_seats_max
                iv_seats_occupied TYPE /dmo/plane_seats_occupied
      RETURNING VALUE(rv_percent) TYPE decfloat16.
ENDCLASS.


CLASS zcl_nusa_flight_service IMPLEMENTATION.

  METHOD get_flights.
    SELECT * FROM /dmo/flight
      WHERE carrier_id = @iv_carrier_id
      ORDER BY flight_date, connection_id
      INTO TABLE @rt_flights.
  ENDMETHOD.

  METHOD calc_load_factor.
    rv_percent = round( val = iv_seats_occupied * 100 / iv_seats_max dec = 2 ).
  ENDMETHOD.

ENDCLASS.
`,
    definitions: `*"* use this source file for any type of declarations (class
*"* definitions, interfaces or type declarations) you need for
*"* components in the private section
`,
    implementations: `*"* use this source file for the definition and implementation of
*"* local helper classes, interface definitions and type
*"* declarations
`,
    testclasses: `CLASS ltc_load_factor DEFINITION FINAL FOR TESTING
  DURATION SHORT RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    DATA cut TYPE REF TO zcl_nusa_flight_service.
    METHODS setup.
    METHODS full_flight FOR TESTING.
    METHODS rounds_to_two_decimals FOR TESTING.
    METHODS zero_seats_returns_zero FOR TESTING.
ENDCLASS.


CLASS ltc_load_factor IMPLEMENTATION.

  METHOD setup.
    cut = NEW #( ).
  ENDMETHOD.

  METHOD full_flight.
    cl_abap_unit_assert=>assert_equals(
      act = cut->calc_load_factor( iv_seats_max = 180 iv_seats_occupied = 180 )
      exp = 100 ).
  ENDMETHOD.

  METHOD rounds_to_two_decimals.
    cl_abap_unit_assert=>assert_equals(
      act = cut->calc_load_factor( iv_seats_max = 180 iv_seats_occupied = 131 )
      exp = '72.78' ).
  ENDMETHOD.

  METHOD zero_seats_returns_zero.
    cl_abap_unit_assert=>assert_equals(
      act = cut->calc_load_factor( iv_seats_max = 0 iv_seats_occupied = 0 )
      exp = 0 ).
  ENDMETHOD.

ENDCLASS.
`,
  },
  ZCL_NUSA_CONSOLE: {
    main: `CLASS zcl_nusa_console DEFINITION
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.


CLASS zcl_nusa_console IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
    DATA(lo_service) = NEW zcl_nusa_flight_service( ).
    DATA(lt_flights) = lo_service->get_flights( iv_carrier_id = 'GA' ).

    out->write( |{ lines( lt_flights ) } flights for carrier GA| ).
    out->write( lt_flights ).
  ENDMETHOD.

ENDCLASS.
`,
    definitions: '', implementations: '', testclasses: '',
  },
  ZIF_NUSA_LOGGER: {
    main: `INTERFACE zif_nusa_logger
  PUBLIC.

  METHODS log
    IMPORTING iv_text TYPE string.

  METHODS flush.
ENDINTERFACE.
`,
  },
  ZNUSA_FG_UTIL: {
    main: `*******************************************************************
*   System-defined Include-files.                                 *
*******************************************************************
  INCLUDE lznusa_fg_utiltop.                 " Global Declarations
  INCLUDE lznusa_fg_utiluxx.                 " Function Modules
`,
  },
  LZNUSA_FG_UTILTOP: { main: `FUNCTION-POOL znusa_fg_util.                "MESSAGE-ID ..
` },
  LZNUSA_FG_UTILUXX: {
    main: `*****************************************************************
*   THIS FILE IS GENERATED BY THE FUNCTION LIBRARY.             *
*   NEVER CHANGE IT MANUALLY, PLEASE!                           *
*****************************************************************
INCLUDE lznusa_fg_utilu01.                  "Z_NUSA_FORMAT_AMOUNT
INCLUDE lznusa_fg_utilu02.                  "Z_NUSA_GET_CARRIER
`,
  },
  Z_NUSA_FORMAT_AMOUNT: {
    main: `FUNCTION z_nusa_format_amount
  IMPORTING
    VALUE(iv_amount) TYPE p
    VALUE(iv_currency) TYPE waers DEFAULT 'IDR'
  EXPORTING
    VALUE(ev_text) TYPE string.

  ev_text = |{ iv_amount NUMBER = USER } { iv_currency }|.

ENDFUNCTION.
`,
  },
  Z_NUSA_GET_CARRIER: {
    main: `FUNCTION z_nusa_get_carrier
  IMPORTING
    VALUE(iv_carrier_id) TYPE /dmo/carrier_id
  EXPORTING
    VALUE(es_carrier) TYPE /dmo/carrier
  EXCEPTIONS
    not_found.

  SELECT SINGLE * FROM /dmo/carrier
    WHERE carrier_id = @iv_carrier_id
    INTO @es_carrier.
  IF sy-subrc <> 0.
    RAISE not_found.
  ENDIF.

ENDFUNCTION.
`,
  },
  ZR_NUSA_BOOKING: {
    main: `REPORT zr_nusa_booking.

INCLUDE zr_nusa_booking_top.
INCLUDE zr_nusa_booking_f01.

START-OF-SELECTION.
  PERFORM load_bookings.
  PERFORM print_bookings.
`,
  },
  ZR_NUSA_BOOKING_TOP: {
    main: `*&---------------------------------------------------------------------*
*& Include zr_nusa_booking_top: global data
*&---------------------------------------------------------------------*
TYPES: BEGIN OF ty_booking,
         booking_id TYPE n LENGTH 4,
         customer   TYPE c LENGTH 30,
         amount     TYPE p LENGTH 8 DECIMALS 2,
       END OF ty_booking.

DATA gt_bookings TYPE STANDARD TABLE OF ty_booking WITH EMPTY KEY.
`,
  },
  ZR_NUSA_BOOKING_F01: {
    main: `*&---------------------------------------------------------------------*
*& Include zr_nusa_booking_f01: subroutines
*&---------------------------------------------------------------------*
FORM load_bookings.
  gt_bookings = VALUE #( ( booking_id = '0001' customer = 'Sari Wulandari' amount = '1250.00' )
                         ( booking_id = '0002' customer = 'Budi Hartono'   amount = '980.50' ) ).
ENDFORM.

FORM print_bookings.
  LOOP AT gt_bookings INTO DATA(ls_booking).
    WRITE: / ls_booking-booking_id, ls_booking-customer, ls_booking-amount.
  ENDLOOP.
ENDFORM.
`,
  },
  ZR_NUSA_FLIGHTS: {
    main: `REPORT zr_nusa_flights.

PARAMETERS p_carr TYPE /dmo/carrier_id DEFAULT 'GA'.

START-OF-SELECTION.
  DATA(lo_service) = NEW zcl_nusa_flight_service( ).
  DATA(lt_flights) = lo_service->get_flights( iv_carrier_id = p_carr ).

  LOOP AT lt_flights INTO DATA(ls_flight).
    DATA(lv_load) = lo_service->calc_load_factor(
                      iv_seats_max      = ls_flight-seats_max
                      iv_seats_occupied = ls_flight-seats_occupied ).
    WRITE: / ls_flight-connection_id, ls_flight-flight_date, lv_load.
  ENDLOOP.
`,
    symbols: `@MaxLength:40
001=Flights and load factor of the carrier

@MaxLength:20
002=No flights found
`,
    selections: `@DDICReference:true
P_CARR=Airline
`,
    headings: `LISTHEADER=Flight load factor
COLUMNHEADER_1=Flight Date       Load %
`,
  },
  ZI_NUSA_FLIGHT: {
    main: `@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Nusa: flight with load factor'
define view entity ZI_NUSA_FLIGHT
  as select from /dmo/flight
  association [1] to /dmo/carrier as _Carrier
    on $projection.CarrierId = _Carrier.carrier_id
{
  key carrier_id     as CarrierId,
  key connection_id  as ConnectionId,
  key flight_date    as FlightDate,
      seats_max      as SeatsMax,
      seats_occupied as SeatsOccupied,
      cast( division( seats_occupied * 100, seats_max, 2 )
            as abap.dec( 5, 2 ) ) as LoadFactor,
      _Carrier
}
`,
  },
};

SRC.ZNUSA_TRAVEL = { main: `@EndUserText.label : 'Nusa: travel'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table znusa_travel {
  key client            : abap.clnt not null;
  key travel_id         : abap.numc(8) not null;
  description           : abap.char(60);
  agency_id             : abap.numc(6);
  begin_date            : abap.dats;
  end_date              : abap.dats;
  @Semantics.amount.currencyCode : 'znusa_travel.currency_code'
  total_price           : abap.curr(16,2);
  currency_code         : abap.cuky;
  status                : abap.char(1);
  last_changed_at       : abp_lastchange_tstmpl;
}
` };
SRC.ZUI_NUSA_FLIGHT = { main: `@EndUserText.label: 'Nusa: flight service'
define service ZUI_NUSA_FLIGHT {
  expose ZI_NUSA_FLIGHT as Flight;
  expose /DMO/I_CARRIER as Carrier;
}
` };
SRC.ZUI_NUSA_FLIGHT_O4 = { main: '' };

// form-based objects of the flight app: authorizations, IAM, communication, configuration
const IAMPKG = 'ZNUSA_FLIGHT_IAM';
SRC.ZNUSA_CARRIER_ID = { main: demoDtel('ZNUSA_CARRIER_ID', 'Nusa: airline code', 'ZNUSA_FLIGHT', { kind: 'domain', typeName: '/DMO/CARRIER_ID', dataType: 'CHAR', length: 3, labels: ['Airline', 'Airline code', 'Airline code (IATA)', 'Airline'], searchHelp: '/DMO/H_CARRIER', parameter: '/DMO/CAR' }) };
SRC.ZNUSA_MSG = { main: demoMsag('ZNUSA_MSG', 'Nusa: flight messages', 'ZNUSA_FLIGHT', [['000', '&1 &2 &3 &4', true], ['001', 'Flight &1 does not exist', true], ['002', 'Carrier &1 has no flights on &2', false], ['010', 'Booking &1 saved', true]]) };
SRC.ZNUSA_STATUS = { main: demoDoma('ZNUSA_STATUS', 'Nusa: travel status', 'ZNUSA_FLIGHT', { dataType: 'CHAR', length: 1, values: [['O', 'Open'], ['A', 'Accepted'], ['X', 'Cancelled']] }) };
SRC.ZNUSA_CARR = { main: demoXml('AUTH', 'ZNUSA_CARR', 'Nusa: airline', IAMPKG, '<auth:general auth:dataElement="ZNUSA_CARRIER_ID" auth:checkTable="/DMO/CARRIER" auth:orgLevel="false"/>') };
SRC.ZNUSA_FLT = { main: demoXml('SUSO', 'ZNUSA_FLT', 'Nusa: flights by airline', IAMPKG, `<suso:general suso:objectClass="ZNUS" suso:accessCategory="Read and write"/>
  <suso:fields>
    <suso:field suso:name="ZNUSA_CARR"/>
    <suso:field suso:name="ACTVT"/>
  </suso:fields>
  <suso:activities>
    <suso:activity suso:code="02" suso:text="Change"/>
    <suso:activity suso:code="03" suso:text="Display"/>
  </suso:activities>`) };
SRC.ZNUSA_FLIGHT_APP = { main: demoSia6('ZNUSA_FLIGHT_APP', 'Nusa: maintain airline settings', IAMPKG, { appType: 'MBC', service: 'ZUI_NUSA_FLIGHT_O4', table: 'ZNUSA_TRAVEL' }) };
SRC.ZNUSA_FLIGHT_CS = { main: demoXml('SCO1', 'ZNUSA_FLIGHT_CS', 'Nusa: flight data for partners', IAMPKG, `<sco1:general sco1:scenarioType="Customer managed" sco1:allowedInstances="One instance per scenario and communication system"/>
  <sco1:inbound sco1:basicAuthentication="true" sco1:x509="true" sco1:oauth="false">
    <sco1:service sco1:name="ZUI_NUSA_FLIGHT_O4_IWSG" sco1:type="OData V4"/>
  </sco1:inbound>
  <sco1:outbound/>`) };
SRC.ZNUSA_CARRIER_BC = { main: demoXml('SMBC', 'ZNUSA_CARRIER_BC', 'Nusa: airline settings', IAMPKG, '<smbc:general smbc:configurationType="Table maintenance" smbc:serviceBinding="ZUI_NUSA_FLIGHT_O4" smbc:serviceName="ZUI_NUSA_FLIGHT" smbc:entitySet="Carrier" smbc:recordTransport="true"/>') };

/** The DEMO function group and its parts (they live under the group, not in the package list). */
const FG_OBJECTS = ['ZNUSA_FG_UTIL', 'Z_NUSA_FORMAT_AMOUNT', 'Z_NUSA_GET_CARRIER', 'LZNUSA_FG_UTILTOP', 'LZNUSA_FG_UTILUXX'];
const URI_OF: Record<string, string> = {
  Z_NUSA_FORMAT_AMOUNT: fmUri('ZNUSA_FG_UTIL', 'Z_NUSA_FORMAT_AMOUNT'), Z_NUSA_GET_CARRIER: fmUri('ZNUSA_FG_UTIL', 'Z_NUSA_GET_CARRIER'),
  LZNUSA_FG_UTILTOP: fgIncludeUri('ZNUSA_FG_UTIL', 'LZNUSA_FG_UTILTOP'), LZNUSA_FG_UTILUXX: fgIncludeUri('ZNUSA_FG_UTIL', 'LZNUSA_FG_UTILUXX'),
};
/** objects shown under their parent in the explorer */
const isGroupPart = (o: ObjRef) => o.uri.includes('/functions/groups/') && o.type !== 'FUGR';

const PKG_OF: Record<string, string> = {
  ZUI_NUSA_FLIGHT: 'ZNUSA_FLIGHT_SRV', ZUI_NUSA_FLIGHT_O4: 'ZNUSA_FLIGHT_SRV',
  ZNUSA_CARR: IAMPKG, ZNUSA_FLT: IAMPKG, ZNUSA_FLIGHT_APP: IAMPKG, ZNUSA_FLIGHT_CS: IAMPKG, ZNUSA_CARRIER_BC: IAMPKG,
};

const SAMPLE_DATA: Record<string, Record<string, string | number>[]> = {
  '/DMO/FLIGHT': [
    { client: '100', carrier_id: 'GA', connection_id: '0401', flight_date: '2026-11-10', price: '1850000.00', currency_code: 'IDR', plane_type_id: '737-800', seats_max: 162, seats_occupied: 146 },
    { client: '100', carrier_id: 'GA', connection_id: '0402', flight_date: '2026-11-10', price: '1790000.00', currency_code: 'IDR', plane_type_id: '737-800', seats_max: 162, seats_occupied: 118 },
    { client: '100', carrier_id: 'GA', connection_id: '0880', flight_date: '2026-11-12', price: '9450000.00', currency_code: 'IDR', plane_type_id: 'A330-300', seats_max: 393, seats_occupied: 350 },
    { client: '100', carrier_id: 'QZ', connection_id: '7510', flight_date: '2026-11-11', price: '1250000.00', currency_code: 'IDR', plane_type_id: 'A320', seats_max: 180, seats_occupied: 171 },
    { client: '100', carrier_id: 'JT', connection_id: '0034', flight_date: '2026-11-13', price: '980000.00', currency_code: 'IDR', plane_type_id: '737-900ER', seats_max: 215, seats_occupied: 190 },
  ],
  '/DMO/CARRIER': [
    { client: '100', carrier_id: 'GA', name: 'Garuda Indonesia', currency_code: 'IDR' },
    { client: '100', carrier_id: 'QZ', name: 'Indonesia AirAsia', currency_code: 'IDR' },
    { client: '100', carrier_id: 'JT', name: 'Lion Air', currency_code: 'IDR' },
  ],
  ZNUSA_TRAVEL: [
    { client: '100', travel_id: '00000001', description: 'Jakarta - Denpasar, team offsite', agency_id: '070001', begin_date: '2026-11-20', end_date: '2026-11-23', total_price: '14800000.00', currency_code: 'IDR', status: 'A', last_changed_at: '2026-11-02 09:14:00' },
    { client: '100', travel_id: '00000002', description: 'Surabaya - Makassar, customer visit', agency_id: '070002', begin_date: '2026-12-01', end_date: '2026-12-02', total_price: '4200000.00', currency_code: 'IDR', status: 'O', last_changed_at: '2026-11-03 16:40:00' },
    { client: '100', travel_id: '00000003', description: 'Medan - Jakarta, SAP TechEd', agency_id: '070001', begin_date: '2026-12-08', end_date: '2026-12-11', total_price: '6900000.00', currency_code: 'IDR', status: 'X', last_changed_at: '2026-11-04 08:02:00' },
  ],
};
SAMPLE_DATA.ZI_NUSA_FLIGHT = SAMPLE_DATA['/DMO/FLIGHT'].map(f => ({
  CarrierId: f.carrier_id, ConnectionId: f.connection_id, FlightDate: f.flight_date, SeatsMax: f.seats_max, SeatsOccupied: f.seats_occupied,
  LoadFactor: (Math.round(Number(f.seats_occupied) * 10000 / Number(f.seats_max)) / 100).toFixed(2),
}));

interface MPkg { name: string; desc: string; parent: string; swc: string; layer: string }

const DESC: Record<string, [ObjType, string]> = {
  ZCL_NUSA_FLIGHT_SERVICE: ['CLAS', 'Nusa: flight service with load factor'],
  ZCL_NUSA_CONSOLE: ['CLAS', 'Nusa: console runner for the flight service'],
  ZIF_NUSA_LOGGER: ['INTF', 'Nusa: application log'],
  ZR_NUSA_FLIGHTS: ['PROG', 'Nusa: flight load factor list'],
  ZR_NUSA_BOOKING: ['PROG', 'Nusa: bookings (program with includes)'],
  ZNUSA_FG_UTIL: ['FUGR', 'Nusa: utility function modules'],
  Z_NUSA_FORMAT_AMOUNT: ['FUNC', 'Format an amount with its currency'],
  Z_NUSA_GET_CARRIER: ['FUNC', 'Read an airline'],
  LZNUSA_FG_UTILTOP: ['INCL', 'Global data of ZNUSA_FG_UTIL'],
  LZNUSA_FG_UTILUXX: ['INCL', 'Function modules of ZNUSA_FG_UTIL'],
  ZR_NUSA_BOOKING_TOP: ['INCL', 'Nusa: bookings, global data'],
  ZR_NUSA_BOOKING_F01: ['INCL', 'Nusa: bookings, subroutines'],
  ZI_NUSA_FLIGHT: ['DDLS', 'Nusa: flight with load factor'],
  ZNUSA_TRAVEL: ['TABL', 'Nusa: travel'],
  ZUI_NUSA_FLIGHT: ['SRVD', 'Nusa: flight service'],
  ZUI_NUSA_FLIGHT_O4: ['SRVB', 'Nusa: flight service, OData V4 UI'],
  ZNUSA_CARRIER_ID: ['DTEL', 'Nusa: airline code'],
  ZNUSA_STATUS: ['DOMA', 'Nusa: travel status'],
  ZNUSA_MSG: ['MSAG', 'Nusa: flight messages'],
  ZNUSA_CARR: ['AUTH', 'Nusa: airline'],
  ZNUSA_FLT: ['SUSO', 'Nusa: flights by airline'],
  ZNUSA_FLIGHT_APP: ['SIA6', 'Nusa: manage flights'],
  ZNUSA_FLIGHT_CS: ['SCO1', 'Nusa: flight data for partners'],
  ZNUSA_CARRIER_BC: ['SMBC', 'Nusa: airline settings'],
};
const FORM_OBJECTS = ['ZNUSA_CARRIER_ID', 'ZNUSA_STATUS', 'ZNUSA_MSG', 'ZNUSA_CARR', 'ZNUSA_FLT', 'ZNUSA_FLIGHT_APP', 'ZNUSA_FLIGHT_CS', 'ZNUSA_CARRIER_BC'];

const CONNS: Connection[] = [
  { id: 's4d', kind: 's4', sid: 'S4D', client: '100', user: 'DEVELOPER', url: 'https://s4d.nusa.internal:44300', language: 'EN', auth: 'basic', abapVersion: 'standard', favoritePackages: ['ZNUSA_FLIGHT'], transports: true, label: 'S/4HANA 2023 on-premise', runReports: true },
  { id: 'trl', kind: 'btp', sid: 'TRL', client: '100', user: 'CB9980000123', url: 'https://nusa-dev.abap.ap21.hana.ondemand.com', language: 'EN', auth: 'oauth', abapVersion: 'cloud', favoritePackages: ['ZNUSA_FLIGHT'], transports: true, label: 'BTP ABAP Environment' },
  { id: 'loc', kind: 'runner', sid: 'LOCAL', client: '000', user: 'NUSA', url: 'http://localhost:7777', language: 'EN', auth: 'none', abapVersion: 'runner', favoritePackages: ['$TMP'], transports: false, label: 'ABAP runner on this laptop', runReports: true },
];
const CONN_OBJECTS: Record<string, string[]> = {
  s4d: ['ZCL_NUSA_FLIGHT_SERVICE', 'ZIF_NUSA_LOGGER', 'ZR_NUSA_FLIGHTS', 'ZR_NUSA_BOOKING', 'ZR_NUSA_BOOKING_TOP', 'ZR_NUSA_BOOKING_F01', ...FG_OBJECTS, 'ZI_NUSA_FLIGHT', 'ZNUSA_TRAVEL', 'ZUI_NUSA_FLIGHT', 'ZUI_NUSA_FLIGHT_O4', ...FORM_OBJECTS],
  trl: ['ZCL_NUSA_FLIGHT_SERVICE', 'ZCL_NUSA_CONSOLE', 'ZIF_NUSA_LOGGER', 'ZI_NUSA_FLIGHT', 'ZNUSA_TRAVEL', 'ZUI_NUSA_FLIGHT', 'ZUI_NUSA_FLIGHT_O4', ...FORM_OBJECTS],
  loc: ['ZCL_NUSA_FLIGHT_SERVICE', 'ZR_NUSA_FLIGHTS', 'ZR_NUSA_BOOKING', 'ZR_NUSA_BOOKING_TOP', 'ZR_NUSA_BOOKING_F01', ...FG_OBJECTS],
};
const SEED_TR: Record<string, Transport[]> = {
  s4d: [
    { id: 'S4DK900123', desc: 'Nusa: flight load factor', owner: 'DEVELOPER', status: 'modifiable', task: 'S4DK900124', objects: ['R3TR CLAS ZCL_NUSA_FLIGHT_SERVICE', 'R3TR PROG ZR_NUSA_FLIGHTS'] },
    { id: 'S4DK900130', desc: 'Nusa: CDS flight model', owner: 'DEVELOPER', status: 'modifiable', task: 'S4DK900131', objects: ['R3TR DDLS ZI_NUSA_FLIGHT'] },
    { id: 'S4DK900098', desc: 'Nusa: logger interface', owner: 'DEVELOPER', status: 'released', task: 'S4DK900099', objects: ['R3TR INTF ZIF_NUSA_LOGGER'] },
    { id: 'S4DK900135', desc: 'Nusa: carrier settings', owner: 'DEVELOPER', status: 'modifiable', task: 'S4DK900136', objects: ['R3TR TABU ZNUSA_CARR_SET'], category: 'customizing' },
    { id: 'S4DK900140', desc: 'Copy of flight model for QA', owner: 'DEVELOPER', status: 'released', objects: ['R3TR DDLS ZI_NUSA_FLIGHT'], category: 'copies' },
  ],
  trl: [
    { id: 'TRLK900012', desc: 'Nusa: flight service on BTP', owner: 'CB9980000123', status: 'modifiable', task: 'TRLK900013', objects: ['R3TR CLAS ZCL_NUSA_FLIGHT_SERVICE', 'R3TR CLAS ZCL_NUSA_CONSOLE', 'R3TR INTF ZIF_NUSA_LOGGER', 'R3TR DDLS ZI_NUSA_FLIGHT'] },
  ],
  loc: [],
};

interface MBinding { published: boolean; serviceDefinition: string; version: 'V2' | 'V4'; category: 'UI' | 'Web API' }
interface MObj { ref: ObjState; saved: Partial<Record<Include, string>>; active: Partial<Record<Include, string>>; lock?: string; binding?: MBinding }
interface Persisted {
  objs: Record<string, { ref: ObjState; saved: MObj['saved']; active: MObj['active']; binding?: MBinding }>;
  tr: Record<string, Transport[]>; seq: number;
  pkgs?: Record<string, MPkg[]>; git?: Record<string, GitRepo[]>; favs?: Record<string, string[]>;
}

const STORE_KEY = 'nusa-adt-mock-v6';

/** Standard objects the DEMO system offers in value helps. */
const VH_STANDARD: [string, string, string][] = [
  ['DOMA', 'XFELD', 'Checkbox'], ['DOMA', 'BOOLE', 'Boolean value (X = true)'], ['DOMA', 'CHAR1', 'Single-character flag'],
  ['DOMA', 'LAND1', 'Country key'], ['DOMA', 'WAERS', 'Currency key'], ['DOMA', 'MANDT', 'Client'], ['DOMA', '/DMO/CARRIER_ID', 'Airline code'],
  ['DOMA', '/DMO/CONNECTION_ID', 'Flight connection number'], ['DOMA', '/DMO/STATUS', 'Booking status'],
  ['DTEL', 'ABAP_BOOLEAN', 'Boolean (abap_true / abap_false)'], ['DTEL', 'MANDT', 'Client'], ['DTEL', 'LAND1', 'Country key'],
  ['DTEL', 'WAERS', 'Currency key'], ['DTEL', '/DMO/CARRIER_ID', 'Airline code'], ['DTEL', '/DMO/CONNECTION_ID', 'Flight connection number'],
  ['TABL', '/DMO/CARRIER', 'Airline'], ['TABL', '/DMO/FLIGHT', 'Flight'], ['TABL', '/DMO/CONNECTION', 'Flight connection'], ['TABL', 'T005', 'Countries'], ['TABL', 'TCURC', 'Currency codes'],
  ['TTYP', 'STRING_TABLE', 'Table of strings'], ['SHLP', 'H_T005', 'Countries'], ['SHLP', 'H_TCURC', 'Currencies'], ['SHLP', '/DMO/H_CARRIER', 'Airlines'],
  ['PARA', 'LND', 'Country'], ['PARA', 'FWS', 'Currency'], ['PARA', '/DMO/CAR', 'Airline'],
  ['CLAS', 'CL_ABAP_CONTEXT_INFO', 'Context information of the session'], ['INTF', 'IF_OO_ADT_CLASSRUN', 'Run a class as console application'],
  ['SUSO', 'S_START', 'Start of apps and services'], ['AUTH', 'ACTVT', 'Activity'],
];

export class MockBackend implements Backend {
  readonly id = 'mock';
  private objs = new Map<string, MObj>();            // key: conn|URI
  private tr: Record<string, Transport[]> = {};
  private pkgs: Record<string, MPkg[]> = {};
  private git: Record<string, GitRepo[]> = {};
  private seq = 140;
  private dbg: { conn: string; steps: Step[]; i: number; inner: number; out: string[]; prog: ObjRef; cls: ObjRef } | null = null;

  private conns: Connection[];

  /** `connections` picks and renames the sample systems, e.g. a single DEMO system in the desktop app. */
  constructor(private storage: Storage | null = null, opts: { connections?: (all: Connection[]) => Connection[] } = {}) {
    this.conns = opts.connections ? opts.connections(CONNS.map(c => ({ ...c }))) : CONNS;
    this.seed();
    this.restore();
  }

  private key(conn: string, uri: string) { return conn + '|' + uri; }

  private seed() {
    for (const c of CONNS) {
      const swc = c.abapVersion === 'cloud' ? 'ZNUSA' : 'HOME';
      this.pkgs[c.id] = c.id === 'loc' ? [] : [
        { name: 'ZNUSA_FLIGHT', desc: 'Nusa: flight demo', parent: '', swc, layer: c.abapVersion === 'cloud' ? '' : 'Z' + c.sid },
        { name: 'ZNUSA_FLIGHT_SRV', desc: 'Nusa: flight OData services', parent: 'ZNUSA_FLIGHT', swc, layer: c.abapVersion === 'cloud' ? '' : 'Z' + c.sid },
        { name: IAMPKG, desc: 'Nusa: authorizations, apps and communication', parent: 'ZNUSA_FLIGHT', swc, layer: c.abapVersion === 'cloud' ? '' : 'Z' + c.sid },
      ];
      this.git[c.id] = c.id === 'loc' ? [] : [
        { key: '0242AC11000' + c.sid.length, pkg: 'ZNUSA_FLIGHT', url: 'https://github.com/abapnusantara/nusa-flight.git', branch: 'refs/heads/main', createdBy: c.user, status: 'R', statusText: 'Pulled 2026-11-03 21:14' },
      ];
      for (const name of CONN_OBJECTS[c.id]) {
        const [type, desc] = DESC[name];
        const pkg = c.id === 'loc' ? '$TMP' : PKG_OF[name] || 'ZNUSA_FLIGHT';
        const uri = URI_OF[name] || uriFor(type, name);
        const tr = (SEED_TR[c.id] || []).find(t => t.status === 'modifiable' && t.objects.includes(`R3TR ${type} ${name}`));
        const src = { ...SRC[name] };
        // the copy in the second system is older, so Compare With Other System shows a difference
        if (c.id === 'trl' && name === 'ZCL_NUSA_FLIGHT_SERVICE' && src.main) src.main = `"! Flight service (copy from before the load factor change)\n${src.main}`;
        this.objs.set(this.key(c.id, uri), {
          ref: { uri, name, type, pkg, desc, inactive: false, transport: tr?.id },
          saved: { ...src }, active: { ...src },
          binding: type === 'SRVB' ? { published: false, serviceDefinition: 'ZUI_NUSA_FLIGHT', version: 'V4', category: 'UI' } : undefined,
        });
      }
      this.tr[c.id] = JSON.parse(JSON.stringify(SEED_TR[c.id] || []));
    }
  }

  private restore() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Persisted;
      this.objs.clear();
      for (const [k, v] of Object.entries(p.objs)) this.objs.set(k, { ...v });
      this.tr = p.tr;
      this.seq = p.seq;
      if (p.pkgs) this.pkgs = p.pkgs;
      if (p.git) this.git = p.git;
      for (const [id, f] of Object.entries(p.favs || {})) { const c = this.conns.find(x => x.id === id); if (c) c.favoritePackages = f; }
    } catch { /* ignore broken storage */ }
  }

  private persist() {
    if (!this.storage) return;
    try {
      const objs: Persisted['objs'] = {};
      for (const [k, v] of this.objs) objs[k] = { ref: v.ref, saved: v.saved, active: v.active, binding: v.binding };
      const favs = Object.fromEntries(this.conns.map(c => [c.id, c.favoritePackages]));
      this.storage.setItem(STORE_KEY, JSON.stringify({ objs, tr: this.tr, seq: this.seq, pkgs: this.pkgs, git: this.git, favs } as Persisted));
    } catch { /* storage may be unavailable */ }
  }

  reset() {
    try { this.storage?.removeItem(STORE_KEY); } catch { /* ignore */ }
    this.objs.clear(); this.tr = {}; this.pkgs = {}; this.git = {}; this.seq = 140;
    for (const c of this.conns) { const orig = CONNS.find(x => x.id === c.id); if (orig) c.favoritePackages = ['ZNUSA_FLIGHT'].filter(() => c.id !== 'loc').concat(c.id === 'loc' ? ['$TMP'] : []); void orig; }
    this.seed();
  }

  private get(conn: string, uri: string): MObj {
    const o = this.objs.get(this.key(conn, uri));
    if (!o) throw new Error(`Object ${uri} does not exist in ${conn.toUpperCase()}`);
    return o;
  }
  private conn(id: string): Connection { return (this.conns.find(c => c.id === id) || CONNS.find(c => c.id === id)) as Connection; }
  private all(conn: string): MObj[] { return [...this.objs.entries()].filter(([k]) => k.startsWith(conn + '|')).map(([, v]) => v); }

  includesOf(type: ObjType): Include[] {
    return type === 'CLAS' ? ['main', 'definitions', 'implementations', 'testclasses'] : type === 'PROG' ? ['main', ...TEXT_INCLUDES] : ['main'];
  }

  async connections() { return this.conns; }
  async saveConnection(c: Connection) {
    await wait();
    const i = this.conns.findIndex(x => x.id === c.id);
    if (i >= 0) this.conns[i] = { ...this.conns[i], ...c }; else this.conns.push(c);
    this.persist();
  }
  async deleteConnection(id: string) { this.conns = this.conns.filter(c => c.id !== id); }
  async resetSession() { /* nothing to forget */ }

  // ---------------------------------------------------------------- packages
  private pkgList(conn: string): MPkg[] { return (this.pkgs[conn] ||= []); }

  async packageContents(conn: string, pkg: string): Promise<{ packages: PkgRef[]; objects: ObjState[] }> {
    await wait(60);
    return {
      packages: this.pkgList(conn).filter(p => p.parent === pkg.toUpperCase()).map(p => ({ name: p.name, desc: p.desc })),
      objects: this.all(conn).filter(o => o.ref.pkg === pkg && !isGroupPart(o.ref)).map(o => ({ ...o.ref })),
    };
  }

  async groupContents(conn: string, obj: ObjRef): Promise<ObjRef[]> {
    await wait(50);
    if (obj.type !== 'FUGR') return [];
    const prefix = `/sap/bc/adt/functions/groups/${obj.name.toLowerCase()}/`;
    return this.all(conn).filter(o => o.ref.uri.startsWith(prefix)).map(o => ({ ...o.ref }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'FUNC' ? -1 : 1));
  }

  async valueHelpObjects(conn: string, query: string, types: string[]) {
    await wait(80);
    const re = new RegExp('^' + (query.trim() || '*').toUpperCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (query.includes('*') ? '$' : ''));
    const own = [...this.objs.entries()].filter(([k]) => k.startsWith(conn + '|')).map(([, o]) => ({ name: o.ref.name, desc: o.ref.desc, type: o.ref.type as string, pkg: o.ref.pkg }));
    return [...own, ...VH_STANDARD.map(([type, name, desc]) => ({ name, desc, type, pkg: 'SAP' }))]
      .filter(o => types.includes(o.type) && re.test(o.name)).slice(0, 50);
  }

  async searchPackages(conn: string, query: string): Promise<PkgRef[]> {
    const q = query.trim().toUpperCase().replace(/\*/g, '');
    const list = [...this.pkgList(conn), { name: '$TMP', desc: 'Local objects', parent: '', swc: 'LOCAL', layer: '' }];
    return list.filter(p => !q || p.name.includes(q) || p.desc.toUpperCase().includes(q)).map(p => ({ name: p.name, desc: p.desc }));
  }

  async valueHelp(conn: string, kind: 'softwarecomponents' | 'transportlayers'): Promise<ValueHelpItem[]> {
    const c = this.conn(conn);
    if (kind === 'softwarecomponents') return c.abapVersion === 'cloud' ? [{ name: 'ZNUSA', desc: 'Nusa: software component' }, { name: 'ZLOCAL', desc: 'Local development (not transportable)' }] : [{ name: 'HOME', desc: 'Customer developments' }, { name: 'LOCAL', desc: 'Local developments (no transport)' }];
    return c.abapVersion === 'cloud' ? [] : [{ name: 'Z' + c.sid, desc: `Transport layer of ${c.sid}` }];
  }

  async createPackage(conn: string, p: NewPackage, transport?: string): Promise<PkgRef> {
    await wait(150);
    const name = p.name.toUpperCase();
    if (this.pkgList(conn).some(x => x.name === name)) throw new Error(`Package ${name} already exists`);
    if (p.superPackage && !this.pkgList(conn).some(x => x.name === p.superPackage.toUpperCase())) throw new Error(`Super package ${p.superPackage.toUpperCase()} does not exist`);
    this.pkgList(conn).push({ name, desc: p.desc, parent: p.superPackage.toUpperCase(), swc: p.softwareComponent, layer: p.transportLayer });
    if (transport) {
      const t = this.tr[conn].find(x => x.id === transport);
      if (t && !t.objects.includes(`R3TR DEVC ${name}`)) t.objects.push(`R3TR DEVC ${name}`);
    }
    this.persist();
    return { name, desc: p.desc };
  }

  async deleteObject(conn: string, obj: ObjRef, transport?: string) {
    await wait(120);
    const o = this.get(conn, obj.uri);
    if (o.lock && o.ref.lockedBy && o.ref.lockedBy !== this.conn(conn).user) throw new Error(`${obj.name} is locked by ${o.ref.lockedBy}`);
    if (o.binding?.published) throw new Error(`Unpublish ${obj.name} before deleting it`);
    this.objs.delete(this.key(conn, obj.uri));
    if (transport) { const t = this.tr[conn].find(x => x.id === transport); const e = `R3TR ${obj.type} ${obj.name}`; if (t && !t.objects.includes(e)) t.objects.push(e); }
    this.persist();
  }

  // ---------------------------------------------------------------- business services
  async bindingInfo(conn: string, obj: ObjRef): Promise<BindingInfo> {
    await wait(60);
    const o = this.get(conn, obj.uri);
    const b = o.binding || { published: false, serviceDefinition: '', version: 'V4' as const, category: 'UI' as const };
    const n = obj.name.toLowerCase();
    return {
      name: obj.name, desc: o.ref.desc, bindingType: 'ODATA', odataVersion: b.version, category: b.category, published: b.published,
      services: [{ name: obj.name, version: '0001', serviceDefinition: b.serviceDefinition, published: b.published }],
      serviceUrl: b.published ? (b.version === 'V4' ? `/sap/opu/odata4/sap/${n}/srvd/sap/${b.serviceDefinition.toLowerCase()}/0001/` : `/sap/opu/odata/sap/${obj.name}/`) : undefined,
    };
  }

  async publishBinding(conn: string, obj: ObjRef, publish: boolean): Promise<string> {
    await wait(400);
    const o = this.get(conn, obj.uri);
    if (!o.binding) throw new Error(`${obj.name} is not a service binding`);
    if (publish) {
      const sd = this.all(conn).find(x => x.ref.type === 'SRVD' && x.ref.name === o.binding!.serviceDefinition);
      if (!sd) throw new Error(`Service definition ${o.binding.serviceDefinition} does not exist`);
      if (sd.ref.inactive) throw new Error(`Activate service definition ${sd.ref.name} first`);
    }
    o.binding.published = publish;
    this.persist();
    return publish ? `Local service endpoint of ${obj.name} published` : `Local service endpoint of ${obj.name} unpublished`;
  }

  // ---------------------------------------------------------------- data preview
  async dataPreview(conn: string, req: { entity?: string; sql?: string; rows: number }): Promise<PreviewResult> {
    const started = Date.now();
    await wait(180);
    const sql = (req.sql || `SELECT * FROM ${(req.entity || '').toUpperCase()}`).trim().replace(/\s+/g, ' ');
    const m = sql.match(/^SELECT\s+(.+?)\s+FROM\s+([\w/]+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+([\w]+)(\s+DESC(?:ENDING)?)?)?(?:\s+UP\s+TO\s+(\d+)\s+ROWS)?\s*\.?$/i);
    if (!m) throw new Error('Only SELECT … FROM … [WHERE …] [ORDER BY …] [UP TO n ROWS] is supported in the DEMO system');
    const entity = m[2].toUpperCase();
    const data = SAMPLE_DATA[entity];
    const known = data || this.all(conn).some(o => o.ref.name === entity && (o.ref.type === 'TABL' || o.ref.type === 'DDLS'));
    if (!known) throw new Error(`${entity} is not a database table or CDS view in ${this.conn(conn).sid}`);
    let rows = (data || []).map(r => ({ ...r }));
    if (m[3]) {
      for (const cond of m[3].split(/\s+AND\s+/i)) {
        const c = cond.match(/^([\w]+)\s*(=|<>|>=|<=|>|<|LIKE)\s*'?([^']*)'?$/i);
        if (!c) throw new Error(`Condition not understood: ${cond}`);
        const f = c[1].toLowerCase(), op = c[2].toUpperCase(), v = c[3];
        rows = rows.filter(r => {
          const key = Object.keys(r).find(k => k.toLowerCase() === f);
          if (!key) throw new Error(`Column ${c[1].toUpperCase()} is unknown`);
          const a = String(r[key]), num = !isNaN(+a) && !isNaN(+v);
          const cmp = num ? +a - +v : a.localeCompare(v);
          return op === '=' ? cmp === 0 : op === '<>' ? cmp !== 0 : op === '>' ? cmp > 0 : op === '<' ? cmp < 0 : op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : new RegExp('^' + v.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(a);
        });
      }
    }
    if (m[4]) { const f = m[4].toLowerCase(); rows.sort((a, b) => { const k = Object.keys(a).find(x => x.toLowerCase() === f) || f; const x = String(a[k]), y = String(b[k]); const r = !isNaN(+x) && !isNaN(+y) ? +x - +y : x.localeCompare(y); return m[5] ? -r : r; }); }
    const total = rows.length;
    rows = rows.slice(0, Math.min(req.rows, m[6] ? +m[6] : req.rows));
    const fieldsMeta = await this.catalog(conn).fieldsOf(entity).catch(() => null);
    let cols = data && data.length ? Object.keys(data[0]) : (fieldsMeta || []).map(f => f.name);
    if (m[1].trim() !== '*') {
      const want = m[1].split(',').map(x => x.trim().toLowerCase());
      cols = want.map(w => { const k = cols.find(c => c.toLowerCase() === w); if (!k) throw new Error(`Column ${w.toUpperCase()} is unknown`); return k; });
    }
    const meta = (n: string) => (fieldsMeta || []).find(f => f.name.toLowerCase() === n.toLowerCase());
    return {
      columns: cols.map(c => ({ name: c.toUpperCase(), type: meta(c)?.type || '', desc: meta(c)?.desc || '', key: meta(c)?.key })),
      rows: rows.map(r => cols.map(c => String(r[c] ?? ''))), totalRows: total, sql, ms: Date.now() - started,
    };
  }

  // ---------------------------------------------------------------- abapGit
  async gitRepos(conn: string): Promise<GitRepo[]> { await wait(80); return JSON.parse(JSON.stringify(this.git[conn] || [])); }
  async gitLink(conn: string, r: { pkg: string; url: string; branch: string }) {
    await wait(200);
    if (!/^https:\/\/.+\.git$/.test(r.url)) throw new Error('Enter the HTTPS URL of the repository, ending in .git');
    const list = (this.git[conn] ||= []);
    if (list.some(x => x.pkg === r.pkg.toUpperCase())) throw new Error(`Package ${r.pkg.toUpperCase()} is already linked to a repository`);
    list.push({ key: 'R' + Date.now().toString(16).toUpperCase(), pkg: r.pkg.toUpperCase(), url: r.url, branch: r.branch || 'refs/heads/main', createdBy: this.conn(conn).user, status: '', statusText: 'Linked, not pulled yet' });
    this.persist();
  }
  async gitPull(conn: string, key: string): Promise<string> {
    await wait(600);
    const r = (this.git[conn] || []).find(x => x.key === key);
    if (!r) throw new Error('Repository not found');
    r.status = 'R'; r.statusText = 'Pulled ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
    this.persist();
    return `Pulled ${r.url.split('/').pop()} into ${r.pkg}. Nothing changed in the DEMO system.`;
  }
  async gitUnlink(conn: string, key: string) { this.git[conn] = (this.git[conn] || []).filter(x => x.key !== key); this.persist(); }
  async connect(conn: string): Promise<SystemInfo> {
    await wait(150);
    const c = this.conn(conn);
    if (c.kind === 'runner') return { release: 'nusa-runner 0.3', components: ['ABAP subset: classes, reports, internal tables, Open SQL on SQLite'] };
    if (c.kind === 'btp') return { release: 'SAP BTP ABAP Environment 2611', components: ['SAP_BASIS 816', 'SAP_CLOUD 2611'] };
    return { release: 'S/4HANA 2023 FPS02', components: ['SAP_BASIS 758', 'S4CORE 108'] };
  }

  async packageObjects(conn: string, pkg: string): Promise<ObjState[]> {
    await wait(60);
    return this.all(conn).filter(o => o.ref.pkg === pkg && !isGroupPart(o.ref)).map(o => ({ ...o.ref }));
  }

  async search(conn: string, query: string, filter: SearchFilter = {}): Promise<ObjRef[]> {
    const q = query.trim().toUpperCase().replace(/\*/g, '');
    return this.all(conn).filter(o => (!q || o.ref.name.includes(q) || o.ref.desc.toUpperCase().includes(q))
      && (!filter.type || o.ref.type === filter.type) && pkgMatches(filter.pkg, o.ref.pkg)).map(o => ({ ...o.ref }));
  }

  async read(conn: string, obj: ObjRef, include: Include, version: 'active' | 'inactive') {
    await wait(40);
    const o = this.get(conn, obj.uri);
    return (version === 'active' ? o.active[include] : o.saved[include]) ?? '';
  }

  async state(conn: string, obj: ObjRef): Promise<ObjState> { return { ...this.get(conn, obj.uri).ref }; }

  async lock(conn: string, obj: ObjRef) {
    await wait(40);
    const o = this.get(conn, obj.uri);
    o.lock = o.lock || 'LOCK' + Math.random().toString(36).slice(2, 10).toUpperCase();
    o.ref.lockedBy = this.conn(conn).user;
    return o.lock;
  }
  async unlock(conn: string, obj: ObjRef) {
    const o = this.get(conn, obj.uri);
    o.lock = undefined; o.ref.lockedBy = undefined;
  }

  async transportNeed(conn: string, obj: ObjRef): Promise<TransportNeed> {
    const c = this.conn(conn);
    const o = this.get(conn, obj.uri);
    const requests = this.tr[conn].filter(t => t.status === 'modifiable');
    if (!c.transports || o.ref.pkg.startsWith('$')) return { needed: false, requests: [], reason: 'Local object' };
    if (o.ref.transport) return { needed: false, current: o.ref.transport, requests };
    return { needed: true, requests };
  }

  async createTransport(conn: string, desc: string): Promise<string> {
    await wait(120);
    const prefix = this.conn(conn).sid + 'K9';
    const id = prefix + String(++this.seq).padStart(5, '0');
    const task = prefix + String(++this.seq).padStart(5, '0');
    this.tr[conn].unshift({ id, desc, owner: this.conn(conn).user, status: 'modifiable', task, objects: [] });
    this.persist();
    return id;
  }

  private record(conn: string, o: MObj, transport?: string) {
    if (!transport) return;
    const t = this.tr[conn].find(x => x.id === transport);
    if (!t) throw new Error(`Transport request ${transport} does not exist`);
    if (t.status !== 'modifiable') throw new Error(`Request ${transport} is already released`);
    const entry = `R3TR ${o.ref.type} ${o.ref.name}`;
    if (!t.objects.includes(entry)) t.objects.push(entry);
    o.ref.transport = transport;
  }

  async write(conn: string, obj: ObjRef, include: Include, source: string, lock: string, transport?: string) {
    await wait(80);
    const o = this.get(conn, obj.uri);
    if (o.lock !== lock) throw new Error(`${obj.name} is not locked by you. Reopen the editor to lock it again.`);
    const need = await this.transportNeed(conn, obj);
    if (need.needed && !transport) throw new Error(`${obj.name} must be recorded in a transport request`);
    if (transport) this.record(conn, o, transport);
    o.saved[include] = source;
    o.ref.inactive = this.includesOf(o.ref.type).some(i => (o.saved[i] ?? '') !== (o.active[i] ?? ''));
    this.persist();
  }

  async createObject(conn: string, type: ObjType, name: string, desc: string, pkg: string, transport?: string, extra: CreateExtra = {}): Promise<ObjRef> {
    await wait(150);
    if (type === 'FUNC') {
      const g = (extra.functionGroup || '').toUpperCase();
      const grp = g && this.objs.get(this.key(conn, uriFor('FUGR', g)));
      if (!grp) throw new Error(g ? `Function group ${g} does not exist` : 'Enter the function group of the function module');
      pkg = grp.ref.pkg;
    }
    const uri = newObjectUri(type, name, extra);
    if (this.objs.has(this.key(conn, uri))) throw new Error(`${name} already exists`);
    if (type === 'SRVB' && !extra.serviceDefinition) throw new Error('A service binding needs a service definition');
    if (type === 'FUGR') {
      // the system creates the global data include with the group
      const top = `L${name}TOP`, turi = fgIncludeUri(name, top);
      const src = `FUNCTION-POOL ${name.toLowerCase()}.                "MESSAGE-ID ..\n`;
      this.objs.set(this.key(conn, turi), { ref: { uri: turi, name: top, type: 'INCL', pkg, desc: `Global data of ${name}`, inactive: false }, saved: { main: src }, active: { main: src } });
    }
    const main = template(type, name, desc, { ...extra, pkg });
    const saved: Partial<Record<Include, string>> = type === 'CLAS'
      ? { main, definitions: SRC.ZCL_NUSA_FLIGHT_SERVICE.definitions, implementations: SRC.ZCL_NUSA_FLIGHT_SERVICE.implementations, testclasses: '' }
      : { main };
    const o: MObj = {
      ref: { uri, name, type, pkg, desc, inactive: type !== 'SRVB' }, saved, active: type === 'SRVB' ? { main: '' } : {},
      binding: type === 'SRVB' ? { published: false, serviceDefinition: extra.serviceDefinition!.toUpperCase(), version: extra.bindingType || 'V4', category: extra.category || 'UI' } : undefined,
    };
    this.objs.set(this.key(conn, uri), o);
    this.record(conn, o, transport);
    this.persist();
    return { uri, name, type, pkg, desc };
  }

  // ---------------------------------------------------------------- checks

  private check(conn: string, o: MObj, include: Include, source: string): Problem[] {
    const c = this.conn(conn);
    const at = (line: number, msg: string, sev: Problem['sev'] = 'error'): Problem => ({ sev, msg, uri: o.ref.uri, include, line, source: 'syntax' });
    if (o.ref.type === 'SRVB') return [];
    if (isTextInclude(include)) {
      // like SE38 text elements: three-character symbols, texts within their length
      const out: Problem[] = [];
      let max = 0;
      source.split('\n').forEach((l, i) => {
        const m = /^@MaxLength:(\d+)/.exec(l.trim());
        if (m) { max = +m[1]; return; }
        const eq = l.indexOf('=');
        if (eq < 0) return;
        const key = l.slice(0, eq).trim(), text = l.slice(eq + 1);
        if (include === 'symbols' && !/^[A-Z0-9]{3}$/i.test(key)) out.push(at(i, `Text symbol key "${key}" must have three characters`));
        if (include === 'symbols' && max && text.length > max) out.push(at(i, `Text symbol ${key} is longer than its maximum length ${max}`));
        if (include === 'selections' && text.length > 30) out.push(at(i, `Selection text of ${key} is longer than 30 characters`));
        max = 0;
      });
      return out;
    }
    if (TYPE_INFO[o.ref.type].editor === 'xml') {
      // a light well-formedness check, the real check happens on the system
      const opens = (source.match(/<[A-Za-z]/g) || []).length;
      const closes = (source.match(/<\/[A-Za-z]|\/>/g) || []).length;
      return opens === closes ? [] : [at(0, 'The XML document is not well-formed: an element is not closed')];
    }
    if (isCdsLike(o.ref.type)) {
      const out: Problem[] = [];
      for (const ph of ['data_source_name', 'field_name', 'entity_name', 'table_name', 'element_name', 'authorization_object']) {
        if (new RegExp(`\\b${ph}\\b`).test(source)) out.push(at(lineOf(source, new RegExp(`\\b${ph}\\b`)), `Replace the placeholder ${ph.toUpperCase()}`));
      }
      if (out.length) return out;
      const opens = (source.match(/\{/g) || []).length, closes = (source.match(/\}/g) || []).length;
      if (opens !== closes) out.push(at(Math.max(0, lineOf(source, /[{}]/)), 'Unbalanced braces in the element list'));
      return out;
    }
    const lines = source.split('\n');
    const a = analyze(lines);
    const out = a.errors.map(e => at(e.line, e.msg));
    for (const s of a.st) {
      if (c.abapVersion === 'cloud' && ['WRITE', 'FORM', 'PERFORM', 'REPORT', 'PARAMETERS'].includes(s.kw)) {
        out.push(at(s.start, `${s.kw} is not permitted in ABAP for Cloud Development`));
      }
      if (s.kw === 'MOVE') out.push(at(s.start, 'MOVE is obsolete. Use the assignment operator "=" instead', 'warning'));
    }
    if (o.ref.type === 'CLAS' && include === 'main') {
      const decl = declaredMethods(a.st).filter(m => m.cls === o.ref.name.toLowerCase());
      const impl = implementedMethods(a.st).filter(m => m.cls === o.ref.name.toLowerCase());
      for (const m of impl) {
        if (m.name.includes('~')) continue;
        if (!decl.some(d => d.name === m.name)) out.push(at(m.line, `Method "${m.name.toUpperCase()}" is not declared or inherited in class "${o.ref.name}"`));
      }
      for (const d of decl) {
        if (!impl.some(m => m.name === d.name)) out.push(at(d.line, `Implementation missing for method "${d.name.toUpperCase()}"`));
      }
    }
    return out;
  }

  async syntaxCheck(conn: string, obj: ObjRef, include: Include, source: string) {
    await wait(70);
    return this.check(conn, this.get(conn, obj.uri), include, source);
  }

  async activate(conn: string, objs: ObjRef[]) {
    await wait(200);
    const problems: Problem[] = [];
    for (const r of objs) {
      const o = this.get(conn, r.uri);
      for (const inc of this.includesOf(o.ref.type)) {
        problems.push(...this.check(conn, o, inc, o.saved[inc] ?? '').map(p => ({ ...p, source: 'activation' as const })));
      }
    }
    const errors = problems.filter(p => p.sev === 'error');
    if (errors.length) return { ok: false, problems };
    for (const r of objs) {
      const o = this.get(conn, r.uri);
      const before = { ...o.active };
      for (const inc of this.includesOf(o.ref.type)) if (!isTextInclude(inc)) this.revList(conn, o, inc);
      o.active = { ...o.saved };
      o.ref.inactive = false;
      this.addRevisions(conn, o, before);
    }
    this.persist();
    return { ok: true, problems };
  }

  async prettyPrint(_conn: string, source: string) { await wait(60); return prettyPrint(source); }

  // ---------------------------------------------------------------- code intelligence

  private catalogs = new Map<string, Catalog>();
  private catalog(conn: string): Catalog {
    let c = this.catalogs.get(conn);
    if (!c) {
      c = new WorkspaceCatalog(new StdCatalog(this.conn(conn).abapVersion === 'cloud'),
        () => this.all(conn).map(o => ({ name: o.ref.name, type: o.ref.type, desc: o.ref.desc, source: o.saved.main ?? '' })));
      this.catalogs.set(conn, c);
    }
    return c;
  }

  async complete(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Proposal[]> {
    const o = this.objs.get(this.key(conn, obj.uri));
    const related = o ? this.includesOf(o.ref.type).filter(i => i !== include).map(i => o.saved[i] ?? '') : [];
    const req = { source, line, col, catalog: this.catalog(conn), cloud: this.conn(conn).abapVersion === 'cloud', related };
    return isCdsLike(obj.type) ? completeCds(req) : completeAbap(req);
  }

  private wordAt(source: string, line: number, col: number): string {
    const text = source.split('\n')[line] ?? '';
    let a = col, b = col;
    while (a > 0 && /[\w/~]/.test(text[a - 1])) a--;
    while (b < text.length && /[\w/~]/.test(text[b])) b++;
    return text.slice(a, b);
  }

  async navigate(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<Location | null> {
    const word = this.wordAt(source, line, col).toLowerCase();
    if (!word) return null;
    const target = this.all(conn).find(o => o.ref.name.toLowerCase() === word);
    if (target) return { uri: target.ref.uri, include: 'main', line: 0 };
    for (const o of this.all(conn)) {
      if (o.ref.type !== 'CLAS') continue;
      const src = o.saved.main ?? '';
      const l = lineOf(src, new RegExp(`^\\s*METHOD\\s+${word.replace(/[~/]/g, '\\$&')}\\s*\\.`, 'i'));
      if (l >= 0) return { uri: o.ref.uri, include: 'main', line: l };
    }
    const decl = lineOf(source, new RegExp(`(DATA\\(|DATA:?\\s+|FIELD-SYMBOL\\()${word}\\b|\\b${word}\\s+TYPE\\b`, 'i'));
    if (decl >= 0) return { uri: obj.uri, include, line: decl };
    return null;
  }

  async whereUsed(conn: string, _obj: ObjRef, _include: Include, source: string, line: number, col: number): Promise<Hit[]> {
    await wait(120);
    const word = this.wordAt(source, line, col);
    if (!word) return [];
    const re = new RegExp(`(^|[^\\w/])${word.replace(/[~/]/g, '\\$&')}(?![\\w/])`, 'i');
    const hits: Hit[] = [];
    for (const o of this.all(conn)) {
      for (const inc of this.includesOf(o.ref.type)) {
        (o.saved[inc] ?? '').split('\n').forEach((t, i) => {
          if (re.test(t) && !/^\s*\*/.test(t)) hits.push({ uri: o.ref.uri, include: inc, line: i, name: o.ref.name, type: o.ref.type, text: t.trim() });
        });
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------- transports

  async transports(conn: string) { await wait(60); return JSON.parse(JSON.stringify(this.tr[conn] || [])) as Transport[]; }

  async releaseTransport(conn: string, id: string) {
    await wait(250);
    const t = this.tr[conn].find(x => x.id === id);
    if (!t) throw new Error(`Request ${id} not found`);
    const inactive = this.all(conn).filter(o => o.ref.transport === id && o.ref.inactive);
    if (inactive.length) throw new Error(`Release not possible: ${inactive.map(o => o.ref.name).join(', ')} still inactive`);
    t.status = 'released';
    for (const o of this.all(conn)) if (o.ref.transport === id) o.ref.transport = undefined;
    this.persist();
  }

  // ---------------------------------------------------------------- tests, ATC, run

  private guardOk(conn: string): boolean {
    const svc = this.all(conn).find(o => o.ref.name === 'ZCL_NUSA_FLIGHT_SERVICE');
    const src = svc?.active.main ?? '';
    const start = lineOf(src, /^\s*METHOD\s+calc_load_factor/i);
    const body = src.split('\n').slice(start, lineOf(src, /^\s*ENDMETHOD/i, start + 1) + 1).join('\n');
    return /iv_seats_max\s*(=\s*0|IS\s+INITIAL|<=\s*0|EQ\s+0)/i.test(body);
  }

  async runUnit(conn: string, obj: ObjRef): Promise<UnitResult> {
    await wait(450);
    const o = this.get(conn, obj.uri);
    if (o.ref.type !== 'CLAS') return { uri: obj.uri, methods: [], note: 'ABAP Unit in this prototype runs on classes.' };
    const src = o.active.testclasses ?? '';
    const tests = declaredMethods(statements(src.split('\n'))).filter(m => m.testing);
    const note = o.ref.inactive ? 'Tests ran against the active version. Activate to include your latest changes.' : undefined;
    const main = o.active.main ?? '';
    const divLine = Math.max(0, lineOf(main, /round\(/i));
    const methods = tests.map((t, i) => {
      const at: Location = { uri: obj.uri, include: 'testclasses', line: Math.max(0, lineOf(src, new RegExp(`^\\s*METHOD\\s+${t.name}\\s*\\.`, 'i'))) };
      const ms = 2 + ((i * 7 + t.name.length) % 9);
      if (/zero/.test(t.name) && !this.guardOk(conn)) {
        return { cls: t.cls, method: t.name, status: 'error' as const, ms, msg: 'Exception CX_SY_ZERODIVIDE: Division by zero in CALC_LOAD_FACTOR', at: { uri: obj.uri, include: 'main' as Include, line: divLine } };
      }
      return { cls: t.cls, method: t.name, status: 'ok' as const, ms, at };
    });
    return { uri: obj.uri, methods, note };
  }

  async runAtc(conn: string, obj: ObjRef): Promise<AtcFinding[]> {
    await wait(380);
    const o = this.get(conn, obj.uri);
    const c = this.conn(conn);
    const out: AtcFinding[] = [];
    for (const inc of this.includesOf(o.ref.type)) {
      const lines = (o.saved[inc] ?? '').split('\n');
      if (isCdsLike(o.ref.type) || o.ref.type === 'SRVB') continue;
      for (const s of statements(lines)) {
        const at: Location = { uri: o.ref.uri, include: inc, line: s.start };
        if (s.kw === 'SELECT' && /^SELECT\s+\*/i.test(s.text.trim())) out.push({ prio: 2, check: 'Performance', msg: 'SELECT * reads every column of /DMO/FLIGHT. List the fields you use.', at });
        if (/CATCH\s+CX_ROOT/i.test(s.text)) out.push({ prio: 2, check: 'Robustness', msg: 'Catching CX_ROOT also hides programming errors. Catch a specific exception class.', at });
        if (s.kw === 'MOVE') out.push({ prio: 3, check: 'Obsolete statements', msg: 'MOVE is obsolete. Use "=".', at });
        if (c.abapVersion === 'cloud' && s.kw === 'WRITE') out.push({ prio: 1, check: 'ABAP Cloud readiness', msg: 'WRITE is not released for ABAP Cloud.', at });
        if (s.kw === 'SELECT' && !/\bWHERE\b/i.test(s.text)) out.push({ prio: 3, check: 'Performance', msg: 'SELECT without WHERE reads the whole table.', at });
      }
    }
    if (o.ref.type === 'CLAS' && !/FOR\s+TESTING/i.test(o.saved.testclasses ?? '') && !/if_oo_adt_classrun/i.test(o.saved.main ?? '')) {
      out.push({ prio: 3, check: 'ABAP Unit', msg: 'The class has no unit tests.', at: { uri: o.ref.uri, include: 'testclasses', line: 0 } });
    }
    return out.sort((a, b) => a.prio - b.prio);
  }

  private carrierOf(src: string): string {
    return ((src.match(/DEFAULT\s+'(\w+)'/i) || [])[1] || 'GA').toUpperCase();
  }
  private load(f: typeof FLIGHTS[number]): string {
    if (!f.seats_max) return '0.00';
    return (Math.round(f.seats_occupied * 10000 / f.seats_max) / 100).toFixed(2);
  }
  private listLine(f: typeof FLIGHTS[number]): string {
    const d = f.flight_date.split('-').reverse().join('.');
    return `${f.connection_id} ${d}${this.load(f).padStart(24)}`;
  }

  async run(conn: string, obj: ObjRef): Promise<RunResult> {
    await wait(300);
    const o = this.get(conn, obj.uri);
    this.traced(conn, o.ref.name);
    const c = this.conn(conn);
    const note = o.ref.inactive ? 'Ran the active version. Your inactive changes are not included.' : undefined;
    if (o.ref.type === 'INCL') throw new Error(`${o.ref.name} is an include. Run the program that includes it.`);
    if (o.ref.type === 'PROG' && /PERFORM\s+load_bookings/i.test(o.active.main ?? '')) {
      return { kind: 'list', note, output: [`${o.ref.name.padEnd(40)}${c.sid} ${c.client}`, '-'.repeat(56), '0001 Sari Wulandari                        1.250,00', '0002 Budi Hartono                            980,50'].join('\n') };
    }
    if (o.ref.type === 'PROG') {
      const carr = this.carrierOf(o.active.main ?? '');
      const rows = FLIGHTS.filter(f => f.carrier_id === carr);
      const head = `${o.ref.name.padEnd(40)}${c.sid} ${c.client}`;
      return { kind: 'list', note, output: [head, '-'.repeat(56), ...rows.map(f => this.listLine(f)), rows.length ? '' : '(no flights for ' + carr + ')'].join('\n') };
    }
    if (o.ref.type === 'CLAS' && /if_oo_adt_classrun/i.test(o.active.main ?? '')) {
      const cols = ['CARRIER_ID', 'CONNECTION_ID', 'FLIGHT_DATE', 'PRICE', 'CURRENCY_CODE', 'PLANE_TYPE_ID', 'SEATS_MAX', 'SEATS_OCCUPIED'];
      const vals = FLIGHTS.map(f => [f.carrier_id, f.connection_id, f.flight_date, f.price, f.currency_code, f.plane_type_id, String(f.seats_max), String(f.seats_occupied)]);
      const w = cols.map((h, i) => Math.max(h.length, ...vals.map(v => v[i].length)));
      const row = (v: string[]) => v.map((x, i) => x.padEnd(w[i])).join(' ');
      return { kind: 'console', note, output: [`${FLIGHTS.length} flights for carrier GA`, row(cols), ...vals.map(row)].join('\n') };
    }
    if (o.ref.type === 'CLAS') throw new Error(`${o.ref.name} does not implement IF_OO_ADT_CLASSRUN, so it cannot run as a console application`);
    throw new Error(`${o.ref.name} cannot be executed`);
  }

  // ---------------------------------------------------------------- quick fixes and refactorings (computed locally)

  private clsOf(o: MObj) { return o.ref.type === 'CLAS' ? o.ref.name : null; }

  async quickFixes(conn: string, obj: ObjRef, include: Include, source: string, line: number, col: number): Promise<QuickFix[]> {
    await wait(60);
    const o = this.get(conn, obj.uri);
    if (TYPE_INFO[o.ref.type].editor !== 'abap') return [];
    return quickFixesAt(source, include === 'main' ? this.clsOf(o) : null, line, col).map(f => ({ title: f.title, desc: f.desc, token: JSON.stringify(f.edits) }));
  }

  async applyQuickFix(conn: string, obj: ObjRef, include: Include, _source: string, _line: number, _col: number, fix: QuickFix): Promise<TextEdit[]> {
    await wait(60);
    const o = this.get(conn, obj.uri);
    return (JSON.parse(fix.token) as LocalEdit[]).map(e => ({ ...e, uri: o.ref.uri, include, name: o.ref.name, type: o.ref.type, oldText: '' }));
  }

  async renameStart(conn: string, obj: ObjRef, include: Include, line: number, from: number, to: number): Promise<RenameStart> {
    await wait(60);
    const o = this.get(conn, obj.uri);
    const text = (o.saved[include] ?? '').split('\n')[line] ?? '';
    const r = wordRange(text, from) ?? [from, to];
    const oldName = text.slice(r[0], Math.max(r[1], to));
    if (!/^[\w/~]+$/.test(oldName) || KW.has(oldName.toUpperCase())) throw new Error('Place the cursor on a name to rename it');
    return { oldName, token: JSON.stringify({ uri: o.ref.uri, oldName }) };
  }

  private preview(conn: string, title: string, perInclude: { o: MObj; include: Include; edits: LocalEdit[] }[], transport?: string): RefactorPreview {
    const edits: TextEdit[] = [];
    for (const p of perInclude) {
      const src = p.o.saved[p.include] ?? '';
      for (const e of p.edits) edits.push({ ...e, uri: p.o.ref.uri, include: p.include, name: p.o.ref.name, type: p.o.ref.type, oldText: src.slice(offsetOf(src, e.from), offsetOf(src, e.to)) });
    }
    const objects = [...new Map(perInclude.map(p => [p.o.ref.uri, { ...p.o.ref }])).values()];
    return { title, edits, objects, token: JSON.stringify({ conn, transport }) };
  }

  async renamePreview(conn: string, start: RenameStart, newName: string, transport?: string): Promise<RefactorPreview> {
    await wait(120);
    const { uri, oldName } = JSON.parse(start.token) as { uri: string; oldName: string };
    if (!/^[A-Za-z_/][\w/]*$/.test(newName)) throw new Error(`${newName} is not a valid ABAP name`);
    if (newName.toLowerCase() === oldName.toLowerCase()) throw new Error('The new name is the same as the old one');
    const o = this.get(conn, uri);
    const parts = this.includesOf(o.ref.type).map(include => ({ o, include, edits: renameEdits(o.saved[include] ?? '', oldName, newName) })).filter(p => p.edits.length);
    if (!parts.length) throw new Error(`${oldName} is not used in ${o.ref.name}`);
    return this.preview(conn, `Rename ${oldName} to ${newName}`, parts, transport);
  }

  async extractStart(conn: string, obj: ObjRef, include: Include, from: { line: number; ch: number }, to: { line: number; ch: number }): Promise<ExtractStart> {
    await wait(60);
    const o = this.get(conn, obj.uri);
    if (o.ref.type !== 'CLAS' || include !== 'main') throw new Error('Extract Method works in the global class here. Select statements inside a method.');
    const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    extractMethodEdits(o.saved.main ?? '', o.ref.name, from.line, last, 'new_method');   // validates the selection
    return { name: 'new_method', visibility: 'PRIVATE', isStatic: false, className: o.ref.name, params: [], token: JSON.stringify({ uri: o.ref.uri, from: from.line, to: last }) };
  }

  async extractPreview(conn: string, start: ExtractStart, transport?: string): Promise<RefactorPreview> {
    await wait(120);
    const t = JSON.parse(start.token) as { uri: string; from: number; to: number };
    if (!/^[A-Za-z_][\w]*$/.test(start.name)) throw new Error(`${start.name} is not a valid method name`);
    const o = this.get(conn, t.uri);
    const edits = extractMethodEdits(o.saved.main ?? '', o.ref.name, t.from, t.to, start.name.toLowerCase());
    return this.preview(conn, `Extract method ${start.name.toLowerCase()}`, [{ o, include: 'main', edits }], transport);
  }

  async refactorExecute(conn: string, p: RefactorPreview): Promise<void> {
    await wait(200);
    const { transport } = JSON.parse(p.token) as { transport?: string };
    for (const ref of p.objects) {
      const o = this.get(conn, ref.uri);
      if (o.lock) throw new Error(`${o.ref.name} is locked by an editor with unsaved changes. Save or close it first.`);
      const need = await this.transportNeed(conn, o.ref);
      if (need.needed && !transport) throw new Error(`${o.ref.name} must be recorded in a transport request`);
      this.record(conn, o, transport);
      for (const include of this.includesOf(o.ref.type)) {
        const mine = p.edits.filter(e => e.uri === ref.uri && e.include === include);
        if (mine.length) o.saved[include] = applyEdits(o.saved[include] ?? '', mine);
      }
      o.ref.inactive = this.includesOf(o.ref.type).some(i => (o.saved[i] ?? '') !== (o.active[i] ?? ''));
    }
    this.persist();
  }

  // ---------------------------------------------------------------- profiler (sample traces)
  private traceRuns: Record<string, { run: TraceRun; hits: TraceHit[] }[]> = {};
  private tracePending = new Set<string>();
  private traceList(conn: string) {
    if (!this.traceRuns[conn]) {
      const cls = this.all(conn).find(o => o.ref.name === 'ZCL_NUSA_FLIGHT_SERVICE');
      this.traceRuns[conn] = cls ? [this.sampleTrace(conn, 'ZR_NUSA_FLIGHTS', new Date(Date.now() - 86_400_000).toISOString())] : [];
    }
    return this.traceRuns[conn];
  }
  private sampleTrace(conn: string, objectName: string, at: string): { run: TraceRun; hits: TraceHit[] } {
    const cls = this.all(conn).find(o => o.ref.name === 'ZCL_NUSA_FLIGHT_SERVICE');
    const line = (re: RegExp) => Math.max(0, (cls?.saved.main ?? '').split('\n').findIndex(l => re.test(l)));
    const at1 = cls ? { uri: cls.ref.uri, include: 'main' as Include, line: line(/SELECT \* FROM \/dmo\/flight/i) } : undefined;
    const at2 = cls ? { uri: cls.ref.uri, include: 'main' as Include, line: line(/rv_percent\s*=/i) } : undefined;
    const hits: TraceHit[] = [
      { name: `Program ${objectName}`, program: objectName, hits: 1, gross: 48210, net: 1630, grossPct: 100, netPct: 3.4 },
      { name: 'Select /DMO/FLIGHT', program: 'ZCL_NUSA_FLIGHT_SERVICE', hits: 1, gross: 39870, net: 39870, grossPct: 82.7, netPct: 82.7, at: at1 },
      { name: 'Call method ZCL_NUSA_FLIGHT_SERVICE->GET_FLIGHTS', program: 'ZCL_NUSA_FLIGHT_SERVICE', hits: 1, gross: 40120, net: 250, grossPct: 83.2, netPct: 0.5 },
      { name: 'Call method ZCL_NUSA_FLIGHT_SERVICE->CALC_LOAD_FACTOR', program: 'ZCL_NUSA_FLIGHT_SERVICE', hits: 3, gross: 410, net: 410, grossPct: 0.9, netPct: 0.9, at: at2 },
      { name: 'Write', program: objectName, hits: 3, gross: 5900, net: 5900, grossPct: 12.2, netPct: 12.2 },
    ];
    return { run: { id: `/sap/bc/adt/runtime/traces/abaptraces/demo-${Math.random().toString(36).slice(2, 8)}`, title: `${objectName} · DEMO trace`, at, objectName, runtime: 48210, abap: 8340, db: 39870, system: 0 }, hits };
  }
  async traces(conn: string): Promise<TraceRun[]> { await wait(80); return this.traceList(conn).map(t => ({ ...t.run })); }
  async traceHitList(conn: string, id: string): Promise<TraceHit[]> {
    await wait(80);
    const t = this.traceList(conn).find(x => x.run.id === id);
    if (!t) throw new Error('The trace does not exist anymore');
    return t.hits.map(h => ({ ...h }));
  }
  async traceRequest(conn: string): Promise<void> { await wait(80); this.tracePending.add(conn); }
  async traceDelete(conn: string, id: string): Promise<void> { await wait(60); this.traceRuns[conn] = this.traceList(conn).filter(t => t.run.id !== id); }
  /** a run while a trace request is open leaves a trace, as on the system */
  private traced(conn: string, name: string) {
    if (!this.tracePending.delete(conn)) return;
    this.traceList(conn).unshift(this.sampleTrace(conn, name, new Date().toISOString()));
  }

  // ---------------------------------------------------------------- runtime errors and version history
  async dumps(conn: string): Promise<Dump[]> {
    await wait(90);
    const c = this.conn(conn);
    const at = (re: RegExp, name: string): Location | undefined => {
      const o = this.all(conn).find(x => x.ref.name === name);
      if (!o) return undefined;
      return { uri: o.ref.uri, include: 'main', line: Math.max(0, (o.active.main ?? '').split('\n').findIndex(l => re.test(l))) };
    };
    const day = 86_400_000;
    const list: Dump[] = [];
    const cls = at(/rv_percent\s*=/i, 'ZCL_NUSA_FLIGHT_SERVICE');
    if (cls) list.push({
      id: `/sap/bc/adt/runtime/dump/demo-zerodivide-${conn}`, title: 'COMPUTE_INT_ZERODIVIDE in ZCL_NUSA_FLIGHT_SERVICE', error: 'COMPUTE_INT_ZERODIVIDE',
      program: 'ZCL_NUSA_FLIGHT_SERVICE=======CP', user: c.user, at: new Date(Date.now() - 2 * 3600_000).toISOString(), where: cls,
      html: `<h2>Runtime error COMPUTE_INT_ZERODIVIDE</h2><p><b>Short text:</b> Division by 0 (type I or INT8)</p><h3>What happened?</h3><p>Error in the ABAP application program. The current ABAP program "ZCL_NUSA_FLIGHT_SERVICE=======CP" had to be terminated because it found a statement that could not be executed.</p><h3>Error analysis</h3><p>In the current program "ZCL_NUSA_FLIGHT_SERVICE=======CP", an arithmetic operation ('DIVIDE', '/', 'DIV' or 'MOD') with a divisor of 0 was attempted. A flight with SEATS_MAX = 0 was read.</p><h3>How to correct the error</h3><p>Check the divisor before the division, for example with <code>IF iv_max = 0. RETURN. ENDIF.</code></p>`,
    });
    const rep = at(/READ TABLE|WRITE/i, 'ZR_NUSA_FLIGHTS');
    if (rep) list.push({
      id: `/sap/bc/adt/runtime/dump/demo-itab-${conn}`, title: 'ITAB_LINE_NOT_FOUND in ZR_NUSA_FLIGHTS', error: 'ITAB_LINE_NOT_FOUND',
      program: 'ZR_NUSA_FLIGHTS', user: c.user, at: new Date(Date.now() - day).toISOString(), where: rep,
    });
    list.push({ id: `/sap/bc/adt/runtime/dump/demo-timeout-${conn}`, title: 'TIME_OUT in SAPLZNUSA_FG_UTIL', error: 'TIME_OUT', program: 'SAPLZNUSA_FG_UTIL', user: 'BATCH_NUSA', at: new Date(Date.now() - 3 * day).toISOString() });
    return list;
  }
  async dumpDetail(conn: string, dump: Dump): Promise<{ html?: string; text?: string }> {
    await wait(60);
    if (dump.html) return { html: dump.html };
    return { text: `Category               ABAP programming error\nRuntime Errors         ${dump.error}\nABAP Program           ${dump.program}\nApplication Component  Not assigned\nDate and Time          ${new Date(dump.at).toLocaleString()}\nUser                   ${dump.user}\n\nShort Text\n    ${dump.error === 'TIME_OUT' ? 'Time limit exceeded.' : 'Line of an internal table not found.'}\n\nWhat happened?\n    Error in the ABAP application program.\n` };
  }

  private revs = new Map<string, (Revision & { text: string })[]>();
  private revList(conn: string, o: MObj, include: Include) {
    const k = `${conn}|${o.ref.uri}|${include}`;
    let list = this.revs.get(k);
    if (!list) {
      const text = o.active[include] ?? '';
      const tr = this.tr[conn]?.find(t => t.objects.includes(`R3TR ${o.ref.type} ${o.ref.name}`));
      const older = text.split('\n').filter(l => !/^\s*"/.test(l)).join('\n');
      const mk = (n: number, at: number, t: string, title: string): Revision & { text: string } => ({ uri: `${o.ref.uri}/source/${include}/versions/demo${n}/content`, version: String(n).padStart(5, '0'), title, author: this.conn(conn).user, date: new Date(at).toISOString(), transport: tr?.id, text: t });
      list = text ? [mk(2, Date.now() - 86_400_000, text, 'Active version'), ...(older !== text ? [mk(1, Date.now() - 5 * 86_400_000, older, 'First version')] : [])] : [];
      this.revs.set(k, list);
    }
    return list;
  }
  async revisions(conn: string, obj: ObjRef, include: Include): Promise<Revision[]> {
    await wait(80);
    if (isTextInclude(include)) throw new Error('Text elements have no version history here');
    return this.revList(conn, this.get(conn, obj.uri), include).map(({ text: _t, ...r }) => r);
  }
  async revisionSource(conn: string, rev: Revision): Promise<string> {
    await wait(60);
    for (const [k, list] of this.revs) if (k.startsWith(conn + '|')) { const r = list.find(x => x.uri === rev.uri); if (r) return r.text; }
    throw new Error('This version does not exist anymore');
  }
  /** activation adds a version, as in the system */
  private addRevisions(conn: string, o: MObj, before: MObj['active']) {
    for (const inc of this.includesOf(o.ref.type)) {
      if (isTextInclude(inc) || (before[inc] ?? '') === (o.active[inc] ?? '')) continue;
      const list = this.revList(conn, o, inc);
      const n = list.length + 1;
      list.unshift({ uri: `${o.ref.uri}/source/${inc}/versions/demo${n + 10}/content`, version: String(n).padStart(5, '0'), title: 'Activated in Nusa Studio', author: this.conn(conn).user, date: new Date().toISOString(), transport: o.ref.transport, text: o.active[inc] ?? '' });
    }
  }

  async deleteTransport(conn: string, id: string): Promise<void> {
    await wait(120);
    const t = this.tr[conn].find(x => x.id === id);
    if (!t) throw new Error(`Request ${id} not found`);
    if (t.status !== 'modifiable') throw new Error(`Request ${id} is released and cannot be deleted`);
    this.tr[conn] = this.tr[conn].filter(x => x !== t);
    for (const o of this.all(conn)) if (o.ref.transport === id) o.ref.transport = undefined;
    this.persist();
  }

  async removeFromTransport(conn: string, id: string, entries: string[]): Promise<void> {
    await wait(100);
    const t = this.tr[conn].find(x => x.id === id);
    if (!t) throw new Error(`Request ${id} not found`);
    if (t.status !== 'modifiable') throw new Error(`Request ${id} is released; its objects cannot change`);
    const missing = entries.filter(e => !t.objects.includes(e));
    if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in ${id}`);
    t.objects = t.objects.filter(e => !entries.includes(e));
    for (const o of this.all(conn)) if (o.ref.transport === id && entries.includes(`R3TR ${o.ref.type} ${o.ref.name}`)) o.ref.transport = undefined;
    this.persist();
  }

  async moveToTransport(conn: string, from: string, to: string, entries: string[]): Promise<void> {
    const target = this.tr[conn].find(x => x.id === to);
    if (!target) throw new Error(`Request ${to} not found`);
    if (target.status !== 'modifiable') throw new Error(`Request ${to} is released`);
    await this.removeFromTransport(conn, from, entries);
    for (const e of entries) if (!target.objects.includes(e)) target.objects.push(e);
    for (const o of this.all(conn)) if (entries.includes(`R3TR ${o.ref.type} ${o.ref.name}`)) o.ref.transport = to;
    this.persist();
  }

  async changeTransportDesc(conn: string, id: string, desc: string): Promise<void> {
    await wait(80);
    const t = this.tr[conn].find(x => x.id === id);
    if (!t) throw new Error(`Request ${id} not found`);
    if (t.status !== 'modifiable') throw new Error(`Request ${id} is released; its description cannot change`);
    t.desc = desc;
    this.persist();
  }

  // ---------------------------------------------------------------- debugger (scripted for the sample program)

  async debugStart(conn: string, obj: ObjRef, bps: Breakpoint[]): Promise<DebugState | null> {
    const o = this.get(conn, obj.uri);
    if (o.ref.type !== 'PROG') return null;
    const cls = this.all(conn).find(x => x.ref.name === 'ZCL_NUSA_FLIGHT_SERVICE');
    const steps = buildTrace(o.active.main ?? '', cls?.active.main ?? '', this.carrierOf(o.active.main ?? ''), (f) => this.load(f), (f) => this.listLine(f));
    if (!steps || !cls) return null;
    this.dbg = { conn, steps, i: -1, inner: -1, out: [], prog: o.ref, cls: cls.ref };
    return this.advance('continue', bps);
  }

  async debugStep(kind: StepKind, bps: Breakpoint[], target?: Breakpoint) { await wait(60); return this.advance(target ? 'continue' : kind, target ? [...bps, target] : bps); }
  async debugStop() { this.dbg = null; }
  /** DEMO has no other processes that could reach a breakpoint. */
  async debugListen(): Promise<DebugState | null> { throw new Error('The DEMO system has no other processes to debug. Press F8 on the sample program instead.'); }
  async debugChildren(): Promise<DebugVar[]> { return []; }
  async debugFrame(index: number): Promise<DebugState> { await wait(40); return this.view(index); }
  async debugSetValue(name: string, value: string): Promise<DebugState> {
    const st = this.view();
    const find = (vs: DebugVar[]): DebugVar | undefined => { for (const v of vs) { if (v.name.toUpperCase() === name.toUpperCase() && !v.group) return v; const k = v.children && find(v.children); if (k) return k; } return undefined; };
    const v = find(st.vars);
    if (!v) throw new Error(`${name} is not visible here`);
    if (/Table|Structure|REF TO/i.test(v.type + v.value) && v.children?.length) throw new Error(`${name} is not an elementary variable`);
    v.value = value;
    return this.view();
  }

  private advance(kind: StepKind, bps: Breakpoint[]): DebugState {
    const d = this.dbg;
    if (!d) return { done: true, frames: [], vars: [], outputSoFar: '' };
    const isBp = (uri: string, include: Include, line: number) => bps.some(b => b.uri === uri && b.include === include && b.line === line);
    const leave = () => { const s = d.steps[d.i]; if (s && s.out) d.out.push(s.out); };

    if (d.inner >= 0) {                                   // inside CALC_LOAD_FACTOR
      const s = d.steps[d.i];
      if (kind !== 'return' && d.inner < (s.inner?.length ?? 0) - 1) { d.inner++; return this.view(); }
      d.inner = -1;                                       // back in the caller, next statement
      if (kind === 'continue') return this.runOn(isBp, leave);
      leave(); d.i++;
      return d.i >= d.steps.length ? this.finish() : this.view();
    }
    if (kind === 'into' && d.i >= 0 && d.steps[d.i].inner) { d.inner = 0; return this.view(); }
    if (kind === 'continue') return this.runOn(isBp, leave);
    if (d.i >= 0) leave();
    d.i++;
    return d.i >= d.steps.length ? this.finish() : this.view();
  }

  private runOn(isBp: (u: string, i: Include, l: number) => boolean, leave: () => void): DebugState {
    const d = this.dbg as NonNullable<MockBackend['dbg']>;
    while (true) {
      if (d.i >= 0) leave();
      d.i++;
      if (d.i >= d.steps.length) return this.finish();
      const s = d.steps[d.i];
      if (isBp(d.prog.uri, 'main', s.line)) return this.view();
      if (s.inner && s.inner.some(x => isBp(d.cls.uri, 'main', x.line))) {
        d.inner = s.inner.findIndex(x => isBp(d.cls.uri, 'main', x.line));
        return this.view();
      }
    }
  }

  private view(frame = 0): DebugState {
    const d = this.dbg as NonNullable<MockBackend['dbg']>;
    const s = d.steps[d.i];
    const progFrame = { name: `${d.prog.name} · START-OF-SELECTION`, uri: d.prog.uri, include: 'main' as Include, line: s.line };
    // the Variables view groups them like Eclipse: parameters first, then locals
    const grouped = (vs: DebugVar[]): DebugVar[] => {
      const isParam = (v: DebugVar) => /^(P_|IV_|EV_|CV_|RV_|ME$)/i.test(v.name);
      const g = (name: string, list: DebugVar[]): DebugVar => ({ name, type: '', value: '', group: true, expandable: true, children: list });
      return [g('Parameters', vs.filter(isParam)), g('Locals', vs.filter(v => !isParam(v)))].filter(x => x.children?.length);
    };
    if (d.inner >= 0 && s.inner) {
      const x = s.inner[d.inner];
      const frames = [{ name: 'ZCL_NUSA_FLIGHT_SERVICE→CALC_LOAD_FACTOR', uri: d.cls.uri, include: 'main' as Include, line: x.line }, progFrame];
      return { done: false, frames, frame, vars: grouped(frame === 1 ? s.vars : x.vars), outputSoFar: d.out.join('\n') };
    }
    return { done: false, frames: [progFrame], frame: 0, vars: grouped(s.vars), outputSoFar: d.out.join('\n') };
  }

  private finish(): DebugState {
    const out = this.dbg?.out.join('\n') ?? '';
    this.dbg = null;
    return { done: true, frames: [], vars: [], outputSoFar: out };
  }
}

interface Step { line: number; vars: DebugVar[]; out?: string; inner?: { line: number; vars: DebugVar[] }[] }

function buildTrace(prog: string, cls: string, carr: string, load: (f: typeof FLIGHTS[number]) => string, listLine: (f: typeof FLIGHTS[number]) => string): Step[] | null {
  const L = {
    svc: lineOf(prog, /DATA\(lo_service\)/i), get: lineOf(prog, /->get_flights/i), loop: lineOf(prog, /^\s*LOOP\s+AT/i),
    calc: lineOf(prog, /->calc_load_factor/i), write: lineOf(prog, /^\s*WRITE/i),
  };
  const C = { body: lineOf(cls, /rv_percent\s*=/i), end: -1 };
  C.end = lineOf(cls, /^\s*ENDMETHOD/i, C.body);
  if (Object.values(L).some(v => v < 0) || C.body < 0) return null;
  const rows = FLIGHTS.filter(f => f.carrier_id === carr);
  const v = (name: string, type: string, value: string, children?: DebugVar[]): DebugVar => ({ name, type, value, children });
  const flightVar = (f: typeof FLIGHTS[number] | null, name = 'LS_FLIGHT') => v(name, '/DMO/FLIGHT', f ? `Structure: ${f.connection_id} ${f.flight_date}` : 'Structure: initial',
    FLIGHT_FIELDS.slice(1).map(k => v(k.toUpperCase(), 'field', f ? String((f as Record<string, unknown>)[k]) : '')));
  const table = v('LT_FLIGHTS', 'TT_FLIGHTS', `Standard Table [${rows.length}x9]`, rows.map((f, i) => flightVar(f, `[${i + 1}]`)));
  const emptyTable = v('LT_FLIGHTS', 'TT_FLIGHTS', 'Standard Table [0x9]');
  const sy = (tabix: number, subrc = 0) => v('SY', 'SYST', `SUBRC = ${subrc}, TABIX = ${tabix}`, [v('SUBRC', 'I', String(subrc)), v('TABIX', 'I', String(tabix)), v('UNAME', 'C(12)', 'DEVELOPER')]);
  const pc = v('P_CARR', '/DMO/CARRIER_ID', `'${carr}'`);
  const svc = v('LO_SERVICE', 'REF TO ZCL_NUSA_FLIGHT_SERVICE', '{O:7*\\CLASS=ZCL_NUSA_FLIGHT_SERVICE}');
  const steps: Step[] = [
    { line: L.svc, vars: [pc, v('LO_SERVICE', 'REF TO ZCL_NUSA_FLIGHT_SERVICE', 'initial'), emptyTable, sy(0)] },
    { line: L.get, vars: [pc, svc, emptyTable, sy(0)] },
  ];
  let lastLoad = '0.00';
  rows.forEach((f, i) => {
    const before = [pc, svc, table, flightVar(i ? rows[i - 1] : null), v('LV_LOAD', 'DECFLOAT16', lastLoad), sy(i)];
    steps.push({ line: L.loop, vars: before });
    const cur = [pc, svc, table, flightVar(f), v('LV_LOAD', 'DECFLOAT16', lastLoad), sy(i + 1)];
    const params = [v('IV_SEATS_MAX', '/DMO/PLANE_SEATS_MAX', String(f.seats_max)), v('IV_SEATS_OCCUPIED', '/DMO/PLANE_SEATS_OCCUPIED', String(f.seats_occupied)), v('ME', 'REF TO ZCL_NUSA_FLIGHT_SERVICE', '{O:7*\\CLASS=ZCL_NUSA_FLIGHT_SERVICE}')];
    steps.push({
      line: L.calc, vars: cur,
      inner: [
        { line: C.body, vars: [...params, v('RV_PERCENT', 'DECFLOAT16', '0')] },
        { line: C.end, vars: [...params, v('RV_PERCENT', 'DECFLOAT16', load(f))] },
      ],
    });
    lastLoad = load(f);
    steps.push({ line: L.write, vars: [pc, svc, table, flightVar(f), v('LV_LOAD', 'DECFLOAT16', lastLoad), sy(i + 1)], out: listLine(f) });
  });
  return steps;
}
