import { describe, expect, it } from "vitest";

import { findGeneratedImages, findImageProgress, innerPayload, payloadShape } from "./images";

const envelope = (payload: unknown) => JSON.stringify({ type: "data_message", data: JSON.stringify(payload) });

const generated = {
  type: "chat_message_delta",
  conversation_id: "conv-1",
  delta: {
    v: {
      message: {
        author: { role: "tool", name: "image_gen" },
        content: {
          content_type: "multimodal_text",
          parts: [
            {
              content_type: "image_asset_pointer",
              asset_pointer: "sediment://file_00000000abc123",
              width: 1024,
              height: 1536,
              metadata: { dalle: { prompt: "a city of the future at dusk" } },
            },
          ],
        },
      },
    },
  },
};

describe("ChatGPT generated pictures", () => {
  it("reads explicit image percentages from nested events", () => {
    expect(findImageProgress({ type: "image_gen_progress", percentage: 42 })).toBe(42);
    expect(findImageProgress({ message: { author: { role: "tool", name: "image_gen" }, metadata: { progress: { percent: 75 } } } })).toBe(75);
    expect(findImageProgress({ metadata: { image_generation_progress: { progress_percentage: 0 } } })).toBe(0);
  });

  it("does not turn unrelated progress, fractions, text, or invalid numbers into image percentages", () => {
    for (const percentage of [-1, 101, NaN, Infinity, "42"]) {
      expect(findImageProgress({ type: "image_gen_progress", percentage })).toBeNull();
    }
    expect(findImageProgress({ type: "download", percentage: 50 })).toBeNull();
    expect(findImageProgress({ type: "image_gen_progress", progress: 0.5 })).toBeNull();
    expect(findImageProgress({ author: { role: "user", name: "image_gen" }, percentage: 50 })).toBeNull();
    expect(findImageProgress({ type: "image_gen_progress", text: "50%" })).toBeNull();
  });

  it("finds a picture the assistant side made, with its prompt and conversation", () => {
    expect(findGeneratedImages(innerPayload(envelope(generated)))).toEqual([
      {
        fileId: "file_00000000abc123",
        conversationId: "conv-1",
        prompt: "a city of the future at dusk",
        width: 1024,
        height: 1536,
      },
    ]);
  });

  it("ignores pictures the user sent and pointers it cannot trust", () => {
    const fromUser = structuredClone(generated);
    fromUser.delta.v.message.author.role = "user";
    expect(findGeneratedImages(fromUser)).toEqual([]);
    const forged = structuredClone(generated);
    forged.delta.v.message.content.parts[0].asset_pointer = "https://example.com/x.png";
    expect(findGeneratedImages(forged)).toEqual([]);
    expect(innerPayload("not json")).toBeNull();
  });

  it("outlines a payload without its words", () => {
    const shape = payloadShape(generated);
    expect(shape).toBe("chat_message_delta part:image_asset_pointer part:multimodal_text role:tool");
    expect(shape).not.toContain("city");
  });
});
