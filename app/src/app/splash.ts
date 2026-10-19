/**
 * The startup splash lives in `index.html`, not in React: the white frame it
 * replaces happens before the bundle has even parsed, so anything rendered by
 * JS would already be too late.
 *
 * This module owns its lifetime. The one rule that matters: it must never be
 * able to trap the user behind it. Every path ends in the splash being
 * removed, a hard timeout fires regardless of what startup reports, and the
 * intro that plays after startup has its own deadline and can be skipped with
 * a click.
 *
 * The intro: while startup works, the logo's waveforms beat. When startup is
 * done they become LILO's face, and LILO glides from the logo onto the voice
 * stage, where the stage figure takes over the very same model.
 */

import { offerLiloModel } from "../features/voice/lilo/introHandoff";
import { LiloModel } from "../features/voice/lilo/liloModel";
import { LiloRenderer } from "../features/voice/lilo/liloRenderer";

const SPLASH_ID = "splash";
/** Nothing may keep the splash up longer than this, whatever goes wrong. */
const HARD_TIMEOUT_MS = 12_000;
/** Intro seconds when the face is formed and the glide may start. */
const GLIDE_AT = 2.55;
const GLIDE_MS = 950;
/**
 * The intro after startup may not outlast this. rAF does not run in a hidden
 * window, so without it a minimized launch would never leave the splash.
 */
const INTRO_DEADLINE_MS = 4_500;
const FADE_MS = 300;

let dismissed = false;
let failsafe: number | undefined;

interface Intro {
  model: LiloModel;
  renderer: LiloRenderer;
  raf: number;
  glideStarted: boolean;
  deadline?: number;
}

let intro: Intro | null = null;

function element(): HTMLElement | null {
  return document.getElementById(SPLASH_ID);
}

function animationsOn(): boolean {
  return document.documentElement.dataset.animations !== "off";
}

/** Show what startup is actually doing. Ignored once dismissed. */
export function setSplashStatus(text: string): void {
  if (dismissed) return;
  const status = element()?.querySelector<HTMLElement>(".status");
  if (status) status.textContent = text;
}

export function dismissSplash(): void {
  if (dismissed) return;
  dismissed = true;
  if (failsafe !== undefined) window.clearTimeout(failsafe);
  const node = element();
  if (!node) {
    stopIntro();
    return;
  }
  if (!intro) {
    fadeOut(node);
    return;
  }
  node.dataset.state = "face";
  intro.model.release();
  intro.deadline = window.setTimeout(() => fadeOut(node), INTRO_DEADLINE_MS);
  node.addEventListener("click", () => fadeOut(node), { once: true });
}

/** Take the splash away at once: a window that is not the app's start has none. */
export function removeSplash(): void {
  dismissed = true;
  if (failsafe !== undefined) window.clearTimeout(failsafe);
  stopIntro();
  element()?.remove();
}

/**
 * Arm the failsafe. Called as soon as the bundle runs, before React mounts, so
 * a crash during startup still leaves a usable app.
 */
export function armSplashFailsafe(): void {
  if (dismissed || failsafe !== undefined) return;
  failsafe = window.setTimeout(dismissSplash, HARD_TIMEOUT_MS);
  try {
    startIntro();
  } catch {
    // The intro is decoration: a failure must leave the plain splash working.
    stopIntro();
  }
}

function startIntro(): void {
  const node = element();
  const mark = node?.querySelector<SVGSVGElement>("svg.mark");
  if (!node || !mark || !animationsOn()) return;

  const model = new LiloModel({ intro: true });
  model.hold();
  intro = { model, renderer: new LiloRenderer(mark), raf: 0, glideStarted: false };
  node.dataset.live = "true";
  // Keep the stage figure hidden until the splash hands its model over.
  document.documentElement.dataset.intro = "on";

  const input = { phase: "idle" as const, level: null, music: false };
  const loop = (now: number) => {
    if (!intro) return;
    intro.model.step(now, input);
    intro.renderer.draw(intro.model.frame());
    if (!intro.glideStarted && dismissed && intro.model.introTime >= GLIDE_AT) {
      glide(node, mark);
    }
    intro.raf = requestAnimationFrame(loop);
  };
  intro.raf = requestAnimationFrame(loop);
}

function glide(node: HTMLElement, mark: SVGSVGElement): void {
  if (!intro) return;
  intro.glideStarted = true;

  // The classic stage, or the companion's mascot box (where the mark already
  // sits, so the glide there is only the hand-over).
  const target = document.querySelector<HTMLElement>(".stage .orbwrap, [data-lilo-anchor]");
  const to = target?.getBoundingClientRect();
  const from = mark.getBoundingClientRect();
  if (!to || to.width <= 0 || from.width <= 0) {
    fadeOut(node);
    return;
  }

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const scale = to.width / from.width;
  mark.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  // Only the LILO visualizer continues the character; orb and bars take over
  // from a mark that fades on arrival.
  const handsOff = !!target?.querySelector(".lilo-stage");
  if (!handsOff) mark.style.opacity = "0";
  node.dataset.state = "glide";

  window.setTimeout(() => {
    if (!intro) return;
    if (handsOff) {
      cancelAnimationFrame(intro.raf);
      offerLiloModel(intro.model);
    }
    // Two frames: the stage claims the model and draws the same pose, then the
    // splash copy can go without a visible swap.
    requestAnimationFrame(() => requestAnimationFrame(() => remove(node)));
    // rAF may not run in a hidden window.
    window.setTimeout(() => remove(node), 250);
  }, GLIDE_MS);
}

function fadeOut(node: HTMLElement): void {
  if (node.dataset.leaving === "true") return;
  node.dataset.leaving = "true";
  stopIntro();
  // Remove after the fade so it cannot keep swallowing clicks.
  window.setTimeout(() => remove(node), FADE_MS);
}

function stopIntro(): void {
  if (intro) {
    cancelAnimationFrame(intro.raf);
    if (intro.deadline !== undefined) window.clearTimeout(intro.deadline);
    intro = null;
  }
  delete document.documentElement.dataset.intro;
}

function remove(node: HTMLElement): void {
  stopIntro();
  node.remove();
}
