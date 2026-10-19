import { getMicrophone } from "../../shared/lib/microphone";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { publishAudioFrame } from "../../lib/audioBus";
import { translate } from "../../i18n";
import { ChunkBuffer, PCM_RATE, base64ToPcm16, pcm16ToBase64 } from "../shared/pcmAudio";
import { buildRelayImage, buildRelayMessage, buildStopSpeaking } from "./dcProtocol";
import { parseInbound, type ParsedEvent } from "./events";
import { advanceCaption } from "./captionStream";
import { conversationEvents, conversationIsFull, conversationUpdate } from "./conversation";
import { parseConversationHistory } from "./history";
import { findGeneratedImages, findImageProgress, innerPayload, payloadShape } from "./images";
import {
  type SatelliteInfo,
  createVoiceSession,
  uploadVoiceImage,
  conversationHistory,
  generatedImage,
  onSatelliteAudio,
  onSatelliteInputDone,
  releaseVoiceSession,
  satelliteAudioOut,
  satelliteConfig,
  satelliteFinishOutput,
  satelliteReady,
  satelliteStartInput,
} from "./gateway";
import { log } from "../../lib/log";
import type { TranscriptTurn } from "../../types";
import { BaseProvider, newTurn, turnWithId, type ConnectOptions, type SharedImage } from "../types";

const BARGE_IN_HOLD_MS = 220;
const BARGE_IN_COOLDOWN_MS = 700;
const MAX_RECONNECTS = 3;
const DISCONNECT_GRACE_MS = 5_000;
/** Number of spectrum bins pushed to the visualizer. */
const SPECTRUM_BINS = 48;

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Phase 3 provider: the real, free path.
 *
 * The webview owns the WebRTC media (mic up, assistant voice down). Rust only
 * proxies the SDP offer/answer and binds a `voice_session_id` to the account.
 * The user's ChatGPT access token never enters JavaScript.
 *
 * Reference: https://github.com/dyhhhhhh/chatgpt-web-voice
 */
export class ChatGptWebVoiceProvider extends BaseProvider {
  readonly id = "chatgpt-web" as const;
  readonly label = "ChatGPT Web Voice (free account)";
  override readonly supportsNativeAudio = true;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private levelRaf: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  private options: ConnectOptions | null = null;
  private closing = false;
  private assistantSpeaking = false;
  private partial: TranscriptTurn | null = null;
  private playbackSuppressed = false;
  private micLevel = 0;
  private negotiating = false;
  private attachedStream: MediaStream | null = null;
  private outSource: MediaStreamAudioSourceNode | null = null;
  private optimisticUserText: string | null = null;
  private optimisticUserTurnId: string | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micDeviceId = "";
  /** The sender carrying the microphone; kept so the track can be swapped. */
  private audioSender: RTCRtpSender | null = null;
  /**
   * The satellite seam, when `LILO_SATELLITE_IN`/`LILO_SATELLITE_OUT` asked
   * for it: the microphone becomes a stream this provider owns and feeds, and
   * the assistant's audio is tapped back out to a file. See `satellite.rs`.
   */
  private satellite: SatelliteInfo | null = null;
  private satelliteInputStarted = false;
  /** How many uplink chunks were scheduled, for the test seam's log. */
  private satelliteChunksSent = 0;
  private satelliteUnlisten: UnlistenFn[] = [];
  /** Our own 16 kHz stream, playing whatever `sendAudio` is handed. */
  private synthetic: {
    ctx: AudioContext;
    dest: MediaStreamAudioDestinationNode;
    nextTime: number;
    sources: Set<AudioBufferSourceNode>;
  } | null = null;
  /** The assistant's audio, tapped for the headless side. */
  private satelliteTap: {
    ctx: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  } | null = null;
  /** Texts we injected that should not appear in the transcript. */
  private hiddenTexts = new Set<string>();
  /** Generated pictures already fetched (or being fetched), by file id. */
  private imageFiles = new Set<string>();
  /** Payload outlines already logged, so each shape is named once. */
  private shapes = new Set<string>();
  private speakerDeviceId = "";
  private micHotSince = 0;
  private lastBargeIn = 0;
  private spectrumBuffer = new Uint8Array(0);
  private reconnectAttempts = 0;
  private reconnecting = false;
  /** Texts queued while the data channel is still opening (connect/reconnect). */
  private pendingTexts: Array<{ text: string; options?: { hidden?: boolean } }> = [];

