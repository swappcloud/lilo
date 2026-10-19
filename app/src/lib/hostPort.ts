import type { BrowserPort } from "./browserPort";
/** Host operations are independent of the shell and its transport. */
export interface HostPort {
  savePreferences?(preferences: { language: string; wakePhrase: string; wakeWord: boolean }): Promise<void>;
  readonly browser?: BrowserPort | null;
  readonly features?: { animations?: boolean; voicePreferences?: boolean };
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

let installed: HostPort | null = null;

/** Only an alternative entry point installs a port; desktop keeps native IPC. */
export function installHostPort(port: HostPort): void {
  if (installed) throw new Error("A host port is already installed.");
  installed = port;
}

export function hostPort(): HostPort | null { return installed; }
