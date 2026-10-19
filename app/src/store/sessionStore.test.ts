import { describe, expect, it } from "vitest";

import { assistantTalking } from "./sessionStore";

describe("assistantTalking", () => {
  const connected = { connectionState: "connected", assistantSpeaking: true };

  it("counts recent activity, not just the flag", () => {
    // The flag was raised a moment ago by a caption: still talking.
    expect(assistantTalking(connected, 1_000, 1_500)).toBe(true);
    // The web path often omits the final flag: a stale one is not talking.
    expect(assistantTalking(connected, 1_000, 4_000)).toBe(false);
  });

  it("requires a live session and the flag itself", () => {
    expect(
      assistantTalking({ connectionState: "idle", assistantSpeaking: true }, 1_000, 1_500),
    ).toBe(false);
    expect(
      assistantTalking({ ...connected, assistantSpeaking: false }, 1_000, 1_500),
    ).toBe(false);
  });
});
