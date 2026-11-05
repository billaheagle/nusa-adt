# Test cases Nusa Studio 0.3.0

These are the cases to try on a live system after the build on GitHub. Each case has steps, the expected result, and what to send if it fails.

**If something fails:** open **Help: Report a Problem** (`Ctrl+Shift+P` → "Report a Problem", or Settings → About). The text already contains the version and the connection log, with host names, user and SAProuter route hidden. Copy it into the chat, or send it to GitHub. A screenshot of the error toast also helps.

Status: ✅ passed · ❌ failed · ⏭️ cannot test (no access, no authorization)

Systems to prepare:
- **DEV**: an on-premise S/4HANA (HTTPS or RFC) or the office system over VPN
- **QAS** (optional): a second system with the same objects, for the compare test
- **S/4HANA Cloud** MY408355 (browser logon)

---

## A. Build and installation

| # | Steps | Expected |
|---|---|---|
| A1 | Upload, then Actions → **Build desktop app** → Run workflow | `test` and `rust` jobs green (88 unit tests, Rust compile with the dialog plugin, SAP GUI shortcut, updater). The three installer builds green, a draft release appears |
| A2 | Download the Windows `-setup.exe` and the `-portable-x64.exe` | Both open. Title bar, version 0.3.0 under Settings → About |
| A3 | Install the setup over 0.2.0 | Saved systems and passwords are still there |
| A4 | Portable on the office laptop (copy the `.exe` only) | Opens without installing. The `nusa-adt-data` folder appears next to the exe |

## B. Code signing (only once the certificate is in the secrets)

| # | Steps | Expected |
|---|---|---|
| B1 | Without `WINDOWS_CERTIFICATE` secrets: run the workflow | Build stays green, the "Windows code signing certificate" step is *skipped* |
| B2 | With `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` | Log shows "Windows signing with certificate CN=…". Right-click the `.exe`/`.msi` → Properties → **Digital Signatures** shows your name and a timestamp. The portable exe is signed too |
| B3 | With the `APPLE_*` secrets (if you have a Mac account) | The `.dmg` opens without "unidentified developer" (with notarization) |

## C. Updates

| # | Steps | Expected |
|---|---|---|
| C1 | Publish release 0.3.0, open 0.2.0 → Settings → **Check for updates now** | Shows that 0.3.0 is available with a Download button |
| C2 | (Only with the updater secrets) installed build → **Install and restart** | Downloads, installs, the app restarts as the new version |

## D. Browser logon (S/4HANA Cloud / BTP)

| # | Steps | Expected |
|---|---|---|
| D1 | Settings → Browser logon: **automatic opening off** (default). Connect MY408355 | The browser does **not** open by itself. A card appears with **Open in browser**, **Copy link**, **Cancel** |
| D2 | Click **Copy link**, paste it into another browser (e.g. an incognito window) and log on | Nusa Studio connects, the explorer fills up |
| D3 | Turn on "open the logon page in the browser automatically", log on again | The default browser opens by itself |
| D4 | Click **Cancel** while waiting | The card closes, the status is not connected, no error popup |

## E. RFC logon (SAP GUI / SAProuter)

| # | Steps | Expected |
|---|---|---|
| E1 | Add system → SAP GUI / RFC → **Browse…** for the SDK folder | The folder picker opens; after choosing, green "Found …sapnwrfc.dll" |
| E2 | Fill the SDK folder with a wrong folder | Red text explaining what is missing (e.g. a Linux SDK on Windows) |
| E3 | Office system over VPN: application server + instance, SAProuter empty | Connects, no ICU popup |
| E4 | Wrong password once | Clear message, **no** repeated logon attempts (the user is not locked) |

## F. Explorer, search, package cache

| # | Steps | Expected |
|---|---|---|
| F1 | Arrow next to a program that uses `INCLUDE` | Its includes appear underneath and can be opened |
| F2 | Arrow next to a function group | Function modules and includes (TOP, UXX, …) appear |
| F3 | Close the app, open it again | The favorite packages show their contents **at once** (from the last session), then refresh by themselves. Objects deleted elsewhere disappear after the refresh |
| F4 | Search view: type quickly `ZCL_A` → delete → `ZR_` | The result always matches the latest text (never the result of an old query) |
| F5 | Search with Type = Function Module, Package = `Z*` | Only function modules from Z packages |
| F6 | `Ctrl+Shift+P` right after switching tabs, type straight away | The text goes into the palette, not into the editor |

## G. Function groups and function modules (new)

| # | Steps | Expected |
|---|---|---|
| G1 | `Ctrl+N` → Type **Function Group** → `ZNUSA_TEST_FG`, package Z…, description → Create → choose a TR | The group is created and opens. The arrow shows the `LZNUSA_TEST_FGTOP` include (made by the system) |
| G2 | Right-click the group → **New Function Module…** | The dialog opens with Function group already filled in and the package following the group |
| G3 | Name `Z_NUSA_TEST_FM`, description → Create → TR | The FM opens with a template (IMPORTING/EXPORTING). Save + Activate succeed |
| G4 | Check in SE37 | The FM exists in the right group, active |
| G5 | `Ctrl+N` → Function Module with a group that does not exist | Message "Function group … does not exist" (from the system) |
| G6 | F8 on the FM (on-premise) | SAP GUI opens on the SE37 test screen of the FM. *(The `WB_EXEC` OK code has not been checked yet: if it only stops on the SE37 start screen, report it)* |

