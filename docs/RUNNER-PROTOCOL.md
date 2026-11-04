# Local runner protocol

Nusa Studio talks to the local ABAP runner with the **same ADT REST calls** it uses for SAP
systems, so one client covers S/4HANA, BTP and the runner. The runner only has to serve
the subset below. `test/fake-adt-server.ts` is an executable version of this document:
if your runner answers those requests the same way, the IDE works with it.

Base URL is the connection URL (default `http://localhost:7777`). No auth, no CSRF token,
no `sap-client`. The IDE still sends `X-sap-adt-sessiontype: stateful|stateless`; the
runner may ignore it.

## Required

| Method | Path | Purpose | Response |
|---|---|---|---|
| GET | `/sap/bc/adt/discovery` | connection test | any 200 (Atom service document is fine) |
| POST | `/sap/bc/adt/repository/nodestructure?parent_type=DEVC/K&parent_name=$TMP` | explorer | `asx:abap` with `SEU_ADT_REPOSITORY_OBJ_NODE` rows: `OBJECT_TYPE` (`CLAS/OC`, `INTF/OI`, `PROG/P`, `DDLS/DF`), `OBJECT_NAME`, `OBJECT_URI`, `DESCRIPTION` |
| GET | `{objectUri}` | metadata | root element with `adtcore:name`, `adtcore:type`, `adtcore:description`, `adtcore:version="active|inactive"`, child `adtcore:packageRef adtcore:name` |
| GET | `{objectUri}/source/main?version=active|workingArea` | read source | `text/plain` |
| GET | `{classUri}/includes/{definitions|implementations|testclasses}` | class includes | `text/plain`, 404 if it does not exist yet |
| POST | `{objectUri}?_action=LOCK&accessMode=MODIFY` | lock | `asx:abap` with `LOCK_HANDLE` |
| POST | `{objectUri}?_action=UNLOCK&lockHandle=…` | unlock | 200 |
| PUT | `{sourceUrl}?lockHandle=…` | save inactive version | 200; 423 when the handle is wrong |
| POST | `{classUri}/includes` | create an include | 200 |
| POST | `/sap/bc/adt/checkruns?reporters=abapCheckRun` | syntax check | `chkrun:checkRunReports` with `chkrun:checkMessage chkrun:uri="…#start=line,col" chkrun:type="E|W|I" chkrun:shortText` (base64 source arrives in `chkrun:content`) |
| POST | `/sap/bc/adt/activation?method=activate` | activate | empty body on success, or `chkl:messages` with `msg type="E" href="…#start=l,c"` and `shortText/txt` |
| GET | `/sap/bc/adt/activation/inactiveobjects` | inactive list | `adtcore:objectReference adtcore:uri` entries (may be empty) |
| POST | `/sap/bc/adt/oo/classrun/{CLASS}` | run a class implementing `IF_OO_ADT_CLASSRUN` | `text/plain` console output |
| POST | `/nusa/run/programs/{program}` | run a report (runner-only extension) | `text/plain` list output |

## Optional

| Method | Path | Without it |
|---|---|---|
| GET | `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=Z*` | object search returns nothing |
| POST | `/sap/bc/adt/abapsource/prettyprinter` | the IDE formats locally |
| POST | `/sap/bc/adt/abapsource/codecompletion/proposal` | keyword-only completion |
| POST | `/sap/bc/adt/navigation/target` | F3 does nothing |
| POST | `/sap/bc/adt/abapunit/testruns` | no ABAP Unit |
| ATC endpoints | `/sap/bc/adt/atc/...` | no ATC |

Transports are off for runner connections, so `/sap/bc/adt/cts/*` is never called.
