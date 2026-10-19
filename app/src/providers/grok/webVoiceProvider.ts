import type { UnlistenFn } from "@tauri-apps/api/event";
import { publishAudioFrame } from "../../lib/audioBus";
import type { TranscriptTurn } from "../../types";
import { BaseProvider, turnWithId, type ConnectOptions } from "../types";
import { PcmAudio, pcm16ToBase64 } from "../shared/pcmAudio";
import { log } from "../../lib/log";
import { grokVoiceStart, grokVoiceStop, grokVoiceSend, onGrokVoice, type GrokVoiceEvent } from "./gateway";

type Frame = Record<string, unknown>;
const record = (value: unknown): Frame => value && typeof value === "object" ? value as Frame : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
// The site's client may use the GA realtime names; map them onto the beta ones.
const ALIASES: [string, string][] = [
  ["response.output_audio_transcript.", "response.audio_transcript."],
  ["response.output_audio.", "response.audio."],
  ["response.output_text.", "response.text."],
];
const frameKind = (kind: string): string => {
  for (const [from, to] of ALIASES) if (kind.startsWith(from)) return to + kind.slice(from.length);
  return kind === "conversation.item.input_audio_transcription.delta"
    ? "conversation.item.input_audio_transcription.updated" : kind;
};

/** Grok's cookie-authenticated socket stays on grok.com; audio stays here. */
export class GrokWebVoiceProvider extends BaseProvider {
  readonly id = "grok-web";
  readonly label = "Grok Voice (web session)";
  override readonly supportsNativeAudio = true;
  private unlisten: UnlistenFn | null = null;
  private audio: PcmAudio | null = null;
  private live = false;
  private generation = 0;
  private pending = false;
  private micDevice = "";
  private userTurns = new Map<string, TranscriptTurn>();
  private assistant: TranscriptTurn | null = null;
  private assistantUsesAudioTranscript = false;
  private suppressed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frame types already logged this session, so the log names each once. */
  private seenKinds = new Set<string>();
  private micLogged = false;
  /** Generated pictures still arriving in parts, by id. */
  private imageParts = new Map<string, string[]>();

  async connect(options: ConnectOptions): Promise<void> {
    if (this.pending || this.live) return;
    const generation = ++this.generation;
    this.pending = true;
    this.micDevice = options.micDeviceId ?? "";
    this.setBargeIn(options.bargeIn ?? true, options.bargeInSensitivity ?? 0.6);
    this.emitState("connecting");
    this.seenKinds.clear();
    this.micLogged = false;
    const current = () => generation === this.generation;
    try {
      const unlisten = await onGrokVoice((events) => { if (current()) this.applyEvents(events); });
      if (!current()) { unlisten(); return; }
      this.unlisten = unlisten;
      const audio = new PcmAudio((chunk) => {
        if (current() && this.live && !this.muted) this.send({ type: "input_audio_buffer.append", audio: chunk });
      }, 24000, 480);
      this.audio = audio;
      await audio.open(this.micDevice || undefined);
      if (!current()) { await audio.close(); return; }
      if (this.muted) audio.closeMic();
      await audio.setOutputDevice(options.speakerDeviceId ?? "");
      if (!current()) return;
      this.session = await grokVoiceStart({
        voice: options.settings.voice || "ara", language: options.languageCode,
        instructions: options.instructions, conversationId: options.conversation?.conversationId ?? options.sessionId,
      });
      if (!current()) return;
      if (this.session) this.emitConversation({ conversationId: this.session });
    log("grok-web", `ready conversation=${this.session}`);
      this.live = true;
      this.timer = setInterval(() => {
        const levels = audio.levels();
        const mic = this.muted ? 0 : levels.mic;
        publishAudioFrame({ mic, output: levels.output, spectrum: [], micSpectrum: [] });
        this.emitLevel({ mic, output: levels.output });
      }, 50);
      this.emitState("connected");
    } catch (error) {
      if (!current()) return;
      const err = error instanceof Error ? error : new Error(String(error));
      await this.cleanup();
      this.emitState("error", err.message);
      this.emitError(err);
    } finally {
      if (current()) this.pending = false;
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.live && !this.muted && chunk.byteLength % 2 === 0) {
      this.send({ type: "input_audio_buffer.append", audio: pcm16ToBase64(new Int16Array(chunk)) });
    }
  }

  sendText(value: string, _options?: { hidden?: boolean }): void {
    if (!this.live || !value.trim()) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", object: "realtime.item", content: [{ type: "input_text", text: value }] } });
    this.send({ type: "response.create" });
  }

  interrupt(): void {
    this.suppressed = true;
    this.audio?.stopPlayback();
    this.finishAssistant();
  }

  override setMuted(muted: boolean): void {
    super.setMuted(muted);
    if (muted) this.audio?.closeMic();
    else if (this.audio) void this.audio.openMic(this.micDevice || undefined).catch((error) => this.emitError(new Error(String(error))));
  }

  override async setInputDevice(deviceId: string): Promise<void> {
    this.micDevice = deviceId;
    this.audio?.closeMic();
    if (!this.muted) await this.audio?.openMic(deviceId || undefined);
  }

  override async setOutputDevice(deviceId: string): Promise<void> {
    await this.audio?.setOutputDevice(deviceId);
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    this.pending = false;
    await this.cleanup();
    this.emitState("disconnected");
  }

  private send(event: Frame): void {
    if (event.type === "input_audio_buffer.append" && !this.micLogged) {
      this.micLogged = true;
      log("grok-web", "microphone streaming");
    }
    void grokVoiceSend(event).catch((error) => {
      log("grok-web", `send ${String(event.type)} failed: ${String(error)}`);
      if (this.live) this.fail("The Grok voice transport is unavailable.");
    });
  }

