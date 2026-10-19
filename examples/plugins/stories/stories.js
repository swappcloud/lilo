// Explicit storytelling sessions, with a bounded local journal of narration.
const ID = "com.lilo.stories";
const STORE = "stories.json";
const MAX_STORIES = 12;
const PREMISES = ["The moonlit garden","The sleepy cloud","The fox and the little star","The lantern by the lake","The turtle's quiet journey","The forest library","The tiny lighthouse","The meadow's gentle song","The bear and the paper boat","The owl's cozy nest","The rabbit and the silver leaf","The island of soft dreams"];
const atomic = typeof lilo.memory === "function" && typeof lilo.hostInfo === "function" && lilo.hostInfo().permissions.includes("storage:self");
let revision = 0;
let active = null;
let finishing = null;
let dirty = false;
let lastSavedAt = 0;
const schema = (properties, required) => ({type:"object", properties:properties || {}, required:required || []});
const text = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";

function load() {
  let value;
  if (atomic) {
    const record = lilo.memory("read", {key:"stories"});
    revision = record.revision;
    if (record.found) value = record.value;
  }
  if (!value) {
    const raw = lilo.read(STORE);
    value = raw ? JSON.parse(raw) : {version:1, nextId:1, stories:[]};
  }
  if (!value || value.version !== 1 || !Number.isInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.stories) || value.stories.length > MAX_STORIES ||
    value.stories.some((story) => !Number.isInteger(story.id) || story.id < 1 || story.id >= value.nextId || typeof story.title !== "string" || !story.title || story.title.length > 160 ||
      typeof story.theme !== "string" || story.theme.length > 160 || !["bedtime","adventure"].includes(story.mode) ||
      !Number.isInteger(story.minutes) || story.minutes < 2 || story.minutes > 30 || !Number.isInteger(story.age) || story.age < 3 || story.age > 12 || !Number.isFinite(story.updatedAt) ||
      !Array.isArray(story.chapters) || story.chapters.length > 8 ||
      story.chapters.some((chapter) => !Number.isFinite(chapter.at) || !Array.isArray(chapter.turns) || chapter.turns.length > 8 ||
        chapter.turns.some((turn) => typeof turn.id !== "string" || typeof turn.text !== "string" || turn.text.length > 2000))) ||
    new Set(value.stories.map((story)=>story.id)).size !== value.stories.length) {
    throw new Error("Unsupported story memory. Existing stories were preserved.");
  }
  return value;
}
let state = load();

function save(forgetting) {
  // Compact old chapters; keep the latest ending for tomorrow's continuation.
  for (const story of state.stories) {
    story.chapters = story.chapters.slice(-8);
    for (const chapter of story.chapters) chapter.turns = chapter.turns.slice(-8);
  }
  while (JSON.stringify(state).length > 120000) {
    const older = state.stories.find((story)=>story.chapters.length > 1);
    if (older) {older.chapters.shift();continue;}
    const chapter = state.stories.flatMap((story)=>story.chapters).find((item)=>item.turns.length > 1);
    if (!chapter) break;
    chapter.turns.shift();
  }
  if (atomic) {
    revision = lilo.memory("write", {key:"stories", schemaVersion:1, expectedRevision:revision, value:state, purgePrevious:!!forgetting}).revision;
    if (lilo.read(STORE)) lilo.write(STORE, "");
  } else lilo.write(STORE, JSON.stringify(state));
  dirty = false;
  lastSavedAt = Date.now();
  lilo.publish("stories.changed", {});
}

function transaction(change, forgetting) {
  const previous = JSON.stringify(state), previousActive = active, previousFinishing = finishing;
  try { const result = change(); save(forgetting); return result; }
  catch (error) { state = JSON.parse(previous); active = previousActive; finishing = previousFinishing; throw error; }
}

function command(name, tool, en, pt, it, args, confirm) {
  return {name:"stories." + name, tool, args:args || {}, requiresConfirm:!!confirm,
    descriptions:[["en","Tell or manage a children's story."],["pt","Conte ou gerencie uma história infantil."],["it","Racconta o gestisci una storia per bambini."]],
    templates:en.map((s)=>["en",s]).concat(pt.map((s)=>["pt",s]),it.map((s)=>["it",s]))};
}

