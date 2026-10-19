import { onImagine, onPluginEvent, pluginImage } from "../lib/gateway";
import { log } from "../lib/log";
import { providerMeta } from "../providers";
import { translate } from "../i18n";
import { useGeneratedImageStore } from "./generatedImages";
import { useSessionStore } from "./sessionStore";
import { toast } from "./toastStore";

/**
 * "Create an image of …": a tool asked for a picture (`imagine`), and the
 * live session's backend is the one that draws it. A backend that declares
 * `inbound.images` is asked in a hidden turn and LILO thinks until the picture
 * arrives (`generatedImages`); any other is told to say it cannot.
 */
export function requestImage(prompt: string): void {
  const session = useSessionStore.getState();
  if (session.connectionState !== "connected") {
    toast(translate("images.needCall"));
    return;
  }
  const meta = providerMeta(session.providerId);
  if (!meta.protocol.inbound.images || !meta.protocol.outbound.text) {
    log("images", `${session.providerId} cannot create pictures`);
    session.sendText(
      `[LILO] The user asked for a picture of: ${prompt}. This voice backend cannot create pictures in LILO; say so briefly.`,
      { hidden: true },
    );
    return;
  }
  log("images", `asking ${session.providerId} for a picture`);
  useGeneratedImageStore.getState().wait(prompt);
  session.sendText(
    `Create an image of: ${prompt}. Generate it now with your image tool, then say in a few words that it is ready. Do not describe it at length.`,
    { hidden: true },
  );
}

/** How long each picture of a slideshow stays before the next one. */
export const SLIDE_MS = 6_000;
const MAX_SLIDES = 8;
let slides: ReturnType<typeof setTimeout>[] = [];
let revision = 0;
let presenting = false;

export function stopSlides(): void {
  revision += 1;
  slides.forEach(clearTimeout);
  slides = [];
}

/** Read a plugin's own stored pictures through the host, without a live call. */
async function showStored(source: string, payload: unknown): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(data.items) ? data.items : [data];
  const entries = list
    .map((item) => (item ?? {}) as Record<string, unknown>)
    .filter((item) => typeof item.file === "string" && typeof item.mime === "string")
    .slice(0, MAX_SLIDES);
  stopSlides();
  const request = revision;
  const shown = await Promise.all(
    entries.map(async (item) => ({
      id: `stored-${String(item.file)}`,
      prompt: typeof item.prompt === "string" ? item.prompt : "",
      src: await pluginImage(source, String(item.file), String(item.mime)).catch(() => ""),
    })),
  );
  if (request !== revision) return;
  const pictures = shown.filter((picture) => picture.src);
  const present = (index: number) => {
    if (request !== revision) return;
    const picture = pictures[index];
    if (!picture) return;
    const last = index === pictures.length - 1;
    presenting = true;
    try {
      // Schedule the next slide before this one's expiry to avoid a blank frame.
      if (!last) slides.push(setTimeout(() => present(index + 1), SLIDE_MS));
      useGeneratedImageStore.getState().show(picture, last ? undefined : SLIDE_MS);
    } finally {
      presenting = false;
    }
  };
  present(0);
}

export function startImageRequests(): () => void {
  let stopped = false;
  const offs: Array<() => void> = [
    useGeneratedImageStore.subscribe((state, previous) => {
      if (!presenting && (state.shown !== previous.shown || state.pending !== previous.pending)) stopSlides();
    }),
  ];
  const keep = (off: () => void) => {
    if (stopped) off();
    else offs.push(off);
  };
  void onImagine(({ prompt }) => requestImage(prompt)).then(keep);
  void onPluginEvent((event) => {
    if (stopped || event.topic !== "image.show") return;
    showStored(event.source, event.payload).catch((error) => log("images", `could not show a stored picture: ${String(error)}`));
  }).then(keep);
  return () => {
    stopped = true;
    stopSlides();
    offs.forEach((off) => off());
  };
}
