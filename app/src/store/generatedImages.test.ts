import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  publishEvent: vi.fn(),
  pluginImage: vi.fn(),
  listener: null as null | ((event: { topic: string; source: string; payload: unknown }) => void),
}));
vi.mock("../lib/gateway", () => ({
  isTauri: () => true,
  publishEvent: gateway.publishEvent,
  pluginImage: gateway.pluginImage,
  onImagine: async () => () => {},
  onPluginEvent: async (cb: typeof gateway.listener) => {
    gateway.listener = cb;
    return () => {};
  },
}));
vi.mock("./sessionStore", () => ({ useSessionStore: { getState: () => ({}) } }));

import { SLIDE_MS, startImageRequests, stopSlides } from "./imageRequests";
import { PENDING_MS, SHOWN_MS, receiveGeneratedImage, useGeneratedImageStore } from "./generatedImages";

const picture = { id: "img-1", prompt: "a red fox", mime: "image/png", data: "iVBORw0KGgo=", width: 64, height: 64 };
const stored = (file: string) => ({ file, mime: "image/png" });
const showGallery = (payload: unknown) => gateway.listener?.({ topic: "image.show", source: "com.lilo.gallery", payload });
let stop: (() => void) | undefined;

async function flushImages() {
  // File loading and the Promise.all continuation both run before timers.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("generated pictures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gateway.publishEvent.mockReset().mockResolvedValue(undefined);
    gateway.pluginImage.mockReset().mockImplementation(async (_source, file) => `data:${file}`);
    useGeneratedImageStore.getState().dismiss();
    useGeneratedImageStore.setState({ pending: null, progress: null });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    stopSlides();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows a picture as a thought for a while and hands it to the plugins", () => {
    receiveGeneratedImage(picture, "grok-web");
    expect(useGeneratedImageStore.getState().shown).toEqual({
      id: "img-1",
      prompt: "a red fox",
      src: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(gateway.publishEvent).toHaveBeenCalledWith(
      "image.created",
      expect.objectContaining({ id: "img-1", mime: "image/png", data: picture.data, provider: "grok-web" }),
    );
    vi.advanceTimersByTime(SHOWN_MS);
    expect(useGeneratedImageStore.getState().shown).toBeNull();
  });

  it("drops what is not a supported picture", () => {
    receiveGeneratedImage({ ...picture, mime: "image/svg+xml" }, "grok-web");
    receiveGeneratedImage({ ...picture, data: "\"><script>" }, "grok-web");
    expect(useGeneratedImageStore.getState().shown).toBeNull();
    expect(gateway.publishEvent).not.toHaveBeenCalled();
  });

  it("tracks real progress only for a pending picture and resets it on arrival or timeout", () => {
    const store = useGeneratedImageStore.getState();
    store.reportProgress(42);
    expect(useGeneratedImageStore.getState().progress).toBeNull();
    store.wait("a fox");
    store.reportProgress(42);
    store.reportProgress(20);
    store.reportProgress(101);
    store.reportProgress(NaN);
    expect(useGeneratedImageStore.getState().progress).toBe(42);
    receiveGeneratedImage(picture, "grok-web");
    expect(useGeneratedImageStore.getState().progress).toBeNull();
    store.wait("a whale");
    store.reportProgress(0);
    expect(useGeneratedImageStore.getState().progress).toBe(0);
    vi.advanceTimersByTime(PENDING_MS);
    expect(useGeneratedImageStore.getState().pending).toBeNull();
    expect(useGeneratedImageStore.getState().progress).toBeNull();
  });

  it("shows a stored picture a plugin names, reading it through the host", async () => {
    gateway.pluginImage.mockResolvedValue("data:image/png;base64,AAAA");
    stop = startImageRequests();
    await Promise.resolve();
    gateway.listener?.({ topic: "image.show", source: "com.lilo.gallery", payload: { file: "img/1.b64", mime: "image/png", prompt: "a fox" } });
    await vi.waitFor(() => expect(useGeneratedImageStore.getState().shown?.src).toBe("data:image/png;base64,AAAA"));
    expect(gateway.pluginImage).toHaveBeenCalledWith("com.lilo.gallery", "img/1.b64", "image/png");
    stop();
  });

  it("shows gallery pictures in order and keeps the last one for the usual duration", async () => {
    stop = startImageRequests();
    showGallery({ items: [stored("first"), stored("second"), stored("third")] });
    await flushImages();
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:first");
    await vi.advanceTimersByTimeAsync(SLIDE_MS);
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:second");
    await vi.advanceTimersByTimeAsync(SLIDE_MS);
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:third");
    await vi.advanceTimersByTimeAsync(SHOWN_MS - 1);
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:third");
    await vi.advanceTimersByTimeAsync(1);
    expect(useGeneratedImageStore.getState().shown).toBeNull();
  });

  it("ignores a superseded request whose files finish loading late", async () => {
    let finish!: (src: string) => void;
    gateway.pluginImage.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    stop = startImageRequests();
    showGallery(stored("old"));
    showGallery(stored("new"));
    await flushImages();
    finish("data:old");
    await flushImages();
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:new");
  });

  it("does not show files that finish loading after cleanup", async () => {
    let finish!: (src: string) => void;
    gateway.pluginImage.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    stop = startImageRequests();
    showGallery(stored("late"));
    stop();
    finish("data:late");
    await flushImages();
    expect(useGeneratedImageStore.getState().shown).toBeNull();
  });

  it("stops the slideshow when the user dismisses a picture", async () => {
    stop = startImageRequests();
    showGallery({ items: [stored("first"), stored("second")] });
    await flushImages();
    await vi.advanceTimersByTimeAsync(0);
    useGeneratedImageStore.getState().dismiss();
    await vi.advanceTimersByTimeAsync(SLIDE_MS);
    expect(useGeneratedImageStore.getState().shown).toBeNull();
  });

  it("does not overwrite a newly generated picture with the next slide", async () => {
    stop = startImageRequests();
    showGallery({ items: [stored("first"), stored("second")] });
    await flushImages();
    await vi.advanceTimersByTimeAsync(0);
    receiveGeneratedImage(picture, "grok-web");
    await vi.advanceTimersByTimeAsync(SLIDE_MS);
    expect(useGeneratedImageStore.getState().shown?.id).toBe("img-1");
  });

  it("skips unreadable files and limits the slideshow to eight pictures", async () => {
    gateway.pluginImage.mockRejectedValueOnce(new Error("missing file"));
    stop = startImageRequests();
    showGallery({ items: [null, {}, ...Array.from({ length: 10 }, (_, index) => stored(String(index)))] });
    await flushImages();
    expect(gateway.pluginImage).toHaveBeenCalledTimes(8);
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:1");
    await vi.advanceTimersByTimeAsync(6 * SLIDE_MS);
    expect(useGeneratedImageStore.getState().shown?.src).toBe("data:7");
  });
});