function describe() {
  return {
    contextTool:"stories_context",
    tools:[
      {name:"stories_start",description:"Start a new children's story only after an explicit request. Duration is a pacing target, not an exact audio timer.",parameters:schema({theme:{type:"string",maxLength:160},minutes:{type:"integer",minimum:2,maximum:30},mode:{type:"string",enum:["bedtime","adventure"]},age:{type:"integer",minimum:3,maximum:12}})},
      {name:"stories_continue",description:"Continue a saved story in a new chapter, only when requested. Without an ID, resume the most recent story.",parameters:schema({id:{type:"integer"},title:{type:"string"},minutes:{type:"integer",minimum:2,maximum:30}})},
      {name:"stories_pause",description:"End storytelling now, keeping its saved ending for another day.",parameters:schema()},
      {name:"stories_context",description:"Read the current storytelling mode; saved stories never activate it.",parameters:schema()},
      {name:"stories_list",description:"List the saved story library and continuation controls.",parameters:schema()},
      {name:"stories_rename",description:"Rename a saved story without changing its content.",parameters:schema({id:{type:"integer"},title:{type:"string"},replacement:{type:"string",maxLength:100}},["id","replacement"])},
      {name:"stories_forget",description:"Delete a saved story and its journal after confirmation.",parameters:schema({id:{type:"integer"}},["id"])},
    ],
    commands:[
      command("bedtime","stories_start",["tell a bedtime story","tell me a bedtime story"],["conte uma história de boa noite","conte uma historia de boa noite"],["racconta una storia della buonanotte"],{mode:"bedtime"}),
      command("bedtime_minutes","stories_start",["tell a bedtime story for {minutes} minutes"],["conte uma história de boa noite de {minutes} minutos"],["racconta una storia della buonanotte di {minutes} minuti"],{mode:"bedtime"}),
      command("start","stories_start",["tell a story","tell me a story"],["conte uma história","conte uma historia"],["racconta una storia"]),
      command("theme","stories_start",["tell a story about {!theme}","tell me the story of {!theme}"],["conte uma história sobre {!theme}","conte a história de {!theme}"],["racconta una storia su {!theme}","racconta la storia di {!theme}"]),
      command("minutes","stories_start",["tell a story for {minutes} minutes"],["conte uma história de {minutes} minutos"],["racconta una storia di {minutes} minuti"]),
      command("theme_minutes","stories_start",["tell a story about {!theme} for {minutes} minutes"],["conte uma história sobre {!theme} de {minutes} minutos"],["racconta una storia su {!theme} di {minutes} minuti"]),
      command("continue","stories_continue",["continue yesterday's story","continue my story"],["continue a história de ontem","continue minha história"],["continua la storia di ieri","continua la mia storia"]),
      command("continue_title","stories_continue",["continue the story {!title}"],["continue a história {!title}"],["continua la storia {!title}"]),
      command("stop","stories_pause",["stop the story","end story time"],["pare a história","termine a história"],["ferma la storia","termina la storia"]),
      command("library","stories_list",["show my stories"],["mostre minhas histórias"],["mostra le mie storie"]),
    ],
    subscribes:["conversation.turn","conversation.ended","activity.started"],
    publishes:["stories.changed","activity.started"],
    ui:{
      status:[{label:"Storytelling",value:active ? "Active" : "Inactive"},{label:"Saved stories",value:String(state.stories.length)}],
      actions:[],
      list:{title:"Your story shelf",tool:"stories_list",empty:"Ask LILO for a story. Its ending will be saved here for another day."},
    },
    prompt:"Storytelling starts only through stories_start or stories_continue after an explicit request. An inactive stories_context overrides earlier narration and library memories. Do not start a story during ordinary chat or language study. During an active story, follow the narration guide and saved ending. Narrate naturally in the user's requested language, without technical stage directions, timers, quizzes, or asking questions mid-story. Call stories_pause when the requested story has ended. Never claim an exact audio duration or guarantee a child will fall asleep.",
  };
}

