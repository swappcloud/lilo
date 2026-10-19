import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedEvent } from "./events";
import type { TranscriptTurn } from "../../types";
import { ChatGptWebVoiceProvider } from "./webVoiceProvider";

/** Drive the private event handler the way the data channel does. */
function harness() {
  const provider = new ChatGptWebVoiceProvider();
  const captions: TranscriptTurn[] = [];
  provider.onCaption((turn) => captions.push(turn));
  const internals = provider as unknown as {
    applyEvent(event: ParsedEvent): void;
    handleMessage(data: unknown): void;
    stopSpeaking(): void;
  };
  const caption = (event: Partial<ParsedEvent>) =>
    internals.applyEvent({
      kind: "caption",
      speaker: "assistant",
      text: "",
      final: false,
      mode: "append",
      raw: null,
      ...event,
    });
  return { captions, caption, internals };
}

describe("barge-in never splits what the user is saying", () => {
  it("keeps appending to the user's turn across a barge-in", () => {
    const { captions, caption, internals } = harness();
    caption({ speaker: "user", text: "okay lilo", mode: "replace", messageId: "u1" });
    internals.stopSpeaking();
    internals.applyEvent({
      kind: "stopped",
      speaker: "assistant",
      text: "",
      final: true,
      mode: "replace",
      raw: null,
    });
    // Append deltas carry no role and no id.
    caption({ text: " play music" });
    caption({ text: " bohemian rhapsody by queen" });

    const user = captions.filter((turn) => turn.speaker === "user");
    const last = user[user.length - 1];
    expect(last.id).toBe("u1");
    expect(last.text).toBe("okay lilo play music bohemian rhapsody by queen");
    expect(captions.some((turn) => turn.speaker === "assistant")).toBe(false);
  });

  it("still closes the assistant's turn when interrupted", () => {
    const { captions, caption, internals } = harness();
    caption({ speaker: "assistant", text: "Sure, what", mode: "replace", messageId: "a1" });
    internals.stopSpeaking();
    const assistant = captions.filter((turn) => turn.id === "a1");
    expect(assistant[assistant.length - 1].final).toBe(true);
  });
});

describe("text sent while the data channel is opening", () => {
  it("queues instead of erroring, then flushes once open", () => {
    const provider = new ChatGptWebVoiceProvider();
    const errors: Error[] = [];
    provider.onError((error) => errors.push(error));
    const sent: string[] = [];
    const internals = provider as unknown as {
      dc: RTCDataChannel | null;
      flushPendingTexts(): void;
    };

    // No channel yet: connect/reconnect races used to surface an error banner.
    provider.sendText("first", { hidden: true });
    expect(errors).toHaveLength(0);

    internals.dc = {
      readyState: "connecting",
      send: (payload: string) => sent.push(payload),
    } as unknown as RTCDataChannel;
    provider.sendText("second", { hidden: true });
    expect(sent).toHaveLength(0);

    (internals.dc as unknown as { readyState: string }).readyState = "open";
    internals.flushPendingTexts();
    expect(sent).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });
});


describe("live data channel captions", () => {
  it("emits each transcript delta immediately under one message id", () => {
    const { captions, internals } = harness();
    const send = (event: unknown) => internals.handleMessage(JSON.stringify({ type: "data_message", data: JSON.stringify(event) }));
    send({ type: "response.audio_transcript.delta", item_id: "a1", delta: "Hello" });
    expect(captions.at(-1)).toMatchObject({ id: "a1", text: "Hello", final: false });
    send({ type: "response.audio_transcript.delta", item_id: "a1", delta: " there 👋." });
    expect(captions.at(-1)).toMatchObject({ id: "a1", text: "Hello there 👋.", final: false });
    send({ type: "response.audio_transcript.done", item_id: "a1", transcript: "Hello there 👋." });
    expect(captions.at(-1)).toMatchObject({ id: "a1", text: "Hello there 👋.", final: true });
  });

  it("emits native web snapshots and append operations without waiting for playback to end", () => {
    const { captions, internals } = harness();
    const send = (delta: unknown) => internals.handleMessage(JSON.stringify({ type: "data_message", data: JSON.stringify({ type: "chat_message_delta", delta }) }));
    send({ v: { message: { id: "a2", author: { role: "assistant" }, content: { parts: [{ content_type: "audio_transcription", direction: "out", text: "Hello" }] } } } });
    expect(captions.at(-1)).toMatchObject({ id: "a2", text: "Hello", final: false });
    send({ v: [{ o: "append", p: "/message/content/parts/0/text", v: " there." }] });
    expect(captions.at(-1)).toMatchObject({ id: "a2", text: "Hello there.", final: false });
  });
});


