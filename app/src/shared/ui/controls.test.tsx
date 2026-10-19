import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RangeSlider } from "./controls";
describe("range slider values",()=>{
  it("shows the current number, unit, bounds and a linked explanation",async()=>{
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const element=document.createElement("div");const root=createRoot(element);const change=vi.fn();
    try {
      await act(async()=>root.render(<RangeSlider label="Volume" value={65} min={10} unit="%" help="Playback volume" onChange={change}/>));
      const input=element.querySelector("input")!;
      expect(element.querySelector("output")?.textContent).toBe("65%");
      expect(input.getAttribute("aria-valuetext")).toBe("65%");
      expect(element.querySelector(".slider-bounds")?.textContent).toBe("10%100%");
      expect(element.querySelector(`[id="${input.getAttribute("aria-describedby")}"]`)?.textContent).toBe("Playback volume");
      await act(async()=>root.render(<RangeSlider label="Maximum notes" value={20} min={1} max={50} onChange={change}/>));
      expect(element.querySelector("output")?.textContent).toBe("20");
      expect(element.querySelector("input")?.max).toBe("50");
    } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
  });
});
