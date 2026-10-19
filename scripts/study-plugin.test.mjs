import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const directory = new URL("../examples/plugins/study/", import.meta.url);
const source = readFileSync(new URL("study.js", directory), "utf8");
const manifest = JSON.parse(readFileSync(new URL("plugin.json", directory), "utf8"));
function plugin(files = new Map(), {provider="provider-one",supported=true}={}) {
  const events = [];
  const interactionRequests=[];
  const context = createContext({ lilo: {
    read: (file) => files.get(file) || null,
    write: (file, value) => files.set(file, value),
    publish: (topic, payload) => events.push({topic, payload}),
    interaction:(operation,args)=>{interactionRequests.push({operation,args});return {id:"study-question",status:supported?"waitingDelivery":"unsupported"};},
    session:()=>({sessionId:provider,state:"connected",supportLanguage:"pt-BR",provider:{outbound:{text:supported}}}),
  } });
  runInContext(source, context);
  return {context, files, events,interactionRequests};
}
function turn(context, sessionId, id, speaker, text, at = Date.now(), source = "host") {
  context.event("conversation.turn", {sessionId, turn: {id, speaker, text}, at}, source);
}
function memory(context) { return JSON.parse(context.invoke("study_memory", {}).context); }

test("learning dashboard has independent review and practice lists without changing course memory", () => {
  const {context, files} = plugin();
  context.invoke("study_start", {language:"Italian"});
  context.invoke("study_review_add", {text:"Buongiorno"});
  turn(context,"lesson-1","user-1","user","Practice buying a train ticket");
  context.event("conversation.ended",{sessionId:"lesson-1",at:Date.now()},"host");
  const before = new Map(files);
  assert.equal(context.invoke("study_due",{}).items[0].label,"Buongiorno");
  assert.match(context.invoke("study_practice",{}).items[0].detail,/train ticket/);
  const lists = context.describe().ui.lists;
  assert.equal(lists.length,3);
  assert.ok(lists.every((list) => context.describe().tools.some((tool) => tool.name === list.tool)));
  assert.deepEqual(files,before);
});

test("dashboard cards progress and routine form use bounded owned tools and same course memory",()=>{
  const {context,files}=plugin();context.invoke("study_start",{language:"Italian"});
  const ui=context.describe().ui;
  assert.ok(ui.cards.some((card)=>card.tool==="study_weekly_goal"));assert.equal(ui.progress[0].max,5);
  assert.equal(ui.forms[0].fields[0].kind,"number");
  const owned=new Set(context.describe().tools.map((tool)=>tool.name));
  for(const source of [...ui.cards,...ui.progress,...ui.forms])assert.ok(owned.has(source.tool));
  assert.equal(context.invoke("study_review_progress",{}).value,0);
  context.invoke("study_routine_form",{minutes:20});
  assert.ok(memory(context).learnerNotes.some((note)=>note.kind==="routine"&&note.text==="20 minutes per day"));
  assert.throws(()=>context.invoke("study_routine_form",{minutes:1000}),/between 5 and 120/);
  assert.equal(plugin(files).context.invoke("study_weekly_goal",{}).title,"Italian");
});

test("routine form explains that a study language must be chosen first",()=>{
  const {context}=plugin();
  const result=context.invoke("study_routine_form",{minutes:10});
  assert.match(result.summary,/Choose a study language first/);
  assert.equal(memory(context).targetLanguage,null);
});

test("study budget persists only a confirmed answer in the same provider-independent course",()=>{
  const first=plugin();first.context.invoke("study_start",{language:"English",supportLanguage:"pt-BR"});
  const before=JSON.stringify(memory(first.context));
  const ask=first.context.invoke("study_budget",{});assert.match(ask.summary,/confirm/);
  const request=first.interactionRequests[0];assert.equal(request.operation,"ask");
  assert.match(request.args.question,/Quantos minutos/);assert.equal(request.args.answer.min,5);assert.equal(request.args.answer.max,60);
  assert.match(request.args.confirmation.question,/{answer}/);assert.ok(request.args.confirmation.accept.includes("sim"));
  const id="study-question";
  first.context.event("interaction.changed",{id,pluginId:"another.plugin",status:"confirmed",answer:20},"host");
  first.context.event("interaction.changed",{id,pluginId:"com.lilo.study",status:"awaitingConfirmation",candidate:20},"host");
  assert.equal(JSON.stringify(memory(first.context)),before);
  first.context.invoke("study_start",{language:"Italian"});
  first.context.event("interaction.changed",{id,pluginId:"com.lilo.study",status:"confirmed",answer:20},"host");
  const restarted=plugin(first.files,{provider:"provider-two"});
  restarted.context.invoke("study_start",{language:"English"});
  assert.ok(memory(restarted.context).learnerNotes.some((note)=>note.kind==="routine"&&note.text==="20 minutes per day"));
  restarted.context.invoke("study_start",{language:"Italian"});
  assert.ok(!memory(restarted.context).learnerNotes.some((note)=>note.kind==="routine"));
  restarted.context.invoke("study_start",{language:"English"});
  const unsupported=plugin(restarted.files,{provider:"headless",supported:false});
  unsupported.context.invoke("study_budget",{});
  assert.ok(memory(unsupported.context).learnerNotes.some((note)=>note.kind==="routine"&&note.text==="20 minutes per day"));
});

