/**
 * The data half of a store, and what changed in it since last time — small
 * enough to send to another window on every caption.
 *
 * Stores are immutable (Zustand), so a field that did not change is the same
 * reference: comparing references finds the changes without walking them. A
 * list of items with an `id` (conversations, accounts, tool runs) sends only
 * the items that changed plus the order, so a caption growing in one
 * conversation does not resend all forty.
 */

export type Snapshot = Record<string, unknown>;

export type FieldPatch =
  | { op: "set"; value: unknown }
  | { op: "unset" }
  | { op: "list"; ids: string[]; items: Record<string, unknown> };

export type StorePatch = Record<string, FieldPatch>;

/** Every field that is data, never an action. */
export function snapshotOf(state: object): Snapshot {
  const snapshot: Snapshot = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== "function") snapshot[key] = value;
  }
  return snapshot;
}

function idOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function isIdList(value: unknown): value is { id: string }[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  for (const item of value) {
    const id = idOf(item);
    if (id === null || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function diffList(previous: unknown[], next: { id: string }[]): FieldPatch {
  const before = new Map<string, unknown>();
  for (const item of previous) {
    const id = idOf(item);
    if (id !== null) before.set(id, item);
  }
  const items: Record<string, unknown> = {};
  for (const item of next) {
    if (before.get(item.id) !== item) items[item.id] = item;
  }
  return { op: "list", ids: next.map((item) => item.id), items };
}

/** What changed from `previous` to `next`; empty when nothing did. */
export function diffSnapshot(previous: Snapshot, next: Snapshot): StorePatch {
  const patch: StorePatch = {};
  for (const [key, value] of Object.entries(next)) {
    const old = previous[key];
    if (old === value) continue;
    if (value === undefined) {
      if (key in previous && old !== undefined) patch[key] = { op: "unset" };
      continue;
    }
    patch[key] =
      Array.isArray(old) && isIdList(value) ? diffList(old, value) : { op: "set", value };
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next) && previous[key] !== undefined) patch[key] = { op: "unset" };
  }
  return patch;
}

/**
 * Apply a patch on top of `current`, keeping every unchanged item's
 * reference so a list re-renders only the rows that changed.
 */
export function applyPatch(current: Snapshot, patch: StorePatch): Snapshot {
  const next: Snapshot = {};
  for (const [key, change] of Object.entries(patch)) {
    if (change.op === "set") {
      next[key] = change.value;
    } else if (change.op === "unset") {
      next[key] = undefined;
    } else {
      const old = new Map<string, unknown>();
      const list = current[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = idOf(item);
          if (id !== null) old.set(id, item);
        }
      }
      next[key] = change.ids
        .map((id) => (id in change.items ? change.items[id] : old.get(id)))
        .filter((item) => item !== undefined);
    }
  }
  return next;
}

export function isEmptyPatch(patch: StorePatch): boolean {
  return Object.keys(patch).length === 0;
}
