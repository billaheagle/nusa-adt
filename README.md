# Nusa ADT

A lightweight desktop IDE for ABAP: the workflow of Eclipse ADT in a VS Code-style
window. It talks to SAP through the same ADT REST services Eclipse uses, so nothing has to
be installed on the SAP side.

> **Ringkasan.** Nusa ADT adalah IDE ABAP ringan (Tauri, ±10–15 MB) dengan tampilan ala
> VS Code. Terhubung ke S/4HANA on-premise, BTP ABAP Environment, dan ABAP runner lokal
> lewat layanan ADT REST yang sama dengan Eclipse. Prototipe UI bisa dijalankan tanpa SAP
> (`npm run prototype`, buka `dist/nusa-adt-prototype.html`).

## What works

| Feature | S/4HANA / NetWeaver | BTP ABAP Environment | Local runner |
|---|---|---|---|
| Project Explorer (packages, `$TMP`), object search | ✓ | ✓ | ✓ |
| Editor: ABAP + CDS highlighting, F3, comment toggle | ✓ | ✓ | ✓ |
| Context-aware completion (see below), merged with the system's own proposals | ✓ | ✓ released objects only | ✓ |
| Dark, light or follow-system theme | ✓ | ✓ | ✓ |
| Lock, save inactive, activate, activate all | ✓ | ✓ | ✓ |
| Class includes: global, local types, test classes | ✓ | ✓ | ✓ |
| Syntax check (Ctrl+F2), pretty printer (Shift+F1) | ✓ server | ✓ server | local fallback |
| Transport requests: pick, create, release | ✓ | ✓ | – |
| ABAP Unit (Ctrl+Shift+F10) | ✓ | ✓ | if the runner serves it |
| ATC (Ctrl+Shift+F2) | ✓ | ✓ | – |
| Run console class `IF_OO_ADT_CLASSRUN` (F8/F9) | ✓ | ✓ | ✓ |
| Run report with list output | SAP GUI only | – | ✓ |
| Where-used (Ctrl+Shift+G) | ✓ object level | ✓ object level | – |
| Debugger: breakpoints, step into/over/return, variables, stack | experimental | experimental | – |
| BTP browser login (service key, OAuth) | – | ✓ | – |

## How it is built

```
┌──────────────── Tauri window (system webview) ────────────────┐
│ src/ui        workbench: explorer, tabs, CodeMirror, panels,   │
│               palette, transports, debugger                    │
│ src/backends  Backend interface                                │
│   adt.ts      → real systems             mock.ts → prototype   │
│ src/adt       ADT REST client: URLs, XML payloads, parsers     │
└───────────────────────────┬───────────────────────────────────┘
                            │ invoke('adt_request')
┌───────────────────────────┴───────────────────────────────────┐
│ src-tauri (Rust)  per-system session: cookies, CSRF token,      │
│                   stateful session for locks, Basic/OAuth,     │
│                   connections.json + OS keychain               │
└───────────────────────────────────────────────────────────────┘
```

The UI never talks to SAP directly. Rust keeps two cookie jars per system (stateless and
stateful) because ADT enqueue locks live in the stateful session between LOCK, PUT and
UNLOCK. Passwords and BTP service keys go to the OS keychain (Keychain, Credential
Manager, Secret Service), never into the project folder.

## Get the desktop app

The easiest way is to let GitHub build the installers:

1. Create a GitHub repository and upload this folder (or `git push` it).
2. Open **Actions → Build desktop app → Run workflow**.
3. After 15–25 minutes open **Releases**: a draft release holds `.msi`/`.exe` (Windows), `.dmg` (macOS) and `.deb`/`.AppImage` (Linux).

The installers are not code-signed yet. Windows SmartScreen asks once (**More info → Run anyway**); on macOS right-click the app and choose **Open** the first time.

## Run it

Requirements: Node 20+, Rust stable, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
for your OS (WebView2 on Windows, `webkit2gtk-4.1` on Linux, Xcode command line tools on macOS).

```bash
npm install
npm run tauri dev        # desktop app with hot reload
npm run tauri build      # installer in src-tauri/target/release/bundle
npm test                 # unit tests (ABAP analysis, ADT parsers, backends)
npm run prototype        # single-file HTML prototype with sample systems
npm run smoke            # headless UI test of the prototype
```

On first start the app lists only the local runner. Add systems under **Systems** (the
server icon at the bottom of the left rail):

- **S/4HANA or NetWeaver**: URL such as `https://host:44300`, client, user. The password
  is asked once and stored in the keychain. Turn on *Accept a self-signed certificate*
  only for development systems.
- **BTP ABAP Environment**: paste the instance's service key JSON. The browser opens for
  login on first use; the token refreshes automatically.
- **Local runner**: URL of the runner, no login. See [docs/RUNNER-PROTOCOL.md](docs/RUNNER-PROTOCOL.md).

SAP side: the ICF services under `/sap/bc/adt` must be active (transaction `SICF`) and the
user needs the same authorizations as for Eclipse ADT.

## Code completion

Completion knows where the cursor is and asks the system's repository for names, fields
and signatures (cached per session). On S/4HANA and BTP the server's own proposals are
added to the list, so nothing the system offers is lost.

