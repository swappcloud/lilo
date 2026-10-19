import { create } from "zustand";

import { ownerCall } from "../app/windowRole";
import { isTauri, listPlugins, onPluginEvent, onScene, runTool } from "../lib/gateway";
import { logError } from "../lib/log";
import type { PluginSceneSource, Scene, SceneKind } from "../types";

const KINDS: ReadonlySet<SceneKind> = new Set([
  "none",
  "clear",
  "sun",
  "clouds",
  "fog",
  "rain",
  "snow",
  "storm",
  "heat",
  "cold",
]);

/** Plugin output is untrusted: anything outside the vocabulary draws nothing. */
export function toScene(value: unknown): Scene | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind as SceneKind)) return null;
  const intensity = typeof raw.intensity === "number" && Number.isFinite(raw.intensity)
    ? Math.min(1, Math.max(0, raw.intensity))
    : 0.6;
  return { kind: raw.kind as SceneKind, intensity, night: raw.night === true };
}

interface SceneStore {
  scene: Scene | null;
  setScene: (scene: Scene | null) => void;
}

export const useSceneStore = create<SceneStore>((set) => ({
  scene: null,
  setScene: (scene) => set({ scene }),
}));

let sources: PluginSceneSource[] = [];
let timers: ReturnType<typeof setInterval>[] = [];

async function poll(source: PluginSceneSource): Promise<void> {
  try {
    const result = (await runTool(source.tool, {})) as { scene?: unknown } | null;
    // The host also emits the scene as an event; applying it here too keeps a
    // plain poll working if the event is missed.
    const scene = toScene(result?.scene);
    if (scene) useSceneStore.getState().setScene(scene);
  } catch (error) {
    logError("scene", error);
  }
}

/**
 * Re-read which plugins provide a scene and restart polling. Called at start,
 * after a plugin is installed or removed, and after plugin settings change.
 * The scene is drawn behind LILO, so from the panel it runs in the owner.
 */
export const refreshScene = ownerCall("scene.refresh", async (): Promise<void> => {
  if (!isTauri()) return;
  for (const timer of timers) clearInterval(timer);
  timers = [];
  try {
    const plugins = await listPlugins();
    sources = plugins.flatMap((plugin) => (plugin.ui.scene ? [plugin.ui.scene] : []));
  } catch (error) {
    logError("scene", error);
    sources = [];
  }
  if (sources.length === 0) {
    useSceneStore.getState().setScene(null);
    return;
  }
  // One background at a time: the first plugin that offers one owns it.
  const source = sources[0];
  await poll(source);
  timers.push(setInterval(() => void poll(source), Math.max(15, source.everySecs) * 1000));
});

/** Start listening and polling. Returns the cleanup. */
export function startScene(): () => void {
  const offs: Array<() => void> = [];
  let stopped = false;
  const keep = (unlisten: () => void) => {
    if (stopped) unlisten();
    else offs.push(unlisten);
  };
  void onScene((payload) => {
    const scene = toScene(payload);
    if (scene) useSceneStore.getState().setScene(scene);
  }).then(keep);
  // A new place means new weather: ask again rather than wait for the poll.
  void onPluginEvent((event) => {
    if (event.topic === "location.changed") void refreshScene();
  }).then(keep);
  void refreshScene();
  return () => {
    stopped = true;
    for (const off of offs) off();
    for (const timer of timers) clearInterval(timer);
    timers = [];
  };
}
