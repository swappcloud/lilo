import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { PluginView } from "../../types";

const mocks=vi.hoisted(()=>({read:vi.fn(),action:vi.fn(),interrupt:vi.fn(),send:vi.fn(),refresh:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../../lib/gateway",()=>({isTauri:()=>true,hasHost:()=>true,runTool:mocks.read,onPluginEvent:vi.fn().mockResolvedValue(()=>{}),pluginImage:vi.fn(),pluginSettings:vi.fn()}));
vi.mock("../../store/sessionStore",()=>({useSessionStore:Object.assign(
  (select:(s:unknown)=>unknown)=>select({runTool:mocks.action}),
  {getState:()=>({connectionState:"connected",interrupt:mocks.interrupt,sendText:mocks.send})},
)}));
vi.mock("../../store/pluginsStore",()=>({usePluginsStore:Object.assign(
  (select:(s:unknown)=>unknown)=>select({setSettings:vi.fn()}),{getState:()=>({refresh:mocks.refresh})},
)}));
vi.mock("../../store/settingsDraft",()=>({useSettingsDraft:(select:(s:unknown)=>unknown)=>select({})}));
vi.mock("../../store/sceneStore",()=>({refreshScene:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../../store/toastStore",()=>({toast:vi.fn()}));
vi.mock("../../i18n",()=>({useTranslation:()=>({locale:"en",t:(key:string)=>key})}));
import { PluginPage } from "./PluginPage";

const plugin:PluginView={
  manifest:{id:"com.lilo.stories",name:"Story time",api:1,version:"1.0.0",capabilities:[]},
  enabled:true,loaded:true,manageable:true,tools:["stories_list","stories_rename","stories_continue"],
  ui:{settings:[],status:[],actions:[],list:{title:"Stories",tool:"stories_list",empty:"No stories"}},
};
const row={label:"The fox",detail:"Bedtime · 5 min · 1 chapter",edit:{tool:"stories_rename",label:"Rename story",matchParameter:"title",valueParameter:"replacement",value:"The fox",args:{id:1}},
  action:{tool:"stories_continue",label:"Continue story",args:{id:1}}};
afterEach(()=>{vi.clearAllMocks();});

test("title editing uses its explicit value while keeping shelf metadata visible",async()=>{
  mocks.read.mockResolvedValue({items:[row]});mocks.action.mockResolvedValue({summary:"Renamed"});
  const element=document.createElement("div"),root=createRoot(element);
  try {
    await act(async()=>root.render(<PluginPage plugin={plugin}/>));
    expect(element.textContent).toContain(row.detail);
    const button=(label:string)=>Array.from(element.querySelectorAll("button")).find((b)=>b.textContent?.trim()===label)!;
    await act(async()=>button("plugins.editNote").click());
    expect(element.querySelector("textarea")?.value).toBe("The fox");
    await act(async()=>button("plugins.saveNote").click());
    expect(mocks.action).toHaveBeenCalledWith("stories_rename",{id:1,title:"The fox",replacement:"The fox"});
    expect(mocks.interrupt).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
  } finally {await act(async()=>root.unmount());}
});
test("background reads stay silent and explicit continuation waits for interruption before relaying context",async()=>{
  mocks.read.mockResolvedValue({items:[row]});
  mocks.action.mockResolvedValue({summary:"Continue the story",context:'{"phase":"telling"}'});
  let complete!:()=>void;
  mocks.interrupt.mockImplementation(()=>new Promise<void>((resolve)=>{complete=resolve;}));
  const element=document.createElement("div"),root=createRoot(element);
  try {
    await act(async()=>root.render(<PluginPage plugin={plugin}/>));
    expect(mocks.interrupt).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
    const button=Array.from(element.querySelectorAll("button")).find((b)=>b.textContent?.includes("Continue story"))!;
    await act(async()=>button.click());expect(mocks.interrupt).toHaveBeenCalledOnce();expect(mocks.send).not.toHaveBeenCalled();
    await act(async()=>complete());
    expect(mocks.send).toHaveBeenCalledWith(expect.stringContaining('phase'),{hidden:true});
    expect(mocks.send).toHaveBeenCalledOnce();
  } finally {await act(async()=>root.unmount());}
});