| Where you type | What you get |
|---|---|
| `lo_obj->`, `me->`, `cls=>create( )->` | instance methods and attributes of the inferred class, with call snippets (`calc( iv_max = … iv_occ = )`) |
| `cls=>`, `if_x=>` | static methods, constants, types |
| `ls_row-`, `sy-`, `ls-a-b` | components of the inferred structure, including rows of `LOOP AT … INTO DATA( )`, `SELECT … INTO TABLE @DATA( )` and method results |
| after `TYPE`, `TYPE TABLE OF`, `LIKE`, `REF TO` | built-in types, local and class types, data elements, tables, structures, CDS entities, table types, classes |
| `SELECT … FROM`, `JOIN` | database tables and CDS views (released only on ABAP Cloud) |
| SELECT field list, `FIELDS`, `WHERE`, `ORDER BY`, `alias~` | fields of the tables in FROM/JOIN, SQL functions, `@` host variables |
| inside `meth(` / `NEW cls(` | parameter names not used yet, then values after `=` |
| `CALL FUNCTION '…` | function modules with the full pattern (optional inputs commented out, exceptions numbered) |
| `CATCH`, `RAISING`, `RAISE EXCEPTION TYPE/NEW` | exception classes |
| `METHOD ` in an implementation | declared methods not yet implemented, including `if_x~method` |
| `LOOP AT`, `READ TABLE`, `SORT … BY`, `WITH KEY`, `WHERE` on tables | table variables, next keywords, row components |
| `IF`, `ELSEIF`, `WHILE`, `CHECK` | operands, functions, comparison operators |
| statement start | statements valid in that scope (class definition, implementation, method, report), snippets, variables, own methods; `WRITE` and friends hidden on ABAP Cloud |
| `##`, `"#EC`, `<` | pragmas, pseudo comments, field symbols |
| CDS `@` and `#` | annotations with value templates, enum values |
| CDS `from`, `join`, `association … to`, `projection on` | data sources |
| CDS element list, `alias.`, `_Assoc.`, `$projection.`, `abap.`, `cast( … as` | fields of the sources, associations, functions, built-in types |

## Keys

| Action | Key | Action | Key |
|---|---|---|---|
| Open object | Ctrl+Shift+A | All commands | Ctrl+Shift+P / F1 |
| Save | Ctrl+S | Activate / all inactive | Ctrl+F3 / Ctrl+Shift+F3 |
| Check syntax | Ctrl+F2 | Pretty printer | Shift+F1 |
| Run | F8 / F9 | ABAP Unit | Ctrl+Shift+F10 |
| ATC | Ctrl+Shift+F2 | Where-used | Ctrl+Shift+G |
| Go to definition | F3 | Completion | Ctrl+Space |
| Toggle breakpoint | Ctrl+Shift+B or click left of the line number | Toggle comment | Ctrl+/ |
| Debugger | F5 into · F6 over · F7 return · F8 resume · Shift+F5 stop | Side bar / panel | Ctrl+B / Ctrl+J |
| Dark mode on/off | Ctrl+Alt+D or the sun/moon button | Theme picker | click the theme item in the status bar |

## Project layout

```
src/core/abap.ts        tokenizer, statement splitter, block checker, pretty printer
src/core/complete.ts    context-aware completion for ABAP and CDS
src/core/catalog.ts     reference data and parsers for classes, tables, CDS views, function modules
src/core/types.ts       Backend interface and shared types
src/ui/                 app.ts (workbench), editor.ts (CodeMirror modes, completion), styles.css
src/adt/                client.ts (endpoints + parsers), catalog.ts (repository lookups for completion), xml.ts, debugger.ts, tauri.ts
src/backends/           adt.ts (real systems), mock.ts (sample systems for the prototype)
src-tauri/src/          main.rs (commands), session.rs (HTTP/CSRF/stateful), oauth.rs, connections.rs
test/                   node:test suites, in-memory ADT server, Playwright smoke test
docs/RUNNER-PROTOCOL.md what the local runner must serve
```

## Verification status

Be clear about what has been tested and what has not:

- **Tested**: the workbench end to end against the mock systems (Playwright smoke test:
  edit, save, activate, ABAP Unit, includes, palette, new object with a new transport,
  debugger stepping, syntax errors, dark/light switching, completion in context, phone width); ABAP analysis; 14 completion contexts and pretty printer; ADT
  response parsers against payloads in the shape real systems return; the ADT backend's
  edit cycle against an in-memory ADT server (lock → transport → create include → write →
  activate → run). TypeScript type-checks clean.
- **Not yet tested**: the Rust side was written without access to crates.io, so it has
  been syntax-checked with `rustfmt` but not compiled. Run `cargo check` in `src-tauri`
  first and expect small fixes. No live SAP system was available, so request payloads for
  object creation, ATC, where-used and especially the **debugger** may need adjusting
  against your system. The BTP OAuth redirect uses `http://localhost:<random port>/adt/redirect`;
  confirm your UAA allows it.

## Next

CDS formatter and DDL completion, rename and extract-method refactoring, RAP generators,
abapGit integration, Monaco as an optional editor, debugger watchpoints.

License: MIT.
