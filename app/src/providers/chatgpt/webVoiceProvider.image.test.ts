import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatGptWebVoiceProvider } from "./webVoiceProvider";
import type { SharedImage } from "../types";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("./gateway", () => ({ uploadVoiceImage: mocks.upload }));
const image: SharedImage = { fileId: "", dataBase64: "fixture-image", name: "screen.jpg", mime: "image/jpeg", size: 3, width: 100, height: 80 };
function connected() {
  const provider = new ChatGptWebVoiceProvider();
  const dc = { readyState: "open", send: vi.fn() };
  Object.assign(provider, { dc, session: "fixture-session" });
  return { provider, dc };
}

describe("ChatGPT screenshot delivery", () => {
  beforeEach(() => { mocks.upload.mockReset(); });
  it("uploads a local image through the active session before relaying its vendor pointer", async () => {
    mocks.upload.mockResolvedValue({ fileId: "file-fixture" });
    const { provider, dc } = connected();
    provider.sendImage(image, "Look at this");
    await vi.waitFor(() => expect(dc.send).toHaveBeenCalledOnce());
    expect(mocks.upload).toHaveBeenCalledWith("fixture-session", "fixture-image", "image/jpeg", "screen.jpg");
    expect(dc.send.mock.calls[0][0]).toContain("file-fixture");
    expect(dc.send.mock.calls[0][0]).not.toContain("fixture-image");
  });
  it("drops an upload that completes after the voice session changes", async () => {
    let finish!: (result: { fileId: string }) => void;
    mocks.upload.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { provider, dc } = connected();
    provider.sendImage(image, "Look at this");
    Object.assign(provider, { session: "next-session" });
    finish({ fileId: "file-fixture" });
    await Promise.resolve(); await Promise.resolve();
    expect(dc.send).not.toHaveBeenCalled();
  });
});
