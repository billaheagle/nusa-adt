// Desktop entry: CodeMirror from node_modules, backend talking to real systems through Rust.
import CodeMirror from 'codemirror';
import 'codemirror/addon/mode/simple';
import 'codemirror/addon/hint/show-hint';
import 'codemirror/addon/selection/active-line';
import 'codemirror/addon/edit/matchbrackets';
import './ui/styles.css';
import { AdtBackend } from './backends/adt';
import { TauriConnStore, TauriTransport } from './adt/tauri';
import { startApp } from './ui/app';

(window as unknown as { CodeMirror: unknown }).CodeMirror = CodeMirror;
startApp(new AdtBackend(new TauriTransport(), new TauriConnStore())).catch(err => {
  document.body.textContent = 'Nusa ADT failed to start: ' + String(err?.stack || err);
});
