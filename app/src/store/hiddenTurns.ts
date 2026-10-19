/**
 * Bookkeeping for the hidden turns LILO sends itself.
 *
 * The persona and the command manifest go to the model as user-role messages
 * so a backend without a system-prompt channel still gets them. Some backends
 * echo that text straight back as a user caption — and the manifest literally
 * lists command names with their descriptions ("end-call (End the live
 * conversation)"), so feeding the echo to the router made LILO hang up on
 * itself the moment it connected.
 *
 * Kept as its own module so the rule is testable without a live session.
 */

/** Lowercase, strip punctuation, collapse whitespace — for comparing echoes. */
export function normalizeHidden(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class HiddenTurns {
  /** Full normalized texts of the hidden turns sent in this session. */
  private readonly sent = new Set<string>();

  remember(text: string): void {
    const key = normalizeHidden(text);
    if (key) this.sent.add(key);
  }

  /**
   * True when a caption is (part of) a hidden turn. Deltas arrive in pieces,
   * so a prefix on either side still belongs to us; an exact match is the last
   * piece and can be forgotten.
   */
  matches(text: string): boolean {
    const key = normalizeHidden(text);
    if (!key) return false;
    for (const candidate of this.sent) {
      if (candidate === key) {
        this.sent.delete(candidate);
        return true;
      }
      if (candidate.startsWith(key) || key.startsWith(candidate)) return true;
    }
    return false;
  }

  clear(): void {
    this.sent.clear();
  }
}