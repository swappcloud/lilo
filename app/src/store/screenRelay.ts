import { onScreen } from "../lib/gateway";
import { useSessionStore } from "./sessionStore";

/**
 * The vision channel: the host uploaded a screenshot a tool produced (a
 * plugin's `screen` result) and the live session may show it.
 *
 * Kept apart from the plugin-notification wiring on purpose: this is a
 * session concern, and the store decides whether the current backend can see
 * images at all.
 */
export function startScreenRelay(): () => void {
  let stopped = false;
  let off: (() => void) | undefined;
  void onScreen(({ text, ...image }) => {
    useSessionStore.getState().relayImage(image, text);
  }).then((unlisten) => {
    if (stopped) unlisten();
    else off = unlisten;
  });
  return () => {
    stopped = true;
    off?.();
  };
}
