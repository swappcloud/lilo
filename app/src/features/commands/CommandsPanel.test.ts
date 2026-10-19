import { describe, expect, it } from "vitest";
import type { CommandManifestEntry, PluginView } from "../../types";
import { commandGroups, matchingCommands } from "./CommandsPanel";
const command=(name:string,tool:string|null,example:string):CommandManifestEntry=>({name,tool,scope:"tool",description:"Save a note",requiresConfirm:false,examples:[example]});
describe("voice command discovery",()=>{
  it("finds accented examples and matches every search term without treating regex syntax as code",()=>{
    const commands=[command("notes.add","notes_add","anota uma reunião amanhã"),command("notes.list","notes_list","read my notes")];
    expect(matchingCommands(commands,"reuniao amanha")).toEqual([commands[0]]);
    expect(matchingCommands(commands,"reuniao missing")).toEqual([]);
    expect(matchingCommands(commands,"[.*")).toEqual([]);
    expect(matchingCommands(commands,"   ")).toHaveLength(2);
  });
  it("uses the owning plugin name instead of flattening all extensions into Other",()=>{
    const plugin:PluginView={manifest:{id:"com.example.notes",name:"Notebook",version:"1.0.0",api:1,capabilities:[]},enabled:true,loaded:true,manageable:true,tools:["notes_add"],ui:{settings:[],actions:[],status:[]}};
    const groups=commandGroups([command("notes.add","notes_add","add note"),command("media.play","media_play","play music"),command("end-call",null,"end call")],[plugin],"en",{music:"Music",conversation:"Conversation",other:"Other"});
    expect(groups.map((group)=>group.label)).toEqual(["Notebook","Music","Conversation"]);
    expect(groups[0].items[0].name).toBe("notes.add");
  });
});
