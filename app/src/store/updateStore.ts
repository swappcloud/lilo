import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { APP_VERSION, call, isTauri } from "../lib/gateway";
import { translate } from "../i18n";
import { toast } from "./toastStore";

export interface UpdateInfo {
  status: "idle" | "checking" | "available" | "upToDate" | "downloading" | "installing" | "error";
  currentVersion: string;
  version: string | null;
  notes: string | null;
  progress: number | null;
  error: string | null;
  installable: boolean;
}
interface UpdateStore {
  info: UpdateInfo | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
}
const failed = (error: unknown): void => {
  const info = useUpdateStore.getState().info;
  useUpdateStore.setState({ info: { currentVersion: APP_VERSION, version: null, notes: null, progress: null, installable: false,
    ...info, status: "error", error: error instanceof Error ? error.message : String(error) } });
};

export const useUpdateStore = create<UpdateStore>(() => ({
  info: null,
  check: async () => {
    if (!isTauri()) return;
    try { useUpdateStore.setState({ info: await call<UpdateInfo>("app_update_check") }); }
    catch (error) { failed(error); }
  },
  install: async () => {
    if (!isTauri()) return;
    const version = useUpdateStore.getState().info?.version;
    if (!version) return;
    try { await call("app_update_install", { version }); }
    catch (error) { failed(error); }
  },
}));

/** Both desktop windows observe one native updater; only the main checks automatically. */
export function watchUpdates(notify = false): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  let off: (() => void) | undefined;
  let notified = "";
  let receivedEvent = false;
  const apply = (info: UpdateInfo) => {
    if (cancelled) return;
    useUpdateStore.setState({ info });
    if (notify && info.status === "available" && info.version && notified !== info.version) {
      notified = info.version;
      toast(translate("update.availableToast", { version: info.version }));
    }
  };
  void listen<UpdateInfo>("app-update", (event) => {
    receivedEvent = true;
    apply(event.payload);
  }).then((unlisten) => {
    if (cancelled) { unlisten(); return; }
    off = unlisten;
    void call<UpdateInfo>("app_update_status").then((info) => {
      if (!receivedEvent) apply(info);
    }, () => {});
  }, failed);
  const initial = notify ? window.setTimeout(() => void useUpdateStore.getState().check(), 20_000) : undefined;
  const periodic = notify ? window.setInterval(() => void useUpdateStore.getState().check(), 6 * 60 * 60 * 1000) : undefined;
  return () => { cancelled = true; off?.(); window.clearTimeout(initial); window.clearInterval(periodic); };
}
