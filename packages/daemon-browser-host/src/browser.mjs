import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeDiagnostic } from "./diagnostics.mjs";

/** Linux native WebKitGTK adapter, started only for a phone login. */
export class NativeBrowser {
  #child = null;
  #pending = new Map();
  #sequence = 0;
  #failure = null;
  #diagnostic = {};
  constructor(_dataDir, launch = spawn) { this.launch = launch; }
  status() { return { engine: "webkitgtk", running: this.#child !== null, failure: this.#failure, diagnostic: this.#diagnostic }; }
  async start(provider) {
    if (process.platform !== "linux") throw new Error("Native daemon login requires Linux.");
    const child = this.launch("xvfb-run", ["-a", "-s", "-screen 0 430x740x24 -nolisten tcp", "python3", fileURLToPath(new URL("./native_webview.py", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"], detached: true,
      env: { ...process.env, GDK_BACKEND: "x11" },
    });
    this.#child = child;
    this.#failure = null;
    this.#diagnostic = {};
    child.stderr?.on("data", chunk => {
      const text = chunk.toString("utf8");
      // Retain only a known diagnostic category, never the native message.
      if (/bwrap|namespace|Operation not permitted/i.test(text)) this.#failure = "sandbox-unavailable";
      else if (/cannot open display/i.test(text)) this.#failure = "display-unavailable";
      else if (/ImportError|ModuleNotFoundError/i.test(text)) this.#failure = "dependency-unavailable";
      else if (/Traceback/.test(text)) this.#failure ??= "initialization-failed";
    });
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > 768000) { child.kill(); return; }
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.result?.diagnostic) {
            const next = safeDiagnostic(message.result.diagnostic);
            if (JSON.stringify(next) !== JSON.stringify(this.#diagnostic)) console.info(JSON.stringify({ event: "phone-form", ...next }));
            this.#diagnostic = next;
          }
          const pending = this.#pending.get(message.id);
          if (pending) {
            this.#pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) {
              this.#failure = ["TypeError", "AttributeError", "ValueError"].includes(message.kind) ? message.kind : "native-action-failed";
              pending.reject(new Error("Native login action failed."));
            }
            else pending.resolve(message.result);
          }
        } catch { /* Native diagnostics are never returned to the phone. */ }
      }
    });
    const failed = () => {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Native login stopped.")); }
      this.#pending.clear();
    };
    child.on("error", failed);
    child.on("exit", code => { if (this.#child === child && code !== 0) this.#failure ??= "engine-stopped"; failed(); });
    child.stdin.on("error", failed);
    try {
      await this.#request({ action: "start", provider: { id: provider.id, loginUrl: provider.loginUrl, homeUrl: provider.homeUrl, navigationHosts: provider.navigationHosts, phoneForm: provider.phoneForm, capture: provider.capture } });
    } catch (error) { await this.close(); throw error; }
  }
  #request(message) {
    return new Promise((resolve, reject) => {
      if (!this.#child || this.#child.exitCode !== null) return reject(new Error("Native login is closed."));
      const id = ++this.#sequence;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("Native login timed out.")); void this.close(); }, 25000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ ...message, id })}\n`, error => {
        if (error) { clearTimeout(timer); this.#pending.delete(id); reject(new Error("Native login is closed.")); }
      });
    });
  }
  input(message) { return this.#request({ ...message, id: undefined }); }
  snapshot() { return this.#request({ action: "snapshot" }); }
  async close() {
    const child = this.#child;
    this.#child = null;
    if (!child?.pid) return;
    const terminate = signal => { try { process.kill(-child.pid, signal); } catch { /* Process group already stopped. */ } };
    terminate("SIGTERM");
    await new Promise(resolve => {
      const timer = setTimeout(() => { terminate("SIGKILL"); resolve(); }, 1500);
      child.once("exit", () => { clearTimeout(timer); terminate("SIGKILL"); resolve(); });
      if (child.exitCode !== null) { clearTimeout(timer); terminate("SIGKILL"); resolve(); }
    });
  }
}