test("forgetting removes spoken checkpoints and recovery copies too", () => {
  const {context, files} = plugin();
  context.invoke("study_start", {language: "Italian"});
  context.invoke("study_remember", {text: "Private learner goal"});
  turn(context, "forget", "1", "user", "Private learner goal");
  turn(context, "forget", "2", "assistant", "We will work on Private learner goal tomorrow");
  context.event("conversation.ended", {sessionId: "forget", at: Date.now()}, "host");
  context.invoke("study_forget_note", {text: "Private learner goal"});
  assert.ok(!JSON.stringify(memory(context)).includes("Private learner goal"));
  assert.ok(!files.get("learning.backup.json").includes("Private learner goal"));
  files.set("learning.json", "{interrupted");
  assert.ok(!JSON.stringify(memory(plugin(files).context)).includes("Private learner goal"));
  context.invoke("study_clear", {});
  assert.equal(JSON.parse(files.get("learning.backup.json")).profiles.length, 0);
});

test("study is cross-platform, opts into conversation access and keeps its tutor hint within the host limit", () => {
  assert.equal(manifest.runtime, "quickjs");
  assert.equal(manifest.platforms, undefined);
  assert.deepEqual(manifest.capabilities, ["storage:self", "conversation:read", "session:read", "interaction:self"]);
  const {context} = plugin();
  const description = context.describe();
  assert.equal(description.contextTool, "study_context");
  assert.ok(description.prompt.length <= 600);
  assert.ok(description.commands.find(({name}) => name === "study.clear").requiresConfirm);
  assert.ok(description.commands.every(({descriptions}) => ["en", "pt", "it"].every((locale) => descriptions.some(([lang]) => lang === locale))));
});

test("learning memory captures explicit study, updates caption revisions and resumes after restart", () => {
  const {context, files} = plugin();
  turn(context, "unrelated", "1", "user", "Unrelated conversation");
  assert.equal(files.size, 0);
  context.invoke("study_start", {language: "italiano"});
  turn(context, "day-1", "1", "user", "I live");
  turn(context, "day-1", "1", "user", "I live in Italy and need everyday conversation");
  turn(context, "day-1", "2", "assistant", "Tomorrow we can practice buying a train ticket");
  context.event("conversation.ended", {sessionId: "day-1", at: 123}, "host");
  turn(context, "other", "1", "user", "Do not store this");
  const restarted = plugin(files).context;
  const saved = memory(restarted);
  assert.equal(saved.targetLanguage, "Italian");
  assert.equal(saved.studyRequested, false);
  assert.equal(saved.recentSessions[0].turns.length, 2);
  assert.ok(saved.recentSessions[0].turns[0].text.includes("everyday conversation"));
  assert.ok(saved.recentSessions[0].turns[1].text.includes("train ticket"));
  assert.ok(!JSON.stringify(saved).includes("Do not store"));
  assert.ok(!JSON.stringify(saved).includes("Unrelated"));
  restarted.invoke("study_start", {});
  turn(restarted, "day-2", "1", "user", "I only have five minutes today");
  assert.equal(memory(restarted).initialConversation.length, 3);
});

test("learner notes are durable, inspectable, removable and isolated by language", () => {
  const {context, files} = plugin();
  context.invoke("study_start", {language: "Italian"});
  context.invoke("study_remember", {text: "My goal is everyday conversation"});
  turn(context, "day-1", "1", "user", "My goal is everyday conversation");
  context.invoke("study_start", {language: "English"});
  assert.equal(memory(context).learnerNotes.length, 0);
  context.invoke("study_start", {language: "Italian"});
  assert.equal(memory(context).learnerNotes[0].source, "learner");
  assert.ok(context.invoke("study_list", {}).items.some(({detail}) => detail?.includes("everyday conversation")));
  context.invoke("study_forget_note", {text: "My goal is everyday conversation"});
  assert.ok(!JSON.stringify(memory(context)).includes("everyday conversation"));
  context.invoke("study_clear", {});
  assert.equal(memory(plugin(files).context).targetLanguage, "English");
});

