import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../examples/plugins/stories/stories.js", import.meta.url), "utf8");
const studySource = readFileSync(new URL("../examples/plugins/study/study.js", import.meta.url), "utf8");
function plugin(files = new Map(), atomic = false, code = source, publish) {
  let now = 1000;
  const events = [];
  const clock = class extends Date {static now() {return now;}};
  const lilo = {read:(key)=>files.get(key) || null,write:(key,value)=>files.set(key,value),
    session:()=>({sessionId:"voice-session"}),hostInfo:()=>({permissions:["storage:self"]}),
    publish:(topic,payload)=>{events.push({topic,payload});publish?.(topic,payload);}};
  if (atomic) lilo.memory = (operation,args)=>{
    const stored = files.get("atomic:"+args.key);
    if (operation === "read") return stored ? {found:true,revision:stored.revision,schemaVersion:1,value:structuredClone(stored.value)} : {found:false,revision:0};
    assert.equal(args.expectedRevision,stored?.revision || 0);
    files.set("atomic:"+args.key,{revision:args.expectedRevision+1,value:structuredClone(args.value),purged:args.purgePrevious});
    return {revision:args.expectedRevision+1};
  };
  const context = vm.createContext({lilo,Date:clock});vm.runInContext(code,context);
  return {context,events,time:(value)=>{now=value;},phase:()=>JSON.parse(context.invoke("stories_context",{}).context).phase,
    narration:(id,words,at=now)=>context.event("conversation.turn",{sessionId:"voice-session",at,firstSeenAt:at,turn:{id,speaker:"assistant",text:words}},"host")};
}
test("saved stories never start narration after a restart", () => {
  const files = new Map(), app = plugin(files);
  assert.equal(app.phase(),"inactive");
  app.context.invoke("stories_start",{theme:"Pinocchio",mode:"bedtime",minutes:5});
  app.narration("chapter-1","The little wooden boy rested under the moon.");app.time(3000);app.context.tick();
  const restarted = plugin(files);
  assert.equal(restarted.phase(),"inactive");
  const resumed = JSON.parse(restarted.context.invoke("stories_continue",{}).context);
  assert.equal(resumed.phase,"telling");assert.equal(resumed.chapter,2);
  assert.match(resumed.previousEnding[0],/wooden boy/);
  assert.equal(resumed.targetWords,450);
});
test("captions are idempotent, bounded and contain no user turns or foreign session turns", () => {
  const files = new Map(), app = plugin(files);
  app.context.invoke("stories_start",{});
  app.narration("first","A quiet garden.");app.narration("first","A quiet garden in the moonlight.");
  for (const [speaker,sessionId] of [["user","voice-session"],["assistant","other-session"]]) app.context.event("conversation.turn",{at:1000,firstSeenAt:1000,sessionId,turn:{id:"private",speaker,text:"private detail"}},"host");
  app.context.event("conversation.turn",{at:1000,firstSeenAt:999,sessionId:"voice-session",turn:{id:"old",speaker:"assistant",text:"Earlier conversation"}},"host");
  app.time(3000);app.context.tick();
  const story = JSON.parse(files.get("stories.json")).stories[0];
  assert.equal(story.chapters[0].turns.length,1);
  assert.match(story.chapters[0].turns[0].text,/moonlight/);
  assert.doesNotMatch(files.get("stories.json"),/private detail|Earlier conversation/);
});
test("explicit stop and existing interaction end stop narration without resuming from context", () => {
  const app = plugin();app.context.invoke("stories_start",{});app.context.invoke("stories_pause",{});
  assert.equal(app.phase(),"inactive");
  app.context.invoke("stories_continue",{});
  app.context.event("conversation.ended",{sessionId:"other-session",at:1000},"host");assert.equal(app.phase(),"telling");
  app.context.event("conversation.ended",{sessionId:"voice-session",at:1000},"host");assert.equal(app.phase(),"inactive");
});
test("late delivery of the final caption keeps the ending but subsequent ordinary replies are excluded", () => {
  const files = new Map(), app = plugin(files);app.context.invoke("stories_start",{});
  app.time(2000);app.context.invoke("stories_pause",{});app.narration("last","And everyone slept peacefully.",1900);
  app.narration("ordinary","Here is the weather forecast.",2100);app.time(4000);app.context.tick();
  assert.match(files.get("stories.json"),/slept peacefully/);assert.doesNotMatch(files.get("stories.json"),/weather forecast/);
});
test("the shelf supports rename, continuation and deletion with atomic history purge", () => {
  const files = new Map(), app = plugin(files,true);app.context.invoke("stories_start",{theme:"The fox"});
  app.narration("a","The fox followed the stars.");app.context.tick();
  assert.equal(app.context.invoke("stories_list",{}).items[0].action.tool,"stories_pause");
  app.context.invoke("stories_pause",{});
  const item = app.context.invoke("stories_list",{}).items[0];assert.equal(item.action.tool,"stories_continue");
  assert.equal(item.edit.value,"The fox");
  app.context.invoke(item.edit.tool,{...item.edit.args,[item.edit.matchParameter]:item.edit.value,[item.edit.valueParameter]:"The starlit fox"});
  assert.equal(app.context.invoke("stories_list",{}).items[0].label,"The starlit fox");
  assert.throws(()=>app.context.invoke("stories_rename",{id:1,title:"The fox",replacement:"Wrong"}),/changed/);
  app.context.invoke("stories_forget",{id:1});assert.equal(app.phase(),"inactive");
  assert.equal(files.get("atomic:stories").purged,true);assert.equal(files.get("atomic:stories").value.stories.length,0);
});
test("deleting the active story ends its mode; deleting another story does not interrupt it", () => {
  const app=plugin();app.context.invoke("stories_start",{theme:"The fox"});app.context.invoke("stories_start",{theme:"The moon"});
  const unrelated=app.context.invoke("stories_forget",{id:1});assert.equal(unrelated.context,undefined);assert.equal(app.phase(),"telling");
  const ended=app.context.invoke("stories_forget",{id:2});assert.equal(JSON.parse(ended.context).phase,"inactive");assert.equal(app.phase(),"inactive");
});
test("invalid durations and corrupted storage preserve the existing journal", () => {
  const app = plugin();for (const minutes of [0,31,2.5,"invalid"]) assert.throws(()=>app.context.invoke("stories_start",{minutes}),/length/);
  assert.equal(app.context.invoke("stories_list",{}).count,0);
  const files = new Map([["stories.json",'{"version":99}']]);assert.throws(()=>plugin(files),/preserved/);assert.equal(files.get("stories.json"),'{"version":99}');
});
test("continuation follows the latest narrated story and rejects ambiguous titles", () => {
  const app=plugin();app.context.invoke("stories_start",{theme:"The fox"});app.time(2000);
  app.context.invoke("stories_start",{theme:"The moon"});app.time(3000);
  app.context.invoke("stories_continue",{id:1});app.context.invoke("stories_pause",{});app.time(4000);
  assert.equal(JSON.parse(app.context.invoke("stories_continue",{}).context).storyId,1);
  app.context.invoke("stories_start",{theme:"The fox"});
  assert.throws(()=>app.context.invoke("stories_continue",{title:"The fox"}),/More than one/);
  assert.ok(app.context.describe().prompt.length <= 600);
});
test("study and storytelling deactivate one another only through authenticated explicit activity events", () => {
  let stories,study;
  stories = plugin(new Map(),false,source,(topic,payload)=>study?.context.event(topic,payload,"com.lilo.stories"));
  study = plugin(new Map(),false,studySource,(topic,payload)=>stories.context.event(topic,payload,"com.lilo.study"));
  study.context.invoke("study_start",{language:"English"});
  stories.context.invoke("stories_start",{});
  assert.equal(JSON.parse(study.context.invoke("study_context",{}).context).phase,"inactive");
  study.context.invoke("study_start",{language:"English"});assert.equal(stories.phase(),"inactive");
  stories.context.invoke("stories_start",{});
  stories.context.event("activity.started",{owner:"com.lilo.study"},"unrelated");assert.equal(stories.phase(),"telling");
});
