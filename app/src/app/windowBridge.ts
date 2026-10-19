/**
 * One owner, many views: how the panel window shows the main window's state
 * without owning any of it.
 *
 * The main window owns the stores. While a panel is open it sends the panel
 * a snapshot, then only what changed (`mirror.ts`), numbered so a lost
 * message is noticed and repaired with a fresh snapshot. The panel replaces
 * every action of the mirrored stores with a request to the owner; the
 * owner runs it, and its reply carries the changes it caused, so after an
 * awaited action the panel reads the new state, as it would in one window.
 *
 * Nothing in the panel can therefore persist, connect or duck the music on
 * its own: there is one session and one writer, whichever window the user is
 * looking at. Stores that are the panel's own (the settings draft, toasts)
 * are not mirrored.
 */

import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StoreApi, UseBoundStore } from "zustand";

import { isTauri } from "../lib/gateway";
import { log } from "../lib/log";
import { useProviderLimits } from "../store/providerLimits";
import { useAlertStore } from "../store/alertStore";
import { usePluginsStore } from "../store/pluginsStore";
import { usePreferencesStore } from "../store/preferencesStore";
import { useSessionStore } from "../store/sessionStore";
import { useWakeStore } from "../store/wakeStore";
import {
  applyPatch,
  diffSnapshot,
  isEmptyPatch,
  snapshotOf,
  type Snapshot,
  type StorePatch,
} from "./mirror";
import { runOwnerCall, setOwnerRemote } from "./windowRole";
// The owner answers the calls these modules declare with `ownerCall`, so they
// are loaded here even in a main window that never draws them.
import "../shared/hooks/useMediaDevices";
import "../store/sceneStore";
import "../store/settingsDraft";
import "./useMenuActions";

const OWNER_WINDOW = "main";
const PANEL_WINDOW = "panel";
const TO_PANEL = "lilo://mirror";
const TO_OWNER = "lilo://to-owner";
/** Changes are gathered this long before they are sent: captions come fast. */
const COALESCE_MS = 80;
/** The panel draws with its own defaults if the owner never answers. */
const FIRST_SNAPSHOT_MS = 2_500;
/** A change that arrived early waits this long for the ones before it. */
const GAP_MS = 400;

/** What the bridge needs of a store: what it moves is untyped JSON anyway. */
interface MirroredStore {
  getState(): Readonly<Record<string, unknown>>;
  setState(partial: Record<string, unknown>): void;
  subscribe(listener: () => void): () => void;
}

function mirrored<T extends object>(store: UseBoundStore<StoreApi<T>>): MirroredStore {
  return {
    getState: () => store.getState() as unknown as Record<string, unknown>,
    setState: (partial) => store.setState(partial as Partial<T>),
    subscribe: (listener) => store.subscribe(listener),
  };
}

type StoreKey = "session" | "preferences" | "plugins" | "wake" | "alert" | "providerLimits";

const MIRRORED: Record<StoreKey, MirroredStore> = {
  session: mirrored(useSessionStore),
  preferences: mirrored(usePreferencesStore),
  plugins: mirrored(usePluginsStore),
  wake: mirrored(useWakeStore),
  alert: mirrored(useAlertStore),
  providerLimits: mirrored(useProviderLimits),
};
const STORE_KEYS = Object.keys(MIRRORED) as StoreKey[];

interface Mirror {
  seq: number;
  stores: Partial<Record<StoreKey, StorePatch>>;
}

type ToPanel =
  | { kind: "owner-ready" }
  | { kind: "snapshot"; seq: number; stores: Record<StoreKey, Snapshot> }
  | ({ kind: "patch" } & Mirror)
  | { kind: "reply"; id: number; ok: boolean; value?: unknown; error?: string; mirror?: Mirror };

type Request =
  | { kind: "action"; store: StoreKey; name: string; args: unknown[] }
  | { kind: "call"; name: string; args: unknown[] };

type ToOwner = { kind: "hello" } | { kind: "resync" } | { kind: "bye" } | ({ id: number } & Request);

function snapshots(): Record<StoreKey, Snapshot> {
  const all = {} as Record<StoreKey, Snapshot>;
  for (const key of STORE_KEYS) all[key] = snapshotOf(MIRRORED[key].getState());
  return all;
}

function isStoreKey(value: unknown): value is StoreKey {
  return STORE_KEYS.includes(value as StoreKey);
}

// --- owner --------------------------------------------------------------

