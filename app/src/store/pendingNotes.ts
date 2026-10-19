/**
 * The "[LILO] running …" note, held back for a moment.
 *
 * Every hidden turn is a user message to the model, and the web voice paths
 * answer every user message. A fast command (the weather mood, the volume)
 * used to send its pending note and its result in the same instant: two turns,
 * two replies, and the first one was the model thanking LILO for the note.
 * The note only matters when the result is slow (resolving a track takes
 * seconds), so it goes out only if the result has not arrived by then.
 */
export const PENDING_NOTE_DELAY_MS = 1_200;

export class PendingNotes {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly send: (text: string) => void,
    private readonly delayMs = PENDING_NOTE_DELAY_MS,
  ) {}

  /** Send `text` for `command` later, unless its result comes first. */
  hold(command: string, text: string): void {
    this.settle(command);
    const timer = setTimeout(() => {
      this.timers.delete(command);
      this.send(text);
    }, this.delayMs);
    this.timers.set(command, timer);
  }

  /** The result for `command` arrived: its pending note is no longer needed. */
  settle(command: string): void {
    const timer = this.timers.get(command);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(command);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
