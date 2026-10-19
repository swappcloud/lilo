import type { UnlistenFn } from "@tauri-apps/api/event";

import { publishAudioFrame } from "../../lib/audioBus";
import {
  claudeVoiceAudio,
  claudeVoiceStart,
  claudeVoiceStop,
  onClaudeVoice,
  type ClaudeVoiceEvent,
} from "./gateway";
import { log } from "../../lib/log";
import type { TranscriptTurn } from "../../types";
import {
  DEFAULT_CLAUDE_MODEL,
  claudeLanguage,
  normalizeClaudeSpeed,
  resolveClaudeVoice,
} from "./voiceCatalog";
import { PcmAudio } from "../shared/pcmAudio";
import { spokenPrefix } from "./spokenText";
import { BaseProvider, newTurn, turnWithId, type ConnectOptions } from "../types";

/** One `ws` report's payload: a JSON frame from the claude.ai voice socket. */
interface VoiceFrame {
  type?: string;
  [key: string]: unknown;
}

/**
 * Claude's SSE delivers a reply's whole text within milliseconds, well ahead
 * of the voice. The caption follows the voice instead, like ChatGPT's: each
 * `tts_word` frame names a word and when it plays (`pts_ms`, into the turn's
 * audio), and the bubble shows the text up to the last word already heard.
 */
const CAPTION_TICK_MS = 50;

/**
 * `message_complete` (the text is done) can arrive a beat before
 * `playback_start` (the audio actually begins) — closing the turn on that
 * race would end the bubble before Claude starts speaking. This grace period
 * gives `playback_start` a chance to arrive before assuming there is no audio
 * for this turn at all (e.g. a text-only limit/error message).
 */
const PLAYBACK_GRACE_MS = 400;

/**
 * Claude's own endpointing is trigger-happy: it can decide the user's turn is
 * over — and start the reply — mid-sentence, well before `SLOT_SETTLE_MS`
 * (see `router.rs`) would naturally consider the caption settled. Marking
 * the user's turn `final` right then skips that debounce and fires a
 * free-text command (e.g. "play <song>") on a truncated slot. This keeps the
 * turn open for slightly longer than the router's own settle window, so a
 * command already waits on the real text before this closes it for display.
 */
const USER_TURN_CLOSE_MS = 1_200;

/**
 * Claude voice mode over the user's claude.ai web session.
 *
 * The socket lives in the hidden claude.ai window (see
 * `src-tauri/assets/claude-voice-engine.js`); Rust relays its reports as
 * `claude-voice` batches. The microphone and playback live here, because
 * WebKit holds capture back in a page nobody can see: mic PCM goes out through
 * `claude_voice_audio`, the assistant's PCM comes back as `audio` reports.
 * The protocol is in `docs/claude-voice-protocol.md`.
 */
export class ClaudeWebVoiceProvider extends BaseProvider {
  readonly id = "claude-web" as const;
  readonly label = "Claude Voice (web session)";
  override readonly supportsNativeAudio = true;