  async connect(options: ConnectOptions): Promise<void> {
    // Guard against a second session (e.g. double click): one peer, one audio
    // output. Reconnects go through `negotiate()` directly.
    if (this.pc && !this.closing) {
      this.options = options;
      return;
    }
    this.options = options;
    this.closing = false;
    this.pendingTexts = [];
    this.playbackSuppressed = false;
    this.session = options.sessionId;
    this.conversation = options.conversation;
    this.micDeviceId = options.micDeviceId ?? "";
    this.speakerDeviceId = options.speakerDeviceId ?? "";
    if (options.bargeIn !== undefined) this.bargeInEnabled = options.bargeIn;
    if (options.bargeInSensitivity !== undefined) {
      this.bargeInSensitivity = options.bargeInSensitivity;
    }
    this.emitState("connecting");
    try {
      if (this.conversation) {
        try {
          const history = parseConversationHistory(await conversationHistory(this.conversation.conversationId), this.conversation.conversationId);
          if (this.closing) return;
          if (history) {
            this.emitConversation(history.conversation);
            this.emitHistory(history.turns);
          }
        } catch {
          if (this.closing) return;
          this.emitCaption(newTurn("system", translate("conversation.syncUnavailable"), true));
        }
      }
      // The headless seam has no microphone at all: the session is driven by
      // audio arriving from somewhere else.
      this.satellite = await satelliteConfig().catch(() => null);
      if (this.satellite) {
        log(
          "session",
          `satellite seam: input=${this.satellite.input} output=${this.satellite.output}`,
        );
      }
      if (!this.satellite?.input) await this.ensureMic();
      await this.negotiate();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /**
   * With the ordinary WebRTC path the microphone track carries audio by
   * itself, so there is nothing to push. In the satellite seam the track is
   * ours: chunks are scheduled onto it here, back to back, the way `PcmAudio`
   * plays what comes out of a socket.
   */
  sendAudio(chunk: ArrayBuffer): void {
    const synthetic = this.synthetic;
    if (!synthetic || chunk.byteLength < 2) return;
    if (this.satelliteChunksSent < 3) {
      this.satelliteChunksSent += 1;
      let peak = 0;
      const probe = new Int16Array(chunk);
      for (let i = 0; i < probe.length; i += 1) peak = Math.max(peak, Math.abs(probe[i]));
      log(
        "session",
        `satellite: chunk ${this.satelliteChunksSent} (${chunk.byteLength} bytes, peak ${peak}, ctx ${synthetic.ctx.state})`,
      );
    }
    const samples = new Int16Array(chunk);
    const buffer = synthetic.ctx.createBuffer(1, samples.length, PCM_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;
    const node = synthetic.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(synthetic.dest);
    const now = synthetic.ctx.currentTime;
    if (synthetic.nextTime < now + 0.02) synthetic.nextTime = now + 0.06;
    node.start(synthetic.nextTime);
    synthetic.nextTime += buffer.duration;
    synthetic.sources.add(node);
    node.onended = () => synthetic.sources.delete(node);
  }

  /** The synthetic microphone, created once and reused across reconnects. */
  private syntheticMic(): MediaStream | null {
    if (this.synthetic) return this.synthetic.dest.stream;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.emitError(new Error("No AudioContext for the satellite seam."));
      return null;
    }
    const ctx = new Ctor({ sampleRate: PCM_RATE });
    void ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    this.synthetic = { ctx, dest, nextTime: 0, sources: new Set() };
    return dest.stream;
  }

  sendText(text: string, options?: { hidden?: boolean }): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.closing) return;
    if (!this.dc || this.dc.readyState !== "open") {
      // A send can race the data channel while it opens (first connect,
      // reconnect). Queue it: the error this used to raise was noise, not a
      // user problem.
      if (this.pendingTexts.length === 0) {
        log("session", "data channel not open yet — holding text until it is");
      }
      if (this.pendingTexts.length < 50) this.pendingTexts.push({ text: trimmed, options });
      return;
    }
    this.dc.send(buildRelayMessage(trimmed));
    const normalized = normalizeText(trimmed);
    // An instruction we inject (e.g. the persona) is not something the user
    // said: send it, but keep it out of the transcript and swallow its echo.
    if (options?.hidden) {
      this.hiddenTexts.add(normalized);
      return;
    }
    // Optimistic user bubble; if the server echoes the same text we replace
    // this turn instead of adding a duplicate.
    const turn = newTurn("user", trimmed, true);
    this.optimisticUserText = normalized;
    this.optimisticUserTurnId = turn.id;
    this.emitCaption(turn);
  }

