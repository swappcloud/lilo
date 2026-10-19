import { describe, expect, it } from "vitest";

import { MARK_LOWER_WAVE_D } from "../../../shared/brand/logoPaths";
import { LiloModel, type LiloInput } from "./liloModel";
import { voiceLevels } from "./liloRenderer";

/** Deterministic PRNG so gaze, blinks and syllables are reproducible. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const idle: LiloInput = { phase: "idle", level: null, music: false };

it("preserves every frame of the character across intro, voice, music and moods", () => {
  let digest = 2166136261;
  const record = (frame: ReturnType<LiloModel["frame"]>) => {
    const text = JSON.stringify(frame);
    for (let i = 0; i < text.length; i += 1) {
      digest = Math.imul(digest ^ text.charCodeAt(i), 16777619);
    }
  };
  for (const phase of ["idle", "listening", "thinking", "speaking"] as const) {
    const model = new LiloModel({ intro: true, random: seeded() });
    for (let i = 0; i < 360; i += 1) {
      model.step(1000 + i * (1000 / 30), {
        phase, level: (i % 17) / 16, low: (i % 13) / 12, high: (i % 11) / 10,
        music: i > 150 && i < 250,
        musicLevels: { level: (i % 19) / 18, low: 0.6, high: 0.3 },
        gaze: { x: Math.sin(i / 10), y: Math.cos(i / 13) },
        mood: (["happy", "sad", "angry", "surprised", null] as const)[Math.floor(i / 72)],
      });
      record(model.frame());
    }
    model.settle({ phase, level: null, music: false });
    record(model.frame());
  }
  expect((digest >>> 0).toString(16)).toMatchInlineSnapshot(`"d5feaff1"`);
});

function run(model: LiloModel, seconds: number, input: LiloInput, from = 1000): number {
  let now = from;
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    now += 1000 / 60;
    model.step(now, input);
  }
  return now;
}

function finite(frame: ReturnType<LiloModel["frame"]>): boolean {
  return !JSON.stringify(frame).includes("NaN");
}

describe("LiloModel intro", () => {
  it("starts as the vector logo: waveforms, no face", () => {
    const frame = new LiloModel({ intro: true, random: seeded() }).frame();
    expect(frame.lowerWaveD).toBe(MARK_LOWER_WAVE_D);
    expect(frame.eyeLeft.rx).toBe(0);
    expect(frame.eyeRight.rx).toBe(0);
    expect(frame.mouthOpacity).toBe(0);
    expect(frame.upperWaveOpacity).toBe(1);
  });

  it("keeps beating as the logo while held", () => {
    const model = new LiloModel({ intro: true, random: seeded() });
    model.hold();
    run(model, 10, idle);
    expect(model.introTime).toBeLessThan(1.55);
    expect(model.frame().eyeRight.rx).toBe(0);
  });

  it("becomes a face once released", () => {
    const model = new LiloModel({ intro: true, random: seeded() });
    model.hold();
    const now = run(model, 3, idle);
    model.release();
    run(model, 3.5, idle, now);
    const frame = model.frame();
    expect(model.introDone).toBe(true);
    expect(frame.eyeLeft.rx).toBeGreaterThan(5);
    expect(frame.eyeRight.rx).toBeGreaterThan(5);
    expect(frame.upperWaveOpacity).toBe(0);
    expect(frame.lowerWaveOpacity).toBe(0);
    expect(frame.mouthOpacity).toBe(1);
  });

  it("skips the intro when not asked for", () => {
    const model = new LiloModel({ random: seeded() });
    run(model, 0.5, idle);
    expect(model.introDone).toBe(true);
    expect(model.frame().eyeLeft.rx).toBeGreaterThan(5);
  });
});

describe("LiloModel phases", () => {
  it("listening swaps the mouth for the waveform", () => {
    const model = new LiloModel({ random: seeded() });
    run(model, 2, { phase: "listening", level: 0.3, music: false });
    const frame = model.frame();
    expect(frame.waveOpacity).toBeGreaterThan(0.95);
    expect(frame.mouthOpacity).toBeLessThan(0.05);
  });

  it("speaking opens the mouth with the voice level", () => {
    const quiet = new LiloModel({ random: seeded() });
    const loud = new LiloModel({ random: seeded() });
    run(quiet, 1, { phase: "speaking", level: 0, music: false });
    run(loud, 1, { phase: "speaking", level: 1, low: 1, high: 0.5, music: false });
    const height = (d: string) => {
      const ys = d.match(/-?\d+(\.\d+)?,(-?\d+(\.\d+)?)/g)!.map((p) => Number(p.split(",")[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(height(loud.frame().mouthD)).toBeGreaterThan(height(quiet.frame().mouthD) + 10);
  });

  it("lip-syncs on its own when no level is available", () => {
    const model = new LiloModel({ random: seeded() });
    const mouths = new Set<string>();
    let now = 1000;
    for (let i = 0; i < 60; i += 1) {
      now = run(model, 0.05, { phase: "speaking", level: null, music: false }, now);
      mouths.add(model.frame().mouthD);
    }
    expect(mouths.size).toBeGreaterThan(20);
  });

  it("keeps the face alive when a speaking phase reports silence", () => {
    // The web path can leave `assistantSpeaking` on after the audio stopped;
    // a literal zero reading must not freeze the mouth.
    const model = new LiloModel({ random: seeded() });
    const mouths = new Set<string>();
    let now = 1000;
    for (let i = 0; i < 60; i += 1) {
      now = run(
        model,
        0.05,
        { phase: "speaking", level: 0, low: 0, high: 0, music: false },
        now,
      );
      mouths.add(model.frame().mouthD);
    }
    expect(mouths.size).toBeGreaterThan(20);
  });

  it("sways to music even when idle", () => {
    const model = new LiloModel({ random: seeded() });
    const tilts = new Set<string>();
    let now = 1000;
    for (let i = 0; i < 40; i += 1) {
      now = run(model, 0.1, { phase: "idle", level: null, music: true }, now);
      tilts.add(model.frame().tilt);
    }
    expect(tilts.size).toBeGreaterThan(20);
    expect(model.frame().waveOpacity).toBeGreaterThan(0.9);
  });

  it("sways to the music even while the assistant is speaking", () => {
    const tilt = (d: string) => Math.abs(Number(d.match(/-?\d+(\.\d+)?/)?.[0] ?? 0));
    const maxTilt = (music: boolean) => {
      const model = new LiloModel({ random: seeded() });
      let now = 1000;
      let peak = 0;
      for (let i = 0; i < 80; i += 1) {
        now = run(model, 0.1, { phase: "speaking", level: 0.5, music }, now);
        peak = Math.max(peak, tilt(model.frame().tilt));
      }
      return peak;
    };
    // The speaking sway alone is ~1.5°; the music adds ±6°.
    expect(maxTilt(true)).toBeGreaterThan(2.5);
    expect(maxTilt(false)).toBeLessThan(2);
  });

  it("follows the real music when the player reports its loudness", () => {
    const quiet = new LiloModel({ random: seeded() });
    const loud = new LiloModel({ random: seeded() });
    const song = (level: number) => ({ level, low: level, high: level * 0.5 });
    run(quiet, 1, { phase: "idle", level: null, music: true, musicLevels: song(0.02) });
    run(loud, 1, { phase: "idle", level: null, music: true, musicLevels: song(0.95) });
    const spread = (d: string) => {
      const ys = d.match(/-?\d+(\.\d+)?,(-?\d+(\.\d+)?)/g)!.map((p) => Number(p.split(",")[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread(loud.frame().waveD)).toBeGreaterThan(spread(quiet.frame().waveD) * 3);
  });

  it("never produces NaN in any phase", () => {
    for (const phase of ["idle", "listening", "thinking", "speaking"] as const) {
      const model = new LiloModel({ intro: true, random: seeded() });
      let now = 1000;
      for (let i = 0; i < 40; i += 1) {
        now = run(model, 0.1, { phase, level: (i % 7) / 6, music: i % 2 === 0 }, now);
        expect(finite(model.frame())).toBe(true);
      }
    }
  });

  it("settle paints the target pose in one call", () => {
    const model = new LiloModel({ intro: true, random: seeded() });
    model.settle({ phase: "thinking", level: null, music: false });
    const thinking = model.frame();
    expect(thinking.eyeLeft.rx).toBeGreaterThan(5);
    expect(thinking.mouthOpacity).toBe(1);
    model.settle({ phase: "listening", level: null, music: false });
    expect(model.frame().waveOpacity).toBe(1);
  });
});

describe("voiceLevels", () => {
  const frame = {
    mic: 0.3,
    output: 0.2,
    spectrum: Array.from({ length: 48 }, (_, i) => (i < 2 ? 0.8 : 0.3)),
    micSpectrum: Array.from({ length: 48 }, () => 0.5),
  };

  it("synthesizes outside a live voice", () => {
    expect(voiceLevels("idle", frame).level).toBeNull();
    expect(voiceLevels("thinking", frame).level).toBeNull();
    expect(voiceLevels("speaking", null).level).toBeNull();
  });

  it("reads the assistant while speaking and the mic while listening", () => {
    const speaking = voiceLevels("speaking", frame);
    const listening = voiceLevels("listening", frame);
    expect(speaking.level).toBeCloseTo((0.2 - 0.024) * 3.5);
    expect(listening.level).toBeCloseTo((0.3 - 0.024) * 3.5);
    expect(speaking.low).toBeCloseTo(1);
    expect(speaking.high).toBeCloseTo(0.66);
  });

  it("gates bands below the noise floor", () => {
    const quiet = voiceLevels("listening", { ...frame, mic: 0.01 });
    expect(quiet.level).toBe(0);
    expect(quiet.low).toBe(0);
    expect(quiet.high).toBe(0);
  });

  it("lets the model lip-sync before the output analyser exists", () => {
    expect(voiceLevels("speaking", { ...frame, output: 0, spectrum: [] }).level).toBeNull();
  });
});
