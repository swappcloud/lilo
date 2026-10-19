/**
 * Reads the mood of a stretch of conversation from its words.
 *
 * LILO's face reacts to what is said without a model in the loop: a short
 * per-language list of cues (laughter, thanks, condolences, "wow"…) scored
 * per mood. The web voice paths speak whatever text the assistant writes, so
 * asking it for expression markers would have them read out loud; the words
 * themselves are the only signal there is.
 *
 * Cues are compared normalized (lowercase, no accents) and on word
 * boundaries; a negation just before a cue ("not happy", "not sad")
 * cancels it.
 */
import type { MoodKind } from "../types";

/** English, Portuguese, Italian and Spanish, normalized. */
const CUES: Record<MoodKind, readonly string[]> = {
  happy: [
    // en
    "thanks", "thank you", "great", "awesome", "love it", "glad", "happy", "congrats",
    "congratulations", "wonderful", "fantastic", "good news", "nice", "perfect", "lol",
    // pt
    "obrigado", "obrigada", "valeu", "adorei", "amei", "otimo", "otima", "excelente",
    "perfeito", "que bom", "que legal", "parabens", "feliz", "alegre", "boa noticia",
    "maravilha", "maravilhoso",
    // it
    "grazie", "ottimo", "perfetto", "felice", "contento", "fantastico", "bellissimo",
    "che bello", "complimenti", "evviva",
    // es
    "gracias", "genial", "estupendo", "felicidades", "que bien",
  ],
  sad: [
    // en
    "sorry", "unfortunately", "sad", "passed away", "died", "miss you", "lonely", "crying",
    "bad news", "that's a shame",
    // pt
    "sinto muito", "lamento", "infelizmente", "que pena", "triste", "morreu", "faleceu",
    "saudade", "saudades", "sozinho", "sozinha", "chorando", "chorar", "ma noticia",
    // it
    "mi dispiace", "purtroppo", "che peccato", "piangere", "solitudine",
    // es
    "lo siento", "lastima", "desafortunadamente",
  ],
  surprised: [
    // en
    "wow", "whoa", "amazing", "unbelievable", "no way", "oh my", "omg", "incredible",
    // pt
    "uau", "nossa", "caramba", "incrivel", "inacreditavel", "nao acredito", "jura",
    // it
    "davvero", "incredibile", "accidenti", "mamma mia", "caspita", "non ci credo",
    // es
    "increible", "en serio", "no me digas",
  ],
  angry: [
    // en
    "damn", "hate", "angry", "annoying", "furious",
    // pt
    "droga", "odeio", "raiva", "irritado", "irritada", "que saco", "absurdo",
    // it
    "odio", "rabbia", "maledizione", "che palle",
    // es
    "maldita", "que rabia",
  ],
};

const NEGATIONS = new Set(["not", "no", "never", "nao", "nunca", "non", "mai", "nem"]);

/** Laughter in any spelling: "haha", "kkkk", "rsrs", "hehe", "jaja". */
const LAUGHTER = /^(?:(?:ha){2,}h?|(?:he){2,}|(?:ja){2,}|k{3,}|(?:rs){2,})$/;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

const CUE_WORDS: Array<[MoodKind, string[]]> = Object.entries(CUES).flatMap(([kind, cues]) =>
  cues.map((cue) => [kind as MoodKind, cue.split(" ")] as [MoodKind, string[]]),
);

/** The mood `text` reads as, or `null` when it carries none (or a tie). */
export function moodOf(text: string): MoodKind | null {
  const words = normalize(text);
  if (!words.length) return null;
  const score: Record<MoodKind, number> = { happy: 0, sad: 0, surprised: 0, angry: 0 };
  const negated = (at: number) =>
    NEGATIONS.has(words[at - 1] ?? "") || NEGATIONS.has(words[at - 2] ?? "");

  for (let i = 0; i < words.length; i += 1) {
    if (LAUGHTER.test(words[i])) score.happy += 1;
    for (const [kind, cue] of CUE_WORDS) {
      if (cue.every((word, k) => words[i + k] === word) && !negated(i)) score[kind] += 1;
    }
  }

  let best: MoodKind | null = null;
  let top = 0;
  let tie = false;
  for (const kind of Object.keys(score) as MoodKind[]) {
    if (score[kind] > top) {
      best = kind;
      top = score[kind];
      tie = false;
    } else if (score[kind] === top && top > 0) {
      tie = true;
    }
  }
  return tie ? null : best;
}
