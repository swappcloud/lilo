import { expect, it } from "vitest";
import { mergeConversationHistory } from "./conversationHistory";
import type { TranscriptTurn } from "../types";

it("updates matching upstream messages and retains cross-provider conversation history", () => {
  const turn = (id: string, text: string, timestamp: number): TranscriptTurn => ({ id, text, timestamp, speaker: "user", final: true });
  const result = mergeConversationHistory([turn("chat-1", "partial", 1), turn("other-provider", "continue here", 3)], [turn("chat-1", "full message", 1), turn("chat-2", "remote follow-up", 2)]);
  expect(result.map((entry) => entry.id)).toEqual(["chat-1", "chat-2", "other-provider"]);
  expect(result[0].text).toBe("full message");
});
