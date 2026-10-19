import { createHash } from "node:crypto";
import { open, seal, ReplayGuard } from "./crypto.mjs";

/** Use cases depend on a browser port and provider declarations, never an engine. */
export class BrowserService {
  #guard = new ReplayGuard();
  #owner = null;
  #expires = 0;
  #provider = null;
  #accountEmail = null;
  constructor(browser, providers, audio) { this.browser = browser; this.providers = providers; this.audio = audio; }
  async exchange(key, envelope) {
    const message = open(key, envelope, "request");
    this.#guard.accept(message);
    const owner = createHash("sha256").update(key).digest("hex");
    let result;
    let stage = "request";
    try {
      if (["audioStatus", "audioTestSpeaker", "audioTestMicrophone"].includes(message.action)) {
        const audio = message.action === "audioStatus" ? await this.audio.status() : message.action === "audioTestSpeaker" ? await this.audio.testSpeaker() : await this.audio.testMicrophone();
        result = { frame: { phase: "audio", audio } };
      } else if (message.action === "start") {
        const provider = this.providers.get(message.provider);
        if (!provider) throw new Error("Provider login is unavailable.");
        if (this.#owner && this.#owner !== owner && Date.now() < this.#expires) throw new Error("Browser is already in use.");
        if (this.browser.mode === "voice") throw new Error("The voice browser is currently in use.");
        await this.browser.close();
        this.#owner = owner;
        this.#provider = provider;
        this.#accountEmail = null;
        this.#expires = Date.now() + 15 * 60000;
        stage = "start";
        await this.browser.start(provider);
      } else {
        if (this.#owner !== owner || Date.now() > this.#expires) throw new Error("Login expired. Start again.");
        if (message.action === "cancel") {
          await this.close();
          return { payload: seal(key, { id: message.id, phase: "closed" }, "response") };
        }
        stage = "input";
        await this.browser.input(message);
      }
      stage = "snapshot";
      result ??= await this.browser.snapshot();
      if (result.account) {
        // A confirmed session is copied to the daemon; the browser is not an idle dependency.
        stage = "capture-cleanup";
        await this.close();
        delete result.frame.image;
      }
      return { payload: seal(key, { id: message.id, ...result.frame }, "response"), account: result.account ?? null };
    } catch (error) {
      const description = typeof error?.message === "string" ? error.message : "";
      const category = /Execution context was destroyed|Cannot find context with specified id/i.test(description) ? "navigation"
        : /Target.*closed|browser.*closed/i.test(description) ? "browser-closed"
        : /timeout/i.test(description) ? "timeout" : "unexpected";
      console.warn(JSON.stringify({ event: "phone-error", stage, category }));
      if (this.#owner === owner) await this.close();
      // Browser/network exceptions can contain URLs or provider secrets.
      return { payload: seal(key, { id: message.id, phase: "error", error: "The browser action failed or the login expired. Retry or start again." }, "response") };
    }
  }
  async forget(provider, email) {
    if (this.#provider?.id === provider && (!this.#accountEmail || this.#accountEmail.toLowerCase() === email.toLowerCase())) await this.close();
  }
  async close() {
    await this.browser.close();
    this.#owner = this.#provider = this.#accountEmail = null;
    this.#expires = 0;
  }
  async expire() { if (this.#owner && Date.now() > this.#expires) await this.close(); }
}