function duration(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 2 || number > 30) throw new Error("Choose a story length from 2 to 30 minutes.");
  return number;
}

function context() {
  if (!active) return {phase:"inactive",instructions:"Ordinary conversation. Saved stories are not a request to narrate. Only an explicit new or continuation request starts storytelling."};
  const story = state.stories.find((item) => item.id === active.id);
  const history = story.chapters.slice(0, -1).flatMap((chapter) => chapter.turns).slice(-3).map((turn)=>turn.text);
  const bedtime = story.mode === "bedtime";
  return {phase:"telling",activityPolicy:"Storytelling is the active guided activity. Pause tutoring, quizzes and unrelated scripted routines.",storyId:story.id,title:story.title,theme:story.theme,mode:story.mode,age:story.age,
    chapter:story.chapterCount || story.chapters.length,requestedMinutes:active.minutes,targetWords:active.minutes * (bedtime ? 90 : 115),
    durationAccuracy:"Estimated spoken duration. The provider controls speech speed and pauses; captions are not an audio clock.",
    previousEnding:history,continuation:(story.chapterCount || story.chapters.length) > 1,
    narrationGuide:(bedtime ? "Use a warm, soft, unhurried voice. Gradually simplify the language and slow the rhythm. Gentle repetition and sensory images should lead toward a quiet, safe ending; no sudden surprises, tension, or energetic closing question. " : "Tell a warm, imaginative, age-appropriate adventure with clear characters, a beginning, a small challenge and a reassuring ending. ") +
      "Aim for the requested spoken length using the target word budget and natural pauses. Do not rush or shorten it to a paragraph. Do not say stage directions aloud. Invent an original tale when no theme was requested. For a classic such as Pinocchio, create a gentle retelling of the traditional story, never copy a modern adaptation verbatim. Avoid frightening, violent or adult content; never request a child's name, address or other personal information. When continuing, briefly reconnect to the saved ending, retain characters and setting, then tell a new chapter instead of repeating the last one. End by calling stories_pause.",
  };
}

function begin(story, minutes) {
  const session = typeof lilo.session === "function" ? lilo.session() : {};
  active = {id:story.id,minutes,startedAt:Date.now(),sessionId:session.sessionId || null};
  finishing = null;
  story.chapterCount = (story.chapterCount || story.chapters.length) + 1;
  story.chapters.push({at:Date.now(),turns:[]});
  story.updatedAt = Date.now();
}

function pause() {
  const wasActive = !!active;
  if (active) finishing = {...active,stoppedAt:Date.now()};
  active = null;
  if (dirty) save();
  else lilo.publish("stories.changed", {});
  return {summary:wasActive ? "Story time ended. The saved ending is ready for another day." : "Story time is inactive.",context:JSON.stringify(context())};
}

