import { describe, expect, it, vi } from "vitest";

vi.mock("./gateway", () => ({
  claudeVoiceAudio: vi.fn(async () => {}),
  claudeVoiceStart: vi.fn(async () => {}),
  claudeVoiceStop: vi.fn(async () => {}),
  onClaudeVoice: vi.fn(async () => () => {}),
  isTauri: () => false,
}));

import type { ClaudeVoiceEvent } from "./gateway";
import type { ConnectionState, TranscriptTurn } from "../../types";
import { ClaudeWebVoiceProvider } from "./webVoiceProvider";

vi.mock("../shared/pcmAudio", () => ({
  PcmAudio: class {
    async open() {}
    async openMic() {}
    closeMic() {}
    play() {}
    stopPlayback() {}
    levels() {
      return { mic: 0, output: 0 };
    }
    async close() {}
  },
}));

/** Feed engine reports the way the `claude-voice` listener does. */
function harness() {
  const provider = new ClaudeWebVoiceProvider();
  const captions: TranscriptTurn[] = [];
  const states: ConnectionState[] = [];
  const errors: string[] = [];
  provider.onCaption((turn) => captions.push(turn));
  provider.onState((state) => states.push(state));
  provider.onError((error) => errors.push(error.message));
  const internals = provider as unknown as {
    applyEvents(events: ClaudeVoiceEvent[]): void;
    live: boolean;
    audio: unknown;
  };
  // The playback clock, in seconds; a chunk plays as soon as it arrives.
  const playback = { now: 0, end: 0 };
  internals.audio = {
    clock: () => playback.now,
    play: () => playback.now,
    queued: () => Math.max(0, playback.end - playback.now),
    stopPlayback() {},
    levels: () => ({ mic: 0, output: 0 }),
    closeMic() {},
    close: async () => {},
  };
  // 100 ms of 16 kHz PCM16, as base64.
  const audio = () => internals.applyEvents([{ type: "audio", data: "A".repeat(4268) }]);
  const frame = (message: Record<string, unknown>) =>
    internals.applyEvents([{ type: "ws", message }]);
  // The socket double-wraps every SSE event: `{type, data: {...same fields}}`.
  const delta = (text: string) =>
    frame({
      type: "message_sse",
      event: { type: "content_block_delta", data: { delta: { type: "text_delta", text } } },
    });
  const last = (speaker: TranscriptTurn["speaker"]) =>
    captions.filter((turn) => turn.speaker === speaker).at(-1);
  return { provider, captions, states, errors, internals, frame, delta, last, audio, playback };
}

