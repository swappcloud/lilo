import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
const source=readFileSync(new URL("../examples/plugins/notes/notes.js",import.meta.url),"utf8");
function plugin(files=new Map(),atomic=false) {
  const events=[];
  const lilo={read:(key)=>files.get(key)||null,write:(key,value)=>files.set(key,value),publish:(topic)=>events.push(topic),hostInfo:()=>({permissions:atomic?["storage:self"]:[]})};
  if(atomic) lilo.memory=(operation,args)=>{
    const stored=files.get("memory");
    if(operation==="read")return stored?{found:true,revision:stored.revision,value:structuredClone(stored.value)}:{found:false,revision:0};
    assert.equal(args.expectedRevision,stored?.revision||0);
    files.set("memory",{revision:args.expectedRevision+1,value:structuredClone(args.value),purged:args.purgePrevious});
    return {revision:args.expectedRevision+1};
  };
  const context=createContext({lilo});runInContext(source,context);return {context,files,events};
}
test("notes are a live list with complete CRUD and stable IDs for duplicates",()=>{
  const {context,files,events}=plugin(new Map([["notes.txt","Existing note\nSame note\nSame note"]]));
  const ui=context.describe().ui;assert.equal(ui.list.tool,"notes_list");assert.equal(ui.forms[0].tool,"notes_add");
  const rows=context.invoke("notes_list",{}).items;assert.equal(rows.length,3);
  const second=rows[0];context.invoke("notes_edit",{...second.edit.args,text:second.detail,replacement:"Edited second duplicate"});
  assert.equal(context.invoke("notes_list",{}).notes.filter((text)=>text==="Same note").length,1);
  context.invoke("notes_add",{text:"A new\nmultiline note"});assert.equal(plugin(files).context.invoke("notes_list",{}).count,4);
  const fresh=context.invoke("notes_list",{}).items[0];context.invoke("notes_delete",fresh.deleteAction.args);
  assert.equal(context.invoke("notes_list",{}).count,3);assert.ok(events.includes("notes.changed"));
  assert.equal(context.describe().commands.find((command)=>command.tool==="notes_delete").requiresConfirm,true);
  context.invoke("notes_clear",{});assert.equal(context.invoke("notes_list",{}).count,0);
});
test("notes reject stale edits and keep old content when new input is invalid",()=>{
  const {context}=plugin();context.invoke("notes_add",{text:"Original"});
  const row=context.invoke("notes_list",{}).items[0];context.invoke("notes_edit",{id:row.edit.args.id,text:"Original",replacement:"Current"});
  assert.throws(()=>context.invoke("notes_edit",{id:row.edit.args.id,text:"Original",replacement:"Stale"}),/changed/);
  assert.throws(()=>context.invoke("notes_add",{text:"x".repeat(2001)}),/2000/);
  assert.equal(context.invoke("notes_list",{}).notes[0],"Current");context.configure({max:10000});
  for(let index=0;index<60;index++)context.invoke("notes_add",{text:"Note "+index});
  assert.equal(context.invoke("notes_list",{}).count,50);
});
test("native memory migrates plaintext and purges old recovery versions after editing or forgetting",()=>{
  const {context,files}=plugin(new Map([["notes.txt","A private note"]]),true);
  const row=context.invoke("notes_list",{}).items[0];assert.equal(files.get("notes.txt"),"");
  context.invoke("notes_edit",{id:row.edit.args.id,text:row.detail,replacement:"Updated"});assert.equal(files.get("memory").purged,true);
  assert.equal(plugin(files,true).context.invoke("notes_list",{}).notes[0],"Updated");
  context.invoke("notes_clear",{});assert.equal(files.get("memory").purged,true);assert.equal(files.get("memory").value.notes.length,0);
});
