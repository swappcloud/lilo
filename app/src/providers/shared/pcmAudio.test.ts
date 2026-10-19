import { describe, expect, it, vi } from "vitest";

import { base64ToPcm16, ChunkBuffer, floatToPcm16, pcm16ToBase64, PcmAudio } from "./pcmAudio";

describe("pcm helpers", () => {
  it("round-trips PCM16 through base64", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768]);
    expect(Array.from(base64ToPcm16(pcm16ToBase64(samples)))).toEqual(Array.from(samples));
  });

  it("clamps floats into PCM16", () => {
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2])))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });

  it("emits fixed 40 ms chunks across uneven frames", () => {
    const chunks: number[] = [];
    const buffer = new ChunkBuffer((chunk) => chunks.push(chunk.length));
    buffer.push(new Float32Array(1024));
    buffer.push(new Float32Array(300));
    expect(chunks).toEqual([640, 640]);
  });

  it("supports 20 ms Grok chunks without dropping uneven frame tails", () => {
    const chunks: number[] = [];
    const buffer = new ChunkBuffer((chunk) => chunks.push(chunk.length), 480);
    buffer.push(new Float32Array(1024));
    buffer.push(new Float32Array(416));
    expect(chunks).toEqual([480, 480, 480]);
  });

  it("releases a microphone that finishes opening after capture was cancelled", async () => {
    let resolve!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((done) => { resolve = done; }));
    const node = () => ({ connect: vi.fn().mockReturnThis(), disconnect: vi.fn(), fftSize: 0 });
    vi.stubGlobal("AudioContext", class {
      resume = async () => {};
      close = async () => {};
      createGain = node;
      createAnalyser = node;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const audio = new PcmAudio(() => {});
    try {
      const opening = audio.open();
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
      audio.closeMic();
      resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      await opening;
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await audio.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("provider playback sample rates", () => {
  it("plays the declared output rate independently of the capture rate", () => {
    const createBuffer = vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate, getChannelData: () => new Float32Array(length),
    }));
    const audio = new PcmAudio(() => {}, 16000);
    Object.assign(audio, { context: { currentTime: 0, createBuffer,
      createBufferSource: () => ({ connect: vi.fn(), start: vi.fn() }) }, output: {} });
    audio.play(pcm16ToBase64(new Int16Array([1, 2])), undefined, 24000);
    expect(createBuffer).toHaveBeenCalledWith(1, 2, 24000);
  });
});
