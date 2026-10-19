import { expect, it } from "vitest";
import { parseConversationHistory } from "./history";

it("imports bounded spoken history only from the requested thread", () => {
  const raw = { conversationId: "chat-1", parentMessageId: "node-2", turns: [
    { id: "m1", text: "Hello", speaker: "user", timestamp: 1 },
    { id: "private", text: "Hidden instructions", speaker: "system", timestamp: 2 },
    { id: "bad", text: "Invalid timestamp", speaker: "assistant", timestamp: Infinity },
  ] };
  expect(parseConversationHistory(raw, "other-chat")).toBeNull();
  expect(parseConversationHistory(raw, "chat-1")).toEqual({ conversation: { conversationId: "chat-1", parentMessageId: "node-2" }, turns: [{ id: "m1", text: "Hello", speaker: "user", timestamp: 1, final: true }] });
});
