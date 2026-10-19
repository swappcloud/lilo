import type { ProviderId } from "./contract";
import type {
  ConnectionState,
  TranscriptTurn,
} from "../types";

/** Runs one of LILO's tools on behalf of a backend that calls tools natively. */
export type ToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ConnectOptions {
  /** The provider's durable chat, distinct from an individual voice call. */
  conversation?: ProviderConversation;
  /**
   * The active provider's own options (`voice`, `voiceMode`, whatever it
   * declares). One shape for everyone: a provider reads the keys it asked for.
   */
  settings: Record<string, string>;
  languageCode?: string;
  /**
   * LILO's opening context (persona, command manifest, reply-language rule).
   * A backend that can take it before the conversation starts uses it here;
   * the others get it later as hidden text.
   */
  instructions?: string;
  /** Reuse a previous session id to resume an interrupted conversation. */
  sessionId?: string;
  /** "" / undefined = system default device. */
  micDeviceId?: string;
  speakerDeviceId?: string;
  bargeIn?: boolean;
  /** 0..1 — higher is more sensitive. */
  bargeInSensitivity?: number;
}

export interface ProviderConversation {
  conversationId: string;
  parentMessageId?: string;
}

/** A picture already uploaded to the vendor, as the web client describes it. */
/** Availability reported by the provider, never estimated by the host. */
export interface ProviderQuota {
  /** Public account key supplied by the host when sign-in completes during connect. */
  accountKey?: string; kind: "daily"; retryAt?: number; }

export interface SharedImage {
  fileId: string;
  /** Local screenshot bytes. The adapter owns any remote upload. */
  dataBase64?: string;
  name: string;
  mime: string;
  /** Bytes. */
  size: number;
  width: number;
  height: number;
}

export interface LevelState {
  mic: number;
  output: number;
}

export type Unsubscribe = () => void;

/**
 * Phase 5 provider abstraction.
 *
 * Implementations must never leak transport details (WebRTC, DataChannel,
 * gateway endpoints) to the UI. Swapping in the Gemini Live API later means
 * adding one class that satisfies this interface.
 */
/** A picture the backend made in the conversation (`inbound.images`). */
export interface GeneratedImage {
  /** The backend's id for the picture, stable across repeats. */
  id: string;
  /** What was asked for, when the backend says. */
  prompt: string;
  mime: string;
  /** The picture's bytes, base64. */
  data: string;
  width?: number;
  height?: number;
}

export interface VoiceProvider {
  onHistory?(cb: (turns: TranscriptTurn[]) => void): Unsubscribe;
  onConversation?(cb: (conversation: ProviderConversation) => void): Unsubscribe;
  onConversationLimit?(cb: () => void): Unsubscribe;
  readonly id: ProviderId;
  readonly label: string;
  readonly supportsNativeAudio: boolean;

  connect(options: ConnectOptions): Promise<void>;
  /** Push raw PCM/audio to the backend (used by native/custom capture paths). */
  sendAudio(chunk: ArrayBuffer): void;
  sendText(text: string, options?: { hidden?: boolean }): void;
  /**
   * Show the model a picture taken locally (the user's screen). The frame is
   * already uploaded to the vendor; only its id crosses the wire.
   */
  sendImage?(image: SharedImage, text: string): void;
  /** Barge-in: stop the assistant mid-utterance. */
  interrupt(): void;
  /** Mute/unmute the microphone without dropping the session. */
  setMuted(muted: boolean): void;
  /** Enable/disable automatic barge-in and tune sensitivity (0..1). */
  setBargeIn(enabled: boolean, sensitivity: number): void;
  /** Switch capture/sink device; applies live when possible. */
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;

  /** Upstream session id, for resuming a conversation later. */
  getSessionId(): string | undefined;

  onResponse(cb: (turn: TranscriptTurn) => void): Unsubscribe;
  onCaption(cb: (turn: TranscriptTurn) => void): Unsubscribe;
  onState(cb: (state: ConnectionState, detail?: string) => void): Unsubscribe;
  onError(cb: (error: Error) => void): Unsubscribe;
  onLevel(cb: (level: LevelState) => void): Unsubscribe;
  /** Remaining voice budget the backend reports, in seconds. */
  onUsage(cb: (remainingSeconds: number) => void): Unsubscribe;
  onQuota?(cb: (quota: ProviderQuota) => void): Unsubscribe;
  /** A picture the backend made; only one declaring `inbound.images` emits. */
  onImage?(cb: (image: GeneratedImage) => void): Unsubscribe;
  /** Explicit generation percentage supplied by the backend, from 0 to 100. */
  onImageProgress?(cb: (percent: number) => void): Unsubscribe;
}

/**
 * Shared listener plumbing + small helpers. Keeps concrete providers focused on
 * transport, and guarantees identical event semantics across implementations.
 */
export abstract class BaseProvider implements VoiceProvider {
  private historyListeners = new Set<(turns: TranscriptTurn[]) => void>();

  onHistory(cb: (turns: TranscriptTurn[]) => void): Unsubscribe {
    this.historyListeners.add(cb);
    return () => this.historyListeners.delete(cb);
  }

  protected emitHistory(turns: TranscriptTurn[]): void {
    this.historyListeners.forEach((cb) => cb(turns));
  }
  private conversationListeners = new Set<(conversation: ProviderConversation) => void>();
  private conversationLimitListeners = new Set<() => void>();
  protected conversation: ProviderConversation | undefined;

