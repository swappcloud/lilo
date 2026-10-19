import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getMicrophone } from "../../shared/lib/microphone";
import { BaseProvider, turnWithId, type ConnectOptions } from "../types";
import { PcmAudio, pcm16ToBase64 } from "../shared/pcmAudio";
import type { ProviderDeps } from "../contract";
import type { PluginVoiceProvider } from "./types";

type Output = { pluginId: string; providerId: string; sessionId: string; closed: boolean; events: Record<string, unknown>[] };

/** The host owns media; sandboxed plugins translate their upstream protocol. */
export class PluginVoiceTransport extends BaseProvider {
  readonly id: string;
  readonly label: string;
  override readonly supportsNativeAudio: boolean;
  private generation = 0;
  private audio: PcmAudio | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private output: HTMLAudioElement | null = null;
  private subscriptions: (() => void)[] = [];
  private queue: string[] = [];
  private flushingGeneration: number | null = null;
  private ready = false;
  private inputDevice = "";
  private responding = false;
  private pendingFrames: string[] = [];
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private context: AudioContext | null = null;
  private micMeter: AnalyserNode | null = null;
  private outputMeter: AnalyserNode | null = null;
  private readonly meterData = new Float32Array(256);
  private meter(stream: MediaStream): AnalyserNode | null {
    if (!this.context) return null;
    const meter = this.context.createAnalyser(); meter.fftSize = 256;
    this.context.createMediaStreamSource(stream).connect(meter); return meter;
  }
  private levels() {
    if (this.audio) { const level=this.audio.levels(); this.emitLevel({...level,mic:this.muted ? 0 : level.mic}); return; }
    const rms = (meter: AnalyserNode | null) => {
      if (!meter) return 0;
      meter.getFloatTimeDomainData(this.meterData);
      return Math.min(1, Math.sqrt(this.meterData.reduce((sum, value) => sum + value * value, 0) / this.meterData.length));
    };
    this.emitLevel({mic:this.muted ? 0 : rms(this.micMeter),output:rms(this.outputMeter)});
  }
  private sendFrame(data: string) {
    if (data.length > 65536 || (this.channel?.bufferedAmount ?? 0) > 262144) { this.fail(new Error("Plugin voice frame overflow.")); return; }
    if (this.channel?.readyState === "open") this.channel.send(data);
    else if (this.pendingFrames.length < 32) this.pendingFrames.push(data);
    else this.fail(new Error("Plugin voice frame queue overflow."));
  }
  constructor(private readonly owner: string, private readonly spec: PluginVoiceProvider, private readonly deps: ProviderDeps) {
    super(); this.supportsNativeAudio = spec.transport.kind === "pcm"; this.label = spec.label; this.id = `plugin:${owner}/${spec.id}`;
  }
  private call(operation: string, args: Record<string, unknown> = {}) {
    return invoke<Record<string, unknown>>("plugin_voice_call", { id: this.owner,
      request: { providerId: this.spec.id, sessionId: this.session, operation, args } });
  }
  private command(operation: string, args: Record<string, unknown> = {}) {
    const generation = this.generation;
    void this.call(operation, args).catch(error => { if (generation === this.generation) this.fail(error); });
  }
  private fail(error: unknown) {
    this.emitError(error instanceof Error ? error : new Error("Plugin voice transport failed."));
    void this.disconnect();
  }
  async connect(options: ConnectOptions): Promise<void> {
    await this.disconnect();
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    this.session = crypto.randomUUID(); this.inputDevice = options.micDeviceId ?? "";
    this.emitState("connecting");
    try {
      const off = await listen<Output>("lilo://plugin-voice", ({ payload }) => {
        if (live() && payload.pluginId === this.owner && payload.providerId === this.spec.id && payload.sessionId === this.session) {
          if (payload.closed) { void this.disconnect(); return; }
          try { for (const event of payload.events) { if (!live()) break; this.receive(event); } } catch (error) { this.fail(error); }
        }
      });
      if (!live()) { off(); return; } this.subscriptions.push(off);
      const overflow = await listen("lilo://plugin-voice-overflow", () => { if (live()) this.fail(new Error("Voice output overflow; reconnect to continue.")); });
      if (!live()) { overflow(); return; } this.subscriptions.push(overflow);
      let sdp: string | undefined;
      if (this.spec.transport.kind === "webrtc") {
        const stream = await getMicrophone({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
          ...(this.inputDevice ? { deviceId: { exact: this.inputDevice } } : {}) }, video: false });
        if (!live()) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        this.context = new AudioContext(); await this.context.resume();
        if (!live()) return;
        this.micMeter = this.meter(stream);
        const peer = new RTCPeerConnection(); this.peer = peer;
        stream.getAudioTracks().forEach(track => peer.addTrack(track, stream));
        const output = new Audio(); output.autoplay = true; this.output = output;
        peer.ontrack = event => { if (live()) { output.srcObject = event.streams[0] ?? new MediaStream([event.track]); this.outputMeter = this.meter(output.srcObject as MediaStream); void output.play().catch(error => { if (live()) this.fail(error); }); } };
        peer.onconnectionstatechange = () => { if (live() && ["failed", "disconnected"].includes(peer.connectionState)) this.fail(new Error("Plugin voice connection was lost.")); };
        const spec = this.spec.transport;
        const label = spec.channelLabel ?? "oai-events";
        const bind = (channel: RTCDataChannel) => {
          if (!live() || this.channel || channel.label !== label) { channel.close(); return; }
          this.channel = channel;
          const flushFrames = () => { if (live()) this.pendingFrames.splice(0).forEach(frame => this.sendFrame(frame)); };
          channel.onopen = flushFrames;
          channel.onclose = () => { if (live() && this.ready) this.fail(new Error("Plugin voice channel closed.")); };
          if (channel.readyState === "open") flushFrames();
          channel.onmessage = event => {
            if (!live() || typeof event.data !== "string" || event.data.length > 65536) return;
            this.command("event", { frame: event.data });
          };
        };
        if (spec.remoteChannel) {
          const negotiation = peer.createDataChannel("lilo-negotiation");
          this.subscriptions.push(() => negotiation.close());
          peer.ondatachannel = event => bind(event.channel);
        } else bind(peer.createDataChannel(label));
        await peer.setLocalDescription(await peer.createOffer());
        if (!live()) return;
        sdp = peer.localDescription?.sdp;
        if (!sdp) throw new Error("The browser could not create a voice offer.");
      }
      if (this.spec.transport.kind === "pcm") {
        const audio = new PcmAudio(chunk => {
          if (live() && this.ready && !this.muted && (this.bargeInEnabled || !this.responding)) this.enqueue(chunk);
        }, this.spec.transport.inputSampleRate ?? 16000);
        this.audio = audio;
        await audio.open(this.inputDevice);
        if (!live()) { await audio.close(); return; }
        await audio.setOutputDevice(options.speakerDeviceId ?? "");
      }
      const result = await this.call("connect", { ...options, ...(sdp ? { sdp } : {}) });
      if (!live()) return;
      if (result.quota && typeof result.quota === "object") {
        const quota = result.quota as { kind?: unknown; retryAt?: unknown };
        if (quota.kind === "daily") {
          this.emitQuota({ kind: "daily", ...(typeof result.accountKey === "string" ? { accountKey: result.accountKey } : {}), ...(typeof quota.retryAt === "number" ? { retryAt: quota.retryAt } : {}) });
          throw new Error("This provider has reached its daily voice limit. See its reported retry time.");
        }
      }
      if (result.connected === false) throw new Error("This provider could not start voice. Check its account access.");
      if (this.peer) {
        if (typeof result.sdp !== "string" || !result.sdp.startsWith("v=0")) throw new Error("Plugin did not return a valid voice answer.");
        await this.peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const timer = setInterval(() => {
            if (!live()) { clearInterval(timer); reject(new Error("Plugin voice connection was cancelled.")); }
            else if (this.channel?.readyState === "open") { clearInterval(timer); resolve(); }
            else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error("Plugin voice channel did not open in time.")); }
          }, 50);
        });
      }
      if (!live()) return;
      this.setBargeIn(options.bargeIn ?? true, options.bargeInSensitivity ?? 0.6);
      this.ready = true;
      await this.setOutputDevice(options.speakerDeviceId ?? "");
      if (!live()) return;
      this.meterTimer = setInterval(() => this.levels(), 80);
      this.emitState("connected");
    } catch (error) {
      if (live()) { await this.disconnect(); throw error; }
    }
  }
  private enqueue(chunk: string) {
    if (this.queue.length >= 50) { this.fail(new Error("Plugin voice input is too slow.")); return; }
    this.queue.push(chunk); void this.flush();
  }
  private async flush() {
    const generation = this.generation;
    if (this.flushingGeneration === generation) return;
    this.flushingGeneration = generation;
    try {
      while (this.queue.length && generation === this.generation && this.ready) await this.call("audio", { audio: this.queue.shift() });
    } catch (error) { if (generation === this.generation) this.fail(error); }
    finally { if (this.flushingGeneration === generation) this.flushingGeneration = null; }
  }
  private receive(event: Record<string, unknown>) {
    switch (event.type) {
      case "caption":
        if (typeof event.id === "string" && typeof event.text === "string" && (event.speaker === "user" || event.speaker === "assistant"))
          this.emitCaption(turnWithId(event.id, event.speaker, event.text, event.final === true));
        break;
      case "audio":
        if (typeof event.audio === "string" && this.spec.transport.kind === "pcm")
          this.audio?.play(event.audio, undefined, this.spec.transport.outputSampleRate ?? 24000);
        break;
      case "response_started": this.responding = true; if(this.output) this.output.muted=false; this.updateTracks(); break;
      case "input_started": if (this.bargeInEnabled) { this.audio?.stopPlayback(); if(this.output) this.output.muted=true; } break;
      case "state": if (event.state === "connected") { this.responding = false; this.updateTracks(); } break;
      case "usage": if (typeof event.remainingSeconds === "number" && Number.isFinite(event.remainingSeconds)) this.emitUsage(event.remainingSeconds); break;
      case "quota": if (event.kind === "daily") this.emitQuota({ kind: "daily", ...(typeof event.retryAt === "number" ? { retryAt: event.retryAt } : {}) }); break;
      case "error": this.fail(new Error(typeof event.message === "string" ? event.message : "Plugin voice error.")); break;
      case "frames":
        if (Array.isArray(event.frames)) for (const frame of event.frames) {
          const data = typeof frame === "string" ? frame : JSON.stringify(frame);
          this.sendFrame(data);
        }
        break;
      case "tool_call":
        if (this.spec.protocol?.inbound.nativeToolCalls && this.deps.runTool && typeof event.id === "string" && typeof event.name === "string" && event.args && typeof event.args === "object" && !Array.isArray(event.args)) {
          const generation = this.generation;
          void this.deps.runTool(event.name, event.args as Record<string, unknown>).then(result => {
            if (generation === this.generation) return this.call("toolResult", { id: event.id, result });
          }).catch(error => { if (generation === this.generation) this.fail(error); });
        }
    }
  }
  sendAudio(chunk: ArrayBuffer): void { if (this.spec.transport.kind === "pcm" && this.ready && chunk.byteLength % 2 === 0 && chunk.byteLength <= 32000) this.enqueue(pcm16ToBase64(new Int16Array(chunk))); }
  sendText(text: string, options?: { hidden?: boolean }): void { if (this.ready) this.command("text", { text, hidden: options?.hidden ?? false }); }
  interrupt(): void { this.audio?.stopPlayback(); if(this.output) this.output.muted=true; this.responding = false; this.updateTracks(); if (this.ready) this.command("interrupt"); }
  private updateTracks() { this.stream?.getAudioTracks().forEach(track => {track.enabled=!this.muted && (this.bargeInEnabled || !this.responding);}); }
  setMuted(muted: boolean): void { super.setMuted(muted); this.updateTracks(); }
  setBargeIn(enabled: boolean,sensitivity: number): void { super.setBargeIn(enabled,sensitivity); this.updateTracks(); }
  async setInputDevice(deviceId: string): Promise<void> {
    this.inputDevice = deviceId;
    if (this.audio) { this.audio.closeMic(); await this.audio.openMic(deviceId); }
    else if (this.peer && this.ready) throw new Error("Reconnect to switch this provider's microphone.");
  }
  async setOutputDevice(deviceId: string): Promise<void> {
    if (this.audio) await this.audio.setOutputDevice(deviceId);
    else if (this.output) {
      const output = this.output as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (output.setSinkId) await output.setSinkId(deviceId);
      else if (deviceId) throw new Error("Audio output selection is unavailable in this webview.");
    }
  }
  async disconnect(): Promise<void> {
    const session = this.session; ++this.generation; this.ready = false;
    this.flushingGeneration = null;
    this.queue = []; this.pendingFrames = []; this.responding = false;
    if (this.meterTimer) clearInterval(this.meterTimer); this.meterTimer = null;
    const context = this.context; this.context = null; this.micMeter = null; this.outputMeter = null;
    await context?.close().catch(() => {});
    this.subscriptions.splice(0).forEach(off => off());
    this.channel?.close(); this.channel = null; this.peer?.close(); this.peer = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.output) { this.output.pause(); this.output.srcObject = null; this.output = null; }
    const audio = this.audio; this.audio = null; await audio?.close();
    if (session) {
      this.session = undefined;
      void invoke("plugin_voice_call", { id: this.owner, request: {providerId: this.spec.id, sessionId: session, operation: "disconnect", args: {}} }).catch(() => {});
    }
    this.emitState("idle");
  }
}
