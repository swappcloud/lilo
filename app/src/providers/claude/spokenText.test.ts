import { describe, expect, it } from "vitest";

import { spokenPrefix } from "./spokenText";

describe("spokenPrefix", () => {
  const text = "Sure! It's 3 o'clock in Rome.";

  it("covers nothing before the first word", () => {
    expect(spokenPrefix(text, [])).toBe(0);
    expect(spokenPrefix("", ["hi"])).toBe(0);
  });

  it("follows the spoken words, punctuation included", () => {
    expect(text.slice(0, spokenPrefix(text, ["Sure"]))).toBe("Sure!");
    expect(text.slice(0, spokenPrefix(text, ["Sure", "it's"]))).toBe("Sure! It's");
  });

  it("counts a word the voice reads differently as one token", () => {
    expect(text.slice(0, spokenPrefix(text, ["Sure", "it's", "three"]))).toBe("Sure! It's 3");
  });

  it("resyncs when the voice skips a token", () => {
    expect(text.slice(0, spokenPrefix(text, ["Sure", "it's", "in"]))).toBe("Sure! It's 3 o'clock in");
  });

  it("never runs past the text", () => {
    expect(spokenPrefix("Hi there", ["hi", "there", "extra", "words"])).toBe(8);
  });
});
