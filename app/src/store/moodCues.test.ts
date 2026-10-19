import { describe, expect, it } from "vitest";

import { moodOf } from "./moodCues";

describe("moodOf", () => {
  it("reads each mood in every app language", () => {
    expect(moodOf("Obrigado, adorei!")).toBe("happy");
    expect(moodOf("Thanks, that's great")).toBe("happy");
    expect(moodOf("Sinto muito pela sua perda.")).toBe("sad");
    expect(moodOf("Mi dispiace, purtroppo è chiuso.")).toBe("sad");
    expect(moodOf("Uau, não acredito!")).toBe("surprised");
    expect(moodOf("Odeio segunda-feira")).toBe("angry");
  });

  it("hears laughter in any spelling", () => {
    expect(moodOf("hahaha")).toBe("happy");
    expect(moodOf("kkkkk")).toBe("happy");
    expect(moodOf("rsrs")).toBe("happy");
  });

  it("matches whole words, accents aside", () => {
    expect(moodOf("Parabéns")).toBe("happy");
    expect(moodOf("Incrível")).toBe("surprised");
    expect(moodOf("the showroom is closed")).toBeNull();
  });

  it("lets a negation cancel the cue", () => {
    expect(moodOf("I am not happy")).toBeNull();
    expect(moodOf("Não estou triste")).toBeNull();
  });

  it("stays neutral without cues or on a tie", () => {
    expect(moodOf("What time is it in Rome?")).toBeNull();
    expect(moodOf("")).toBeNull();
    expect(moodOf("wow, sorry")).toBeNull();
  });
});
