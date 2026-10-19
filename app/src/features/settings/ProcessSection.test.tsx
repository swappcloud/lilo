import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessSection, sampledCpu } from "./ProcessSection";
const mocks=vi.hoisted(()=>({report:vi.fn()}));
vi.mock("../../lib/gateway",()=>({isTauri:()=>true,processReport:mocks.report}));
const usage={rssBytes:128*1024*1024,cpuSeconds:2,threads:8,processes:2,uptimeSeconds:10,groups:[{kind:"host",rssBytes:128*1024*1024,cpuSeconds:2,threads:8,processes:2}]};
async function mount(test:(element:HTMLDivElement)=>Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const element=document.createElement("div");const root=createRoot(element);
  try {await act(async()=>root.render(<ProcessSection/>));await test(element);}
  finally {await act(async()=>root.unmount());vi.unstubAllGlobals();vi.useRealTimers();}
}
beforeEach(()=>{mocks.report.mockReset().mockResolvedValue(usage);});
describe("compact process metrics",()=>{
  it("calculates CPU deltas, permits multiple cores and treats restart or backward time as unknown",()=>{
    expect(sampledCpu(null,{cpuSeconds:2,at:1000})).toBeNull();
    expect(sampledCpu({cpuSeconds:2,at:1000},{cpuSeconds:3,at:3000})).toBe(50);
    expect(sampledCpu({cpuSeconds:2,at:1000},{cpuSeconds:6,at:3000})).toBe(200);
    expect(sampledCpu({cpuSeconds:6,at:1000},{cpuSeconds:1,at:3000})).toBeNull();
    expect(sampledCpu({cpuSeconds:2,at:1000},{cpuSeconds:3,at:500})).toBeNull();
  });
  it("keeps totals visible and reserves tables for expanded diagnostic details",async()=>{
    await mount(async(element)=>{
      expect(element.querySelectorAll(".process-metric")).toHaveLength(2);
      expect(element.querySelectorAll(".process-components article")).toHaveLength(1);
      expect(element.querySelector(".process-details")?.hasAttribute("open")).toBe(false);
      expect(element.textContent).toContain("128");
      expect(element.querySelector("table")?.textContent).toContain("LILO");
    });
  });
  it("retains the last sample on a refresh failure and retries without parallel requests",async()=>{
    vi.useFakeTimers();
    await mount(async(element)=>{
      mocks.report.mockRejectedValueOnce(new Error("sample unavailable"));
      await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
      expect(element.querySelectorAll(".process-metric")).toHaveLength(2);
      expect(element.querySelector('[role="alert"]')?.textContent).toContain("last sample");
      let finish!:(value:typeof usage)=>void;mocks.report.mockImplementationOnce(()=>new Promise((resolve)=>{finish=resolve;}));
      const button=element.querySelector("button")!;
      await act(async()=>button.click());expect(button.disabled).toBe(true);
      const count=mocks.report.mock.calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
      expect(mocks.report).toHaveBeenCalledTimes(count);
      await act(async()=>finish(usage));expect(button.disabled).toBe(false);
    });
  });
});
