import { describe, expect, it } from "vitest";

import type { Scene } from "../../types";
import { motionFor, MotionField, particleCount, parseColor } from "./sceneRenderer";

const scene = (kind: Scene["kind"], intensity = 0.7, night = false): Scene => ({
  kind,
  intensity,
  night,
});

/** A 2D context that records what was drawn, for tests. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "createRadialGradient" || prop === "createLinearGradient") {
          return () => {
            calls[prop] = (calls[prop] ?? 0) + 1;
            return gradient;
          };
        }
        return () => {
          calls[prop] = (calls[prop] ?? 0) + 1;
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function fieldOf(kind: Scene["kind"], width = 1200, height = 800): MotionField {
  return new MotionField(motionFor(scene(kind)), width, height);
}

function run(field: MotionField, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) field.step(1 / 60);
}

describe("motionFor", () => {
  it("maps our vocabulary onto the motion model", () => {
    expect(motionFor(scene("sun")).scene).toBe("clear");
    expect(motionFor(scene("clouds")).scene).toBe("fog");
    expect(motionFor(scene("storm")).scene).toBe("storm");
    expect(motionFor(scene("none")).scene).toBe("clear");
  });

  it("turns intensity into rain strength and keeps the night flag", () => {
    expect(motionFor(scene("rain", 0.9)).precip).toBe(90);
    expect(motionFor(scene("rain", 3)).precip).toBe(100);
    expect(motionFor(scene("clear", 0.5, true)).night).toBe(1);
  });
});

describe("particleCount", () => {
  it("uses the reference counts at the reference size", () => {
    expect(particleCount("clear", 1024, 1000)).toBe(26);
    expect(particleCount("rain", 1024, 1000)).toBe(120);
  });

  it("scales with the window and thins out on narrow screens", () => {
    expect(particleCount("storm", 1600, 1000)).toBeGreaterThan(
      particleCount("storm", 800, 500),
    );
    expect(particleCount("rain", 600, 800)).toBeLessThan(particleCount("rain", 1200, 400));
    for (const kind of ["clear", "rain", "snow", "fog", "storm"] as const) {
      expect(particleCount(kind, 320, 480)).toBeGreaterThan(0);
    }
  });
});

describe("MotionField", () => {
  it("rain falls and stays inside the field", () => {
    const field = fieldOf("rain");
    run(field, 0.5);
    const { ctx, calls } = recorder();
    field.draw(ctx, 1, true, { r: 99, g: 102, b: 241 });
    expect(calls.stroke).toBeGreaterThanOrEqual(particleCount("rain", 1200, 800));
  });

  it("snow drifts down, heat rises", () => {
    const snow = fieldOf("snow");
    const heat = fieldOf("heat");
    const ys = (field: MotionField) =>
      (field as unknown as { particles: Array<{ y: number }> }).particles.map((p) => p.y);
    const snowBefore = ys(snow);
    const heatBefore = ys(heat);
    snow.step(0.05);
    heat.step(0.05);
    const snowAfter = ys(snow);
    const heatAfter = ys(heat);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(snowAfter)).toBeGreaterThan(mean(snowBefore));
    // Heat shimmers both ways: some motes rise, some sink.
    expect(heatAfter.filter((y, i) => y < heatBefore[i]).length).toBeGreaterThan(0);
    expect(heatAfter.filter((y, i) => y > heatBefore[i]).length).toBeGreaterThan(0);
  });

  it("wraps every particle back into the window", () => {
    const field = fieldOf("rain");
    run(field, 30);
    const particles = (field as unknown as { particles: Array<{ x: number; y: number }> })
      .particles;
    for (const p of particles) {
      expect(p.y).toBeGreaterThanOrEqual(-24);
      expect(p.y).toBeLessThanOrEqual(824);
      expect(p.x).toBeGreaterThanOrEqual(-24);
      expect(p.x).toBeLessThanOrEqual(1224);
    }
  });

  it("storm brings lightning; rain never does", () => {
    const storm = fieldOf("storm");
    let struck = false;
    for (let i = 0; i < 60 * 90 && !struck; i += 1) {
      storm.step(1 / 60);
      struck = storm.lightning;
    }
    expect(struck, "a storm must thunder within 90s").toBe(true);

    const rain = fieldOf("rain");
    run(rain, 90);
    expect(rain.lightning).toBe(false);
  });

  it("storm draws bolts and a flash, fog draws banks, motes are dots", () => {
    const storm = fieldOf("storm");
    while (!storm.lightning) storm.step(1 / 60);
    const stormCtx = recorder();
    storm.draw(stormCtx.ctx, 1, true, { r: 99, g: 102, b: 241 });
    expect(stormCtx.calls.fillRect).toBeGreaterThan(0);
    expect(stormCtx.calls.lineTo).toBeGreaterThan(0);

    const fog = fieldOf("fog");
    const fogCtx = recorder();
    fog.draw(fogCtx.ctx, 1, true, { r: 99, g: 102, b: 241 });
    expect(fogCtx.calls.createRadialGradient).toBe(particleCount("fog", 1200, 800));

    const clear = fieldOf("clear");
    const clearCtx = recorder();
    clear.draw(clearCtx.ctx, 1, true, { r: 99, g: 102, b: 241 });
    expect(clearCtx.calls.arc).toBe(particleCount("clear", 1200, 800));
  });
});

describe("parseColor", () => {
  it("reads the palette forms the stylesheet can produce", () => {
    expect(parseColor("#6366f1")).toEqual({ r: 99, g: 102, b: 241 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("   ")).toEqual({ r: 91, g: 140, b: 255 });
  });
});
