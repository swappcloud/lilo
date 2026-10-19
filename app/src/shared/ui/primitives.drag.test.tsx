// Native dragging belongs to the panel header, never to scrollable messages.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { SlidePanel } from "./primitives";

const native = vi.hoisted(()=>({drag:vi.fn(()=>Promise.resolve())}));
vi.mock("../../lib/gateway",()=>({isTauri:()=>true}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>({startDragging:native.drag})}));
vi.mock("../../i18n",()=>({useTranslation:()=>({t:(key:string)=>key})}));
afterEach(()=>{native.drag.mockClear();});
function pointer(target:Element) {
  const event=new Event("pointerdown",{bubbles:true,cancelable:true});
  Object.defineProperties(event,{button:{value:0},isPrimary:{value:true}});
  target.dispatchEvent(event);
}

test("scrollbar and transcript gestures do not drag the native window",async()=>{
  const element=document.createElement("div"), root=createRoot(element);
  try {
    await act(async()=>root.render(<SlidePanel title="Conversation" open onClose={()=>{}}><div role="log">A long conversation</div></SlidePanel>));
    pointer(element.querySelector('[role="log"]')!);
    expect(native.drag).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());}
});
test("the header drags the window while its close button stays interactive",async()=>{
  const close=vi.fn();
  const element=document.createElement("div"), root=createRoot(element);
  try {
    await act(async()=>root.render(<SlidePanel title="Conversation" open onClose={close}><div role="log">A long conversation</div></SlidePanel>));
    pointer(element.querySelector("h2")!);
    expect(native.drag).toHaveBeenCalledOnce();native.drag.mockClear();
    pointer(element.querySelector("button")!);element.querySelector("button")!.click();
    expect(native.drag).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
  } finally {await act(async()=>root.unmount());}
});
