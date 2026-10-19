import { describe, expect, it } from "vitest";
import { advanceCaption } from "./captionStream";
import type { ParsedEvent } from "./events";

const caption = (fields: Partial<ParsedEvent>): ParsedEvent => ({
  kind: "caption", speaker: "assistant", text: "", final: false, mode: "replace", raw: null, ...fields,
});

describe("shared voice caption stream", () => {
  it("finalizes the user command before the assistant's next turn", () => {
    const user = advanceCaption(null, caption({ speaker: "user", text: "play music", messageId: "user-1" }));
    const next = advanceCaption(user.partial, caption({ text: "One moment", messageId: "assistant-1" }));
    expect(next.finalized).toMatchObject({ id: "user-1", speaker: "user", text: "play music", final: true });
    expect(next.turn).toMatchObject({ id: "assistant-1", speaker: "assistant", final: false });
  });

  it("keeps role-less chunks on the user's stable turn", () => {
    const user = advanceCaption(null, caption({ speaker: "user", text: "play", messageId: "user-1" }));
    const next = advanceCaption(user.partial, caption({ mode: "append", text: " Bohemian Rhapsody" }));
    expect(next.finalized).toBeNull();
    expect(next.turn).toMatchObject({ id: "user-1", speaker: "user", text: "play Bohemian Rhapsody" });
  });
});