describe("user captions", () => {
  it("replaces the interim transcript instead of appending to it", () => {
    const { captions, frame, last } = harness();
    frame({ type: "transcript_interim", text: "okay lilo", utterance_seq: 1 });
    frame({ type: "transcript_interim", text: "okay lilo play music", utterance_seq: 1 });

    const user = captions.filter((turn) => turn.speaker === "user");
    expect(new Set(user.map((turn) => turn.id)).size).toBe(1);
    expect(last("user")).toMatchObject({ text: "okay lilo play music", final: false });
  });

  it("keeps the turn open across Claude's mid-sentence endpointing", () => {
    const { frame, delta, last } = harness();
    frame({ type: "transcript_interim", text: "play the", utterance_seq: 1 });
    frame({ type: "user_input_end", speech_end_offset_ms: 400 });
    // Half a sentence must never be final: a free-text command would fire
    // with "the" as the song.
    expect(last("user")).toMatchObject({ text: "play the", final: false });

    frame({ type: "transcript_interim", text: "play the song walk by pantera", utterance_seq: 1 });
    frame({ type: "user_input_end", speech_end_offset_ms: 2100 });
    expect(last("user")).toMatchObject({ final: false });

    // The assistant starting to answer does not finalize the turn right
    // away: Claude's own endpointing can be premature, and forcing `final`
    // here would make the router fire a free-text command on whatever
    // partial text had arrived instead of waiting for it to settle.
    delta("Sure.");
    expect(last("user")).toMatchObject({ text: "play the song walk by pantera", final: false });
  });

  it("finalizes the user's turn for display only after the router would already have settled it", () => {
    vi.useFakeTimers();
    try {
      const { frame, delta, last } = harness();
      frame({ type: "transcript_interim", text: "play the song walk by pantera", utterance_seq: 1 });
      delta("Sure.");
      expect(last("user")).toMatchObject({ final: false });
      vi.advanceTimersByTime(2000);
      expect(last("user")).toMatchObject({ text: "play the song walk by pantera", final: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new turn for a new utterance", () => {
    const { captions, frame } = harness();
    frame({ type: "transcript_interim", text: "hello", utterance_seq: 1 });
    frame({ type: "transcript_interim", text: "what time is it", utterance_seq: 2 });
    const user = captions.filter((turn) => turn.speaker === "user");
    expect(user[1]).toMatchObject({ text: "hello", final: true });
    expect(user.at(-1)).toMatchObject({ text: "what time is it", final: false });
    expect(user[0].id).not.toBe(user.at(-1)?.id);
  });
});

describe("assistant captions", () => {
  it("follows the voice word by word and stays open while the audio plays", () => {
    vi.useFakeTimers();
    try {
      const { frame, delta, last, audio, playback } = harness();
      frame({ type: "message_sse", event: { type: "message_start", data: { message: { id: "m1" } } } });
      delta("Sure, ");
      delta("playing now.");
      // The text arrives long before the voice: nothing shows yet.
      vi.advanceTimersByTime(2000);
      expect(last("assistant")).toBeUndefined();

      frame({ type: "playback_start", kind: "reply" });
      audio();
      frame({ type: "tts_word", text: "Sure", pts_ms: 0 });
      frame({ type: "tts_word", text: "playing", pts_ms: 400 });
      frame({ type: "tts_word", text: "now", pts_ms: 800 });
      frame({ type: "message_complete" });
      vi.advanceTimersByTime(100);
      expect(last("assistant")).toMatchObject({ text: "Sure,", final: false });

      playback.now = 0.5;
      vi.advanceTimersByTime(100);
      expect(last("assistant")).toMatchObject({ text: "Sure, playing", final: false });

      playback.now = 1;
      vi.advanceTimersByTime(100);
      expect(last("assistant")).toMatchObject({ text: "Sure, playing now.", final: false });

      frame({ type: "playback_end" });
      expect(last("assistant")).toMatchObject({ id: "claude-a-m1", final: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps following the voice after the server finished streaming it", () => {
    vi.useFakeTimers();
    try {
      const { frame, delta, last, audio, playback } = harness();
      frame({ type: "message_sse", event: { type: "message_start", data: { message: { id: "m1" } } } });
      delta("Sure, playing now.");
      frame({ type: "playback_start", kind: "reply" });
      audio();
      frame({ type: "tts_word", text: "Sure", pts_ms: 0 });
      frame({ type: "tts_word", text: "playing", pts_ms: 400 });
      frame({ type: "tts_word", text: "now", pts_ms: 800 });
      // Every chunk is in and the server says so, with a second still to play.
      playback.end = 1;
      frame({ type: "message_complete" });
      frame({ type: "playback_end" });
      vi.advanceTimersByTime(100);
      expect(last("assistant")).toMatchObject({ text: "Sure,", final: false });

      playback.now = 1;
      vi.advanceTimersByTime(1000);
      expect(last("assistant")).toMatchObject({ text: "Sure, playing now.", final: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows complete Unicode captions as audio starts without word timing", () => {
    vi.useFakeTimers();
    try {
      const { frame, delta, last, audio, playback } = harness();
      delta("Hello 👋 café e\u0301.");
      vi.advanceTimersByTime(100);
      expect(last("assistant")).toBeUndefined();
      frame({ type: "playback_start", kind: "reply" });
      audio();
      vi.advanceTimersByTime(50);
      expect(last("assistant")).toMatchObject({ text: "Hello 👋 café e\u0301.", final: false });
      delta(" Welcome!");
      vi.advanceTimersByTime(50);
      expect(last("assistant")?.text).toBe("Hello 👋 café e\u0301. Welcome!");
      playback.now = 1;
      frame({ type: "playback_end" });
      expect(last("assistant")?.final).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on message_complete when no audio came", () => {
    vi.useFakeTimers();
    try {
      const { frame, delta, last } = harness();
      delta("You've reached your usage limit.");
      vi.advanceTimersByTime(2000);
      frame({ type: "message_complete" });
      // playback_start never arrives for a text-only reply: the grace period
      // runs out and the turn closes on its own.
      vi.advanceTimersByTime(500);
      expect(last("assistant")?.final).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close on message_complete if playback_start follows within the grace period", () => {
    vi.useFakeTimers();
    try {
      const { frame, delta, last } = harness();
      delta("Sure, playing now.");
      vi.advanceTimersByTime(2000);
      frame({ type: "message_complete" });
      frame({ type: "playback_start" });
      vi.advanceTimersByTime(500);
      expect(last("assistant")?.final ?? false).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the turn when the user barges in", () => {
    const { frame, delta, last } = harness();
    delta("Let me tell you");
    frame({ type: "playback_start" });
    frame({ type: "server_interrupt" });
    expect(last("assistant")?.final).toBe(true);
  });
});

describe("connection", () => {
  it("does not start the engine if hang-up happens while the microphone opens", async () => {
    const gateway = await import("./gateway");
    const { PcmAudio } = await import("../shared/pcmAudio");
    vi.mocked(gateway.claudeVoiceStart).mockClear();
    let finish!: () => void;
    const opening = vi.spyOn(PcmAudio.prototype, "open")
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const provider = new ClaudeWebVoiceProvider();
    const connecting = provider.connect({ settings: {} });
    await Promise.resolve();
    await provider.disconnect();
    finish();
    await connecting;
    expect(gateway.claudeVoiceStart).not.toHaveBeenCalled();
    opening.mockRestore();
  });

  it("releases a voice listener that arrives after hang-up", async () => {
    const gateway = await import("./gateway");
    let finish!: (off: () => void) => void;
    vi.mocked(gateway.onClaudeVoice).mockImplementationOnce(() =>
      new Promise((resolve) => { finish = resolve; }));
    vi.mocked(gateway.claudeVoiceStart).mockClear();
    const off = vi.fn();
    const provider = new ClaudeWebVoiceProvider();
    const connecting = provider.connect({ settings: {} });
    await provider.disconnect();
    finish(off);
    await connecting;
    expect(off).toHaveBeenCalledOnce();
    expect(gateway.claudeVoiceStart).not.toHaveBeenCalled();
  });

  it("reports an unexpected close as an error", () => {
    const { internals, states, errors } = harness();
    internals.live = true;
    internals.applyEvents([{ type: "closed", code: 1011 }]);
    expect(states.at(-1)).toBe("error");
    expect(errors[0]).toContain("1011");
  });

  it("fails connect with the engine's message", async () => {
    const gateway = await import("./gateway");
    vi.mocked(gateway.claudeVoiceStart).mockRejectedValueOnce(new Error("conversation create: 403"));
    const { provider, states } = harness();
    await expect(provider.connect({ settings: {} })).rejects.toThrow("403");
    expect(states).toEqual(["connecting", "error"]);
  });
});
