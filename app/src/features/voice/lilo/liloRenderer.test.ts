import { describe, expect, it, vi } from "vitest";

import { LiloModel } from "./liloModel";
import { LiloRenderer } from "./liloRenderer";

describe("LiloRenderer visibility", () => {
  it("leaves invisible paths alone and refreshes them before revealing them", () => {
    const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.innerHTML = '<path data-lilo="wave" d="M0,0" />';
    const path = root.firstElementChild!;
    const writes = vi.spyOn(path, "setAttribute");
    const renderer = new LiloRenderer(root);
    const frame = new LiloModel().frame();

    renderer.draw({ ...frame, waveD: "M1,1", waveOpacity: 0 });
    expect(path.getAttribute("opacity")).toBe("0");
    expect(path.getAttribute("d")).toBe("M0,0");

    writes.mockClear();
    renderer.draw({ ...frame, waveD: "M2,2", waveOpacity: 0.01 });
    expect(writes.mock.calls).toEqual([["d", "M2,2"], ["opacity", "0.01"]]);

    writes.mockClear();
    renderer.draw({ ...frame, waveD: "M2,2", waveOpacity: 0.01 });
    expect(writes).not.toHaveBeenCalled();
  });
});