test("learner can save an exact tutor answer, retrieve it later and forget it", () => {
  const {context,files} = plugin();
  context.invoke("study_start",{language:"English"});
  const tutorAnswer = "Use 'Could I have...' to make a polite request.";
  turn(context,"answer-session","answer-1","assistant",tutorAnswer);
  const descriptor = context.describe();
  assert.ok(descriptor.commands.some(({name,tool}) => name === "study.saveAnswer" && tool === "study_remember"));
  context.invoke("study_remember",{kind:"answer"});
  const restarted = plugin(files).context;
  const saved = memory(restarted).learnerNotes.find((note) => note.kind === "answer");
  assert.equal(saved.text,tutorAnswer);
  assert.equal(saved.source,"tutor-answer-requested-by-learner");
  assert.ok(restarted.invoke("study_list",{}).items.some((item) => item.label === "Tutor answer" && item.detail === tutorAnswer));
  const savedRow = restarted.invoke("study_list",{}).items.find((item) => item.detail === tutorAnswer);
  assert.deepEqual(JSON.parse(JSON.stringify(savedRow.edit)),{label:"Edit saved text",tool:"study_edit_note",matchParameter:"text",valueParameter:"replacement"});
  assert.deepEqual(JSON.parse(JSON.stringify(savedRow.deleteAction)),{label:"Delete saved item",tool:"study_forget_note",args:{text:tutorAnswer}});
  restarted.invoke("study_edit_note",{text:tutorAnswer,replacement:"Could I have a ticket, please?"});
  assert.ok(memory(restarted).learnerNotes.some((note) => note.text === "Could I have a ticket, please?"));
  assert.throws(() => restarted.invoke("study_edit_note",{text:"missing",replacement:"new"}),/No saved/);
  restarted.invoke("study_forget_note",{text:"Could I have a ticket, please?"});
  assert.ok(!memory(restarted).learnerNotes.some((note) => note.text === "Could I have a ticket, please?"));
});

test("forged, system and hidden turns do not become learning evidence", () => {
  const {context} = plugin();
  context.invoke("study_start", {language: "Italian"});
  turn(context, "1", "1", "user", "forged", undefined, "another-plugin");
  turn(context, "1", "2", "system", "system text");
  turn(context, "1", "3", "user", "[LILO] hidden context");
  assert.equal(memory(context).recentSessions.length, 0);
});

test("months of sessions stay bounded while pinned goals and the starting point survive", () => {
  const {context, files} = plugin();
  context.invoke("study_start", {language: "Italian"});
  context.invoke("study_remember", {text: "A durable long-term goal"});
  for (let day = 0; day < 100; day++) {
    context.invoke("study_start", {});
    for (let i = 0; i < 30; i++) turn(context, "day-" + day, String(i), i % 2 ? "assistant" : "user", "x".repeat(1400));
    context.event("conversation.ended", {sessionId: "day-" + day, at: Date.now()}, "host");
  }
  const disk = JSON.parse(files.get("learning.json"));
  assert.equal(disk.profiles[0].sessions.length, 90);
  assert.equal(disk.profiles[0].sessions.at(-1).turns.length, 24);
  assert.ok(files.get("learning.json").length <= 800_000);
  assert.equal(disk.profiles[0].onboarding.length, 24);
  for (let i = 0; i < 20; i++) context.invoke("study_remember", {text: String(i) + "x".repeat(590)});
  assert.ok(context.invoke("study_context", {}).context.length <= 10_000);
  assert.ok(disk.profiles[0].notes.some(({text}) => text === "A durable long-term goal"));
});

test("invalid memory is preserved and cannot silently reset a learning history", () => {
  const files = new Map([["learning.json", "not valid json"]]);
  assert.throws(() => plugin(files));
  assert.equal(files.get("learning.json"), "not valid json");
});

