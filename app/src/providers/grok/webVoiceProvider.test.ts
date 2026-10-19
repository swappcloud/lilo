import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptTurn } from "../../types";
import type { GeneratedImage } from "../types";
import type { GrokVoiceEvent } from "./gateway";

const fake = vi.hoisted(() => ({
  events: null as null | ((events: GrokVoiceEvent[]) => void),
  start: vi.fn(), stop: vi.fn(), send: vi.fn(), unlisten: vi.fn(),
  open: vi.fn(), close: vi.fn(), play: vi.fn(), stopPlayback: vi.fn(),
  openMic: vi.fn(), closeMic: vi.fn(), output: vi.fn(),
}));
vi.mock("./gateway", () => ({
  onGrokVoice: async (cb: (events: GrokVoiceEvent[]) => void) => { fake.events = cb; return fake.unlisten; },
  grokVoiceStart: fake.start, grokVoiceStop: fake.stop, grokVoiceSend: fake.send,
}));
vi.mock("../shared/pcmAudio", () => ({
  pcm16ToBase64: () => "AAA=",
  PcmAudio: class {
    open = fake.open; close = fake.close; play = fake.play; stopPlayback = fake.stopPlayback;
    openMic = fake.openMic; closeMic = fake.closeMic; setOutputDevice = fake.output;
    levels = () => ({ mic: 0, output: 0 }); queued = () => 0;
  },
}));
import { GrokWebVoiceProvider } from "./webVoiceProvider";

const frame = (message: Record<string, unknown>) => fake.events?.([{ type: "frame", message }]);
const options = { settings: { voice: "ara" }, languageCode: "pt-BR", instructions: "LILO instructions" };

beforeEach(() => {
  vi.clearAllMocks();
  fake.start.mockResolvedValue("c-1");
  fake.stop.mockResolvedValue(undefined);
  fake.send.mockResolvedValue(undefined);
  fake.open.mockResolvedValue(undefined);
  fake.close.mockResolvedValue(undefined);
  fake.output.mockResolvedValue(undefined);
});

describe("Grok provider", () => {
  it("sends initial context and releases microphone, timers and transport", async () => {
    const provider = new GrokWebVoiceProvider();
    const states: string[] = [];
    provider.onState((state) => states.push(state));
    await provider.connect(options);
    expect(fake.start).toHaveBeenCalledWith({ voice: "ara", language: "pt-BR", instructions: "LILO instructions", conversationId: undefined });
    expect(states).toEqual(["connecting", "connected"]);
    provider.setMuted(true);
    expect(fake.closeMic).toHaveBeenCalled();
    await provider.disconnect();
    expect(fake.close).toHaveBeenCalled();
    expect(fake.stop).toHaveBeenCalled();
    expect(fake.unlisten).toHaveBeenCalled();
    expect(states.at(-1)).toBe("disconnected");
  });

  it("keeps partial user captions open until the server completes them", async () => {
    const provider = new GrokWebVoiceProvider();
    const turns: TranscriptTurn[] = [];
    provider.onCaption((turn) => turns.push(turn));
    await provider.connect(options);
    frame({ type: "conversation.item.input_audio_transcription.updated", item_id: "u-1", transcript: "play" });
    frame({ type: "conversation.item.input_audio_transcription.completed", item_id: "u-1", transcript: "play a song" });
    frame({ type: "conversation.item.input_audio_transcription.updated", item_id: "u-1", transcript: "play" });
    frame({ type: "conversation.item.input_audio_transcription.completed", item_id: "u-1", transcript: "play a song" });
    expect(turns.map((turn) => [turn.text, turn.final])).toEqual([["play", false], ["play a song", true]]);
    expect(turns[0].id).toBe(turns[1].id);
    await provider.disconnect();
  });

  it("accepts the GA realtime event names for audio and captions", async () => {
    const provider = new GrokWebVoiceProvider();
    const turns: TranscriptTurn[] = [];
    provider.onCaption((turn) => turns.push(turn));
    await provider.connect(options);
    frame({ type: "conversation.item.input_audio_transcription.delta", item_id: "u-1", transcript: "hi" });
    frame({ type: "response.created", response: { id: "a-1" } });
    frame({ type: "response.output_audio.delta", delta: "AAA=" });
    frame({ type: "response.output_audio_transcript.delta", delta: "hello" });
    expect(fake.play).toHaveBeenCalledTimes(1);
    expect(turns.map((turn) => [turn.speaker, turn.text])).toEqual([["user", "hi"], ["assistant", "hello"]]);
    await provider.disconnect();
  });

  it("reassembles a generated picture from its parts, in any order", async () => {
    const provider = new GrokWebVoiceProvider();
    const images: GeneratedImage[] = [];
    provider.onImage((image) => images.push(image));
    await provider.connect(options);
    const part = (index: number, data: string) => ({
      type: "image", id: "img-1", part: index, parts: 2, mime: "image/jpeg",
      prompt: "a red fox", width: 1024, height: 768, data,
    });
    fake.events?.([part(1, "BBBB")]);
    expect(images).toHaveLength(0);
    fake.events?.([part(0, "AAAA")]);
    expect(images).toEqual([
      { id: "img-1", prompt: "a red fox", mime: "image/jpeg", data: "AAAABBBB", width: 1024, height: 768 },
    ]);
    // A part outside the declared count is ignored.
    fake.events?.([{ ...part(5, "CCCC"), id: "img-2" }]);
    expect(images).toHaveLength(1);
    await provider.disconnect();
  });

  it("suppresses interrupted audio until a new response starts", async () => {
    const provider = new GrokWebVoiceProvider();
    await provider.connect(options);
    frame({ type: "response.created", response: { id: "a-1" } });
    frame({ type: "response.audio.delta", delta: "AAA=" });
    provider.interrupt();
    frame({ type: "response.audio.delta", delta: "AAA=" });
    expect(fake.play).toHaveBeenCalledTimes(1);
    frame({ type: "response.created", response: { id: "a-2" } });
    frame({ type: "response.audio.delta", delta: "AAA=" });
    expect(fake.play).toHaveBeenCalledTimes(2);
    await provider.disconnect();
  });

  it("does not start transport after cancelling microphone setup", async () => {
    let opened!: () => void;
    fake.open.mockReturnValue(new Promise<void>((resolve) => { opened = resolve; }));
    const provider = new GrokWebVoiceProvider();
    const states: string[] = [];
    provider.onState((state) => states.push(state));
    const connecting = provider.connect(options);
    await Promise.resolve();
    await provider.disconnect();
    opened();
    await connecting;
    expect(fake.start).not.toHaveBeenCalled();
    expect(states).toEqual(["connecting", "disconnected"]);
  });

  it("cleans up refused startup and unexpected socket loss", async () => {
    fake.start.mockRejectedValueOnce(new Error("Voice unavailable"));
    const provider = new GrokWebVoiceProvider();
    const states: string[] = [];
    provider.onState((state) => states.push(state));
    await provider.connect(options);
    expect(states.at(-1)).toBe("error");
    expect(fake.close).toHaveBeenCalled();
    await provider.connect(options);
    fake.events?.([{ type: "closed", code: 1008 }]);
    expect(states.at(-1)).toBe("error");
    await provider.disconnect();
  });
});
