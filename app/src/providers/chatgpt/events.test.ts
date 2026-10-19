import { describe, expect, it } from "vitest";

import { extractRole, extractText, parseDelta, parseInbound } from "./events";

function envelope(event: unknown): string {
  return JSON.stringify({ type: "data_message", data: JSON.stringify(event) });
}

describe("extractText", () => {
  it("reads a top-level delta", () => {
    expect(extractText({ delta: "hello" })).toBe("hello");
  });

  it("reads content.parts arrays", () => {
    expect(extractText({ content: { parts: ["foo", "bar"] } })).toBe("foo\nbar");
  });

  it("descends into payload / message nesting", () => {
    expect(extractText({ payload: { message: { text: "deep" } } })).toBe("deep");
  });

  it("returns empty string when nothing is found", () => {
    expect(extractText({ type: "unknown" })).toBe("");
    expect(extractText(null)).toBe("");
  });
});

describe("extractRole", () => {
  it("reads author.role", () => {
    expect(extractRole({ author: { role: "user" } })).toBe("user");
  });

  it("reads a flat role", () => {
    expect(extractRole({ role: "assistant" })).toBe("assistant");
  });

  it("defaults to assistant", () => {
    expect(extractRole({})).toBe("assistant");
  });
});

describe("parseInbound", () => {
  it("unwraps the data_message envelope (string data)", () => {
    const inner = JSON.stringify({
      type: "chat_message_delta",
      delta: "Hel",
      author: { role: "assistant" },
    });
    const envelope = JSON.stringify({ type: "data_message", data: inner });
    const events = parseInbound(envelope);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("caption");
    expect(events[0].text).toBe("Hel");
    expect(events[0].speaker).toBe("assistant");
  });

  it("handles an object data payload", () => {
    const envelope = JSON.stringify({
      type: "data_message",
      data: { type: "relay_message", message: { role: "user", content: { parts: ["hi"] } } },
    });
    const events = parseInbound(envelope);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("message");
    expect(events[0].speaker).toBe("user");
    expect(events[0].text).toBe("hi");
  });

  it("marks completed events as final", () => {
    const inner = JSON.stringify({ type: "chat_message_completed", delta: "done" });
    const events = parseInbound(JSON.stringify({ type: "data_message", data: inner }));
    expect(events[0].final).toBe(true);
  });

  it("classifies errors", () => {
    const events = parseInbound(JSON.stringify({ type: "error", message: "boom" }));
    expect(events[0].kind).toBe("error");
  });

  it("returns nothing for malformed JSON", () => {
    expect(parseInbound("not json")).toEqual([]);
    expect(parseInbound("42")).toEqual([]);
  });
});

describe("parseDelta (real chat_message_delta shapes)", () => {
  it("reads delta.v.message with author role", () => {
    const parsed = parseDelta({
      v: {
        message: {
          id: "msg-1",
          author: { role: "assistant" },
          content: { parts: ["Hello", " there"] },
        },
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.role).toBe("assistant");
    expect(parsed?.text).toBe("Hello\n there");
    expect(parsed?.messageId).toBe("msg-1");
    expect(parsed?.mode).toBe("replace");
  });

  it("infers the role from an audio_transcription part direction", () => {
    const user = parseDelta({
      v: {
        message: {
          id: "msg-2",
          content: {
            parts: [
              { content_type: "audio_transcription", direction: "in", text: "hi there" },
            ],
          },
        },
      },
    });
    expect(user?.role).toBe("user");
    expect(user?.text).toBe("hi there");

    const assistant = parseDelta({
      v: {
        message: {
          content: {
            parts: [
              { content_type: "audio_transcription", direction: "out", text: "hello" },
            ],
          },
        },
      },
    });
    expect(assistant?.role).toBe("assistant");
  });

  it("handles append operations", () => {
    const parsed = parseDelta({
      v: [
        { o: "append", p: "/message/content/parts/0/text", v: "abc" },
        { o: "append", p: "/message/content/parts/0/text", v: "def" },
        { o: "other", p: "/nope", v: "zzz" },
      ],
    });
    expect(parsed?.mode).toBe("append");
    expect(parsed?.text).toBe("abcdef");
    expect(parsed?.role).toBeUndefined();
  });

  it("returns null for unknown shapes", () => {
    expect(parseDelta("hello")).toBeNull();
    expect(parseDelta(null)).toBeNull();
  });
});

describe("parseInbound — protocol events", () => {
  it("parses a real chat_message_delta caption", () => {
    const events = parseInbound(
      envelope({
        type: "chat_message_delta",
        delta: {
          v: {
            message: {
              id: "m1",
              author: { role: "assistant" },
              content: { parts: [{ text: "Paris" }] },
            },
          },
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("caption");
    expect(events[0].speaker).toBe("assistant");
    expect(events[0].text).toBe("Paris");
    expect(events[0].messageId).toBe("m1");
    expect(events[0].mode).toBe("replace");
  });

  it("maps state_update to speaking/stopped", () => {
    expect(
      parseInbound(envelope({ type: "state_update", payload: { new_state: "speaking" } }))[0]
        .kind,
    ).toBe("speaking");
    expect(
      parseInbound(envelope({ type: "state_update", payload: { new_state: "listening" } }))[0]
        .kind,
    ).toBe("stopped");
  });

  it("extracts the remaining voice budget from usage_update", () => {
    const events = parseInbound(
      envelope({ type: "usage_update", audio_s: 3400 }),
    );
    expect(events[0].kind).toBe("usage");
    expect(events[0].text).toBe("3400");
  });

  it("reads input audio transcription as a user caption", () => {
    const events = parseInbound(
      envelope({ type: "input_audio_transcription", transcript: "what time is it" }),
    );
    expect(events[0].kind).toBe("caption");
    expect(events[0].speaker).toBe("user");
    expect(events[0].text).toBe("what time is it");
  });
});

describe("streaming audio transcript fallback", () => {
  it("keeps transcript fragments partial and preserves their spaces", () => {
    const event = parseInbound(envelope({ type: "response.audio_transcript.delta", delta: " hello ", item_id: "a1" }))[0];
    expect(event).toMatchObject({kind:"caption",speaker:"assistant",text:" hello ",final:false,mode:"append",messageId:"a1"});
  });
  it("replaces the transcript only when its final snapshot arrives", () => {
    const event = parseInbound(envelope({ type: "response.output_audio_transcript.done", transcript: "Hello there.", item_id: "a1" }))[0];
    expect(event).toMatchObject({text:"Hello there.",final:true,mode:"replace",messageId:"a1"});
  });
});
