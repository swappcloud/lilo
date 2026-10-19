import { newTurn, BaseProvider, delay } from "../types";
import type { ConnectOptions, ToolRunner } from "../types";

interface MockOptions {
  /** Delay between streamed caption chunks. Lowered in tests. */
  tickMs?: number;
  runTool?: ToolRunner;
}

/**
 * Phase 5 stub provider.
 *
 * Validates the abstraction (and the whole UI) with **zero network calls** and
 * zero account risk. It also demonstrates Phase 6 tool-calling end-to-end:
 * ask about the time or to "search ..." and it invokes the real Rust tools.
 */
export class MockVoiceProvider extends BaseProvider {
  readonly id = "mock" as const;
  readonly label = "Mock (offline demo)";

  private readonly tickMs: number;
  private readonly runTool?: ToolRunner;

  private connected = false;
  private speaking = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private partial: ReturnType<typeof newTurn> | null = null;

  constructor(options: MockOptions = {}) {
    super();
    this.tickMs = options.tickMs ?? 45;
    this.runTool = options.runTool;
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.emitState("connecting");
    await delay(this.tickMs * 4);
    this.connected = true;
    this.session = `vs_mock_${Math.random().toString(36).slice(2, 10)}`;
    this.emitState("connected");
    // The offline mock reports the free-account ballpark so the budget chip is
    // exercised without a real session.
    this.emitUsage(2 * 60 * 60);
    this.speak(
      `Hi! I'm the offline mock voice (voice: ${options.settings.voice ?? "cove"}). ` +
        `Try "what time is it?", "search weather in Lisbon", or type anything.`,
    );
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (!this.connected) return;
    const magnitude = Math.min(1, 0.15 + chunk.byteLength / 40000);
    this.emitLevel({ mic: magnitude, output: this.speaking ? 0.55 : 0 });
  }

  sendText(text: string, options?: { hidden?: boolean }): void {
    if (!this.connected) return;
    // Hidden turns are app instructions (the persona and the command
    // manifest). Showing or answering them would put internal text in the
    // transcript — and the manifest lists command names, which the router
    // would happily execute.
    if (options?.hidden) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    this.interrupt();
    this.emitCaption(newTurn("user", trimmed, true));
    void this.respond(trimmed);
  }

  interrupt(): void {
    if (!this.speaking && this.timers.size === 0) return;
    this.clearTimers();
    if (this.partial) {
      this.emitCaption({ ...this.partial, final: true });
      this.partial = null;
    }
    if (this.speaking) {
      this.speaking = false;
      this.emitLevel({ mic: 0, output: 0 });
      this.emitCaption(newTurn("system", "Interrupted", true));
    }
  }

  async disconnect(): Promise<void> {
    this.clearTimers();
    this.connected = false;
    this.speaking = false;
    this.session = undefined;
    this.emitLevel({ mic: 0, output: 0 });
    this.emitState("disconnected");
    await delay(this.tickMs);
  }

  private async respond(userText: string): Promise<void> {
    const lower = userText.toLowerCase();

    if (/(time|clock|date|day)/.test(lower)) {
      const result = await this.callTool("get_current_time", {
        timezone: "",
      });
      if (result) {
        const t = result as { formatted?: string; timezone?: string };
        this.speak(`Right now it's ${t.formatted} (${t.timezone}).`);
        return;
      }
      this.speak("I couldn't read the clock just now.");
      return;
    }

    const searchMatch = lower.match(/search(?:\s+for)?\s+(.*)/);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      const result = await this.callTool("web_search", { query, max_results: 3 });
      if (Array.isArray(result) && result.length > 0) {
        const top = result[0] as { snippet?: string; title?: string };
        this.speak(`Here's what I found: ${top.snippet ?? top.title ?? "no summary"}`);
        return;
      }
      this.speak("I didn't find anything useful for that search.");
      return;
    }

    this.speak(
      `You said: "${userText}". In the real provider this is where ChatGPT's ` +
        `voice would answer live over WebRTC.`,
    );
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.runTool) return null;
    try {
      return await this.runTool(name, args);
    } catch {
      return null;
    }
  }

  /** Stream a canned reply word-by-word to exercise captions + barge-in. */
  private speak(message: string): void {
    this.interrupt();
    this.speaking = true;
    this.partial = newTurn("assistant", "", false);
    const words = message.split(/(\s+)/);

    const step = (index: number) => {
      if (!this.speaking || !this.partial) return;
      const next = words[index] ?? "";
      this.partial = { ...this.partial, text: this.partial.text + next, final: false };
      this.emitCaption(this.partial);
      this.emitLevel({
        mic: 0,
        output: Math.min(1, 0.25 + (index / Math.max(1, words.length)) * 0.7),
      });

      if (index + 1 >= words.length) {
        this.emitCaption({ ...this.partial, final: true });
        this.partial = null;
        this.speaking = false;
        this.emitLevel({ mic: 0, output: 0 });
        return;
      }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        step(index + 1);
      }, this.tickMs);
      this.timers.add(timer);
    };

    step(0);
  }

  private clearTimers(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }
}