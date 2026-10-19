import type { TranscriptTurn } from "../types";

type Publish = (topic: string, payload: unknown) => Promise<void>;

/** Coalesce caption revisions before handing them to opted-in memory plugins. */
export class ConversationEvents {
  private pending = new Map<string, { turn: TranscriptTurn; at: number; firstSeenAt: number }>();
  private firstSeen = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly publish: Publish,
    private readonly hidden: (text: string) => boolean,
    private readonly reportError: (error: unknown) => void,
  ) {}

  caption(turn: TranscriptTurn): void {
    if (this.closed || turn.speaker === "system" || !turn.text.trim() ||
        turn.text.startsWith("[LILO]") || this.hidden(turn.text)) return;
    const text = turn.text.length > 2_000
      ? turn.text.slice(0, 999) + "…" + turn.text.slice(-1_000)
      : turn.text;
    const at = Date.now();
    const firstSeenAt = this.firstSeen.get(turn.id) ?? at;
    if (!this.firstSeen.has(turn.id)) {
      if (this.firstSeen.size >= 512) {
        const oldest = this.firstSeen.keys().next().value;
        if (oldest !== undefined) this.firstSeen.delete(oldest);
      }
      this.firstSeen.set(turn.id, firstSeenAt);
    }
    this.pending.set(turn.id, { turn: { ...turn, text }, at, firstSeenAt });
    this.timer ??= setTimeout(() => this.flush(), 750);
  }

  private send(topic: string, payload: unknown): void {
    this.queue = this.queue.then(() => this.publish(topic, payload)).catch(this.reportError);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const {turn, at, firstSeenAt} of this.pending.values()) {
      this.send("conversation.turn", { sessionId: this.sessionId, turn, at, firstSeenAt });
    }
    this.pending.clear();
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.closed) return this.queue;
    this.closed = true;
    this.flush();
    this.send("conversation.ended", { sessionId: this.sessionId, at: Date.now() });
    await this.queue;
  }
}
