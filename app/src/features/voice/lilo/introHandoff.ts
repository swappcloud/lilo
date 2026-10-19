import type { LiloModel } from "./liloModel";

/**
 * The startup splash plays the intro with its own model, then glides it onto
 * the stage. Handing the model over (instead of starting a fresh one) keeps
 * gaze, blink and breathing continuous: the swap is invisible.
 */
let offered: LiloModel | null = null;

export function offerLiloModel(model: LiloModel): void {
  offered = model;
}

/** Take the offered model, once. */
export function claimLiloModel(): LiloModel | null {
  const model = offered;
  offered = null;
  return model;
}