  interrupt(): void {
    this.stopSpeaking();
  }

  /**
   * Hand the model a picture taken locally (the user's screen). The frame was
   * already uploaded, so only the file id crosses the wire. A screenshot is
   * about *now*: when the channel is not open it is dropped, never queued.
   */
  sendImage(image: SharedImage, text: string): void {
    const dc = this.dc;
    const session = this.session;
    if (this.closing || !dc || dc.readyState !== "open") return;
    const deliver = (fileId: string) => {
      if (this.closing || this.dc !== dc || this.session !== session || dc.readyState !== "open") return;
      if (text.trim()) this.hiddenTexts.add(normalizeText(text.trim()));
      dc.send(buildRelayImage({ ...image, fileId }, text));
    };
    if (image.dataBase64) {
      if (!session) return;
      void uploadVoiceImage(session, image.dataBase64, image.mime, image.name)
        .then(({ fileId }) => deliver(fileId))
        .catch(() => {
          if (!this.closing && this.dc === dc) this.emitError(new Error("Screenshot could not be uploaded to this voice session."));
        });
    } else if (image.fileId) deliver(image.fileId);
  }

  /**
   * Mute by *releasing* the capture device.
   *
   * Disabling a live track sends silence but keeps the microphone open, so the
   * OS still reports it in use and no other app can have it. Stopping the
   * tracks is what actually turns the indicator off; unmuting re-acquires the
   * device and swaps the track back in, with no renegotiation.
   */
  override setMuted(muted: boolean): void {
    super.setMuted(muted);
    if (this.satellite?.input) {
      // Nothing to release: the track is ours, so muting swaps it out.
      const track = muted ? null : (this.synthetic?.dest.stream.getAudioTracks()[0] ?? null);
      if (this.audioSender) void this.audioSender.replaceTrack(track);
      this.emitLevel({ mic: 0, output: this.readLevel(this.outAnalyser) });
      return;
    }
    if (muted) {
      this.releaseMic();
      this.emitLevel({ mic: 0, output: this.readLevel(this.outAnalyser) });
    } else {
      void this.restoreMic();
    }
  }

  private releaseMic(): void {
    if (this.audioSender) void this.audioSender.replaceTrack(null);
    this.micSource?.disconnect();
    this.micSource = null;
    this.micAnalyser = null;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    this.micLevel = 0;
  }

  private async restoreMic(): Promise<void> {
    // No `this.micStream` guard here on purpose: checking it would narrow the
    // property to `null` for the rest of the method, and TypeScript cannot see
    // that `ensureMic()` below fills it. `ensureMic()` is a no-op when a
    // stream already exists, so calling it is the guard.
    if (!this.pc) return;
    try {
      await this.ensureMic();
      const [track] = this.micStream?.getAudioTracks() ?? [];
      if (this.audioSender && track) await this.audioSender.replaceTrack(track);
      this.attachMicAnalyser();
    } catch (error) {
      this.emitError(
        error instanceof Error ? error : new Error("Failed to reopen the microphone"),
      );
    }
  }

  /** Switch microphone live via `replaceTrack` (no session drop). */
  override async setInputDevice(deviceId: string): Promise<void> {
    if (this.satellite?.input) return; // there is no device to switch
    this.micDeviceId = deviceId;
    if (!this.pc || !this.micStream) return; // applies on next connect
    try {
      const stream = await getMicrophone({
        audio: this.audioConstraints(),
        video: false,
      });
      const [track] = stream.getAudioTracks();
      if (this.audioSender && track) await this.audioSender.replaceTrack(track);
      this.micStream.getTracks().forEach((old) => old.stop());
      this.micStream = stream;
      this.attachMicAnalyser();
      // Muted means muted, even across a device change.
      if (this.muted) this.releaseMic();
    } catch (error) {
      this.emitError(
        error instanceof Error ? error : new Error("Failed to switch microphone"),
      );
    }
  }