/** Start serving panels. Returns the teardown. */
export function startOwnerBridge(): () => void {
  if (!isTauri()) return () => {};
  /** What the panel has, or null while no panel listens. */
  let sent: Record<StoreKey, Snapshot> | null = null;
  let seq = 0;
  let timer: number | undefined;

  const send = (message: ToPanel) => {
    void emitTo(PANEL_WINDOW, TO_PANEL, message).catch(() => {});
  };

  const takeMirror = (): Mirror | null => {
    if (!sent) return null;
    const now = snapshots();
    const stores: Mirror["stores"] = {};
    for (const key of STORE_KEYS) {
      const patch = diffSnapshot(sent[key], now[key]);
      if (!isEmptyPatch(patch)) stores[key] = patch;
    }
    sent = now;
    if (Object.keys(stores).length === 0) return null;
    seq += 1;
    return { seq, stores };
  };

  const flush = () => {
    timer = undefined;
    const mirror = takeMirror();
    if (mirror) send({ kind: "patch", ...mirror });
  };

  const run = async (request: Request): Promise<unknown> => {
    if (request.kind === "call") return runOwnerCall(request.name, request.args);
    if (!isStoreKey(request.store)) throw new Error(`unknown store ${String(request.store)}`);
    const action = MIRRORED[request.store].getState()[request.name];
    if (typeof action !== "function") throw new Error(`unknown action ${request.name}`);
    return action(...request.args);
  };

  const answer = async (message: { id: number } & Request) => {
    let reply: ToPanel;
    try {
      const value = await run(message);
      reply = {
        kind: "reply",
        id: message.id,
        ok: true,
        value: typeof value === "function" ? undefined : value,
      };
    } catch (error) {
      reply = {
        kind: "reply",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    window.clearTimeout(timer);
    timer = undefined;
    const mirror = takeMirror();
    send(mirror ? { ...reply, mirror } : reply);
  };

  const offStores = STORE_KEYS.map((key) =>
    MIRRORED[key].subscribe(() => {
      if (sent && timer === undefined) timer = window.setTimeout(flush, COALESCE_MS);
    }),
  );

  const pending: Promise<UnlistenFn> = listen<ToOwner>(TO_OWNER, (event) => {
    const message = event.payload;
    switch (message.kind) {
      case "hello":
      case "resync":
        window.clearTimeout(timer);
        timer = undefined;
        sent = snapshots();
        seq += 1;
        send({ kind: "snapshot", seq, stores: sent });
        break;
      case "bye":
        window.clearTimeout(timer);
        timer = undefined;
        sent = null;
        break;
      default:
        void answer(message);
    }
  });
  // A panel left open across a reload of this window asks again.
  void pending.then(() => send({ kind: "owner-ready" }));

  return () => {
    offStores.forEach((off) => off());
    window.clearTimeout(timer);
    void pending.then((unlisten) => unlisten());
  };
}

// --- panel --------------------------------------------------------------

/**
 * Turn this window's stores into a view of the owner's. Resolves once the
 * first snapshot is in (or after a short wait, so a silent owner never
 * leaves the panel blank).
 */
export function startPanelBridge(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  let seq = -1;
  let resyncing = false;
  /** Changes that overtook an earlier one, by number. */
  const early = new Map<number, Mirror>();
  let gapTimer: number | undefined;
  let nextId = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const post = (message: ToOwner) => {
    void emitTo(OWNER_WINDOW, TO_OWNER, message).catch((error: unknown) =>
      log("panel", `owner unreachable: ${String(error)}`),
    );
  };

  const request = (message: Request): Promise<unknown> => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      post({ ...message, id });
    });
  };

  // Every action of a mirrored store runs in the owner.
  for (const key of STORE_KEYS) {
    const store = MIRRORED[key];
    const proxies: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, value] of Object.entries(store.getState())) {
      if (typeof value === "function") {
        proxies[name] = (...args) => request({ kind: "action", store: key, name, args });
      }
    }
    store.setState(proxies);
  }
  setOwnerRemote((name, args) => request({ kind: "call", name, args }));

  const resync = () => {
    if (resyncing) return;
    resyncing = true;
    post({ kind: "resync" });
  };

  const apply = (mirror: Mirror) => {
    seq = mirror.seq;
    for (const key of STORE_KEYS) {
      const patch = mirror.stores[key];
      if (!patch) continue;
      const store = MIRRORED[key];
      store.setState(applyPatch(snapshotOf(store.getState()), patch));
    }
  };

  /** Apply changes in order; one that never arrives costs a fresh snapshot. */
  const applyMirror = (mirror: Mirror) => {
    if (seq < 0 || mirror.seq <= seq) return;
    early.set(mirror.seq, mirror);
    for (let next = early.get(seq + 1); next; next = early.get(seq + 1)) {
      early.delete(next.seq);
      apply(next);
    }
    window.clearTimeout(gapTimer);
    gapTimer = early.size > 0 ? window.setTimeout(resync, GAP_MS) : undefined;
  };

  let firstSnapshot: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    firstSnapshot = resolve;
    window.setTimeout(resolve, FIRST_SNAPSHOT_MS);
  });

  void listen<ToPanel>(TO_PANEL, (event) => {
    const message = event.payload;
    switch (message.kind) {
      case "owner-ready":
        post({ kind: "hello" });
        break;
      case "snapshot":
        seq = message.seq;
        resyncing = false;
        early.clear();
        window.clearTimeout(gapTimer);
        for (const key of STORE_KEYS) {
          const store = MIRRORED[key];
          const snapshot = message.stores[key] ?? {};
          // JSON drops undefined fields: a data field missing here is unset.
          const next: Snapshot = {};
          for (const field of Object.keys(snapshotOf(store.getState()))) next[field] = undefined;
          store.setState({ ...next, ...snapshot });
        }
        firstSnapshot();
        break;
      case "patch":
        applyMirror(message);
        break;
      case "reply": {
        if (message.mirror) applyMirror(message.mirror);
        const pending = waiting.get(message.id);
        if (!pending) break;
        waiting.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error ?? "owner call failed"));
        break;
      }
    }
  }).then(() => post({ kind: "hello" }));

  window.addEventListener("pagehide", () => post({ kind: "bye" }));
  return ready;
}
