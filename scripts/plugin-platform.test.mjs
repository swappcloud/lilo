import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync("examples/plugins/dictionary/dictionary.js", "utf8");
const manifest = JSON.parse(readFileSync("examples/plugins/dictionary/plugin.json", "utf8"));
const entry = {word: "hello", phonetic: "həˈləʊ", meanings: [{partOfSpeech: "exclamation",
  definitions: [{definition: "A greeting.", example: "Hello, how are you?"}]}],
  sourceUrls: ["https://en.wiktionary.org/wiki/hello"], license: {name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0"}};

function plugin({files = new Map(), response = [entry], status = 200, online = true, failWrite = false} = {}) {
  const requests = [];
  const events = [];
  const lilo = {
    read: (name) => files.get(name) ?? null,
    write: (name, text) => { if (failWrite) throw new Error("Disk unavailable"); files.set(name, text); },
    publish: (topic, payload) => events.push({topic, payload}),
  };
  if (online) {
    lilo.hostInfo = () => ({api: 1, apis: ["http"], permissions: manifest.capabilities});
    lilo.http = (url, options) => {
      requests.push({url, options});
      return {status, ok: status >= 200 && status < 300, body: JSON.stringify(response), headers: {}};
    };
  }
  const context = vm.createContext({lilo});
  vm.runInContext(source, context);
  return {context, files, requests, events};
}

test("dictionary uses public APIs, bounded HTTP and explicit learner intent", () => {
  assert.equal(manifest.runtime, "quickjs");
  assert.deepEqual(manifest.capabilities, ["storage:self", "http:api.dictionaryapi.dev"]);
  const {context, files, requests} = plugin();
  const description = context.describe();
  assert.ok(description.prompt.length <= 600);
  assert.ok(description.commands.find(({name}) => name === "dictionary.forget").requiresConfirm);
  context.invoke("dictionary_lookup", {word: "Hello!"});
  assert.equal(files.size, 0);
  const command = description.commands.find(({name}) => name === "dictionary.save");
  const result = context.invoke(command.tool, {...command.args, word: "hello"});
  assert.match(result.summary, /Saved/);
  assert.equal(requests[0].url, "https://api.dictionaryapi.dev/api/v2/entries/en/hello");
  assert.equal(requests[0].options.maxResponseBytes, 131072);
  assert.equal(JSON.parse(files.get("vocabulary.json")).entries.length, 1);
  assert.match(context.invoke("dictionary_list", {}).items[0].detail, /CC BY-SA/);
});

test("saved vocabulary resumes offline and has usable deletion and context", () => {
  const {context, files} = plugin();
  context.invoke("dictionary_lookup", {word: "hello", save: true});
  const offline = plugin({files, online: false}).context;
  assert.equal(offline.invoke("dictionary_list", {}).items[0].label, "hello");
  assert.match(offline.invoke("dictionary_context", {}).context, /greeting/);
  assert.throws(() => offline.invoke("dictionary_lookup", {word: "hello"}), /Update LILO/);
  offline.invoke("dictionary_forget", {word: "hello"});
  assert.equal(plugin({files, online: false}).context.invoke("dictionary_list", {}).items.length, 0);
});

test("failed lookups, malformed responses and write failures never claim or retain a save", () => {
  for (const config of [{status: 404}, {status: 429}, {response: []}, {response: [{meanings: [null]}]}, {failWrite: true}]) {
    const {context, files} = plugin(config);
    assert.throws(() => context.invoke("dictionary_lookup", {word: "hello", save: true}));
    assert.equal(files.size, 0);
    assert.equal(context.invoke("dictionary_list", {}).items.length, 0);
  }
  const {context, requests} = plugin();
  assert.throws(() => context.invoke("dictionary_lookup", {word: "../secret"}));
  assert.equal(requests.length, 0);
});

test("malformed existing notebooks are preserved instead of reset", () => {
  const files = new Map([["vocabulary.json", "{partial"]]);
  assert.throws(() => plugin({files}));
  assert.equal(files.get("vocabulary.json"), "{partial");
});

const reviewSource = readFileSync("examples/plugins/vocabulary-review/review.js", "utf8");
const phrasebookSource = readFileSync("examples/plugins/phrasebook/phrasebook.js", "utf8");
test("phrasebook reads live language/capabilities and refreshes only for host session events", () => {
  const session = {supportLanguage:"pt-BR",state:"connected",provider:{outbound:{text:true}}};
  const events = [];
  const context = vm.createContext({lilo:{session:() => structuredClone(session),
    publish:(topic,payload) => events.push({topic,payload})}});
  vm.runInContext(phrasebookSource, context);
  assert.ok(context.describe().subscribes.includes("session.changed"));
  const first = context.invoke("phrasebook_today");
  assert.match(first.items[0].detail, /gostaria/);
  assert.equal(JSON.parse(first.context).liveText, true);
  session.supportLanguage = "en-US";
  session.provider.outbound.text = false;
  const changed = context.invoke("phrasebook_today");
  assert.match(changed.items[0].detail, /would like/);
  assert.equal(JSON.parse(changed.context).liveText, false);
  context.event("session.changed", {}, "another-plugin");
  assert.equal(events.length, 0);
  context.event("session.changed", {}, "host");
  assert.equal(events.at(-1).topic, "phrasebook.changed");
  session.provider = null;
  assert.equal(JSON.parse(context.invoke("phrasebook_today").context).liveText, false);
});
function reviewHost({records = new Map(), jobs = new Map(), failWrite = false} = {}) {
  const events = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const lilo = {
    memory(operation, args) {
      const record = records.get(args.key) || {found: false, revision: 0, schemaVersion: 0, value: null, recovered: false};
      if (operation === "read") return clone(record);
      if (failWrite) throw new Error("Disk unavailable");
      assert.equal(args.expectedRevision, record.revision);
      const next = {found: true, revision: record.revision + 1, schemaVersion: args.schemaVersion,
        value: clone(args.value), recovered: false};
      records.set(args.key, next);
      return clone(next);
    },
    schedule(operation, args) {
      if (operation === "put") jobs.set(args.id, clone(args));
      if (operation === "cancel") jobs.delete(args.id);
      return {jobs: clone([...jobs.values()]), history: [], recovered: false};
    },
    publish: (topic, payload) => events.push({topic, payload}),
  };
  const context = vm.createContext({lilo});
  vm.runInContext(reviewSource, context);
  return {context, records, jobs, events, lilo};
}

function routineHost({records = new Map(), failWrite = false, supported = true} = {}) {
  const memory = reviewHost({records, failWrite});
  const requests = [];
  const context = vm.createContext({lilo:{...memory.lilo,
    session:() => ({supportLanguage:"pt-BR"}),
    interaction:(operation, options) => {
      requests.push({operation, options});
      return {id:"question-1",status:supported ? "waitingDelivery" : "unsupported"};
    }}});
  vm.runInContext(readFileSync("examples/plugins/study-routine/routine.js", "utf8"), context);
  const answer = (status, extra = {}, source = "host") => context.event("interaction.changed",
    {id:"question-1",pluginId:"com.lilo.study-routine",status,...extra},source);
  return {...memory, context, requests, answer};
}

test("routine interview saves only a separate owned confirmation and resumes across calls", () => {
  const host = routineHost();
  host.context.invoke("routine_interview");
  assert.match(host.requests[0].options.question, /Quantos minutos/);
  host.answer("awaitingConfirmation",{candidate:15});
  host.answer("confirmed",{answer:15},"another-plugin");
  host.answer("confirmed",{answer:15,id:"old-question"});
  assert.equal(host.records.size,0);
  host.answer("confirmed",{answer:15});
  host.answer("confirmed",{answer:30});
  assert.equal(host.records.get("routine").revision,1);
  assert.equal(host.records.get("routine").value.minutes,15);
  const resumed = routineHost({records:host.records,supported:false});
  resumed.context.invoke("routine_interview");
  assert.match(resumed.context.invoke("routine_status").summary,/15 minutes/);
  assert.equal(host.records.get("routine").revision,1);
});

test("failed routine storage preserves memory and cannot replay a terminal confirmation", () => {
  const host = routineHost({failWrite:true});
  host.context.invoke("routine_interview");
  assert.throws(() => host.answer("confirmed",{answer:15}),/Disk unavailable/);
  assert.equal(host.events.length,0);
  assert.equal(host.records.size,0);
  assert.doesNotThrow(() => host.answer("confirmed",{answer:15}));
  assert.match(host.context.invoke("routine_status").summary,/failed/);
});

test("daily vocabulary review persists self-reports and resumes without an account", () => {
  const first = reviewHost();
  first.context.invoke("review_add", {word: "hello", cue: "A greeting"});
  assert.equal(first.context.invoke("review_today", {}).items.length, 1);
  first.context.invoke("review_record", {word: "hello", recalled: true});
  const resumed = reviewHost(first);
  assert.equal(resumed.context.invoke("review_today", {}).items.length, 0);
  assert.equal(resumed.records.get("vocabulary").value.entries[0].reviews, 1);
  assert.match(resumed.context.invoke("review_context", {}).context, /no proficiency assessment/);
  resumed.context.invoke("review_forget", {word: "hello"});
  assert.equal(reviewHost(resumed).records.get("vocabulary").value.entries.length, 0);
});

test("daily review uses persistent owned jobs and re-arms local calendar time before notifying", () => {
  const host = reviewHost();
  host.context.invoke("review_add", {word: "hello", cue: "A greeting"});
  host.context.invoke("review_daily", {time: "18:00"});
  const job = host.jobs.get("daily-review");
  assert.equal(job.tool, "review_remind");
  assert.equal(job.missed, "runOnce");
  assert.ok(job.at > Date.now());
  assert.equal(new Date(job.at).getHours(), 18);
  const resumed = reviewHost(host);
  assert.match(resumed.context.invoke("review_context", {}).context, /daily-review/);
  resumed.jobs.delete(job.id);
  resumed.context.invoke(job.tool, {...job.args, _schedule: {id: job.id}});
  assert.ok(resumed.jobs.has(job.id));
  assert.equal(resumed.events.at(-1).topic, "notify");
  resumed.context.invoke("review_stop", {});
  assert.equal(resumed.jobs.size, 0);
  assert.equal(resumed.records.get("vocabulary").value.entries.length, 1);
  assert.throws(() => resumed.context.invoke("review_daily", {time: "25:00"}));
  assert.throws(() => resumed.context.invoke("review_remind", job.args));
});

test("review preserves unknown schemas and never claims a failed save", () => {
  const host = reviewHost({failWrite: true});
  assert.throws(() => host.context.invoke("review_add", {word: "hello", cue: "A greeting"}), /Disk/);
  assert.equal(host.context.invoke("review_today", {}).items.length, 0);
  const records = new Map([["vocabulary", {found: true, schemaVersion: 99, revision: 1, value: {entries: []}}]]);
  assert.throws(() => reviewHost({records}), /Unsupported/);
  assert.equal(records.get("vocabulary").schemaVersion, 99);
});

test("dictionary migrates its real legacy notebook into atomic memory and sanitizes the obsolete copy", () => {
  const notebook = {version: 1, entries: [{word: "hello", definitions: [{definition: "A greeting."}], source: "User"}]};
  const files = new Map([["vocabulary.json", JSON.stringify(notebook)]]);
  const memory = reviewHost();
  const context = vm.createContext({lilo: {...memory.lilo, read: (name) => files.get(name) ?? null,
    write: (name, value) => files.set(name, value),
    hostInfo: () => ({permissions: ["storage:self"]})}});
  vm.runInContext(source, context);
  assert.equal(memory.records.get("vocabulary").value.entries[0].word, "hello");
  assert.equal(JSON.parse(files.get("vocabulary.json")).entries.length, 0);
  context.invoke("dictionary_forget", {word: "hello"});
  assert.equal(memory.records.get("vocabulary").value.entries.length, 0);
});

test("study migrates the real legacy main and recovery files into versioned memory", () => {
  const state = {version: 1, selected: "", profiles: []};
  const files = new Map([["learning.json", "{partial"], ["learning.backup.json", JSON.stringify(state)]]);
  const memory = reviewHost();
  const lilo = {...memory.lilo, read: (name) => files.get(name) ?? null,
    write: (name, value) => files.set(name, value), hostInfo: () => ({permissions: ["storage:self"]})};
  const context = vm.createContext({lilo});
  vm.runInContext(readFileSync("examples/plugins/study/study.js", "utf8"), context);
  assert.equal(memory.records.get("learning").revision, 1);
  assert.equal(JSON.parse(files.get("learning.json")).profiles.length, 0);
  assert.equal(JSON.parse(files.get("learning.backup.json")).profiles.length, 0);
  assert.equal(memory.records.get("learning").schemaVersion, 1);
});

test("the same language course continues across voice providers without splitting or resetting memory", () => {
  const memory = reviewHost();
  const files = new Map();
  const studySource = readFileSync("examples/plugins/study/study.js", "utf8");
  function study(sessionId, liveText) {
    const context = vm.createContext({lilo:{...memory.lilo,
      read:(name) => files.get(name) ?? null, write:(name,value) => files.set(name,value),
      hostInfo:() => ({permissions:["storage:self","conversation:read"]}),
      session:() => ({sessionId,state:"connected",supportLanguage:"pt-BR",provider:{outbound:{text:liveText}}})}});
    vm.runInContext(studySource, context);
    return context;
  }
  const first = study("voice-provider-one", true);
  first.invoke("study_start", {language:"English",intent:"learn",supportLanguage:"Portuguese"});
  first.invoke("study_remember", {text:"Speak English at work",kind:"goal"});
  first.invoke("study_remember", {text:"Fifteen minutes every day",kind:"routine"});
  first.invoke("study_review_add", {text:"Could you repeat that?"});
  const at = Date.now();
  first.event("conversation.turn", {sessionId:"voice-provider-one",at,
    turn:{id:"recap",speaker:"assistant",text:"Next lesson: introduce yourself in a work meeting.",final:true}}, "host");
  first.event("conversation.ended", {sessionId:"voice-provider-one",at:at+1}, "host");
  const revision = memory.records.get("learning").revision;
  const other = study("voice-provider-two", false);
  assert.equal(JSON.parse(other.invoke("study_context", {}).context).phase, "inactive");
  const inherited = JSON.parse(other.invoke("study_memory", {}).context);
  assert.equal(memory.records.get("learning").revision, revision);
  assert.equal(inherited.targetLanguage, "English");
  assert.equal(inherited.supportLanguage, "Portuguese");
  assert.match(JSON.stringify(inherited.learnerNotes), /Speak English at work/);
  assert.match(JSON.stringify(inherited.learnerNotes), /Fifteen minutes/);
  assert.match(JSON.stringify(inherited.dueReviews), /Could you repeat/);
  assert.match(JSON.stringify(inherited.lastCheckpoint), /introduce yourself/);
  other.invoke("study_start", {language:"English",intent:"improve"});
  other.invoke("study_remember", {text:"Use short work role-plays this week",kind:"plan"});
  other.invoke("study_pause", {});
  const back = study("voice-provider-three", true);
  assert.equal(JSON.parse(back.invoke("study_context", {}).context).phase, "inactive");
  const resumed = JSON.parse(back.invoke("study_memory", {}).context);
  assert.match(JSON.stringify(resumed.learnerNotes), /short work role-plays/);
  assert.equal(memory.records.get("learning").value.profiles.length, 1);
  assert.equal(files.size, 0);
});
