import type { LocalVoiceTranscript } from "../lib/gateway";

const SETTLE_MS = 900;
const MAX_PENDING = 24;
const MAX_RECENT = 96;
const REPEAT_GAP_MS = 1_500;

export function isLocalVoiceTranscript(value: unknown): value is LocalVoiceTranscript {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    typeof item.turnId === "string" &&
    item.turnId.length > 0 &&
    item.turnId.length <= 128 &&
    typeof item.text === "string" &&
    item.text.trim().length > 0 &&
    item.text.length <= 8192 &&
    !item.text.includes("\0") &&
    typeof item.isFinal === "boolean"
  );
}

type Timer = ReturnType<typeof setTimeout>;
interface Pending { transcript: LocalVoiceTranscript; timer: Timer; }
interface Recent { text: string; at: number; routedTurnId: string; }

/** Settles partial local speech and routes each final once. */
export class LocalVoiceController {
  private pending = new Map<string, Pending>();
  private recent = new Map<string, Recent>();
  private sequence = 0;

  constructor(
    private readonly dispatch: (transcript: LocalVoiceTranscript) => void | Promise<void>,
    private readonly canRoute: () => boolean,
    private readonly settleMs = SETTLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  push(value: unknown): boolean {
    if (!isLocalVoiceTranscript(value)) return false;
    if (!this.canRoute()) {
      this.cancel();
      return false;
    }

    const transcript = { ...value, text: value.text.trim() };
    this.pruneRecent();
    const existing = this.pending.get(transcript.turnId);
    if (transcript.isFinal) {
      if (existing) clearTimeout(existing.timer);
      this.pending.delete(transcript.turnId);
      const previous = this.recent.get(transcript.turnId);
      if (previous && previous.text === transcript.text && this.now() - previous.at < REPEAT_GAP_MS) return true;
      this.route(transcript, previous);
      return true;
    }

    if (existing) clearTimeout(existing.timer);
    else if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.entries().next().value as [string, Pending] | undefined;
      if (oldest) {
        clearTimeout(oldest[1].timer);
        this.pending.delete(oldest[0]);
      }
    }
    const timer = setTimeout(() => {
      this.pending.delete(transcript.turnId);
      if (!this.canRoute()) return;
      const settled = { ...transcript, isFinal: true as const };
      this.route(settled, this.recent.get(transcript.turnId));
    }, this.settleMs);
    this.pending.set(transcript.turnId, { transcript, timer });
    return true;
  }

  cancel(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private route(transcript: LocalVoiceTranscript, previous?: Recent): void {
    // Some native recognizers retain one task ID across nearby utterances.
    // Preserve it for a partial/final pair, then mint a fresh router ID when
    // that task starts a later utterance (including the same repeated phrase).
    let routedTurnId = transcript.turnId;
    if (previous && this.now() - previous.at >= REPEAT_GAP_MS) {
      routedTurnId = `${transcript.turnId}:${++this.sequence}`;
    } else if (previous && previous.text !== transcript.text) {
      routedTurnId = `${transcript.turnId}:${++this.sequence}`;
    }
    const routed = { ...transcript, turnId: routedTurnId };
    this.recent.delete(transcript.turnId);
    this.recent.set(transcript.turnId, { text: transcript.text, at: this.now(), routedTurnId });
    while (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value!);
    void this.dispatch(routed);
  }

  private pruneRecent(): void {
    const cutoff = this.now() - 60_000;
    for (const [id, recent] of this.recent) {
      if (recent.at < cutoff) this.recent.delete(id);
    }
  }
}