  private unlisten: UnlistenFn | null = null;
  private live = false;
  private closing = false;
  /** Distinguishes this session's turn ids from a previous session's. */
  private run = "";
  private userTurn: TranscriptTurn | null = null;
  private assistantTurn: TranscriptTurn | null = null;
  /** Whether the assistant turn's audio started, so its end closes the turn. */
  private assistantPlaying = false;
  private audio: PcmAudio | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private micDeviceId = "";
  /** Set when LILO cuts the assistant off: that turn's remaining audio is dropped. */
  private playbackSuppressed = false;
  /** The assistant turn's whole text so far; the caption shows a prefix. */
  private replyText = "";
  private captionTimer: ReturnType<typeof setInterval> | null = null;
  /** Playback-clock time the turn's first audio chunk starts, in seconds. */
  private turnAudioStart: number | null = null;
  /** Audio received for the turn, in ms — calibrates `pts_ms`. */
  private turnAudioMs = 0;
  /** The turn's spoken words, `at` in ms from its audio start. */
  private words: { text: string; at: number }[] = [];
  /** Subtracted from `pts_ms` when it is not counted from the turn's start. */
  private ptsBase: number | null = null;
  private lastPts = 0;
  private ptsOffset = 0;
  /** Waiting to see if `playback_start` still arrives — see `PLAYBACK_GRACE_MS`. */
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Delayed close of the user's turn — see `USER_TURN_CLOSE_MS`. */
  private userTurnCloseTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(options: ConnectOptions): Promise<void> {
    if (this.unlisten && !this.closing) return;
    this.closing = false;
    this.live = false;
    this.run = Date.now().toString(36);
    this.userTurn = null;
    this.assistantTurn = null;
    this.assistantPlaying = false;
    this.playbackSuppressed = false;
    this.micDeviceId = options.micDeviceId ?? "";
    this.emitState("connecting");

    // Subscribe first: the start call resolves only after the engine's first
    // reports were already delivered.
    const unlisten = await onClaudeVoice((events) => this.applyEvents(events));
    if (this.closing) {
      unlisten();
      return;
    }
    this.unlisten = unlisten;
    try {
      // The microphone first: a denied permission should fail before a
      // conversation is created upstream.
      const audio = new PcmAudio((chunk) => {
        if (this.live && !this.muted) void claudeVoiceAudio(chunk).catch(() => {});
      });
      this.audio = audio;
      await audio.open(this.micDeviceId || undefined);
      if (this.closing) {
        await audio.close();
        return;
      }
      if (this.muted) audio.closeMic();
      const conversationId = await claudeVoiceStart({
        voice: resolveClaudeVoice(options.settings.voice?.trim(), options.languageCode),
        model: options.settings.model || DEFAULT_CLAUDE_MODEL,
        language: claudeLanguage(options.languageCode),
        locale: options.languageCode,
        speed: normalizeClaudeSpeed(options.settings.speed),
        instructions: options.instructions?.trim() || undefined,
        conversationId: options.conversation?.conversationId ?? options.sessionId,
      });
      // Remembered as the session id: a reconnect (wake word, dropped
      // socket) resumes this same claude.ai conversation instead of
      // leaving a fresh one in the user's history every time.
      if (conversationId) {
        this.session = conversationId;
        this.emitConversation({ conversationId });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.release();
      await this.closeAudio();
      // Stopped while connecting: that is the user's choice, not a failure.
      if (this.closing) return;
      this.emitState("error", err.message);
      this.emitError(err);
      throw err;
    }
    if (this.closing) return;
    this.live = true;
    this.startLevels();
    this.emitState("connected");
  }

  /** Capture runs in `PcmAudio`; nothing is pushed from outside. */
  sendAudio(_chunk: ArrayBuffer): void {}

  /** The voice socket has no client text message (see the protocol notes). */
  sendText(_text: string, _options?: { hidden?: boolean }): void {
    log("claude-voice", "sendText ignored: no text channel on the voice socket");
  }

  interrupt(): void {
    this.playbackSuppressed = true;
    this.audio?.stopPlayback();
    this.closeAssistantTurn();
  }

  /** Mute releases the device, so the OS microphone indicator goes off. */
  override setMuted(muted: boolean): void {
    super.setMuted(muted);
    if (!this.audio) return;
    if (muted) {
      this.audio.closeMic();
    } else {
      void this.audio.openMic(this.micDeviceId || undefined).catch((error) => {
        this.emitError(error instanceof Error ? error : new Error("Failed to reopen the microphone"));
      });
    }
  }

  override async setInputDevice(deviceId: string): Promise<void> {
    this.micDeviceId = deviceId;
    if (!this.audio || this.muted) return;
    this.audio.closeMic();
    await this.audio.openMic(deviceId || undefined).catch((error) => {
      this.emitError(error instanceof Error ? error : new Error("Failed to switch microphone"));
    });
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.live = false;
    this.closeUserTurn();
    this.closeAssistantTurn();
    this.release();
    await claudeVoiceStop().catch(() => {});
    await this.closeAudio();
    this.emitState("disconnected");
  }

  private startLevels(): void {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => {
      if (!this.audio) return;
      const levels = this.audio.levels();
      const mic = this.muted ? 0 : levels.mic;
      publishAudioFrame({ mic, output: levels.output, spectrum: [], micSpectrum: [] });
      this.emitLevel({ mic, output: levels.output });
    }, 50);
  }

  private async closeAudio(): Promise<void> {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    const audio = this.audio;
    this.audio = null;
    await audio?.close();
  }

