import { create } from "zustand";

/**
 * A command waiting for the user's go-ahead.
 *
 * The router emits `Effect::Confirm` and does not touch a tool until this is
 * answered, so the store holds at most one command: a second prompt while one
 * is open would be two questions with one set of buttons.
 */
interface ConfirmStore {
  command: string | null;
  ask: (command: string) => void;
  clear: () => void;
}

export const useConfirmStore = create<ConfirmStore>((set) => ({
  command: null,
  ask: (command) => set({ command }),
  clear: () => set({ command: null }),
}));
