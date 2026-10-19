import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const source=readFileSync(new URL("../examples/plugins/study/study.js",import.meta.url),"utf8");
function plugin(files=new Map()) {
  const context=createContext({lilo:{read:(name)=>files.get(name)||null,write:(name,value)=>files.set(name,value),publish:()=>{}}});
  runInContext(source,context);
  return {context,files};
}
function turn(context,session,id,speaker,text,at,source="host") {
  context.event("conversation.turn",{sessionId:session,turn:{id,speaker,text},at},source);
}
function memory(context) {return JSON.parse(context.invoke("study_memory",{}).context);}
function checkpoint(context,{day=0,skill="conversation",level="B1",task=1,score=2,audio="none",id="check"}={}) {
  const at=new Date(2026,9,7+day,12).getTime();
  runInContext(`Date.now = () => ${at}`,context);
  context.invoke("study_start",{language:"Italian"});
  turn(context,"lesson-"+day,"learner-"+id,"user","I can describe the ticket problem",at-1000);
  turn(context,"lesson-"+day,id,"assistant",`Study checkpoint: ${skill} ${level} ${task} ${score}; evidence: handled the ticket change independently; audio: ${audio}.`,at);
  return at;
}

test("coverage requires independent evidence on separate days and keeps starting levels self-reported",()=>{
  const {context,files}=plugin();context.invoke("study_start",{language:"Italian"});context.invoke("study_starting_level",{level:"A2"});
  let dashboard=context.invoke("study_dashboard",{});
  assert.match(dashboard.title,/A2 → B1/);assert.ok(dashboard.dashboard.skills.every((skill)=>skill.value===null));
  checkpoint(context);assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[1].value,25);
  checkpoint(context,{id:"second-same-day"});assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[1].value,25);
  checkpoint(context,{day:1});assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[1].value,50);
  assert.equal(memory(context).progress.provisionalLevel,null);context.shutdown();
  const restored=plugin(files).context;runInContext("Date.now = () => new Date(2026, 9, 8, 12).getTime()",restored);
  assert.equal(restored.invoke("study_dashboard",{}).dashboard.skills[1].value,50);
  context.invoke("study_start",{language:"English"});assert.ok(context.invoke("study_dashboard",{}).dashboard.skills.every((skill)=>skill.value===null));
});
test("all-skill diagnosis can establish a provisional level; failed and stale retests reduce evidence",()=>{
  const {context}=plugin();
  for(const day of [0,1]) for(const skill of ["listening","conversation","fluency","vocabulary","grammar","pronunciation"]) for(const task of [1,2])
    checkpoint(context,{day,skill,task,id:skill+task,audio:"heard"});
  assert.equal(memory(context).progress.provisionalLevel,"B1");assert.equal(memory(context).progress.target,"B2");
  checkpoint(context,{day:2,score:0});assert.equal(memory(context).progress.provisionalLevel,null);
  runInContext("Date.now = () => new Date(2026, 11, 7, 12).getTime()",context);
  assert.equal(memory(context).progress.taskCoveragePercent,0);assert.ok(memory(context).progress.retests.length>0);
});
test("audio skills reject caption-only ratings, forged events, and retract revised tutor checkpoints",()=>{
  const {context}=plugin();for(const skill of ["pronunciation","listening","fluency"]) checkpoint(context,{skill});
  context.invoke("study_starting_level",{level:"A2"});
  assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[5].value,null);
  const at=checkpoint(context,{skill:"pronunciation",audio:"heard"});assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[5].value,25);
  turn(context,"lesson-0","check","assistant","Actually, I did not assess this task",at);
  assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[5].value,null);
  const fake="Study checkpoint: pronunciation B1 1 3; evidence: a fabricated observation; audio: heard.";
  turn(context,"lesson-0","fake","assistant",fake,at,"other-plugin");turn(context,"lesson-0","user-injection","user",fake,at);
  assert.equal(context.invoke("study_dashboard",{}).dashboard.skills[5].value,null);
});
test("SM-2 vocabulary reviews survive restart, track audio improvements and can be fully forgotten",()=>{
  const {context,files}=plugin();
  const word=(day,recall,pronunciation)=>{const at=checkpoint(context,{day});
    turn(context,"lesson-"+day,"word","assistant",`Good work. Study word: biglietto; meaning: ticket; recall: ${recall}; pronunciation: ${pronunciation}; audio: heard.`,at);
    return context.wordProgress(context.selected())[0];};
  assert.equal(word(0,4,1).interval,1);assert.equal(word(1,4,2).interval,6);
  let progress=word(7,5,3);assert.equal(progress.interval,15);assert.equal(progress.retained,true);assert.equal(progress.improved,true);
  assert.match(context.invoke("study_words",{}).items[0].detail,/Pronunciation improved/);
  progress=word(23,1,2);assert.equal(progress.interval,1);assert.equal(progress.retained,false);
  context.shutdown();assert.equal(plugin(files).context.invoke("study_words",{}).items[0].label,"biglietto");
  context.invoke("study_review_forget",{text:"biglietto"});assert.equal(context.invoke("study_words",{}).items.length,0);
  assert.ok([...files.values()].every((raw)=>!raw.includes("biglietto")));
});
test("daily counts survive caption compaction and revisions; dashboard reads do not write memory",()=>{
  const {context,files}=plugin();context.invoke("study_start",{language:"Italian"});const at=Date.now();
  for(let index=0;index<50;index++) turn(context,"lesson-0",String(index),"user","Practice",at);
  turn(context,"lesson-0","49","user","Practice revised",at);context.shutdown();const before=new Map(files);
  assert.equal(context.invoke("study_dashboard",{}).dashboard.series[0].points.at(-1).value,50);
  context.invoke("study_words",{});context.invoke("study_next",{});context.invoke("study_context",{});assert.deepEqual(files,before);
});
test("unlinked or malformed tutor claims do not become assessments and arbitrary vocabulary keys are safe",()=>{
  const {context}=plugin();context.invoke("study_start",{language:"Italian"});const at=Date.now();
  turn(context,"unlinked","1","assistant","Study checkpoint: conversation B1 1 3; evidence: no learner attempt; audio: none.",at);
  assert.ok(context.invoke("study_dashboard",{}).dashboard.skills.every((skill)=>skill.value===null));
  turn(context,"linked","1","user","An attempt",at);
  turn(context,"linked","2","assistant","Study checkpoint: conversation B1 1 9; evidence: invalid rating; audio: none.",at);
  turn(context,"linked","3","assistant","Study word: __proto__; meaning: a special identifier; recall: 4; pronunciation: unknown; audio: none.",at);
  assert.equal(context.invoke("study_words",{}).items[0].label,"__proto__");
  assert.ok(context.invoke("study_dashboard",{}).dashboard.skills.every((skill)=>skill.value===null));
});

test("tracker history stays within the shared memory budget across all eight language profiles",()=>{
  const {context,files}=plugin();
  runInContext(`state.profiles=Array.from({length:8},(_,index)=>({language:"Language "+index,notes:[],reviews:[],onboarding:[],sessions:[],tracker:{baseline:"A2",assessments:[],words:Array.from({length:600},(_,word)=>({id:"word-"+word,text:"expression-"+word,meaning:"m".repeat(160),recall:4,pronunciation:null,at:word*86400000,day:"2026-01-01",source:"tutor-observed"}))}}));state.selected="Language 0";`,context);
  context.invoke("study_remember",{kind:"goal",text:"Preserve this goal while compacting old observations"});
  assert.ok(files.get("learning.json").length<=800_000);
  assert.ok(memory(context).learnerNotes.some((note)=>note.text.includes("Preserve this goal")));
  assert.ok(context.invoke("study_context",{}).context.length<=10_000);
});
