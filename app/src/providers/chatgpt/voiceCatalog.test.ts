import { describe, expect, it } from "vitest";

import { CHATGPT_VOICE_MODES, normalizeChatGptVoiceMode } from "./voiceCatalog";

describe("normalizeChatGptVoiceMode", () => {
  it("accepts every allowed mode", () => {
    for (const mode of CHATGPT_VOICE_MODES) {
      expect(normalizeChatGptVoiceMode(mode)).toBe(mode);
    }
  });

  it("coerces legacy/invalid values to wingman", () => {
    // The first UI shipped a "default" option, which upstream rejects.
    expect(normalizeChatGptVoiceMode("default")).toBe("wingman");
    expect(normalizeChatGptVoiceMode("")).toBe("wingman");
    expect(normalizeChatGptVoiceMode("nonsense")).toBe("wingman");
  });
});
