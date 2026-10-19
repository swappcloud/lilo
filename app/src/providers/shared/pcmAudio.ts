import { getMicrophone } from "../../shared/lib/microphone";
/**
 * 16 kHz mono PCM16 in and out of the webview, for transports that carry raw
 * audio (the Claude voice socket). Capture hands out base64 chunks; playback
 * schedules incoming chunks back to back and can be cut off at once.
 */

export const PCM_RATE = 16000;
/** Mic chunk size: 40 ms keeps IPC calls down without adding audible lag. */
const CHUNK_SAMPLES = 640;
/** Playback starts this far ahead, so network jitter does not click. */
const PLAYBACK_LEAD_S = 0.06;

export function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToPcm16(text: string): Int16Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Collects float frames into fixed-size PCM16 chunks. */
export class ChunkBuffer {
  private buffer: Int16Array;
  private filled = 0;

  constructor(
    private readonly onChunk: (chunk: Int16Array) => void,
    private readonly chunkSamples = CHUNK_SAMPLES,
  ) {
    this.buffer = new Int16Array(chunkSamples);
  }

  push(samples: Float32Array): void {
    const pcm = floatToPcm16(samples);
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(pcm.length - offset, this.chunkSamples - this.filled);
      this.buffer.set(pcm.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.chunkSamples) {
        this.onChunk(this.buffer);
        this.buffer = new Int16Array(this.chunkSamples);
        this.filled = 0;
      }
    }
  }
}

const rms = (analyser: AnalyserNode | null, data: Float32Array<ArrayBuffer>): number => {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
  return Math.min(1, Math.sqrt(sum / data.length) * 4);
};

/** One audio context for both directions, so the webview's echo canceller
 *  sees the playback it has to remove from the microphone. */
export class PcmAudio {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micGeneration = 0;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private output: GainNode | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private readonly levelData = new Float32Array(new ArrayBuffer(512 * 4));

  constructor(
    private readonly onChunk: (base64: string) => void,
    private readonly sampleRate = PCM_RATE,
    private readonly chunkSamples = CHUNK_SAMPLES,
  ) {}

  async open(deviceId?: string): Promise<void> {
    const context = new AudioContext({ sampleRate: this.sampleRate });
    this.context = context;
    await context.resume().catch(() => {});
    this.output = context.createGain();
    this.outAnalyser = context.createAnalyser();
    this.outAnalyser.fftSize = 512;
    this.output.connect(this.outAnalyser);
    this.outAnalyser.connect(context.destination);
    await this.openMic(deviceId);
  }

  async openMic(deviceId?: string): Promise<void> {
    const context = this.context;
    if (!context || this.stream) return;
    const generation = ++this.micGeneration;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API is unavailable in this webview.");
    }
    const stream = await getMicrophone({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
      video: false,
    });
    if (this.context !== context || generation !== this.micGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    this.source = context.createMediaStreamSource(stream);
    this.micAnalyser = context.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.source.connect(this.micAnalyser);
    // ScriptProcessor, not AudioWorklet: a worklet module needs a script URL
    // the app CSP would have to allow, and 40 ms chunks do not need one.
    const chunks = new ChunkBuffer((chunk) => this.onChunk(pcm16ToBase64(chunk)), this.chunkSamples);
    const processor = context.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (event) => chunks.push(event.inputBuffer.getChannelData(0));
    const silence = context.createGain();
    silence.gain.value = 0;
    this.source.connect(processor);
    processor.connect(silence).connect(context.destination);
    this.processor = processor;
  }

  /** Release the capture device (the OS indicator goes off), keep playback. */
  closeMic(): void {
    ++this.micGeneration;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor = null;
    this.source = null;
    this.micAnalyser = null;
    this.stream = null;
  }

  /** The playback clock, in seconds — what `play` start times are on. */
  clock(): number {
    return this.context?.currentTime ?? 0;
  }

  /** Seconds of scheduled audio not yet played. */
  queued(): number {
    if (!this.context || !this.sources.size) return 0;
    return Math.max(0, this.nextTime - this.context.currentTime);
  }

  /** Schedules a chunk after the previous one; returns when it starts playing. */
  play(base64: string, onPlayed?: () => void, sampleRate = this.sampleRate): number | null {
    const context = this.context;
    const output = this.output;
    if (!context || !output) return null;
    const samples = base64ToPcm16(base64);
    if (!samples.length) return null;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 0x8000;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(output);
    const now = context.currentTime;
    if (this.nextTime < now + 0.01) this.nextTime = now + PLAYBACK_LEAD_S;
    const startsAt = this.nextTime;
    node.start(startsAt);
    this.nextTime += buffer.duration;
    this.sources.add(node);
    node.onended = () => {
      if (this.sources.delete(node)) onPlayed?.();
    };
    return startsAt;
  }

  stopPlayback(): void {
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (context?.setSinkId) await context.setSinkId(deviceId);
    else if (deviceId) throw new Error("Audio output selection is unavailable in this webview.");
  }

  levels(): { mic: number; output: number } {
    return {
      mic: rms(this.micAnalyser, this.levelData),
      output: rms(this.outAnalyser, this.levelData),
    };
  }

  async close(): Promise<void> {
    this.stopPlayback();
    this.closeMic();
    const context = this.context;
    this.context = null;
    this.output = null;
    this.outAnalyser = null;
    await context?.close().catch(() => {});
  }
}
