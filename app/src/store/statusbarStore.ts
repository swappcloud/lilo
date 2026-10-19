import { create } from "zustand";

import { isTauri, onStatusbar, statusbarCurrent, type StatusItem } from "../lib/gateway";
import { logError } from "../lib/log";

interface StatusbarStore {
  item: StatusItem | null;
  set: (item: StatusItem | null) => void;
}

export const useStatusbarStore = create<StatusbarStore>((set) => ({
  item: null,
  set: (item) => set({ item }),
}));

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export function renderStatus(item: StatusItem, nowSeconds: number): string {
  if (item.endsAt != null) return `${item.label} ${clock(item.endsAt - nowSeconds)}`;
  if (item.left != null) return `${item.label} ${clock(item.left)}`;
  return item.label;
}

export function startStatusbar(): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => void) | undefined;
  statusbarCurrent().then(
    (item) => {
      if (!stopped) useStatusbarStore.getState().set(item);
    },
    (error) => logError("statusbar", error),
  );
  void onStatusbar((item) => useStatusbarStore.getState().set(item)).then((off) => {
    if (stopped) off();
    else unlisten = off;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