function invoke(tool, args) {
  args = args || {};
  if (tool === "stories_context") return {summary:active ? "Story time is active." : "Story time is inactive.",context:JSON.stringify(context())};
  if (tool === "stories_pause") return pause();
  if (tool === "stories_list") return {count:state.stories.length,summary:state.stories.length + " saved stories.",items:state.stories.slice().sort((a,b)=>b.updatedAt-a.updatedAt).map((story)=>({
    label:story.title,detail:(story.mode === "bedtime" ? "Bedtime" : "Adventure") + " · " + story.minutes + " min target · " + (story.chapterCount || story.chapters.length) + " chapters · " + new Date(story.updatedAt).toISOString().slice(0,10),
    action:active?.id === story.id ? {label:"End story time",tool:"stories_pause"} : {label:"Continue story",tool:"stories_continue",args:{id:story.id}},
    edit:{label:"Rename story",tool:"stories_rename",matchParameter:"title",valueParameter:"replacement",value:story.title,args:{id:story.id}},
    deleteAction:{label:"Delete story",tool:"stories_forget",args:{id:story.id}},
  }))};
  if (tool === "stories_start") {
    const minutes = duration(args.minutes, 5), theme = text(args.theme, 160);
    if (args.mode !== undefined && !["bedtime","adventure"].includes(args.mode)) throw new Error("Choose bedtime or adventure mode.");
    const age = args.age === undefined ? 6 : Number(args.age);
    if (!Number.isInteger(age) || age < 3 || age > 12) throw new Error("Choose an age from 3 to 12.");
    const result = transaction(() => {
      if (state.stories.length >= MAX_STORIES) throw new Error("Your story shelf is full. Delete a story before starting a new one.");
      const premise = theme || PREMISES.find((title)=>!state.stories.some((item)=>item.title === title)) || "An original story";
      const story = {id:state.nextId++,title:premise,theme:premise,minutes,age,mode:args.mode || "adventure",updatedAt:Date.now(),chapters:[],chapterCount:0};
      state.stories.push(story);begin(story,minutes);
      return {summary:"Tell the requested story now, following its narration guide.",context:JSON.stringify(context())};
    });
    lilo.publish("activity.started", {owner:ID,kind:"storytelling"});
    return result;
  }
  const matches = args.title ? state.stories.filter((item)=>item.title.toLowerCase() === text(args.title,160).toLowerCase()) : [];
  if (args.id === undefined && matches.length > 1) throw new Error("More than one story has that title. Choose one from the shelf or rename it.");
  const story = args.id !== undefined ? state.stories.find((item)=>item.id === args.id) : args.title ? matches[0] : state.stories.slice().sort((a,b)=>b.updatedAt-a.updatedAt || b.id-a.id)[0];
  if (!story) throw new Error("No matching saved story. Ask for a new story first.");
  if (tool === "stories_continue") {
    const minutes = duration(args.minutes, story.minutes);
    const result = transaction(() => {begin(story,minutes);return {summary:"Continue the saved story now, keeping its characters and setting.",context:JSON.stringify(context())};});
    lilo.publish("activity.started", {owner:ID,kind:"storytelling"});
    return result;
  }
  if (tool === "stories_rename") return transaction(() => {
    if (args.title !== undefined && args.title !== story.title) throw new Error("The title changed. Refresh the story shelf.");
    const title = text(args.replacement,100);if (!title) throw new Error("Provide a story title.");
    story.title = title;return {summary:"Story renamed."};
  }, true);
  if (tool === "stories_forget") return transaction(() => {
    const ended = active?.id === story.id;
    state.stories = state.stories.filter((item)=>item.id !== story.id);
    if (active?.id === story.id) active = null;
    if (finishing?.id === story.id) finishing = null;
    return {summary:"Story and saved narration deleted.",...(ended ? {context:JSON.stringify(context())} : {})};
  }, true);
  throw new Error("Unknown story tool.");
}

function event(topic, payload, source) {
  if (topic === "activity.started" && payload?.owner === source && source !== ID && source !== "host") { if (active) pause(); return; }
  if (source !== "host" || !payload) return;
  if (topic === "conversation.ended") {
    if (active && (!active.sessionId || payload.sessionId === active.sessionId)) pause();
    return;
  }
  const session = active || (finishing && payload.at <= finishing.stoppedAt ? finishing : null);
  if (!session || topic !== "conversation.turn" || typeof payload.sessionId !== "string" || (session.sessionId && session.sessionId !== payload.sessionId)) return;
  if (!Number.isFinite(payload.at) || (payload.firstSeenAt ?? payload.at) < session.startedAt) return;
  const turn = payload.turn;
  if (!turn || turn.speaker !== "assistant" || typeof turn.id !== "string") return;
  const narration = text(turn.text,2000);
  if (!narration || narration.startsWith("[LILO]")) return;
  session.sessionId = payload.sessionId;
  const story = state.stories.find((item)=>item.id === session.id), chapter = story.chapters[story.chapters.length - 1];
  const entry = {id:turn.id,text:narration};
  const index = chapter.turns.findIndex((item)=>item.id === entry.id);
  if (index >= 0) chapter.turns[index] = entry;
  else chapter.turns.push(entry);
  chapter.turns = chapter.turns.slice(-8);
  story.updatedAt = Date.now();dirty = true;
}

function tick() { if (dirty && Date.now() - lastSavedAt >= 2000) save(); }
