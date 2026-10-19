import { LiloModel } from "../../app/src/features/voice/lilo/liloModel";

/** A deterministic still from the actual desktop companion; no alternate face. */
const model = new LiloModel({ intro: false, random: () => 0.5 });
for (let frame = 0; frame < 60; frame++) {
  model.step(frame * (1000 / 60), { phase: "idle", level: 0, music: false, gaze: { x: 0, y: 0 } });
}
export const desktopFrame = model.frame();