describe("reply onset and interruption", () => {
  it("does not count the preceding user utterance as barge-in time", () => {
    const provider = new ChatGptWebVoiceProvider();
    const internals = provider as unknown as { assistantSpeaking: boolean; bargeInEnabled: boolean; detectBargeIn(level: number): void; stopSpeaking(): void };
    internals.bargeInEnabled = true;
    const stop = vi.spyOn(internals, "stopSpeaking");
    const clock = vi.spyOn(performance, "now");
    try {
      clock.mockReturnValue(1000);
      internals.detectBargeIn(0.5);
      clock.mockReturnValue(1500);
      internals.assistantSpeaking = true;
      internals.detectBargeIn(0.5);
      expect(stop).not.toHaveBeenCalled();
      clock.mockReturnValue(1600);
      internals.detectBargeIn(0.5);
      expect(stop).not.toHaveBeenCalled();
      clock.mockReturnValue(1721);
      internals.detectBargeIn(0.5);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      stop.mockRestore();
    }
  });

  it("silences interruptions without pausing the live audio stream", () => {
    const { internals } = harness();
    const audio = document.createElement("audio");
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    (internals as unknown as { audioEl: HTMLAudioElement }).audioEl = audio;
    internals.stopSpeaking();
    expect(audio.muted).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    internals.applyEvent({ kind: "speaking", speaker: "assistant", text: "", final: false, mode: "replace", raw: null });
    expect(audio.muted).toBe(false);
    expect(play).toHaveBeenCalledOnce();
  });
});

describe("interrupted playback levels", () => {
  it("keeps measuring the user microphone while suppressing assistant output", () => {
    const provider = new ChatGptWebVoiceProvider();
    const levels: Array<{ mic: number; output: number }> = [];
    provider.onLevel((level) => levels.push(level));
    const mic = {} as AnalyserNode;
    const internals = provider as unknown as {
      playbackSuppressed: boolean;
      micAnalyser: AnalyserNode;
      ensureAudioContext(): void;
      readLevel(analyser: AnalyserNode | null): number;
      readSpectrum(analyser: AnalyserNode | null): number[];
      startLevelLoop(): void;
      stopLevelLoop(): void;
    };
    internals.playbackSuppressed = true;
    internals.micAnalyser = mic;
    const context = vi.spyOn(internals, "ensureAudioContext").mockImplementation(() => {});
    const read = vi.spyOn(internals, "readLevel").mockImplementation((analyser) => analyser === mic ? 0.5 : 0.8);
    const spectrum = vi.spyOn(internals, "readSpectrum").mockReturnValue([]);
    let frame: FrameRequestCallback = () => {};
    const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    try {
      internals.startLevelLoop();
      frame(0);
      expect(levels.at(-1)).toEqual({ mic: 0.5, output: 0 });
    } finally {
      internals.stopLevelLoop();
      context.mockRestore();
      read.mockRestore();
      spectrum.mockRestore();
      raf.mockRestore();
      cancel.mockRestore();
    }
  });
});

describe("temporary WebRTC connection loss", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function connection() {
    const provider = new ChatGptWebVoiceProvider();
    const peer = { connectionState: "disconnected", close: vi.fn() };
    const internals = provider as unknown as {
      pc: RTCPeerConnection;
      handleConnectionState(): void;
      scheduleReconnect(reason: string): void;
    };
    internals.pc = peer as unknown as RTCPeerConnection;
    const reconnect = vi.spyOn(internals, "scheduleReconnect").mockImplementation(() => {});
    return { provider, peer, internals, reconnect };
  }

  it("allows a brief disconnect to recover without restarting the conversation", () => {
    const { peer, internals, reconnect } = connection();
    internals.handleConnectionState();
    vi.advanceTimersByTime(1000);
    peer.connectionState = "connected";
    internals.handleConnectionState();
    vi.advanceTimersByTime(10_000);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("reconnects once after a sustained disconnect, without extending its grace period", () => {
    const { internals, reconnect } = connection();
    internals.handleConnectionState();
    vi.advanceTimersByTime(3000);
    internals.handleConnectionState();
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(reconnect).toHaveBeenCalledExactlyOnceWith("connection disconnected");
  });

  it("does not delay a terminal failure and clears the transient disconnect timer", () => {
    const { peer, internals, reconnect } = connection();
    internals.handleConnectionState();
    peer.connectionState = "failed";
    internals.handleConnectionState();
    expect(reconnect).toHaveBeenCalledExactlyOnceWith("connection failed");
    vi.advanceTimersByTime(10_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("never reconnects after the user ends the conversation", async () => {
    const { provider, internals, reconnect } = connection();
    internals.handleConnectionState();
    await provider.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