  private release(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  // --- engine reports ------------------------------------------------------

  private applyEvents(events: ClaudeVoiceEvent[]): void {
    for (const event of events) this.applyEvent(event);
  }

  private applyEvent(event: ClaudeVoiceEvent): void {
    switch (event.type) {
      case "audio":
        if (!this.playbackSuppressed && typeof event.data === "string") {
          const startsAt = this.audio?.play(event.data) ?? null;
          if (startsAt !== null && this.assistantTurn) {
            this.turnAudioStart ??= startsAt;
            // PCM16 at 16 kHz: 32 bytes per ms (base64 is 4 chars per 3 bytes).
            this.turnAudioMs += (event.data.length * 3) / 4 / 32;
          }
        }
        return;
      case "warning":
        log("claude-voice", `warning: ${String(event.message ?? "")}`);
        return;
      case "stage":
        log("claude-voice", `engine stage: ${String(event.stage ?? "")}`);
        return;
      case "ws":
        this.applyFrame((event.message ?? {}) as VoiceFrame);
        return;
      case "ready":
        log("claude-voice", `ready conversation=${String(event.conversationId ?? "")}`);
        return;
      case "closed":
        this.onClosed(Number(event.code));
        return;
      case "error":
        this.onEngineError(String(event.message ?? "Claude voice failed"));
        return;
      default:
        return;
    }
  }

  private applyFrame(frame: VoiceFrame): void {
    switch (frame.type) {
      case "transcript_interim":
        this.userCaption(String(frame.text ?? ""), frame.utterance_seq);
        return;
      case "user_input_end":
        // Not the end of what the user is saying: Claude's endpointing fires
        // mid-sentence and more than once per phrase. Closing the turn here
        // marked "play the" as final, and a free-text command fired with a
        // one-word slot. The turn closes when a new utterance starts, when the
        // assistant answers, or when the session ends.
        return;
      case "message_sse":
        this.applySse((frame.event ?? {}) as VoiceFrame);
        return;
      case "playback_start":
        this.assistantPlaying = true;
        this.playbackSuppressed = false;
        this.clearCloseGrace();
        return;
      case "tts_word":
        this.onWord(String(frame.text ?? ""), Number(frame.pts_ms));
        return;
      case "playback_end":
        // Sent once the server has streamed the turn's audio, which outruns
        // real time: the caption keeps following until it has been heard.
        this.assistantPlaying = false;
        this.finishAssistantTurn();
        return;
      case "message_complete":
        // Captions arrive faster than speech: the turn stays open while its
        // audio plays, unless there was none. `playback_start` can still be a
        // beat behind this event, so give it `PLAYBACK_GRACE_MS` to show up
        // before assuming this turn has no audio at all.
        if (!this.assistantPlaying) this.scheduleClose();
        return;
      case "server_interrupt":
        this.audio?.stopPlayback();
        this.assistantPlaying = false;
        this.closeAssistantTurn();
        return;
      case "error":
        log("claude-voice", `server error frame: ${JSON.stringify(frame)}`);
        return;
      default:
        return;
    }
  }

  private applySse(event: VoiceFrame): void {
    // Every SSE event on this endpoint is double-wrapped: `{type, data: {...
    // same fields}}`, unlike the plain Anthropic Messages API shape the rest
    // of this method's field names come from.
    const data = (event.data ?? {}) as VoiceFrame;
    if (event.type === "message_start") {
      this.closeAssistantTurn();
      const message = (data.message ?? {}) as VoiceFrame;
      const id =
        typeof message.id === "string" && message.id
          ? `claude-a-${message.id}`
          : newTurn("assistant", "", false).id;
      this.assistantTurn = turnWithId(id, "assistant");
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = (data.delta ?? {}) as VoiceFrame;
      if (delta.type !== "text_delta" || typeof delta.text !== "string") return;
      // The assistant answering usually means the user is done talking, but
      // Claude's own endpointing can start a reply mid-sentence — closing the
      // turn (and its `final: true`) right now would make the router fire a
      // free-text command on whatever partial text had arrived. Let the
      // router's own settle debounce have the first say; this only finalizes
      // the caption for display, after that debounce would already have run.
      this.scheduleUserTurnClose();
      if (!this.assistantTurn) this.assistantTurn = newTurn("assistant", "", false);
      this.replyText += delta.text;
      if (!this.captionTimer) {
        this.captionTimer = setInterval(() => this.tickCaption(), CAPTION_TICK_MS);
      }
    }
  }

  private scheduleUserTurnClose(): void {
    if (this.userTurnCloseTimer || !this.userTurn) return;
    this.userTurnCloseTimer = setTimeout(() => {
      this.userTurnCloseTimer = null;
      this.closeUserTurn();
    }, USER_TURN_CLOSE_MS);
  }

  private clearUserTurnClose(): void {
    if (this.userTurnCloseTimer) clearTimeout(this.userTurnCloseTimer);
    this.userTurnCloseTimer = null;
  }

  /**
   * `pts_ms` is taken as counted from the turn's first audio. Should it turn
   * out to run on a longer clock (it starts past all audio received so far),
   * the first word becomes the zero; should it restart mid-turn (per
   * segment), it is carried on from the last word.
   */
  private onWord(text: string, pts: number): void {
    if (!this.assistantTurn || !text || !Number.isFinite(pts)) return;
    if (this.ptsBase === null) this.ptsBase = pts > this.turnAudioMs + 1_000 ? pts : 0;
    if (pts < this.lastPts) this.ptsOffset += this.lastPts - pts;
    this.lastPts = pts;
    this.words.push({ text, at: pts - this.ptsBase + this.ptsOffset });
  }

  /** Grows the caption to what has been heard (see `CAPTION_TICK_MS`). */
  private tickCaption(): void {
    const turn = this.assistantTurn;
    if (!turn) {
      this.stopCaption();
      return;
    }
    // Nothing shows before the voice does.
    if (this.turnAudioStart === null || !this.audio) return;
    const elapsed = (this.audio.clock() - this.turnAudioStart) * 1000;
    if (elapsed < 0) return;
    let shown = turn.text.length;
    if (this.words.length) {
      const heard = this.words.filter((w) => w.at <= elapsed).map((w) => w.text);
      shown = Math.max(shown, spokenPrefix(this.replyText, heard));
    } else {
      // Missing timestamps must not delay captions or split Unicode characters.
      shown = this.replyText.length;
    }
    shown = Math.min(shown, this.replyText.length);
    if (shown <= turn.text.length) return;
    this.assistantTurn = { ...turn, text: this.replyText.slice(0, shown), final: false };
    this.emitCaption(this.assistantTurn);
  }

  private stopCaption(): void {
    if (this.captionTimer) clearInterval(this.captionTimer);
    this.captionTimer = null;
  }

  private scheduleClose(): void {
    this.clearCloseGrace();
    this.closeGraceTimer = setTimeout(() => {
      this.closeGraceTimer = null;
      if (!this.assistantPlaying) this.finishAssistantTurn();
    }, PLAYBACK_GRACE_MS);
  }

  /** Closes the assistant turn once its queued audio has played out. */
  private finishAssistantTurn(): void {
    const queued = this.audio?.queued() ?? 0;
    if (queued <= 0.05) {
      this.closeAssistantTurn();
      return;
    }
    this.clearCloseGrace();
    this.closeGraceTimer = setTimeout(() => {
      this.closeGraceTimer = null;
      this.finishAssistantTurn();
    }, queued * 1000);
  }

  private clearCloseGrace(): void {
    if (this.closeGraceTimer) clearTimeout(this.closeGraceTimer);
    this.closeGraceTimer = null;
  }

  /**
   * `transcript_interim` is the whole utterance so far: replace, never append.
   *
   * A caption stays open (not final) while it grows, so the command router
   * debounces free-text slots instead of acting on half a sentence.
   */
  private userCaption(text: string, seq: unknown): void {
    if (!text.trim()) return;
    const id = `claude-u-${this.run}-${String(seq ?? "0")}`;
    if (this.userTurn && this.userTurn.id !== id) this.closeUserTurn();
    if (this.userTurn?.id === id && this.userTurn.text === text) return;
    this.userTurn = { ...(this.userTurn?.id === id ? this.userTurn : turnWithId(id, "user")), text, final: false };
    this.emitCaption(this.userTurn);
  }

  private closeUserTurn(): void {
    this.clearUserTurnClose();
    if (!this.userTurn) return;
    if (!this.userTurn.final) {
      this.userTurn = { ...this.userTurn, final: true };
      this.emitCaption(this.userTurn);
    }
    this.userTurn = null;
  }

  private closeAssistantTurn(): void {
    this.clearCloseGrace();
    this.stopCaption();
    const turn = this.assistantTurn;
    this.assistantTurn = null;
    // Whatever hadn't been shown yet still belongs in the transcript once
    // the turn is actually over.
    const text = this.replyText || turn?.text || "";
    this.replyText = "";
    this.turnAudioStart = null;
    this.turnAudioMs = 0;
    this.words = [];
    this.ptsBase = null;
    this.lastPts = 0;
    this.ptsOffset = 0;
    if (turn && text) this.emitCaption({ ...turn, text, final: true });
  }

  private onClosed(code: number): void {
    if (this.closing) return;
    log("claude-voice", `socket closed code=${code}`);
    this.live = false;
    this.closeUserTurn();
    this.closeAssistantTurn();
    this.release();
    void claudeVoiceStop().catch(() => {});
    void this.closeAudio();
    if (code === 1000) {
      this.emitState("disconnected");
    } else {
      this.emitState("error", `closed ${code}`);
      this.emitError(new Error(`Claude voice connection closed (${code}).`));
    }
  }

  private onEngineError(message: string): void {
    log("claude-voice", `engine error: ${message}`);
    // Before `connected`, the start call rejects with this same message.
    if (!this.live || this.closing) return;
    this.emitError(new Error(message));
  }
}