## H. Runtime errors / ST22 (new)

Prepare a test dump:
```abap
REPORT zr_nusa_dump_test.
DATA lv_zero TYPE i.
DATA(lv_x) = 1 / lv_zero.
WRITE lv_x.
```
Activate, run it in SAP GUI (or F8) so it dumps `COMPUTE_INT_ZERODIVIDE`.

| # | Steps | Expected |
|---|---|---|
| H1 | `Ctrl+Shift+P` → **Runtime Errors (ST22)** | The **Runtime Errors** tab in the bottom panel shows the dump with the error name, program, user, time. The count appears on the tab |
| H2 | Click the dump | The full description appears (from the system), readable, without scripts running |
| H3 | **Show source line …** | `ZR_NUSA_DUMP_TEST` opens with the cursor on the division line |
| H4 | Untick **Only <user>** | Other users' dumps appear too (if any, and if authorized) |
| H5 | On S/4HANA Cloud | The list appears or a clear message (if the feed is not available there) |
| H6 | Compare with ST22 in SAP GUI | Same dumps for the same period |

## I. Version history (new)

| # | Steps | Expected |
|---|---|---|
| I1 | Open a class/program that has been activated a few times → right-click the editor → **Compare With Version History…** | A list of versions, newest first, with date, user and TR |
| I2 | Choose the oldest version | A diff tab "↔ Version <date>" shows the differences with the editor |
| I3 | Change something, activate, repeat I1 | A new version appears at the top *(on some releases a version is only written on TR release: report what you see)* |
| I4 | Class: switch to the **Local Types** / **Test Classes** tab, then Version History | The history of that include, or a clear message |
| I5 | Program: **Text Symbols** tab | The menu item is disabled / says text elements have no version history |

## J. Compare with another system (new; needs 2 systems)

| # | Steps | Expected |
|---|---|---|
| J1 | Add QAS (or another system) to the list. In DEV open an object that has been transported → **Compare With Other System…** | The list shows QAS (not DEMO, not LOCAL) |
| J2 | Choose QAS | Logs on to QAS if needed (the browser/password like a normal logon), then the diff tab "↔ QAS active" |
| J3 | Object that only exists in DEV | Message "… does not exist in QAS (not transported yet?)" |
| J4 | After J2, switch to QAS in the system list | QAS is already connected, no new logon |

## K. Report a Problem (new)

| # | Steps | Expected |
|---|---|---|
| K1 | `Ctrl+Shift+P` → **Help: Report a Problem…** | A dialog with title and text. The text contains the version 0.3.0, platform, connection log |
| K2 | Check the text | **No** host names (`<host>`), IP (`<ip>`), user (`<hidden>`), SAProuter route (`/H/<route>`) or passwords |
| K3 | **Copy text** | The clipboard holds the text |
| K4 | **Open GitHub issue** | The browser opens the new issue page of `billaheagle/nusa-adt` with the text filled in (you can still edit or cancel there) |

## L. Features from the previous round that are still unchecked on a live system

| # | Area | Quick steps | Expected |
|---|---|---|---|
| L1 | Quick fix | Type an undeclared variable `lv_new = 1.` → `Ctrl+1` | The proposal "Declare local variable…" from the system, applied |
| L2 | Rename | Cursor on a method → `Alt+Shift+R` | Preview of all changes, after OK every place changes, TR is asked |
| L3 | Extract method | Select a few lines → `Alt+Shift+M` | New method + call, preview first |
| L4 | Debugger | Breakpoint (`Ctrl+Shift+B`) in a report → F8/SAP GUI or wait for any process | Stops at the line, Locals/Globals variables, internal tables show rows, step F5/F6/F7, `Ctrl+R` run to line, double-click a value to change it, click a stack frame |
| L5 | Transport | Transports view: Modifiable/Released tabs, group by category | Matches SE09 |
| L6 | | Edit description, Delete an empty TR | Changes in SE09 |
| L7 | | Tick an object → **Move…** to another TR / **Remove…** | The object moves / disappears from the TR (the object itself stays) |
| L8 | Text elements | Program → **Text Symbols** tab → add `002=Test` → Save → Activate | Shows up in SE38 → Goto → Text Elements |
| L9 | Message class | Open a message class → add a row → Save | Shows up in SE91 |
| L10 | Profiler | Class/report open → `Ctrl+Shift+F9` (or **Trace my next run** then run in SAP GUI) → Refresh | A trace + hit list, click a row → the calling line |
| L11 | F8 report | F8 on a REPORT (on-premise) | SAP GUI opens SE38 and runs the report |

## M. Short regression

| # | Steps | Expected |
|---|---|---|
| M1 | Open, change, Save (`Ctrl+S`) with TR, Activate (`Ctrl+F3`) | As before |
| M2 | Completion `Ctrl+Space`, F2, F3 | As before |
| M3 | Close the app with unsaved changes, reopen | Draft restored + "Show changes" toast |
| M4 | DEMO system | All samples open, Runtime Errors / Version History / Compare can be tried there too |

---

Things that are still **assumptions** (please watch these):
1. The `WB_EXEC` OK code for F8 on a function module in SE37 (G6).
2. The query of the ST22 feed: taken from the system's own feed list (like Eclipse); if the list is empty while ST22 has dumps, report it (H1/H6).
3. Version history: the "versions" link from the object (I1); some releases only write a version on TR release (I3).
4. The FUGR/FUNC creation format follows Eclipse ADT (G1/G3).