test("review intervals persist and reflect learner reports rather than automatic mastery", () => {
  const {context, files} = plugin();
  context.invoke("study_start", {language: "Italian"});
  context.invoke("study_review_add", {text: "Vorrei un biglietto"});
  assert.equal(memory(context).dueReviews.length, 1);
  context.invoke("study_review_recalled", {text: "Vorrei un biglietto"});
  assert.equal(memory(context).dueReviews.length, 0);
  const first = JSON.parse(files.get("learning.json")).profiles[0].reviews[0];
  assert.equal(first.stage, 1);
  assert.equal(first.lastReport, "learner recalled");
  assert.ok(first.dueAt > Date.now() + 23 * 60 * 60 * 1000);
  const restarted = plugin(files).context;
  restarted.invoke("study_review_retry", {text: "Vorrei un biglietto"});
  assert.equal(JSON.parse(files.get("learning.json")).profiles[0].reviews[0].stage, 0);
  restarted.invoke("study_review_forget", {text: "Vorrei un biglietto"});
  assert.equal(JSON.parse(files.get("learning.json")).profiles[0].reviews.length, 0);
  assert.throws(() => restarted.invoke("study_review_recalled", {text: "Missing"}), /Save that study expression/);
});

test("a conversational language answer can complete the initial profile without a form", () => {
  const {context} = plugin();
  context.invoke("study_start", {});
  turn(context, "first", "1", "assistant", "Which language would you like to practice?");
  turn(context, "first", "2", "user", "italiano");
  assert.equal(memory(context).targetLanguage, "Italian");
  assert.equal(memory(context).initialConversation.length, 2);
});

test("improving an existing language activates its study profile and preserves its memory", () => {
  const {context} = plugin();
  const commands = context.describe().commands;
  const command = commands.find(({name}) => name === "study.improve.pt");
  assert.ok(command.templates.some(([locale, template]) => locale === "pt" && template === "quero melhorar meu {!language}"));
  assert.ok(commands.flatMap(({templates}) => templates).some(([locale, template]) => locale === "en" && template === "I want to improve my {!language}"));
  assert.ok(commands.flatMap(({templates}) => templates).some(([locale, template]) => locale === "en" && template === "continue my {!language} study"));
  assert.ok(commands.flatMap(({templates}) => templates).some(([locale, template]) => locale === "pt" && template === "quero continuar meu estudo de {!language}"));
  assert.ok(commands.flatMap(({templates}) => templates).some(([locale, template]) => locale === "it" && template === "voglio migliorare il mio {!language}"));
  const memoryCommand = commands.find(({name}) => name === "study.memory");
  assert.ok(memoryCommand.templates.some(([locale, template]) => locale === "pt" && template === "qual é o meu plano de estudos"));
  const progressCommand = commands.find(({name}) => name === "study.progress");
  assert.ok(progressCommand.templates.some(([locale, template]) => locale === "en" && template === "can you see my progress in language study"));
  context.invoke(command.tool, {...command.args, language: "inglês"});
  context.invoke("study_remember", {kind: "goal", text: "Speak more comfortably in meetings"});
  context.invoke("study_pause", {});
  context.invoke(command.tool, {language: "ingles"});
  assert.equal(memory(context).targetLanguage, "English");
  assert.equal(memory(context).intent, "improve");
  assert.equal(memory(context).supportLanguage, "Portuguese");
  assert.equal(memory(context).studyRequested, true);
  assert.equal(memory(context).learnerNotes[0].text, "Speak more comfortably in meetings");
});

test("a beginner request preserves its own language for explanations and records the tutor's plan automatically", () => {
  const {context, files} = plugin();
  const command = context.describe().commands.find(({name}) => name === "study.learn.pt");
  context.invoke(command.tool, {...command.args, language: "inglês"});
  assert.equal(memory(context).intent, "learn");
  assert.equal(memory(context).supportLanguage, "Portuguese");
  turn(context, "first", "1", "user", "Não entendi a pergunta em inglês");
  turn(context, "first", "2", "assistant", "Vamos começar com apresentações simples. Seu nível é uma estimativa inicial. Nesta semana praticaremos cumprimentos; amanhã retomamos como dizer seu nome.");
  context.event("conversation.ended", {sessionId: "first", at: Date.now()}, "host");
  const restarted = plugin(files).context;
  const saved = memory(restarted);
  assert.ok(saved.lastCheckpoint.tutorTurns[0].text.includes("amanhã retomamos"));
  assert.equal(saved.lastCheckpoint.source, "spoken evidence");
  restarted.invoke("study_start", {});
  assert.equal(memory(restarted).intent, "learn");
  assert.equal(memory(restarted).supportLanguage, "Portuguese");
});