  /** Route playback to a specific output device when the webview supports it. */
  override async setOutputDevice(deviceId: string): Promise<void> {
    this.speakerDeviceId = deviceId;
    await this.applySinkId();
  }

  private async applySinkId(): Promise<void> {
    const el = this.audioEl as
      | (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (el && typeof el.setSinkId === "function") {
      try {
        await el.setSinkId(this.speakerDeviceId || "");
      } catch {
        /* some platforms reject non-default sinks */
      }
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.pendingTexts = [];
    for (const off of this.satelliteUnlisten) off();
    this.satelliteUnlisten = [];
    if (this.satellite?.output) void satelliteFinishOutput().catch(() => {});
    if (this.satelliteTap) {
      this.satelliteTap.processor.disconnect();
      this.satelliteTap.source.disconnect();
      void this.satelliteTap.ctx.close().catch(() => {});
      this.satelliteTap = null;
    }
    if (this.synthetic) {
      for (const node of this.synthetic.sources) {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      void this.synthetic.ctx.close().catch(() => {});
      this.synthetic = null;
    }
    this.emitState("disconnected");
    this.stopLevelLoop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownPeer();

    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;

    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch {
        /* ignore */
      }
      this.audioCtx = null;
      this.micAnalyser = null;
      this.outAnalyser = null;
    }

    await this.releaseSession();
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.playbackSuppressed = false;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private audioConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (this.micDeviceId) {
      constraints.deviceId = { exact: this.micDeviceId };
    }
    return constraints;
  }

  private async ensureMic(): Promise<void> {
    if (this.micStream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API is unavailable in this webview.");
    }
    this.micStream = await getMicrophone({
      audio: this.audioConstraints(),
      video: false,
    });
  }

  private async negotiate(): Promise<void> {
    // Single-flight: never open a second WebRTC session in parallel — doing so
    // makes the assistant audible twice.
    if (this.negotiating) return;
    this.negotiating = true;
    try {
      await this.negotiateOnce();
    } finally {
      this.negotiating = false;
    }
  }

  private async negotiateOnce(): Promise<void> {
    if (!this.options) throw new Error("connect() was not called");
    if (!this.micStream && !this.satellite?.input) await this.ensureMic();

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
      ],
      bundlePolicy: "max-bundle",
    });
    this.pc = pc;

    const outgoing = this.satellite?.input ? this.syntheticMic() : this.micStream;
    for (const track of outgoing?.getAudioTracks() ?? []) {
      this.audioSender = pc.addTrack(track, outgoing!);
    }

