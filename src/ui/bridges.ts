// What the desktop app adds to the workbench (the prototype runs without these).
import type { Connection } from '../core/types';

/** Updates in the desktop app: the latest release, and installing a signed one in place. */
export interface UpdateInfo { version: string; current: string; notes: string; url: string; installable: boolean }
export interface UpdateBridge { check(): Promise<UpdateInfo | null>; install(): Promise<void> }
/** Things only the desktop app can do. */
export interface ToolsBridge {
  pickFolder(start?: string): Promise<string | null>;
  checkSdk(dir: string): Promise<string>;
  detectSdk(): Promise<string | null>;
  openSapGui(conn: Connection, command: string): Promise<string>;
}

export interface LogonBridge {
  /** opened: the page was opened in the default browser already (setting) */
  listen(cb: (e: { state: 'waiting' | 'done'; url: string; opened?: boolean }) => void): void;
  cancel(): Promise<void>;
  /** opens the logon page in the default browser */
  reopen(): Promise<void>;
  autoOpen(on: boolean): Promise<void>;
}