  private applyEvents(events: GrokVoiceEvent[]): void {
    for (const event of events) {
      if (event.type === "frame") {
        this.applyFrame(record(event.message));
      } else if (event.type === "closed") {
        log("grok-web", `socket closed code=${String(event.code ?? "")}${event.reason ? ` reason=${event.reason}` : ""}`);
        if (this.live) this.fail("Grok closed the voice connection. Start a new session or check your account's voice access.");
      } else if (event.type === "image") {
        this.collectImage(event);
      } else if (event.type === "image-error") {
        log("grok-web", `generated image ${String(event.id ?? "")} unavailable: ${String(event.reason ?? "")}`);
      } else if (event.type === "error") {
        log("grok-web", `engine error: ${text(event.message)}${event.reason ? ` (${event.reason})` : ""}`);
        if (this.live) this.fail(text(event.message) || "Grok voice failed.");
      }
    }
  }

  private collectImage(event: GrokVoiceEvent): void {
    const id = text(event.id);
    const parts = Number(event.parts);
    const part = Number(event.part);
    if (!id || !Number.isInteger(parts) || parts < 1 || parts > 64 || !Number.isInteger(part) || part < 0 || part >= parts) return;
    const received = this.imageParts.get(id) ?? new Array<string>(parts).fill("");
    received[part] = text(event.data);
    this.imageParts.set(id, received);
    if (received.some((chunk) => !chunk)) return;
    this.imageParts.delete(id);
    const size = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined);
    log("grok-web", `generated image ${id} received (${parts} part${parts === 1 ? "" : "s"})`);
    this.emitImage({
      id, prompt: text(event.prompt), mime: text(event.mime) || "image/jpeg", data: received.join(""),
      width: size(event.width), height: size(event.height),
    });
  }

  private applyFrame(frame: Frame): void {
    const raw = text(frame.type);
    if (!this.seenKinds.has(raw) && this.seenKinds.size < 64) {
      this.seenKinds.add(raw);
      log("grok-web", `frame ${raw}`);
    }
    const kind = frameKind(raw);
    const id = text(frame.item_id) || text(frame.itemId);
    if (kind === "input_audio_buffer.speech_started") {
      if (this.bargeInEnabled) this.interrupt();
      return;
    }
    if (kind === "conversation.item.input_audio_transcription.updated" || kind === "conversation.item.input_audio_transcription.completed") {
      const value = text(frame.transcript);
      if (!id || !value.trim()) return;
      const final = kind.endsWith(".completed");
      const previous = this.userTurns.get(id);
      if (previous?.final) return;
      const turn = { ...(previous ?? turnWithId(`grok-u-${this.generation}-${id}`, "user")), text: value, final };
      this.emitCaption(turn);
      this.userTurns.set(id, turn);
      if (this.userTurns.size > 64) this.userTurns.delete(this.userTurns.keys().next().value!);
      return;
    }
    if (kind === "response.created") {
      this.finishAssistant();
      this.suppressed = false;
      const responseId = text(record(frame.response).id) || text(frame.response_id);
      this.assistant = turnWithId(`grok-a-${this.generation}-${responseId}`, "assistant");
      return;
    }
    if (kind === "response.audio.delta") {
      if (this.suppressed) return;
      const audio = text(frame.audio) || text(frame.delta);
      if (!audio) return;
      const generation = this.generation;
      try {
        this.audio?.play(audio, () => {
          if (generation === this.generation && this.live && !this.suppressed) {
            this.send({ type: "response.audio.delta.playback_completed", response_id: frame.response_id, rid: frame.rid });
          }
        });
      } catch { this.fail("Grok sent invalid voice audio."); }
      return;
    }
    if (this.suppressed) return;
    if (kind === "response.audio_transcript.delta" || kind === "response.text.delta") {
      if (kind === "response.text.delta" && this.assistantUsesAudioTranscript) return;
      if (!this.assistant) this.assistant = turnWithId(`grok-a-${this.generation}-${id}`, "assistant");
      if (kind === "response.audio_transcript.delta" && !this.assistantUsesAudioTranscript) {
        this.assistantUsesAudioTranscript = true;
        this.assistant = { ...this.assistant, text: "" };
      }
      this.assistant = { ...this.assistant, text: this.assistant.text + text(frame.delta), final: false };
      this.emitCaption(this.assistant);
    } else if (kind === "response.audio_transcript.done" || kind === "response.text.done") {
      if (kind === "response.text.done" && this.assistantUsesAudioTranscript) return;
      if (kind === "response.audio_transcript.done") this.assistantUsesAudioTranscript = true;
      if (this.assistant) this.assistant = { ...this.assistant, text: text(frame.transcript) || text(frame.text) || this.assistant.text };
    } else if (kind === "response.done" || kind === "response.audio.done") {
      if (this.finishTimer) clearTimeout(this.finishTimer);
      this.finishTimer = setTimeout(() => this.finishAssistant(), (this.audio?.queued() ?? 0) * 1000 + 50);
    }
  }

  private finishAssistant(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    if (this.assistant?.text) this.emitCaption({ ...this.assistant, final: true });
    this.assistant = null;
    this.assistantUsesAudioTranscript = false;
  }

  private fail(message: string): void {
    if (!this.live) return;
    this.live = false;
    ++this.generation;
    void this.cleanup();
    this.emitState("error", message);
    this.emitError(new Error(message));
  }

  private async cleanup(): Promise<void> {
    this.live = false;
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.finishAssistant();
    this.userTurns.clear();
    this.imageParts.clear();
    const audio = this.audio;
    this.audio = null;
    await Promise.all([audio?.close(), grokVoiceStop().catch(() => {})]);
  }
}
