import { describe, expect, it } from "vitest";

import { applyPatch, diffSnapshot, isEmptyPatch, snapshotOf } from "./mirror";

describe("mirror", () => {
  it("keeps data and drops actions", () => {
    const snapshot = snapshotOf({ a: 1, b: "x", run: () => {} });
    expect(snapshot).toEqual({ a: 1, b: "x" });
  });

  it("finds nothing when no reference changed", () => {
    const list = [{ id: "a" }];
    expect(isEmptyPatch(diffSnapshot({ list, n: 1 }, { list, n: 1 }))).toBe(true);
  });

  it("sends only the list items that changed, and keeps the others", () => {
    const a = { id: "a", text: "one" };
    const b = { id: "b", text: "two" };
    const c = { id: "c", text: "three" };
    const grown = { ...b, text: "two and more" };
    const patch = diffSnapshot({ list: [a, b, c] }, { list: [grown, a, c] });
    expect(patch.list).toEqual({ op: "list", ids: ["b", "a", "c"], items: { b: grown } });

    const next = applyPatch({ list: [a, b, c] }, patch);
    const list = next.list as { id: string }[];
    expect(list).toEqual([grown, a, c]);
    expect(list[1]).toBe(a);
    expect(list[2]).toBe(c);
  });

  it("removes list items and adds new ones", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const d = { id: "d" };
    const patch = diffSnapshot({ list: [a, b] }, { list: [d, a] });
    expect(applyPatch({ list: [a, b] }, patch).list).toEqual([d, a]);
  });

  it("carries a field that went away", () => {
    const patch = diffSnapshot({ lastError: "boom", n: 1 }, { lastError: undefined, n: 1 });
    expect(patch).toEqual({ lastError: { op: "unset" } });
    const next = applyPatch({ lastError: "boom", n: 1 }, patch);
    expect("lastError" in next && next.lastError === undefined).toBe(true);
  });

  it("survives the trip through JSON", () => {
    const before = { list: [{ id: "a", n: 1 }], settings: { x: 1 }, gone: "y" as string | undefined };
    const after = { list: [{ id: "a", n: 2 }], settings: { x: 2 }, gone: undefined };
    const wire = JSON.parse(JSON.stringify(diffSnapshot(before, after)));
    expect({ ...before, ...applyPatch(before, wire) }).toEqual(after);
  });

  it("replaces plain arrays whole", () => {
    const patch = diffSnapshot({ ids: ["a"] }, { ids: ["a", "b"] });
    expect(patch.ids).toEqual({ op: "set", value: ["a", "b"] });
  });
});
