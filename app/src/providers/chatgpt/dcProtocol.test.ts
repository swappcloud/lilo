import { describe, expect, it } from "vitest";

import {
  buildRelayImage,
  buildRelayMessage,
  buildStopSpeaking,
  wrapDataMessage,
} from "./dcProtocol";

function unwrap(encoded: string): {
  envelope: Record<string, unknown>;
  event: Record<string, unknown>;
} {
  const envelope = JSON.parse(encoded) as Record<string, unknown>;
  return {
    envelope,
    event: JSON.parse(envelope.data as string) as Record<string, unknown>,
  };
}

describe("dcProtocol", () => {
  it("wraps every event in the data_message envelope", () => {
    const { envelope } = unwrap(wrapDataMessage({ type: "whatever" }));
    expect(envelope.type).toBe("data_message");
    expect(typeof envelope.data).toBe("string");
  });

  it("buildStopSpeaking uses the envelope and the correct action", () => {
    const { event } = unwrap(buildStopSpeaking());
    expect(event.type).toBe("action_request");
    expect((event.payload as Record<string, unknown>).action).toBe(
      "stop_speaking",
    );
  });

  it("buildRelayMessage matches the relay_message contract", () => {
    const { event } = unwrap(
      buildRelayMessage("hello", { id: "fixed-id", createTime: 1234.5 }),
    );
    expect(event.type).toBe("relay_message");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.type).toBe("relay_message");
    const message = payload.message as Record<string, unknown>;
    expect(message.id).toBe("fixed-id");
    expect(message.create_time).toBe(1234.5);
    expect((message.author as Record<string, unknown>).role).toBe("user");
    const content = message.content as Record<string, unknown>;
    expect(content.content_type).toBe("text");
    expect(content.parts).toEqual(["hello"]);
    expect(
      (message.clientMetadata as Record<string, unknown>).isOptimistic,
    ).toBe(true);
  });

  it("buildRelayMessage generates an id by default", () => {
    const { event } = unwrap(buildRelayMessage("hi"));
    const message = (event.payload as Record<string, unknown>).message as Record<
      string,
      unknown
    >;
    expect(typeof message.id).toBe("string");
    expect((message.id as string).length).toBeGreaterThan(4);
  });

  it("buildRelayImage is shaped like the web client's image message", () => {
    const image = {
      fileId: "file_123",
      name: "screen.jpg",
      mime: "image/jpeg",
      size: 2048,
      width: 1600,
      height: 900,
    };
    const { event } = unwrap(buildRelayImage(image, "look at this"));
    const payload = event.payload as Record<string, unknown>;
    const message = payload.message as Record<string, unknown>;
    const content = message.content as Record<string, unknown>;
    expect(content.content_type).toBe("multimodal_text");
    const parts = content.parts as unknown[];
    expect(parts[0]).toEqual({
      content_type: "image_asset_pointer",
      asset_pointer: "sediment://file_123",
      size_bytes: 2048,
      width: 1600,
      height: 900,
    });
    // The text is a bare string: an object part makes the server drop it all.
    expect(parts[1]).toBe("look at this");
    const metadata = message.metadata as Record<string, unknown>;
    expect(metadata.attachments).toEqual([
      { id: "file_123", size: 2048, name: "screen.jpg", mimeType: "image/jpeg", width: 1600, height: 900 },
    ]);
  });
});