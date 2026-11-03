// Prototype entry: the workbench running against the in-browser mock system.
import { MockBackend } from './backends/mock';
import { startApp } from './ui/app';

let storage: Storage | null = null;
try { storage = window.localStorage; storage.getItem('probe'); } catch { storage = null; }

startApp(new MockBackend(storage), { prototype: true }).catch(err => {
  document.body.innerHTML = `<pre style="padding:16px;color:#f07178">Nusa ADT failed to start: ${String(err?.stack || err)}</pre>`;
});
