import { describe, expect, it } from "vitest";
import { conversationIsFull, conversationUpdate } from "./conversation";

describe("ChatGPT durable conversation", () => {
  it("learns the chat id separately from a call and retains the authoritative parent", () => {
    const first = conversationUpdate({ type: "startup_telemetry", conversation_id: "chat-123" });
    expect(first).toEqual({ conversationId: "chat-123" });
    const next = conversationUpdate({ type: "conversation_update", payload: { conversation_id: "chat-123", parent_message_id: "message-2" } }, first);
    expect(next).toEqual({ conversationId: "chat-123", parentMessageId: "message-2" });
    expect(conversationUpdate({ type: "startup_telemetry", conversation_id: "chat-other" }, next)).toEqual({ conversationId: "chat-other" });
    expect(conversationUpdate({ type: "caption", conversation_id: "fake" })).toBeUndefined();
    expect(conversationUpdate({ type: "conversation_update", conversation_id: "../bad" })).toBeUndefined();
  });
  it("recognizes only explicit thread capacity errors", () => {
    expect(conversationIsFull({ type: "error", error: { code: "context_length_exceeded" } })).toBe(true);
    expect(conversationIsFull({ type: "error", payload: { code: "conversation_limit_exceeded" } })).toBe(true);
    for (const code of ["rate_limit_exceeded", "network_error", "unauthorized", "usage_limit_reached"]) {
      expect(conversationIsFull({ type: "error", error: { code } })).toBe(false);
    }
    expect(conversationIsFull({ type: "caption", code: "context_length_exceeded" })).toBe(false);
  });
});
