import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry, PluginView } from "../../types";
const mocks=vi.hoisted(()=>({catalog:vi.fn(),install:vi.fn(),refresh:vi.fn(),toast:vi.fn(),settings:{marketplaceUrl:"https://example.test/plugins"},plugins:[] as PluginView[]}));
vi.mock("../../lib/gateway",()=>({isTauri:()=>true,hasHost:()=>true,marketplaceList:mocks.catalog,pluginInstall:mocks.install}));
vi.mock("../../store/pluginsStore",()=>({usePluginsStore:(selector:(state:unknown)=>unknown)=>selector({plugins:mocks.plugins,loaded:true,error:null,refresh:mocks.refresh,setEnabled:vi.fn(),uninstall:vi.fn()})}));
vi.mock("../../store/sessionStore",()=>({useSessionStore:(selector:(state:unknown)=>unknown)=>selector({settings:mocks.settings,saveSettings:vi.fn()})}));
vi.mock("../../store/sceneStore",()=>({refreshScene:vi.fn()}));
vi.mock("../../store/toastStore",()=>({toast:mocks.toast}));
vi.mock("./PluginPage",()=>({pluginPageId:(id:string)=>"plugin:"+id}));
import { PluginsSection } from "./PluginsSection";
const view=(id:string,name:string):PluginView=>({manifest:{id,name,version:"1.0.0",api:1,capabilities:[]},enabled:true,loaded:true,manageable:true,tools:[],ui:{settings:[],status:[],actions:[],list:{title:"Saved",tool:"list"}}});
const entry=(id:string,name:string,updateAvailable:boolean):CatalogEntry=>({id,name,description:"",version:updateAvailable?"1.1.0":"1.0.0",api:1,capabilities:[],path:id,entry:"plugin.js",files:[],installed:true,installedVersion:"1.0.0",updateAvailable});
async function mount(test:(element:HTMLDivElement)=>Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const element=document.createElement("div");const root=createRoot(element);
  try {await act(async()=>root.render(<PluginsSection onNavigate={()=>{}}/>));await test(element);}
  finally {await act(async()=>root.unmount());vi.unstubAllGlobals();}
}
beforeEach(()=>{mocks.plugins=[view("notes","Notebook"),view("study","Language study")];mocks.catalog.mockReset().mockResolvedValue([entry("notes","Notebook",true),entry("study","Language study",false)]);mocks.install.mockReset().mockResolvedValue(undefined);mocks.refresh.mockReset().mockResolvedValue(undefined);});
describe("plugin update controls",()=>{
  it("offers updating next to Configure in the installed card and runs the install path",async()=>{
    await mount(async(element)=>{
      const card=element.querySelector(".plugin-row")!;const buttons=[...card.querySelectorAll("button")];
      expect(buttons.some((button)=>button.textContent?.includes("1.1.0"))).toBe(true);
      expect(buttons.some((button)=>button.textContent==="Configure")).toBe(true);
      await act(async()=>buttons.find((button)=>button.textContent?.includes("1.1.0"))!.click());
      expect(mocks.install).toHaveBeenCalledWith("notes");expect(mocks.refresh).toHaveBeenCalled();
    });
  });
  it("filters installed and catalog cards to plugins that have updates",async()=>{
    await mount(async(element)=>{
      const filter=element.querySelector(".plugin-filter-card select") as HTMLSelectElement;
      await act(async()=>{filter.value="updates";filter.dispatchEvent(new Event("change",{bubbles:true}));});
      expect(element.querySelectorAll(".plugin-row")).toHaveLength(1);expect(element.querySelectorAll(".catalog-row")).toHaveLength(1);
      expect(element.querySelector(".plugin-row")?.textContent).toContain("Notebook");
      expect(element.querySelector(".plugin-row")?.textContent).not.toContain("Language study");
    });
  });
});
