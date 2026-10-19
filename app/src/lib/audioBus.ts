/**
 * Ultra-light audio frame bus.
 *
 * The provider pushes the live voice frame (levels + frequency spectrum) here
 * every animation frame. The canvas visualizer reads it directly instead of
 * going through React state, so 60fps audio data never triggers re-renders.
 */
export interface AudioFrame {
  mic: number;
  output: number;
  /** Assistant/output voice spectrum, normalized 0..1 (low → high frequency). */
  spectrum: number[];
  /** Microphone spectrum, normalized 0..1. */
  micSpectrum: number[];
}

type Listener = (frame: AudioFrame) => void;

const listeners = new Set<Listener>();
let latest: AudioFrame | null = null;

export const EMPTY_SPECTRUM: number[] = [];

export function publishAudioFrame(frame: AudioFrame): void {
  latest = frame;
  for (const listener of listeners) listener(frame);
}

export function subscribeAudioFrame(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function latestAudioFrame(): AudioFrame | null {
  return latest;
}
