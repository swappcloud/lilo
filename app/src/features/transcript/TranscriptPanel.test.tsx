import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  state:{conversation:{id:"first",turns:[{id:"reply",speaker:"assistant",text:"Opening",final:false,timestamp:1}]},connectionState:"connected",sendText:vi.fn()},
}));
vi.mock("../../store/sessionStore",()=>({
  useSessionStore:(select:(s:typeof mocks.state)=>unknown)=>select(mocks.state),
  selectActiveConversation:(s:typeof mocks.state)=>s.conversation,
}));
vi.mock("../../i18n",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("../../shared/ui/primitives",()=>({SlidePanel:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock("./MessageBubble",()=>({MessageBubble:({turn}:{turn:{text:string}})=><p>{turn.text}</p>}));
import { TranscriptPanel } from "./TranscriptPanel";

test("new captions respect manual scrolling and resume following only at the bottom",async()=>{
  const scroll=vi.fn(), element=document.createElement("div"), root=createRoot(element);
  const original=HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView=scroll;
  const render=()=>root.render(<TranscriptPanel open onClose={()=>{}}/>);
  try {
    await act(async()=>render());expect(scroll).toHaveBeenCalledOnce();scroll.mockClear();
    const messages=element.querySelector(".msgs")!;
    Object.defineProperties(messages,{scrollHeight:{value:1200},clientHeight:{value:400},scrollTop:{value:100,writable:true}});
    messages.dispatchEvent(new Event("scroll"));
    mocks.state.conversation.turns[0].text="A longer streamed reply";
    await act(async()=>render());expect(scroll).not.toHaveBeenCalled();
    messages.scrollTop=800;messages.dispatchEvent(new Event("scroll"));
    mocks.state.conversation.turns[0].text="The final streamed reply";
    await act(async()=>render());expect(scroll).toHaveBeenCalledOnce();scroll.mockClear();
    messages.scrollTop=100;messages.dispatchEvent(new Event("scroll"));
    mocks.state.conversation={...mocks.state.conversation,id:"second"};
    await act(async()=>render());expect(scroll).toHaveBeenCalledOnce();
  } finally {
    await act(async()=>root.unmount());
    HTMLElement.prototype.scrollIntoView=original;
  }
});
