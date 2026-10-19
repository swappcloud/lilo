import { useEffect, useRef } from "react";

import { usePreferencesStore } from "../../store/preferencesStore";
import { startScene, useSceneStore } from "../../store/sceneStore";
import { runVisibleAnimationLoop } from "../../shared/lib/visibleRaf";
import { SceneRenderer } from "./sceneRenderer";

const isDark = () => document.documentElement.dataset.theme !== "light";

/** The accent every particle is drawn with, as the stylesheet resolves it. */
function accentColor(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
    "#6366f1"
  );
}

/**
 * The plugin-driven background (weather and the like), behind the voice stage.
 * The loop runs only while a scene is visible or fading; with animations off a
 * single still frame is painted.
 */
export function SceneLayer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const scene = useSceneStore((s) => s.scene);
  const animations = usePreferencesStore((s) => s.animations);
  const theme = usePreferencesStore((s) => s.theme);
  const accent = usePreferencesStore((s) => s.accent);
  const customAccent = usePreferencesStore((s) => s.customAccent);

  useEffect(() => startScene(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const renderer = new SceneRenderer(canvas, ctx);
    renderer.setAccent(accentColor());
    rendererRef.current = renderer;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
      if (!animations) renderer.render(0, isDark());
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      rendererRef.current = null;
    };
  }, [animations]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // The palette can change while a scene is up; the effect follows it.
    renderer.setAccent(accentColor());
    renderer.setScene(scene, animations);
    if (!animations) {
      renderer.render(0, isDark());
      return;
    }
    let last = performance.now();
    // Hidden windows stop animating, and 30 fps is plenty for weather
    // particles: they are pure cost behind a minimized window.
    return runVisibleAnimationLoop(
      (now) => {
        renderer.render((now - last) / 1000, isDark());
        last = now;
        // Nothing left to draw: stop until the next scene arrives.
        return renderer.active;
      },
      { fps: 30 },
    );
  }, [scene, animations, theme, accent, customAccent]);

  return <canvas ref={canvasRef} className="scene-canvas" aria-hidden />;
}
