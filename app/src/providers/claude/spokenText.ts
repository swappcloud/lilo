/**
 * Lines Claude's reply text up with the words its TTS has spoken.
 *
 * The SSE text is what the caption shows (punctuation, casing, numbers as
 * written); `tts_word` frames say which words were voiced. The two differ —
 * the voice reads "3" as "three", skips markdown — so each spoken word is
 * looked up a few tokens ahead and, failing that, counts as one token.
 */

/** How far ahead a spoken word may resync onto the text. */
const LOOKAHEAD = 3;

const normalize = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** End offsets of the whitespace-separated tokens of `text`. */
function tokenEnds(text: string): number[] {
  const ends: number[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    ends.push(match.index + match[0].length);
  }
  return ends;
}

/** The length of `text`'s prefix that `spoken` (in order) has covered. */
export function spokenPrefix(text: string, spoken: readonly string[]): number {
  const ends = tokenEnds(text);
  if (!ends.length || !spoken.length) return 0;
  const tokens = ends.map((end, i) => normalize(text.slice(i ? ends[i - 1] : 0, end)));
  let cursor = 0;
  for (const word of spoken) {
    if (cursor >= tokens.length) break;
    const wanted = normalize(word);
    let found = -1;
    for (let j = cursor; wanted && j < Math.min(tokens.length, cursor + LOOKAHEAD + 1); j += 1) {
      if (tokens[j] === wanted) {
        found = j;
        break;
      }
    }
    cursor = found >= 0 ? found + 1 : cursor + 1;
  }
  return cursor ? ends[cursor - 1] : 0;
}
