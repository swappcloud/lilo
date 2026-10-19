import { useEffect } from "react";

import {
  isTauri,
  onStartup,
  setAssistantName,
  setCommandLocales,
  startupState,
} from "../lib/gateway";
import { startPluginNotifications } from "../store/pluginNotify";
import { startScreenRelay } from "../store/screenRelay";
import { startImageRequests } from "../store/imageRequests";
import { startStatusbar } from "../store/statusbarStore";
import { startSessionIdleWatch } from "../store/sessionIdle";
import { startPluginSessionContext } from "../store/pluginSessionContext";
import { startPluginInteractions } from "../store/pluginInteractions";
import { watchUpdates } from "../store/updateStore";
import { usePreferencesStore } from "../store/preferencesStore";
import { useSessionStore } from "../store/sessionStore";
import { usePluginsStore } from "../store/pluginsStore";
import { dismissSplash, setSplashStatus } from "./splash";

/** One-time startup: load backend data and subscribe to login events. */
export function useBootstrap(): void {
  const loadBackend = useSessionStore((s) => s.loadBackend);
  const initLoginListener = useSessionStore((s) => s.initLoginListener);

  useEffect(() => {
    void loadBackend();
  }, [loadBackend]);

  useEffect(() => startPluginNotifications(), []);

  useEffect(() => startScreenRelay(), []);

  useEffect(() => startImageRequests(), []);

  useEffect(() => startStatusbar(), []);
  useEffect(() => watchUpdates(true), []);
  useEffect(() => startSessionIdleWatch(), []);
  useEffect(() => startPluginSessionContext(), []);
  useEffect(() => startPluginInteractions(), []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void initLoginListener().then((off) => {
      unsubscribe = off;
    });
    return () => unsubscribe?.();
  }, [initLoginListener]);

  // Recognize all declared command languages independently of the reply/UI
  // language, and keep the assistant's wake phrase in sync with the registry.
  useEffect(() => {
    if (!isTauri()) return;
    const push = (wakePhrase: string) => {
      void setCommandLocales([]).catch(() => {});
      void setAssistantName(wakePhrase).catch(() => {});
    };
    push(usePreferencesStore.getState().wakePhrase);
    const unsubscribe = usePreferencesStore.subscribe((state, previous) => {
      if (
        state.language !== previous.language ||
        state.wakePhrase !== previous.wakePhrase
      ) {
        push(state.wakePhrase);
      }
    });
    return unsubscribe;
  }, []);

  // Drive the startup splash from real backend progress, and take it down the
  // moment startup reports done. In a plain browser there is no backend to wait
  // for, so it goes immediately.
  useEffect(() => {
    if (!isTauri()) {
      dismissSplash();
      return;
    }

    let off: (() => void) | undefined;
    const apply = (state: { step: string; done: boolean }) => {
      if (state.done) {
        void usePluginsStore.getState().refresh();
        dismissSplash();
      } else if (state.step) {
        setSplashStatus(state.step);
      }
    };

    void onStartup(apply).then((unlisten) => {
      off = unlisten;
    });
    // A fast machine can finish before React mounts, so ask for the current
    // state too rather than waiting for an event that already fired.
    void startupState().then(apply, () => dismissSplash());

    return () => off?.();
  }, []);
}