  onConversation(cb: (conversation: ProviderConversation) => void): Unsubscribe {
    this.conversationListeners.add(cb);
    return () => this.conversationListeners.delete(cb);
  }

  onConversationLimit(cb: () => void): Unsubscribe {
    this.conversationLimitListeners.add(cb);
    return () => this.conversationLimitListeners.delete(cb);
  }

  protected emitConversation(conversation: ProviderConversation): void {
    this.conversation = conversation;
    this.conversationListeners.forEach((cb) => cb(conversation));
  }

  protected emitConversationLimit(): void {
    this.conversationLimitListeners.forEach((cb) => cb());
  }
  abstract readonly id: ProviderId;
  abstract readonly label: string;
  readonly supportsNativeAudio: boolean = false;

  private stateListeners = new Set<(s: ConnectionState, detail?: string) => void>();
  private captionListeners = new Set<(t: TranscriptTurn) => void>();
  private errorListeners = new Set<(e: Error) => void>();
  private levelListeners = new Set<(l: LevelState) => void>();
  private usageListeners = new Set<(seconds: number) => void>();
  private quotaListeners = new Set<(quota: ProviderQuota) => void>();
  private imageListeners = new Set<(image: GeneratedImage) => void>();
  private imageProgressListeners = new Set<(percent: number) => void>();

  protected session: string | undefined;
  protected muted = false;
  protected bargeInEnabled = true;
  protected bargeInSensitivity = 0.6;

  getSessionId(): string | undefined {
    return this.session;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setBargeIn(enabled: boolean, sensitivity: number): void {
    this.bargeInEnabled = enabled;
    this.bargeInSensitivity = Math.min(1, Math.max(0, sensitivity));
  }

  async setInputDevice(_deviceId: string): Promise<void> {}

  async setOutputDevice(_deviceId: string): Promise<void> {}

  abstract connect(options: ConnectOptions): Promise<void>;
  abstract sendAudio(chunk: ArrayBuffer): void;
  abstract sendText(text: string, options?: { hidden?: boolean }): void;
  abstract interrupt(): void;
  abstract disconnect(): Promise<void>;

  onState(cb: (state: ConnectionState, detail?: string) => void): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onCaption(cb: (turn: TranscriptTurn) => void): Unsubscribe {
    this.captionListeners.add(cb);
    return () => this.captionListeners.delete(cb);
  }

  /** Spec-named alias: fires for assistant turns. */
  onResponse(cb: (turn: TranscriptTurn) => void): Unsubscribe {
    return this.onCaption((turn) => {
      if (turn.speaker === "assistant") cb(turn);
    });
  }

  onError(cb: (error: Error) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  onLevel(cb: (level: LevelState) => void): Unsubscribe {
    this.levelListeners.add(cb);
    return () => this.levelListeners.delete(cb);
  }

  onQuota(cb: (quota: ProviderQuota) => void): Unsubscribe {
    this.quotaListeners.add(cb); return () => this.quotaListeners.delete(cb);
  }
  protected emitQuota(quota: ProviderQuota): void { this.quotaListeners.forEach((cb) => cb(quota)); }

  onUsage(cb: (remainingSeconds: number) => void): Unsubscribe {
    this.usageListeners.add(cb);
    return () => this.usageListeners.delete(cb);
  }

  onImage(cb: (image: GeneratedImage) => void): Unsubscribe {
    this.imageListeners.add(cb);
    return () => this.imageListeners.delete(cb);
  }

  protected emitState(state: ConnectionState, detail?: string): void {
    this.stateListeners.forEach((cb) => cb(state, detail));
  }

  protected emitCaption(turn: TranscriptTurn): void {
    this.captionListeners.forEach((cb) => cb(turn));
  }

  protected emitError(error: Error): void {
    this.errorListeners.forEach((cb) => cb(error));
  }

  protected emitUsage(remainingSeconds: number): void {
    this.usageListeners.forEach((cb) => cb(remainingSeconds));
  }

  protected emitLevel(level: LevelState): void {
    this.levelListeners.forEach((cb) => cb(level));
  }

  protected emitImage(image: GeneratedImage): void {
    this.imageListeners.forEach((cb) => cb(image));
  }

  onImageProgress(cb: (percent: number) => void): Unsubscribe {
    this.imageProgressListeners.add(cb);
    return () => this.imageProgressListeners.delete(cb);
  }

  protected emitImageProgress(percent: number): void {
    this.imageProgressListeners.forEach((cb) => cb(percent));
  }

  protected removeAllListeners(): void {
    this.historyListeners.clear();
    this.conversationListeners.clear();
    this.conversationLimitListeners.clear();
    this.stateListeners.clear();
    this.captionListeners.clear();
    this.errorListeners.clear();
    this.levelListeners.clear();
    this.imageListeners.clear();
    this.imageProgressListeners.clear();
  }
}

let turnSeq = 0;

export function newTurn(
  speaker: TranscriptTurn["speaker"],
  text: string,
  final: boolean,
): TranscriptTurn {
  turnSeq += 1;
  return {
    id: `turn_${Date.now().toString(36)}_${turnSeq}`,
    speaker,
    text,
    final,
    timestamp: Date.now(),
  };
}

/** Build a turn with a protocol-provided id (so streamed updates replace it). */
export function turnWithId(
  id: string,
  speaker: TranscriptTurn["speaker"],
  text = "",
  final = false,
): TranscriptTurn {
  return { id, speaker, text, final, timestamp: Date.now() };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