    // Must be a *negotiated* data channel (id 0): that is what the ChatGPT web
    // client uses, and a non-negotiated channel produces an offer/answer whose
    // m-line ordering the webview SDP parser rejects ("Invalid SDP line.").
    const dc = pc.createDataChannel("oai-events", { negotiated: true, id: 0 });
    this.dc = dc;
    dc.onopen = () => this.flushPendingTexts();
    dc.onmessage = (event) => this.handleMessage(event.data);
    dc.onclose = () => {
      if (!this.closing) this.scheduleReconnect("data channel closed");
    };

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] ?? new MediaStream([event.track]);
      this.attachRemoteAudio(stream);
    };
    pc.onconnectionstatechange = () => this.handleConnectionState();

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc);
    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";

    const outcome = await createVoiceSession({
      offerSdp: sdp,
      voice: this.options.settings.voice ?? "cove",
      voiceMode: this.options.settings.voiceMode ?? "wingman",
      languageCode: this.options.languageCode,
      voiceSessionId: this.session,
      conversationId: this.conversation?.conversationId,
      parentMessageId: this.conversation?.parentMessageId,
    });

    this.session = outcome.voiceSessionId;
    if (this.closing) {
      // connect() was superseded or cancelled while the session was being
      // created: release it here, or it stays alive on the server with no
      // client — and set up a peer that keeps answering.
      await this.releaseSession();
      this.teardownPeer();
      return;
    }
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: outcome.answerSdp });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Webview rejected the answer SDP (${message}). ` +
          `source=${outcome.proxySource} answer[0..120]=${outcome.answerSdp.slice(0, 120).replace(/\r?\n/g, "|")}`,
      );
    }

    this.reconnectAttempts = 0;
    this.restorePlayback();
    this.emitState(
      "connected",
      outcome.accountEmail ? `account: ${outcome.accountEmail}` : undefined,
    );
    this.startLevelLoop();
    this.startSatellitePipes();
  }

  /** Wait for ICE gathering to finish (bounded) so the offer carries candidates. */
  private waitForIceGathering(
    pc: RTCPeerConnection,
    timeoutMs = 2500,
  ): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", onChange);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }, timeoutMs);
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private handleConnectionState(): void {
    if (this.closing || !this.pc) return;
    const peer = this.pc;
    const state = peer.connectionState;
    log("chatgpt-web", `peer state: ${state}`);
    if (state === "disconnected") {
      // ICE may recover without replacing the live peer or interrupting its audio.
      if (this.disconnectedTimer === null) {
        this.disconnectedTimer = setTimeout(() => {
          this.disconnectedTimer = null;
          if (!this.closing && this.pc === peer && peer.connectionState === "disconnected") {
            this.scheduleReconnect("connection disconnected");
          }
        }, DISCONNECT_GRACE_MS);
      }
      return;
    }
    this.clearDisconnectedTimer();
    if (state === "failed" || state === "closed") {
      this.scheduleReconnect(`connection ${state}`);
    }
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer !== null) clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
  }

  private scheduleReconnect(reason: string): void {
    if (this.closing || this.reconnecting) return;
    log("chatgpt-web", `reconnect requested: ${reason}`);

    if (this.reconnectAttempts >= MAX_RECONNECTS) {
      this.emitState("error", "connection lost");
      this.emitError(new Error(`Connection lost (${reason}); reconnect attempts exhausted.`));
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.emitState("reconnecting", `attempt ${attempt}/${MAX_RECONNECTS}`);
    this.emitCaption(
      newTurn("system", `Connection lost — reconnecting (${attempt}/${MAX_RECONNECTS})…`, true),
    );

    const backoff = Math.min(4000, 500 * 2 ** (attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stopLevelLoop();
      this.teardownPeer();
      void this.negotiate()
        .then(() => {
          this.reconnecting = false;
          this.emitCaption(newTurn("system", translate("session.reconnected"), true));
        })
        .catch(() => {
          this.reconnecting = false;
          this.scheduleReconnect("retry failed");
        });
    }, backoff);
  }

  private attachRemoteAudio(stream: MediaStream): void {
    // A track that arrives after the provider was torn down belongs to a
    // session nobody owns any more.
    if (this.closing) return;
    // `ontrack` can fire more than once. If we are already playing a live
    // remote stream, ignore the duplicate — attaching a second one makes the
    // assistant audible twice.
    const existingTrack = this.attachedStream?.getAudioTracks()[0];
    if (existingTrack && existingTrack.readyState === "live") {
      return;
    }
    this.attachedStream = stream;

    if (!this.audioEl) {
      const el = new Audio();
      el.autoplay = true;
      this.audioEl = el;
    }
    this.audioEl.srcObject = stream;
    void this.audioEl.play().catch(() => {
      /* autoplay may require a gesture; connect() is user-initiated */
    });
    void this.applySinkId();

    const ctx = this.ensureAudioContext();
    if (ctx) {
      try {
        this.outSource?.disconnect();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        this.outSource = source;
        this.outAnalyser = analyser;
      } catch {
        /* analyser is best-effort */
      }
    }

    if (this.satellite?.output) this.tapAssistantAudio(stream);
  }

  /**
   * Wire the headless seam once a session is up: listen for the phrase chunks
   * Rust sends, and start the feed. Only once per connect — reconnects keep
   * the phrase already sent.
   */
  private startSatellitePipes(): void {
    const satellite = this.satellite;
    if (!satellite) return;
    if (satellite.input && !this.satelliteInputStarted) {
      this.satelliteInputStarted = true;
      // A client may already be sending: tell it the session is listening, and
      // flush whatever it sent while the session was coming up.
      void satelliteReady().catch(() => {});
      void onSatelliteAudio((payload) => {
        this.sendAudio(base64ToPcm16(payload).buffer as ArrayBuffer);
      }).then((off) => this.satelliteUnlisten.push(off));
      void onSatelliteInputDone(() => {
        log("session", "satellite: the phrase was sent");
      }).then((off) => this.satelliteUnlisten.push(off));
      // A connected client feeds its own audio; only the file-driven test asks
      // Rust to read a WAV.
      if (satellite.feed) {
        void satelliteStartInput().catch((error) => this.emitError(error));
      }
    }
  }

  /**
   * Send the assistant's audio out, chunk by chunk. Its own 16 kHz context, so
   * the chunks are exactly the rate the other side expects, and it respects
   * barge-in: what was interrupted must not be sent on as if it were spoken.
   */
  private tapAssistantAudio(stream: MediaStream): void {
    if (this.satelliteTap) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ sampleRate: PCM_RATE });
    try {
      const source = ctx.createMediaStreamSource(stream);
      let tapChunks = 0;
      const chunks = new ChunkBuffer((chunk) => {
        if (this.playbackSuppressed) return;
        tapChunks += 1;
        if (tapChunks % 25 === 0) {
          let peak = 0;
          for (let i = 0; i < chunk.length; i += 1) peak = Math.max(peak, Math.abs(chunk[i]));
          log("session", `satellite: tapped ${tapChunks} chunks, peak ${peak}`);
        }
        void satelliteAudioOut(pcm16ToBase64(chunk)).catch(() => {});
      });
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => chunks.push(event.inputBuffer.getChannelData(0));
      const silence = ctx.createGain();
      silence.gain.value = 0;
      source.connect(processor);
      processor.connect(silence).connect(ctx.destination);
      this.satelliteTap = { ctx, source, processor };
    } catch (error) {
      this.emitError(
        error instanceof Error ? error : new Error("Could not tap the assistant audio"),
      );
    }
  }

  private ensureAudioContext(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.audioCtx = new Ctor();
    this.attachMicAnalyser();
    return this.audioCtx;
  }

  private attachMicAnalyser(): void {
    if (!this.audioCtx || !this.micStream) return;
    try {
      this.micSource?.disconnect();
      const source = this.audioCtx.createMediaStreamSource(this.micStream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.micSource = source;
      this.micAnalyser = analyser;
    } catch {
      this.micAnalyser = null;
    }
  }

  private startLevelLoop(): void {
    this.stopLevelLoop();
    this.ensureAudioContext();

    const tick = () => {
      const mic = this.readLevel(this.micAnalyser);
      const output = this.playbackSuppressed ? 0 : this.readLevel(this.outAnalyser);
      this.micLevel = mic;
      // Feed the visualizer the live spectra (suppressed while muted/barge-in
      // so the animation matches what is actually audible).
      publishAudioFrame({
        mic,
        output,
        spectrum: this.playbackSuppressed
          ? []
          : this.readSpectrum(this.outAnalyser),
        micSpectrum: this.muted ? [] : this.readSpectrum(this.micAnalyser),
      });
      this.emitLevel({ mic, output });
      this.detectBargeIn(mic);
      this.levelRaf = requestAnimationFrame(tick);
    };
    this.levelRaf = requestAnimationFrame(tick);
  }

  private stopLevelLoop(): void {
    if (this.levelRaf !== null) {
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
    }
  }

  private readLevel(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    const buffer = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const value of buffer) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    return Math.min(1, Math.sqrt(sum / buffer.length) * 2);
  }

  /** Coarse normalized spectrum (0..1) for the voice-reactive visualizer. */
  private readSpectrum(analyser: AnalyserNode | null): number[] {
    if (!analyser) return [];
    if (this.spectrumBuffer.length !== analyser.frequencyBinCount) {
      this.spectrumBuffer = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(this.spectrumBuffer);
    const usable = Math.floor(this.spectrumBuffer.length * 0.72);
    const per = Math.max(1, Math.floor(usable / SPECTRUM_BINS));
    const bins: number[] = new Array<number>(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i += 1) {
      let sum = 0;
      for (let j = 0; j < per; j += 1) {
        sum += this.spectrumBuffer[i * per + j] ?? 0;
      }
      bins[i] = Math.min(1, sum / per / 255);
    }
    return bins;
  }

  private detectBargeIn(micLevel: number): void {
    if (!this.bargeInEnabled) return;
    // Speech before the reply is not an interruption of that reply.
    if (!this.assistantSpeaking) {
      this.micHotSince = 0;
      return;
    }
    // Higher sensitivity lowers the trigger threshold.
    const threshold = Math.max(0.02, 0.14 - this.bargeInSensitivity * 0.12);
    const now = performance.now();
    if (micLevel > threshold) {
      if (this.micHotSince === 0) this.micHotSince = now;
    } else {
      this.micHotSince = 0;
    }

    const sustained =
      this.micHotSince !== 0 && now - this.micHotSince > BARGE_IN_HOLD_MS;
    if (
      this.assistantSpeaking &&
      sustained &&
      now - this.lastBargeIn > BARGE_IN_COOLDOWN_MS
    ) {
      this.lastBargeIn = now;
      this.emitCaption(
        newTurn("system", translate("session.bargeIn"), true),
      );
      this.stopSpeaking();
    }
  }

  /** Send `action_request: stop_speaking` and finalize any partial caption. */
  private stopSpeaking(): void {
    if (this.dc?.readyState === "open") {
      // Must use the `data_message` envelope, like every other event.
      this.dc.send(buildStopSpeaking());
    }
    this.assistantSpeaking = false;
    this.finalizeAssistantPartial();
    this.suppressPlayback();
  }

  /**
   * Interrupting only tells the model to stop generating; audio already
   * buffered on the client keeps playing until we mute it. We un-mute as soon
   * as the assistant starts speaking again.
   */
  private suppressPlayback(): void {
    this.playbackSuppressed = true;
    if (this.audioEl) {
      this.audioEl.muted = true;
      // Keep the live stream draining; pausing can clip the next reply's start.
    }
    this.emitLevel({ mic: this.micLevel, output: 0 });
  }

  private restorePlayback(): void {
    if (!this.playbackSuppressed) return;
    this.playbackSuppressed = false;
    if (this.audioEl) {
      this.audioEl.muted = false;
      void this.audioEl.play().catch(() => {
        /* best effort */
      });
    }
  }

  private handleMessage(data: unknown): void {
    const raw = typeof data === "string" ? data : "";
    if (!raw) return;
    if (import.meta.env?.DEV) {
      // Handy when the undocumented event schema drifts.
      console.debug("[oai-events]", raw);
    }
    this.collectImages(raw);
    for (const event of conversationEvents(innerPayload(raw))) {
      const conversation = conversationUpdate(event, this.conversation);
      if (conversation) this.emitConversation(conversation);
      if (conversationIsFull(event)) {
        this.emitConversationLimit();
        return;
      }
    }
    for (const event of parseInbound(raw)) {
      this.applyEvent(event);
    }
  }

  /** A picture the conversation produced: fetch it once and hand it on. */
  private collectImages(raw: string): void {
    const payload = innerPayload(raw);
    const percent = findImageProgress(payload);
    if (percent !== null) this.emitImageProgress(percent);
    const shape = payloadShape(payload);
    if (!this.shapes.has(shape) && this.shapes.size < 64) {
      this.shapes.add(shape);
      log("chatgpt-web", `data channel shape: ${shape}`);
    }
    for (const image of findGeneratedImages(payload)) {
      if (this.imageFiles.has(image.fileId) || this.imageFiles.size > 256) continue;
      this.imageFiles.add(image.fileId);
      log("chatgpt-web", `generated image ${image.fileId} found; downloading`);
      generatedImage(image.fileId, image.conversationId).then(
        ({ mime, data }) => {
          if (this.closing) return;
          this.emitImage({ id: image.fileId, prompt: image.prompt, mime, data, width: image.width, height: image.height });
        },
        (error) => {
          // A later frame may carry the same picture once it is ready.
          this.imageFiles.delete(image.fileId);
          log("chatgpt-web", `generated image ${image.fileId} unavailable: ${String(error)}`);
        },
      );
    }
  }

  private applyEvent(event: ParsedEvent): void {
    if (event.kind === "caption" && (event.speaker === "user" || event.final)) {
      log("caption", `${event.speaker}${event.final ? " final" : ""}: ${event.text}`);
    }
    if (event.kind === "error") {
      this.emitError(new Error(event.text || "Provider reported an error."));
      return;
    }
    if (event.kind === "usage") {
      if (event.text) {
        const seconds = Number(event.text);
        // The number belongs on the chrome, not in the transcript: the UI keeps
        // it visible for the whole session instead of scrolling away.
        if (Number.isFinite(seconds)) this.emitUsage(seconds);
      }
      return;
    }
    if (event.kind === "speaking") {
      this.restorePlayback();
      this.assistantSpeaking = true;
      return;
    }
    if (event.kind === "stopped") {
      this.assistantSpeaking = false;
      this.finalizeAssistantPartial();
      return;
    }
    if (!event.text) return;

    // Dedupe: the server may echo the user's typed message back.
    if (event.speaker === "user" && this.hiddenTexts.size > 0) {
      const echoed = normalizeText(event.text);
      if (this.hiddenTexts.has(echoed)) {
        this.hiddenTexts.delete(echoed);
        return;
      }
    }
    if (event.speaker === "user" && this.optimisticUserText !== null) {
      if (normalizeText(event.text) === this.optimisticUserText) {
        const id = this.optimisticUserTurnId ?? event.messageId;
        this.optimisticUserText = null;
        this.optimisticUserTurnId = null;
        if (id) {
          this.emitCaption(turnWithId(id, "user", event.text, true));
          return;
        }
      }
    }

    const next = advanceCaption(this.partial, event);
    if (next.finalized) this.emitCaption(next.finalized);
    if (next.turn.speaker === "assistant") {
      this.restorePlayback();
      this.assistantSpeaking = !event.final;
    }
    this.partial = next.partial;
    this.emitCaption(next.turn);
  }

  /**
   * Close the assistant's in-progress turn, and only the assistant's.
   *
   * Barge-in fires while the user is talking. Append deltas carry no role, so
   * closing the user's turn here would attribute the rest of their sentence to
   * the assistant, where command matching never looks.
   */
  private finalizeAssistantPartial(): void {
    if (this.partial?.speaker === "assistant") this.finalizePartial();
  }

  private finalizePartial(): void {
    if (this.partial) {
      this.emitCaption({ ...this.partial, final: true });
      this.partial = null;
    }
  }

  /** Release the server-side session, once. */
  private async releaseSession(): Promise<void> {
    if (!this.session) return;
    const session = this.session;
    this.session = undefined;
    try {
      await releaseVoiceSession(session);
    } catch {
      /* best effort */
    }
  }

  private teardownPeer(): void {
    this.clearDisconnectedTimer();
    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onmessage = null;
      this.dc.onclose = null;
      try {
        this.dc.close();
      } catch {
        /* ignore */
      }
      this.dc = null;
    }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.audioSender = null;

    // Stop any audio still coming from the torn-down peer so a reconnect can
    // never double up with the previous session.
    if (this.audioEl) {
      try {
        this.audioEl.pause();
      } catch {
        /* ignore */
      }
      this.audioEl.srcObject = null;
    }
    if (this.outSource) {
      try {
        this.outSource.disconnect();
      } catch {
        /* ignore */
      }
      this.outSource = null;
    }
    this.outAnalyser = null;
    this.attachedStream = null;
  }

  private flushPendingTexts(): void {
    if (!this.dc || this.dc.readyState !== "open" || this.pendingTexts.length === 0) return;
    const queued = this.pendingTexts;
    this.pendingTexts = [];
    for (const item of queued) this.sendText(item.text, item.options);
  }

  private fail(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.emitState("error", err.message);
    this.emitError(err);
  }
}
