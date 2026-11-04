// Desktop entry: CodeMirror from node_modules, backend talking to real systems through Rust.
import CodeMirror from 'codemirror';
import 'codemirror/addon/mode/simple';
import 'codemirror/addon/hint/show-hint';
import 'codemirror/addon/selection/active-line';
import 'codemirror/addon/edit/matchbrackets';
import './ui/styles.css';
import { AdtBackend } from './backends/adt';
import { RoutingBackend } from './backends/router';
import { desktopLogon, desktopUpdates, TauriConnStore, TauriTransport } from './adt/tauri';
import { startApp } from './ui/app';

(window as unknown as { CodeMirror: unknown }).CodeMirror = CodeMirror;
let storage: Storage | null = null;
try { storage = window.localStorage; storage.getItem('probe'); } catch { storage = null; }

const backend = RoutingBackend.withDemo(new AdtBackend(new TauriTransport(), new TauriConnStore()), storage);
startApp(backend, { logon: desktopLogon, updates: desktopUpdates }).catch(err => {
  document.body.textContent = 'Nusa Studio failed to start: ' + String(err?.stack || err);
});