test("a long tutor recap preserves the next activity at its end", () => {
  const {context} = plugin();
  context.invoke("study_start", {language: "Italian"});
  turn(context, "day-1", "1", "assistant", "Today's practice: " + "x".repeat(1700) + " Tomorrow: practice a medical appointment.");
  assert.ok(JSON.stringify(memory(context).recentSessions).includes("medical appointment"));
});

test("an incomplete write recovers the previous valid save and reports recovery", () => {
  const {context, files} = plugin();
  context.invoke("study_start", {language: "Italian"});
  context.invoke("study_remember", {text: "A durable goal"});
  context.invoke("study_remember", {text: "A newer note"});
  files.set("learning.json", "{incomplete");
  const restored = plugin(files).context;
  assert.equal(memory(restored).learnerNotes[0].text, "A durable goal");
  assert.ok(restored.invoke("study_start", {}).summary.includes("recovered"));
  assert.doesNotThrow(() => JSON.parse(files.get("learning.json")));
});

test("speech writes are checkpointed and flushed when paused or shut down", () => {
  const {context, files} = plugin();
  runInContext("Date.now = () => 1_000", context);
  context.invoke("study_start", {language: "Italian"});
  const before = files.get("learning.json");
  turn(context, "day-1", "1", "user", "Practice one", 1100);
  assert.equal(files.get("learning.json"), before);
  runInContext("Date.now = () => 12_000", context);
  context.tick();
  assert.ok(files.get("learning.json").includes("Practice one"));
  turn(context, "day-1", "2", "assistant", "Next: practice two", 1300);
  context.invoke("study_pause", {});
  assert.ok(files.get("learning.json").includes("practice two"));
  turn(context, "day-1", "3", "assistant", "Final recap", 1400);
  context.shutdown();
  assert.ok(files.get("learning.json").includes("Final recap"));
  turn(context, "day-1", "4", "user", "Unrelated speech", 13000);
  assert.ok(!JSON.stringify(memory(context)).includes("Unrelated speech"));
});

test("explicit goal and routine changes replace the current value and stay in opening context", () => {
  const {context} = plugin();
  context.invoke("study_start", {language: "Italian"});
  context.invoke("study_remember", {kind: "goal", text: "Travel"});
  context.invoke("study_remember", {kind: "goal", text: "Work conversations"});
  context.invoke("study_remember", {kind: "routine", text: "Ten minutes on weekdays"});
  for (let i = 0; i < 30; i++) context.invoke("study_remember", {text: "Other note " + i});
  const notes = memory(context).learnerNotes;
  assert.equal(notes.filter(({kind}) => kind === "goal").length, 1);
  assert.equal(notes.find(({kind}) => kind === "goal").text, "Work conversations");
  assert.equal(notes.find(({kind}) => kind === "routine").text, "Ten minutes on weekdays");
  assert.equal(context.describe().commands.find(({name}) => name === "study.goal").args.kind, "goal");
});


test("inactive study exposes no lesson context until an explicit start", () => {
  const { context, files } = plugin();
  context.invoke("study_start", { language: "Italian" });
  context.invoke("study_remember", { kind: "plan", text: "Practice buying train tickets" });
  const stopped = context.invoke("study_pause", {});
  assert.equal(JSON.parse(stopped.context).phase, "inactive");
  const automatic = JSON.parse(context.invoke("study_context", {}).context);
  assert.equal(automatic.phase, "inactive");
  assert.equal(automatic.studyRequested, false);
  assert.equal(automatic.learnerNotes, undefined);
  assert.equal(automatic.dueReviews, undefined);
  assert.equal(automatic.progress, undefined);
  assert.match(automatic.instructions, /explicit/i);
  assert.ok(memory(context).learnerNotes.some((note) => note.text.includes("train tickets")));
  const restarted = plugin(files).context;
  assert.equal(JSON.parse(restarted.invoke("study_context", {}).context).phase, "inactive");
  assert.equal(JSON.parse(restarted.invoke("study_start", { language: "Italian" }).context).phase, "active");
});

test("the host interaction ending also ends a study with no captured turns", () => {
  const { context } = plugin();
  context.invoke("study_start", { language: "Italian" });
  context.event("conversation.ended", { sessionId: "first-call", at: Date.now() }, "host");
  assert.equal(JSON.parse(context.invoke("study_context", {}).context).phase, "inactive");
  context.invoke("study_start", { language: "Italian" });
  context.event("conversation.ended", { sessionId: "second-call", at: Date.now() }, "host");
  assert.equal(JSON.parse(context.invoke("study_context", {}).context).phase, "inactive");
});
