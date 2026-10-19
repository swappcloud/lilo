/**
 * LILO's face follows the conversation: each caption, as it streams, is read
 * for a mood (`moodCues`) and a match shows briefly — a smile at thanks, a sad
 * look at bad news, surprise at "wow". The user's words get a reaction before
 * the reply starts; the assistant's are LILO's own and keep it going.
 *
 * Only new text is read, word by word as it completes, with a short overlap
 * so a cue split across two updates still matches.
 */
import { moodOf } from "./moodCues";
import { showMood } from "./moodStore";
import { isHiddenTurn, useSessionStore } from "./sessionStore";
import type { TranscriptTurn } from "../types";

/** Characters re-read before the new text, for cues split across updates. */
const OVERLAP = 24;

/** The stretch of `turn` not read yet, up to its last complete word. */
export function unreadText(turn: TranscriptTurn, readUpTo: number): [string, number] {
  const text = turn.text;
  const from = readUpTo > text.length ? 0 : readUpTo;
  const end = turn.final ? text.length : Math.max(from, text.search(/\s\S*$/));
  if (end <= from) return ["", from];
  return [text.slice(Math.max(0, from - OVERLAP), end), end];
}

/** Starts following the active conversation. Returns the cleanup. */
export function watchConversationMood(): () => void {
  let turnId = "";
  let readUpTo = 0;
  return useSessionStore.subscribe((state, previous) => {
    if (state.conversations === previous.conversations) return;
    const turns = state.conversations.find((c) => c.id === state.activeId)?.turns;
    const turn = turns?.[turns.length - 1];
    if (!turn || turn.speaker === "system") return;
    if (turn.id !== turnId) {
      turnId = turn.id;
      readUpTo = 0;
    }
    if (turn.speaker === "user" && isHiddenTurn(turn.text)) return;
    const [text, end] = unreadText(turn, readUpTo);
    readUpTo = end;
    const mood = text && moodOf(text);
    if (mood) showMood(mood, "context");
  });
}
