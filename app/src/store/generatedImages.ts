import { create } from "zustand";

import { isTauri, publishEvent } from "../lib/gateway";
import { log } from "../lib/log";
import type { GeneratedImage } from "../providers";

/** How long a new picture stays in LILO's thought bubble. */
export const SHOWN_MS = 20_000;
/** How long LILO waits for a picture it asked for before giving up. */
export const PENDING_MS = 150_000;

/** Formats a picture may arrive in; anything else is dropped. */
const MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ShownImage {
  id: string;
  prompt: string;
  src: string;
}

interface GeneratedImageStore {
  /** The picture LILO is showing in its thought bubble. */
  shown: ShownImage | null;
  /** What LILO asked the backend to draw, until the picture arrives. */
  pending: string | null;
  progress: number | null;
  show: (image: ShownImage, ms?: number) => void;
  wait: (prompt: string) => void;
  reportProgress: (percent: number) => void;
  dismiss: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export const useGeneratedImageStore = create<GeneratedImageStore>((set, get) => ({
  shown: null,
  pending: null,
  progress: null,
  show: (image, ms = SHOWN_MS) => {
    if (timer) clearTimeout(timer);
    if (pendingTimer) clearTimeout(pendingTimer);
    set({ shown: image, pending: null, progress: null });
    timer = setTimeout(() => set({ shown: null }), ms);
  },
  wait: (prompt) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    set({ pending: prompt, progress: null });
    pendingTimer = setTimeout(() => set({ pending: null, progress: null }), PENDING_MS);
  },
  reportProgress: (percent) => {
    const state = get();
    if (state.pending === null || !Number.isFinite(percent) || percent < 0 || percent > 100) return;
    set({ progress: Math.max(state.progress ?? 0, Math.round(percent)) });
  },
  dismiss: () => {
    if (timer) clearTimeout(timer);
    set({ shown: null });
  },
}));

/**
 * A backend made a picture: LILO shows it as a thought, and whichever plugin
 * keeps pictures receives it on `image.created` (the bundled gallery). The
 * app itself stores nothing.
 */
export function receiveGeneratedImage(image: GeneratedImage, providerId: string): void {
  if (!MIMES.has(image.mime) || !BASE64.test(image.data)) {
    log("images", `dropped a ${image.mime} picture from ${providerId}: not a supported image`);
    return;
  }
  useGeneratedImageStore.getState().show({
    id: image.id,
    prompt: image.prompt,
    src: `data:${image.mime};base64,${image.data}`,
  });
  if (!isTauri()) return;
  void publishEvent("image.created", {
    id: image.id,
    prompt: image.prompt,
    mime: image.mime,
    data: image.data,
    width: image.width,
    height: image.height,
    provider: providerId,
    createdAt: Date.now(),
  }).catch((error) => log("images", `could not hand the picture to plugins: ${String(error)}`));
}
