// Local learning evidence and explicitly sourced, provisional tutor checkpoints.
const STORE = "learning.json";
const BACKUP = "learning.backup.json";
const MAX_PROFILES = 8;
const MAX_SESSIONS = 90;
const MAX_TURNS = 24;
const MAX_NOTES = 50;
const MAX_MEMORY_CHARS = 800_000;
let recording = false;
let sessionId = null;
let startedAt = 0;
let stoppedAt = 0;
let dirty = false;
let lastSaved = "";
let lastSavedAt = 0;
let recovered = false;
let lastTutorAnswer = null;
let pendingBudget = null;
const atomic = typeof lilo.memory === "function" && typeof lilo.hostInfo === "function" &&
  lilo.hostInfo().permissions.includes("storage:self");
let memoryRevision = 0;

function emptyState() { return { version: 1, selected: "", profiles: [] }; }
function sanitizeLegacy() {
  const empty = JSON.stringify(emptyState());
  for (const name of [STORE, BACKUP]) {
    const raw = lilo.read(name);
    if (raw && raw !== empty) lilo.write(name, empty);
  }
}
function load() {
  if (atomic) {
    const record = lilo.memory("read", {key: "learning"});
    memoryRevision = record.revision;
    if (record.found) {
      if (record.schemaVersion !== 1 || record.value.version !== 1 || !Array.isArray(record.value.profiles)) {
        throw new Error("Unsupported study memory format. Existing memory was preserved.");
      }
      recovered = record.recovered;
      lastSaved = JSON.stringify(record.value);
      sanitizeLegacy();
      return record.value;
    }
  }
  let raw = lilo.read(STORE);
  if (!raw) {
    raw = lilo.read(BACKUP);
    recovered = !!raw;
  }
  if (!raw) return emptyState();
  let value;
  try { value = JSON.parse(raw); }
  catch (error) {
    const backup = lilo.read(BACKUP);
    if (!backup) throw error;
    value = JSON.parse(backup);
    raw = backup;
    recovered = true;
  }
  if (value.version !== 1 || !Array.isArray(value.profiles)) {
    throw new Error("Unsupported study memory format. Existing memory was preserved.");
  }
  lastSaved = raw;
  if (atomic) {
    memoryRevision = lilo.memory("write", {key: "learning", schemaVersion: 1,
      expectedRevision: memoryRevision, value}).revision;
    sanitizeLegacy();
  }
  return value;
}
let state = load();

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}
function selected() { return state.profiles.find((profile) => profile.language === state.selected); }
function save(forgetting) {
  let serialized = JSON.stringify(state);
  // Preserve pinned notes and the starting point; compact older spoken evidence.
  while (serialized.length > MAX_MEMORY_CHARS) {
    // Compact optional tracker history in batches across all language profiles.
    let history = null;
    for (const profile of state.profiles) {
      if (!profile.tracker) continue;
      for (const key of ["assessments", "words"]) {
        const records = profile.tracker[key];
        if (records.length > 48 && (!history || records.length > history.length)) history = records;
      }
    }
    if (history) {
      history.sort((a,b)=>a.at-b.at);
      history.splice(0, Math.min(history.length-48, Math.max(24, Math.ceil(history.length/4))));
      serialized = JSON.stringify(state);
      continue;
    }
    let oldest = null;
    for (const profile of state.profiles) {
      for (const session of profile.sessions) {
        if (session.turns.length > 2 && (!oldest || session.startedAt < oldest.startedAt)) oldest = session;
      }
    }
    if (oldest) {
      oldest.turns = oldest.turns.slice(-2).map((turn) => ({ ...turn, text: turn.text.slice(0, 200) }));
    } else {
      const profile = state.profiles.find((item) => item.sessions.length > 1);
      if (!profile) break;
      profile.sessions.shift();
    }
    serialized = JSON.stringify(state);
  }
  if (atomic) memoryRevision = lilo.memory("write", {key: "learning", schemaVersion: 1,
    expectedRevision: memoryRevision, value: JSON.parse(serialized), purgePrevious: !!forgetting}).revision;
  else {
    if (forgetting) lilo.write(BACKUP, serialized);
    else if (lastSaved) lilo.write(BACKUP, lastSaved);
    lilo.write(STORE, serialized);
  }
  lastSaved = serialized;
  lastSavedAt = Date.now();
  dirty = false;
  lilo.publish("study.changed", {});
}
function forgetEvidence(profile, text) {
  if (profile.tracker) {
    profile.tracker.words = profile.tracker.words.filter((item) => !item.text.includes(text) && !item.meaning.includes(text));
    profile.tracker.assessments = profile.tracker.assessments.filter((item) => !item.evidence.includes(text));
  }
  profile.onboarding = profile.onboarding.filter((turn) => !turn.text.includes(text));
  for (const session of profile.sessions) session.turns = session.turns.filter((turn) => !turn.text.includes(text));
  if (profile.lastCheckpoint) {
    for (const key of ["learnerTurns", "tutorTurns"]) {
      profile.lastCheckpoint[key] = (profile.lastCheckpoint[key] || []).filter((turn) => !turn.text.includes(text));
    }
  }
}
function schema(properties, required) {
  return { type: "object", properties: properties || {}, required: required || [] };
}
function command(name, tool, en, pt, it, confirm, args) {
  return {
    name: "study." + name, tool,
    descriptions: [["en", "Manage language study memory."], ["pt", "Gerencia a memória do estudo."], ["it", "Gestisce la memoria dello studio."]],
    requiresConfirm: !!confirm,
    args: args || {},
    templates: en.map((text) => ["en", text]).concat(pt.map((text) => ["pt", text]), it.map((text) => ["it", text])),
  };
}
function studyRequests() {
  const definitions = [
    ["en", "English", ["I want to learn {!language}"], ["I want to improve my {!language}", "I want to improve {!language}", "continue my {!language} study", "resume my {!language} study", "continue studying {!language}"]],
    ["pt", "Portuguese", ["quero aprender {!language}"], ["quero melhorar meu {!language}", "quero melhorar minha {!language}", "quero melhorar o meu {!language}", "quero melhorar {!language}", "quero continuar meu estudo de {!language}", "continuar meu estudo de {!language}", "quero retomar meu estudo de {!language}"]],
    ["it", "Italian", ["voglio imparare {!language}"], ["voglio migliorare il mio {!language}", "voglio migliorare {!language}", "continua il mio studio di {!language}", "riprendi il mio studio di {!language}"]],
  ];
  const commands = [];
  for (const [locale, supportLanguage, learn, improve] of definitions) {
    for (const [intent, templates] of [["learn", learn], ["improve", improve]]) {
      commands.push(command(intent + "." + locale, "study_start",
        locale === "en" ? templates : [], locale === "pt" ? templates : [], locale === "it" ? templates : [],
        false, {intent, supportLanguage}));
    }
  }
  return commands;
}
function describe() {
  return {
    contextTool: "study_context",
    tools: [
      {name:"study_dashboard",description:"Read the evidence-based learning journey, skill profile and daily practice charts.",parameters:schema()},
      {name:"study_words",description:"Read learned expressions, recall history and audio-based pronunciation changes.",parameters:schema()},
      {name:"study_next",description:"Choose a short practice and retention check from saved evidence.",parameters:schema()},
      {name:"study_starting_level",description:"Save a self-reported starting level, never a verified assessment.",parameters:schema({level:{type:"string",enum:["Pre-A1","A1","A2","B1","B2","C1","C2"]}},["level"])},
      { name: "study_start", description: "Begin or resume language study; preserve request intent and explanation language.", parameters: schema({language: {type: "string"}, intent: {type: "string", enum: ["learn", "improve"]}, supportLanguage: {type: "string"}}) },
      { name: "study_pause", description: "Stop recording study until the next explicit study request.", parameters: schema() },
      { name: "study_remember", description: "Save a learner note or the exact latest tutor answer when the learner asks to keep that answer. For answer kind, omit text to use the exact recent tutor turn captured from this session; never invent or paraphrase it.", parameters: schema({text: {type: "string"}, kind: {type: "string", enum: ["note", "goal", "plan", "routine", "correction", "answer"]}}, []) },
      { name: "study_forget_note", description: "Forget one pinned note by its text.", parameters: schema({text: {type: "string"}}, ["text"]) },
      { name: "study_edit_note", description: "Replace one saved note using its old exact text and new text.", parameters: schema({text:{type:"string"},replacement:{type:"string"}},["text","replacement"]) },
      { name: "study_memory", description: "Read the current language's learning evidence and continuation.", parameters: schema() },
      { name: "study_list", description: "Show the study memory and recent sessions.", parameters: schema() },
      { name: "study_due", description: "Read expressions due for review in the selected language.", parameters: schema() },
      { name: "study_practice", description: "Read recent practice evidence in the selected language.", parameters: schema() },
      { name: "study_weekly_goal", description: "Read the selected language course's current weekly goal.", parameters: schema() },
      { name: "study_review_progress", description: "Read self-reported expression review progress from the last seven days.", parameters: schema() },
      { name: "study_routine_form", description: "Save the learner's daily study minutes through the routine form.", parameters: schema({minutes:{type:"integer",minimum:5,maximum:120}},["minutes"]) },
      { name: "study_budget", description: "Ask how many minutes the learner can study each day, separately confirm, and save the answer only after confirmation.", parameters: schema() },
      { name: "study_clear", description: "Delete all memory for the selected language after confirmation.", parameters: schema() },
      { name: "study_context", description: "Read-only learning context for the next voice connection.", parameters: schema() },
      { name: "study_review_add", description: "Keep an expression for spaced review.", parameters: schema({text: {type: "string"}}, ["text"]) },
      { name: "study_review_recalled", description: "Record the learner's report that an expression was recalled.", parameters: schema({text: {type: "string"}}, ["text"]) },
      { name: "study_review_retry", description: "Record an expression the learner wants to revisit sooner.", parameters: schema({text: {type: "string"}}, ["text"]) },
      { name: "study_review_forget", description: "Forget a saved study expression.", parameters: schema({text: {type: "string"}}, ["text"]) },
    ],
    commands: [
      command("progress","study_dashboard",["show my language progress","how is my language progress","can you see my progress in language study","show my study progress","how am I progressing in my studies"],["mostra meu progresso nas línguas","como está meu progresso no idioma","como está meu progresso no estudo","mostra meu progresso no estudo","como estou progredindo nos estudos"],["mostra i miei progressi linguistici","come procede il mio studio","mostra i miei progressi nello studio"]),
      command("next","study_next",["check my language retention","what should I practice today"],["avalia o que eu ainda lembro","o que devo praticar hoje"],["verifica cosa ricordo","cosa devo esercitare oggi"]),
      command("start", "study_start", ["let's study", "let us study", "resume my study", "start language study"], ["vamos estudar", "quero estudar", "retoma meu estudo", "continuar meu estudo"], ["studiamo", "voglio studiare", "riprendi il mio studio"]),
      command("language", "study_start", ["let's study {!language}", "study language {!language}"], ["quero estudar {!language}", "vamos estudar {!language}"], ["voglio studiare {!language}", "studiamo {!language}"]),
      ...studyRequests(),
      command("pause", "study_pause", ["stop studying", "pause my study", "end language study", "finish studying"], ["parar de estudar", "pausa meu estudo", "vamos parar de estudar", "termina meu estudo"], ["smettiamo di studiare", "metti in pausa lo studio", "termina lo studio"]),
      command("remember", "study_remember", ["remember for my study {!text}"], ["lembra para meu estudo {!text}"], ["ricorda per il mio studio {!text}"]),
      command("saveAnswer", "study_remember", ["save that answer for my study", "save this answer for later", "keep that explanation"], ["salva essa resposta no meu estudo", "guarda essa resposta", "salva essa explicação"], ["salva questa risposta per il mio studio", "conserva questa spiegazione"], false, {kind:"answer"}),
      command("goal", "study_remember", ["my study goal is {!text}"], ["meu objetivo de estudo é {!text}"], ["il mio obiettivo di studio è {!text}"], false, {kind: "goal"}),
      command("plan", "study_remember", ["my study plan is {!text}"], ["meu plano de estudo é {!text}"], ["il mio piano di studio è {!text}"], false, {kind: "plan"}),
      command("routine", "study_remember", ["my study routine is {!text}"], ["minha rotina de estudo é {!text}"], ["la mia routine di studio è {!text}"], false, {kind: "routine"}),
      command("budget", "study_budget", ["plan my daily language study time"], ["planeja meu tempo diário de estudo de línguas"], ["pianifica il tempo quotidiano per studiare le lingue"]),
      command("correction", "study_remember", ["my study correction preference is {!text}"], ["no estudo prefiro correções {!text}"], ["nello studio preferisco correzioni {!text}"], false, {kind: "correction"}),
      command("forgetNote", "study_forget_note", ["forget my study note {!text}"], ["esquece minha anotação de estudo {!text}"], ["dimentica la mia nota di studio {!text}"]),
      command("editNote", "study_edit_note", ["change my study note {!text} to {!replacement}"], ["edita minha anotação {!text} para {!replacement}"], ["modifica la mia nota {!text} in {!replacement}"]),
      command("memory", "study_memory", ["what do you remember about my study", "what is my study plan", "show my study plan", "tell me about my study plan", "what is the plan for my studies", "review my study"], ["o que você sabe sobre meu estudo", "qual é meu plano de estudo", "qual é o meu plano de estudos", "meu plano de estudos", "mostra meu plano de estudo", "o que devo estudar", "revisa meu estudo"], ["cosa ricordi del mio studio", "qual è il mio piano di studio", "qual è il mio piano di studi", "mostra il mio piano di studio", "cosa devo studiare", "ripassa il mio studio"]),
      command("due", "study_due", ["read today's study reviews"], ["le minhas revisões de estudo de hoje"], ["leggi i ripassi di studio di oggi"]),
      command("practice", "study_practice", ["read my recent language practice"], ["le minha prática recente de línguas"], ["leggi la mia pratica linguistica recente"]),
      command("clear", "study_clear", ["delete my study memory"], ["apaga minha memória de estudo"], ["cancella la mia memoria di studio"], true),
      command("reviewAdd", "study_review_add", ["save study expression {!text}"], ["guarda a expressão {!text}", "salva a expressão {!text}"], ["salva l'espressione {!text}"]),
      command("reviewRecalled", "study_review_recalled", ["I remembered my study expression {!text}"], ["lembrei a expressão {!text}"], ["ho ricordato l'espressione {!text}"]),
      command("reviewRetry", "study_review_retry", ["I need to review my study expression {!text}"], ["preciso revisar a expressão {!text}"], ["devo ripassare l'espressione {!text}"]),
      command("reviewForget", "study_review_forget", ["forget study expression {!text}"], ["esquece a expressão {!text}"], ["dimentica l'espressione {!text}"]),
    ],
    subscribes: ["conversation.turn", "conversation.ended", "interaction.changed", "activity.started"],
    publishes: ["study.changed", "activity.started"],
    localized: {
      pt:{...STUDY_LABELS.pt,"Study session":"Sessão de estudo","Active":"Ativa","Inactive":"Inativa","Weekly goal":"Meta da semana","Review progress":"Progresso das revisões","Daily routine":"Rotina diária","Minutes per day":"Minutos por dia","Save routine":"Salvar rotina"},
      it:{...STUDY_LABELS.it,"Study session":"Sessione di studio","Active":"Attiva","Inactive":"Inattiva","Weekly goal":"Obiettivo settimanale","Review progress":"Progressi dei ripassi","Daily routine":"Routine giornaliera","Minutes per day":"Minuti al giorno","Save routine":"Salva routine"}
    },
    ui: {
      status: [{label:"Study session",value:recording?"Active":"Inactive",state:recording?"ok":"neutral"}, { label: "Learning memory", value: "Local to this device; only explicit study sessions are recorded." }],
      actions: [{ label: "Resume study", tool: "study_start" }, { label: "Pause study", tool: "study_pause" }, {label:"Plan daily study time",tool:"study_budget"}],
      list: { title: "My learning memory", tool: "study_list", empty: "Say you want to learn a language to begin." },
      lists: [
        {title:"Today's review",tool:"study_due",empty:"No expressions are due today."},
        {title:"Recent practice",tool:"study_practice",empty:"Complete a study conversation to keep practice evidence."},
        {title:"Words taking root",tool:"study_words",empty:"Your tutor's word checkpoints will appear here after practice."}
      ],
      cards:[{title:"Learning journey",tool:"study_dashboard"},{title:"Weekly goal",tool:"study_weekly_goal"},{title:"Your next small win",tool:"study_next"}],
      progress:[{title:"Review progress",tool:"study_review_progress",max:5}],
      forms:[{title:"Daily routine",tool:"study_routine_form",submitLabel:"Save routine",fields:[{key:"minutes",label:"Minutes per day",kind:"number",required:true,min:5,max:120}]},
        {title:"Starting point",tool:"study_starting_level",submitLabel:"Save starting point",fields:[{key:"level",label:"Self-reported level",kind:"select",required:true,options:["Pre-A1","A1","A2","B1","B2","C1","C2"].map((value)=>({value,label:value}))}]}],
    },
    prompt: "Teach only while study_context.phase is active after an explicit study_start. Saved plans and history never activate study; the latest inactive phase overrides earlier tutoring. Follow active context: discover goals and time, diagnose with short oral tasks, scaffold in the support language, target observed gaps, and revisit due words. Resume saved work only when requested. Audio skills require heard audio. Keep levels provisional and never invent progress. End with specific wins, a recap and next step.",
  };
}

function languageKey(value) {
  const text = clean(value, 60).toLowerCase();
  const aliases = {
    italian: "Italian", italiano: "Italian", italiana: "Italian", "italian language": "Italian",
    english: "English", "inglês": "English", ingles: "English", inglese: "English",
    french: "French", "francês": "French", frances: "French", francese: "French",
    spanish: "Spanish", espanhol: "Spanish", "español": "Spanish", spagnolo: "Spanish",
    german: "German", "alemão": "German", alemao: "German", tedesco: "German",
    portuguese: "Portuguese", "português": "Portuguese", portugues: "Portuguese", portoghese: "Portuguese",
  };
  return aliases[text] || clean(value, 60);
}

function start(language, intent, supportLanguage) {
  const target = languageKey(language) || state.selected || "Not chosen yet";
  let profile = state.profiles.find((item) => item.language === target);
  if (!profile) {
    const unchosen = selected();
    if (unchosen && unchosen.language === "Not chosen yet" && target !== "Not chosen yet") {
      unchosen.language = target;
      profile = unchosen;
    }
  }
  if (!profile) {
    if (state.profiles.length >= MAX_PROFILES) throw new Error("Study memory supports eight languages. Delete an unused language before adding another.");
    profile = { language: target, notes: [], reviews: [], onboarding: [], sessions: [] };
    state.profiles.push(profile);
  }
  state.selected = target;
  if (["learn", "improve"].includes(intent)) profile.intent = intent;
  if (["English", "Portuguese", "Italian"].includes(supportLanguage)) profile.supportLanguage = supportLanguage;
  recording = true;
  sessionId = null;
  lastTutorAnswer = null;
  startedAt = Date.now();
  stoppedAt = 0;
  save();
  lilo.publish("study.changed", {phase:"active"});
  lilo.publish("activity.started", {owner:"com.lilo.study",kind:"language-study"});
  return { summary: (recovered ? "Study memory recovered from the previous successful save. " : "") + "Switch to language study. Other guided activities are paused. Learning evidence will be recorded until you pause or end the call.", context: context() };
}

function context(includeMemory) {
  const phase = recording ? "active" : "inactive";
  const boundary = "Study starts or resumes only after an explicit learner request through study_start. Viewing progress, a saved plan, due reviews or old conversation history does not activate study. The latest phase overrides earlier tutoring context. Inactive means ordinary conversation: do not teach, quiz, remind or assess until another explicit study request.";
  if (!recording && !includeMemory) return JSON.stringify({phase, studyRequested: false, instructions: boundary});
  const profile = selected();
  if (!profile) return JSON.stringify({ phase, studyRequested: recording, instructions: boundary, targetLanguage: null, memory: "No previous language study. Discover the goal through conversation." });
  // Prioritize durable learner notes, the initial conversation and the latest work.
  const current = profile.notes.filter((note) => note.kind && note.kind !== "note");
  const general = profile.notes.filter((note) => !note.kind || note.kind === "note");
  const data = {
    phase,
    instructions: boundary,
    targetLanguage: profile.language,
    intent: profile.intent || "explore",
    supportLanguage: profile.supportLanguage || null,
    lastCheckpoint: profile.lastCheckpoint || null,
    studyRequested: recording,
    learnerNotes: current.concat(general.slice(0, 3), general.slice(3).slice(-13)),
    dueReviews: (profile.reviews || []).filter((item) => item.dueAt <= Date.now()).slice(0, 5),
    progress: learningContext(profile),
    initialConversation: profile.onboarding.map((turn) => ({speaker: turn.speaker, text: turn.text.slice(0, 140)})),
    recentSessions: profile.sessions.slice(-3).map((session) => ({
      startedAt: session.startedAt, endedAt: session.endedAt,
      turns: session.turns.slice(-10).map((turn) => ({ speaker: turn.speaker, text: turn.text.length > 300 ? turn.text.slice(0, 149) + "…" + turn.text.slice(-150) : turn.text })),
    })),
    evidencePolicy: "Learner turns are self-reports. Tutor checkpoints are provisional observations, never certified CEFR results. Missing evidence is unknown. Pronunciation requires the tutor to report hearing audio; captions cannot verify this claim.",
  };
  // Remove older evidence, rather than truncate JSON or lose the newest continuation.
  while (JSON.stringify(data).length > 10_000 && data.recentSessions.length > 1) data.recentSessions.shift();
  while (JSON.stringify(data).length > 10_000 && data.learnerNotes.length > 5) data.learnerNotes.splice(5, 1);
  while (JSON.stringify(data).length > 10_000 && data.initialConversation.length > 2) data.initialConversation.pop();
  while (JSON.stringify(data).length > 10_000 && data.recentSessions[0] && data.recentSessions[0].turns.length > 2) data.recentSessions[0].turns.shift();
  while (JSON.stringify(data).length > 10_000 && data.dueReviews.length > 1) data.dueReviews.pop();
  while (JSON.stringify(data).length > 10_000 && data.learnerNotes.length > 1) data.learnerNotes.splice(1, 1);
  while (JSON.stringify(data).length > 10_000 && data.recentSessions.length) data.recentSessions.shift();
  while (JSON.stringify(data).length > 10_000 && data.initialConversation.length) data.initialConversation.pop();
  while (JSON.stringify(data).length > 10_000 && data.progress.retests.length) data.progress.retests.pop();
  while (JSON.stringify(data).length > 10_000 && data.progress.dueWords.length) data.progress.dueWords.pop();
  if (JSON.stringify(data).length > 10_000 && data.lastCheckpoint) {
    data.lastCheckpoint = {...data.lastCheckpoint,
      learnerTurns:(data.lastCheckpoint.learnerTurns||[]).slice(-1),
      tutorTurns:(data.lastCheckpoint.tutorTurns||[]).slice(-1).map((turn)=>({...turn,text:turn.text.slice(-600)}))};
  }
  return JSON.stringify(data);
}

function list() {
  const profile = selected();
  if (!profile) return { items: [], summary: "No language study memory yet." };
  const items = [{ label: profile.language, detail: "Say: let's study. Goals and routines can be pinned by voice." }];
  if (profile.supportLanguage) items.push({label: "Explanation language", detail: profile.supportLanguage});
  if (recovered) items.push({label: "Memory recovered", detail: "The previous successful save was restored after an incomplete write."});
  for (const review of (profile.reviews || [])) {
    items.push({ label: review.dueAt <= Date.now() ? "Expression to revisit" : "Scheduled expression",
      detail: review.text + " · " + new Date(review.dueAt).toISOString().slice(0, 10) });
  }
  for (const note of profile.notes) {
    const answer = note.kind === "answer";
    items.push({ label: answer ? "Tutor answer" : "Learner " + (note.kind || "note"), detail: note.text,
      edit: {label:"Edit saved text",tool:"study_edit_note",matchParameter:"text",valueParameter:"replacement"},
      deleteAction: {label:"Delete saved item",tool:"study_forget_note",args:{text:note.text}} });
  }
  if (profile.onboarding.length) items.push({ label: "Starting point", detail: profile.onboarding.map((turn) => turn.speaker + ": " + turn.text).join("\n") });
  for (const session of profile.sessions.slice(-14).reverse()) {
    items.push({ label: new Date(session.startedAt).toISOString().slice(0, 10),
      detail: session.turns.map((turn) => turn.speaker + ": " + turn.text).join("\n") });
  }
  for (const other of state.profiles) {
    if (other.language !== profile.language) items.push({ label: other.language, action: { label: "Study this language", tool: "study_start", args: {language: other.language} } });
  }
  return { items, summary: "Study memory contains " + profile.sessions.length + " recent sessions and " + profile.notes.length + " learner notes." };
}

function invoke(tool, args) {
  args = args || {};
  if (tool === "study_start") return start(args.language, args.intent, args.supportLanguage);
  if (tool === "study_context") return { context: context() };
  if (tool === "study_list") return list();
  if (tool === "study_dashboard") return learningDashboard(selected());
  if (tool === "study_words") return learningWords(selected());
  if (tool === "study_next") return learningNext(selected());
  if (tool === "study_starting_level") {
    const profile = selected();
    if (!profile) throw new Error("Choose a study language first.");
    if (!LEVELS.includes(args.level)) throw new Error("Choose a CEFR starting level.");
    tracker(profile).baseline = args.level;
    save();
    return {summary:"Self-reported starting point saved. Tutor observations are assessed separately.",context:context()};
  }
  if (tool === "study_due") {
    const profile = selected();
    const due = profile ? (profile.reviews || []).filter((review) => review.dueAt <= Date.now()) : [];
    const observed=profile?wordProgress(profile).filter((word)=>word.dueAt<=Date.now() && !due.some((item)=>item.text.toLowerCase()===word.text.toLowerCase())):[];
    return {items:due.map((review) => ({label:review.text,detail:"Due for learner-reported review; recall is not a proficiency score."}))
      .concat(observed.map((word)=>({label:word.text,detail:"Recall without hints, then use in a fresh sentence. Last tutor recall: "+word.latest.recall+" / 5."}))).slice(0,64),
      summary:(due.length+observed.length) + " expressions are due for review."};
  }
  if (tool === "study_practice") {
    const profile = selected();
    const sessions = profile ? profile.sessions.slice(-14).reverse() : [];
    return {items:sessions.map((session) => ({label:new Date(session.startedAt).toISOString().slice(0,10),
      detail:session.turns.map((turn) => turn.speaker + ": " + turn.text).join("\n")})),
      summary:sessions.length + " recent practice sessions; observations are evidence, not verified levels."};
  }
  if (tool === "study_weekly_goal") {
    const profile=selected();const goal=profile?.notes.find((note)=>note.kind==="goal");
    return {title:profile?.language??"No language selected",detail:goal?.text??"Set a weekly goal by voice or save a study goal note."};
  }
  if (tool === "study_review_progress") {
    const cutoff=Date.now()-7*86_400_000;const count=(selected()?.reviews||[]).filter((item)=>item.lastReportAt>=cutoff).length;
    return {value:Math.min(count,5),label:`${count} learner-reported reviews in the last seven days; no mastery score.`};
  }
  if (tool === "study_routine_form") {
    if (!Number.isInteger(args.minutes)||args.minutes<5||args.minutes>120) throw new Error("Choose between 5 and 120 minutes per day.");
    if (!selected()) return {summary:"Choose a study language first, then save your daily routine."};
    return invoke("study_remember",{kind:"routine",text:`${args.minutes} minutes per day`});
  }
  if (tool === "study_pause") {
    recording = false;
    stoppedAt = Date.now();
    if (dirty) save();
    lilo.publish("study.changed", {phase:"inactive"});
    return { summary: "Study ended. Continue ordinary conversation without lessons, quizzes, reminders or assessments until another explicit study request.", context: context() };
  }
  if (tool === "study_memory") return { summary: list().summary, context: context(true) };
  const profile = selected();
  if (!profile) throw new Error("Choose a study language first.");
  if (tool === "study_budget") {
    if (typeof lilo.interaction !== "function" || typeof lilo.session !== "function") throw new Error("Update LILO to use linked study questions.");
    const locale=(profile.supportLanguage||lilo.session().supportLanguage||"en").split("-")[0].toLowerCase();
    const prompts={
      en:{question:"How many minutes can you study each day? Say a number from five to sixty.",confirmation:"You said {answer} minutes per day. Is that correct?",prefixes:["I can study","I have"],suffixes:["minutes","minutes per day"],accept:["yes","correct"],reject:["no","incorrect"],cancel:["cancel","stop"]},
      pt:{question:"Quantos minutos você pode estudar por dia? Diga um número entre cinco e sessenta.",confirmation:"Você disse {answer} minutos por dia. Está correto?",prefixes:["posso estudar","tenho"],suffixes:["minutos","minutos por dia"],accept:["sim","correto"],reject:["não","nao"],cancel:["cancela","cancelar"]},
      it:{question:"Quanti minuti puoi studiare ogni giorno? Di un numero tra cinque e sessanta.",confirmation:"Hai detto {answer} minuti al giorno. È corretto?",prefixes:["posso studiare","ho"],suffixes:["minuti","minuti al giorno"],accept:["sì","si","corretto"],reject:["no","non corretto"],cancel:["annulla","cancella"]}
    };
    const prompt=prompts[locale]||prompts.en;
    const response=lilo.interaction("ask",{question:prompt.question,answer:{kind:"number",min:5,max:60,prefixes:prompt.prefixes,suffixes:prompt.suffixes},confirmation:{question:prompt.confirmation,accept:prompt.accept,reject:prompt.reject},cancel:prompt.cancel,timeoutMs:30000,retries:1});
    pendingBudget=response.status==="waitingDelivery"?{id:response.id,language:profile.language}:null;
    return {summary:response.status==="waitingDelivery"?"I will ask your daily study time and confirm it before saving.":"A live voice question is not available. Your existing course and routine are unchanged."};
  }
  if (["study_review_add", "study_review_recalled", "study_review_retry", "study_review_forget"].includes(tool)) {
    const text = clean(args.text, 300);
    if (!text) throw new Error("Say which expression to review.");
    profile.reviews = profile.reviews || [];
    let item = profile.reviews.find((review) => review.text.toLowerCase() === text.toLowerCase());
    if (tool === "study_review_forget") {
      const observed=wordProgress(profile).find((word)=>word.text.toLowerCase()===text.toLowerCase());
      if (!item && !observed) throw new Error("No saved study expression matches that text.");
      profile.reviews = profile.reviews.filter((review) => review !== item);
      forgetEvidence(profile, item?item.text:observed.text);
      save(true);
      return {summary: "Study expression forgotten.", context: context()};
    }
    if (tool === "study_review_add") {
      if (!item) {
        if (profile.reviews.length >= 50) throw new Error("The study review notebook is full. Forget an expression before adding another.");
        profile.reviews.push({text, stage: 0, dueAt: Date.now(), source: "learner"});
      }
    } else {
      if (!item) throw new Error("Save that study expression before recording a review.");
      const intervals = [1, 3, 7, 14, 30];
      if (tool === "study_review_retry") item.stage = 0;
      item.dueAt = Date.now() + intervals[item.stage] * 86_400_000;
      if (tool === "study_review_recalled") item.stage = Math.min(item.stage + 1, intervals.length - 1);
      item.lastReport = tool === "study_review_recalled" ? "learner recalled" : "learner requested another review";
      item.lastReportAt = Date.now();
    }
    save();
    return {summary: "Study expression's review schedule saved from your report.", context: context()};
  }
  if (tool === "study_remember") {
    const kind = ["goal", "plan", "routine", "correction", "answer"].includes(args.kind) ? args.kind : "note";
    const text = kind === "answer" && args.text === undefined ? lastTutorAnswer : clean(args.text, 600);
    if (!text) throw new Error("Say what you want to remember for your study.");
    if (text.length > 600) throw new Error("That tutor answer is too long to pin as one note. Ask to save a shorter excerpt.");
    if (!profile.notes.some((note) => note.text === text && (note.kind || "note") === kind)) {
      const existing = kind !== "note" ? profile.notes.findIndex((note) => note.kind === kind) : -1;
      if (existing >= 0) profile.notes.splice(existing, 1);
      if (profile.notes.length >= MAX_NOTES) throw new Error("Your study notebook is full. Forget a note before adding another.");
      profile.notes.push({ text, kind, source: kind === "answer" ? "tutor-answer-requested-by-learner" : "learner", at: Date.now() });
      save();
    }
    return { summary: "Learner note saved in study memory.", context: context() };
  }
  if (tool === "study_forget_note") {
    const text = clean(args.text, 600);
    const index = profile.notes.findIndex((note) => note.text === text);
    if (index < 0) throw new Error("No pinned study note matches that text.");
    profile.notes.splice(index, 1);
    profile.reviews = (profile.reviews || []).filter((review) => !review.text.includes(text));
    // Remove exact copies of this note from other evidence too.
    forgetEvidence(profile, text);
    save(true);
    return { summary: "Study note forgotten.", context: context() };
  }
  if (tool === "study_edit_note") {
    const text = clean(args.text, 600);
    const replacement = clean(args.replacement, 600);
    if (!text || !replacement) throw new Error("Provide the saved text and its replacement.");
    const note = profile.notes.find((item) => item.text === text);
    if (!note) throw new Error("No saved study note matches that text.");
    if (profile.notes.some((item) => item !== note && item.text === replacement && item.kind === note.kind)) throw new Error("That saved text already exists.");
    note.text = replacement;
    note.at = Date.now();
    save(true);
    return {summary:"Saved study item updated.",context:context()};
  }
  if (tool === "study_clear") {
    state.profiles = state.profiles.filter((item) => item !== profile);
    state.selected = state.profiles.length ? state.profiles[0].language : "";
    recording = false;
    sessionId = null;
    stoppedAt = 0;
    startedAt = 0;
    save(true);
    return { summary: "Selected language's study memory deleted.", context: context() };
  }
  throw new Error("Unknown study tool.");
}

function event(topic, payload, source) {
  if (topic === "activity.started" && payload?.owner === source && source !== "com.lilo.study" && source !== "host") {
    if (recording) invoke("study_pause", {});
    return;
  }
  if (source !== "host" || !payload) return;
  if (topic === "interaction.changed") {
    if (payload.pluginId !== "com.lilo.study" || !pendingBudget || payload.id !== pendingBudget.id) return;
    if (payload.status === "confirmed") {
      const profile=state.profiles.find((item)=>item.language===pendingBudget.language);
      const minutes=payload.answer;
      const previous=profile?.notes.slice();
      pendingBudget=null;
      if (!profile || typeof minutes!=="number" || !Number.isFinite(minutes) || minutes<5 || minutes>60) throw new Error("Invalid confirmed study budget.");
      const note={text:`${minutes} minutes per day`,kind:"routine",source:"learner-confirmed",at:Date.now()};
      const existing=profile.notes.findIndex((item)=>item.kind==="routine");
      if(existing>=0) profile.notes[existing]=note;
      else {if(profile.notes.length>=MAX_NOTES)throw new Error("Your study notebook is full. Forget a note before saving this routine.");profile.notes.push(note);}
      try { save(true); }
      catch(error) { profile.notes=previous; throw error; }
      lilo.publish("study.changed",{});
    } else if (["declined","canceled","timedOut","unsupported","failed"].includes(payload.status)) {
      pendingBudget=null;
    }
    return;
  }
  if (typeof payload.sessionId !== "string") return;
  if (topic === "conversation.ended") {
    for (const profile of state.profiles) {
      const session = profile.sessions.find((item) => item.id === payload.sessionId);
      if (session && !session.endedAt) {
        session.endedAt = payload.at;
        profile.lastCheckpoint = {
          at: payload.at,
          source: "spoken evidence",
          learnerTurns: session.turns.filter((turn) => turn.speaker === "user").slice(-2).map((turn) => ({text: turn.text.slice(0, 400)})),
          tutorTurns: session.turns.filter((turn) => turn.speaker === "assistant").slice(-2).map((turn) => ({text: turn.text})),
        };
        dirty = true;
      }
    }
    if (dirty) save();
    if (sessionId === payload.sessionId || sessionId === null) {
      recording = false;
      sessionId = null;
      stoppedAt = 0;
      lastTutorAnswer = null;
      lilo.publish("study.changed", {phase:"inactive"});
    }
    return;
  }
  if (topic !== "conversation.turn") return;
  const finishing = !recording && stoppedAt && payload.at >= startedAt && payload.at <= stoppedAt;
  if (!recording && !finishing) return;
  const turn = payload.turn;
  if (!turn || (turn.speaker !== "user" && turn.speaker !== "assistant")) return;
  const full = clean(turn.text, 2_000);
  if (turn.speaker === "assistant") lastTutorAnswer = full.length <= 600 ? full : null;
  const text = full.length > 1_200 ? full.slice(0, 599) + "…" + full.slice(-600) : full;
  if (!text || text.startsWith("[LILO]")) return;
  if (turn.speaker === "user" && /^(forget my study note|forget study expression|esquece minha anotação de estudo|esquece a expressão|dimentica la mia nota di studio|dimentica l'espressione)\b/i.test(text)) return;
  const profile = selected();
  if (!profile) return;
  if (profile.language === "Not chosen yet" && turn.speaker === "user") {
    const target = languageKey(text);
    if (["Italian", "English", "French", "Spanish", "German", "Portuguese"].includes(target)) {
      const existing = state.profiles.find((item) => item.language === target);
      if (!existing) { profile.language = target; state.selected = target; }
    }
  }
  sessionId = payload.sessionId;
  let session = profile.sessions.find((item) => item.id === sessionId);
  if (!session) {
    session = { id: sessionId, startedAt: payload.at, turns: [] };
    profile.sessions.push(session);
    profile.sessions = profile.sessions.slice(-MAX_SESSIONS);
  }
  const evidence = { id: sessionId + ":" + String(turn.id), speaker: turn.speaker, text, at: payload.at };
  const index = session.turns.findIndex((item) => item.id === evidence.id);
  recordPracticeDay(profile, evidence);
  if (index >= 0) session.turns[index] = evidence;
  else session.turns.push(evidence);
  session.turns = session.turns.slice(-MAX_TURNS);
  captureCheckpoints(profile, session, evidence);
  const initial = profile.onboarding.findIndex((item) => item.id === evidence.id);
  if (initial >= 0) profile.onboarding[initial] = evidence;
  else if (profile.onboarding.length < 24) profile.onboarding.push(evidence);
  dirty = true;
}

// Checkpoint speech in batches; explicit edits and call endings flush immediately.
function tick() {
  if (dirty && Date.now() - lastSavedAt >= 10_000) save();
}

function shutdown() {
  if (dirty) save();
}

// A small oral-task curriculum adapted from CEFR, not an official CEFR test.
const DAY = 86_400_000;
const LEVELS = ["Pre-A1", "A1", "A2", "B1", "B2", "C1", "C2"];
const SKILLS = ["listening", "conversation", "fluency", "vocabulary", "grammar", "pronunciation"];
const SKILL_LABELS = ["Listening", "Natural conversation", "Fluency", "Vocabulary", "Grammar", "Pronunciation"];
const TASKS = {
  listening: [
    ["Identify familiar words in slow personal questions", "Follow a short, clearly spoken instruction"],
    ["Understand the details of an everyday exchange", "Follow a short announcement about a familiar need"],
    ["Retell the main points of a clear everyday story", "Follow an explanation and identify reasons"],
    ["Compare arguments in an extended discussion", "Explain implied intentions in a normal-speed exchange"],
    ["Interpret unstated attitudes in complex speech", "Follow an unfamiliar extended explanation"],
    ["Distinguish subtle meanings in rapid complex speech", "Synthesize layered spoken arguments without simplification"]
  ],
  conversation: [
    ["Introduce yourself with help from a cooperative partner", "Ask and answer simple personal questions"],
    ["Complete a routine shop or travel exchange", "Exchange plans and preferences with brief follow-up questions"],
    ["Handle an unexpected travel problem without a script", "Sustain a familiar conversation and explain your opinions"],
    ["Negotiate a decision and respond to disagreement", "Develop a viewpoint while inviting another perspective"],
    ["Adapt register while discussing a sensitive topic", "Manage turns and clarify subtle misunderstandings"],
    ["Negotiate nuanced disagreement with tact", "Shift register naturally in an unfamiliar complex discussion"]
  ],
  fluency: [
    ["Produce a short personal description despite pauses", "Link a few familiar phrases in a simple response"],
    ["Describe your routine in a short connected sequence", "Explain a simple plan despite visible hesitation"],
    ["Narrate an experience in a connected account", "Keep speaking through a missing word using paraphrase"],
    ["Explain an argument at a steady conversational pace", "Repair a hesitation without losing the listener"],
    ["Give a structured extended account with few disruptions", "Express a complex idea spontaneously with natural pacing"],
    ["Reformulate precise meanings smoothly under pressure", "Deliver a complex spontaneous account with flexible rhythm"]
  ],
  vocabulary: [
    ["Use basic words for personal needs", "Name familiar people, places and everyday objects"],
    ["Choose words for routine transactions", "Describe familiar activities beyond memorized phrases"],
    ["Paraphrase a missing word during a familiar discussion", "Use enough range to describe experiences and opinions"],
    ["Choose precise words for contrasting viewpoints", "Use varied phrasing without frequent repetition"],
    ["Use nuanced phrasing and appropriate collocations", "Explain an unfamiliar topic with flexible lexical choices"],
    ["Express fine shades of meaning with precise wording", "Use figurative and idiomatic language appropriately"]
  ],
  grammar: [
    ["Build a simple personal statement with a basic sentence pattern", "Ask a basic question with understandable word order"],
    ["Distinguish everyday past and present events", "Connect simple clauses to explain a familiar plan"],
    ["Narrate events with consistent time reference", "Give reasons and conditions with connected clauses"],
    ["Use varied complex sentences to develop an argument", "Notice and repair errors that could cause confusion"],
    ["Maintain accurate complex structures in spontaneous discussion", "Choose structures that clarify emphasis and nuance"],
    ["Control intricate structures while reformulating meaning", "Preserve grammatical accuracy under complex conversational demands"]
  ],
  pronunciation: [
    ["Make familiar words intelligible to a cooperative listener", "Use recognizable stress in a practiced short phrase"],
    ["Make a routine spoken exchange understandable", "Use basic word stress and phrase grouping"],
    ["Stay intelligible in an unprepared connected account", "Use stress and intonation to clarify a familiar message"],
    ["Maintain intelligibility during an extended argument", "Use rhythm and intonation to support meaning"],
    ["Use prosody to convey subtle attitude and emphasis", "Maintain clear articulation in complex spontaneous speech"],
    ["Control prosody to distinguish fine shades of meaning", "Adapt articulation and rhythm flexibly to the conversation"]
  ]
};
const CHECKPOINT_GUIDANCE = "Use the saved progress task catalogue to select one short task at a time, starting with diagnosis near the learner's starting point. Test independently before showing an answer. After a meaningful task, optionally finish your spoken feedback with this exact English checkpoint sentence: 'Study checkpoint: conversation B1 1 2; evidence: handled the ticket change independently; audio: none.' Replace skill, level, task number (1 or 2), score and concrete evidence with what actually happened. Scores: 0 not yet, 1 with help, 2 independently, 3 flexibly and independently. Never make up observations. For listening, fluency or pronunciation, assess only if you actually heard the learner's audio and use 'audio: heard'; captions alone cannot assess these skills. For pronunciation assess intelligibility, articulation, stress and rhythm, not resemblance to a native accent. Keep the technical checkpoint short, explain it once, and use normal support-language feedback around it. A word retrieval check can end with 'Study word: example; meaning: a model to follow; recall: 4; pronunciation: unknown; audio: none.' Replace the word and meaning; recall is 0-5 (0 forgotten, 1 incorrect, 2 incorrect but familiar, 3 correct with difficulty, 4 correct after hesitation, 5 easy); pronunciation is unknown or 0-3 with heard audio. Only record words the learner actually tried, not words merely presented. These markers are optional spoken observations captured from captions, not tool calls, and may fail if the provider changes their format. Review up to three due words at the start of study, mixing recall and fresh-context use. Every few minutes and at the end, check one previously demonstrated task without hints, praise specific improvements, and give a short next step. Never describe an unmeasured skill as zero, invent a percentage, or treat the starting point as certified. If checkpoints cannot be captured, explain that the tracker needs observations rather than inventing results.";

function tracker(profile) {
  if (!profile.tracker) profile.tracker = {baseline:"", assessments:[], words:[]};
  return profile.tracker;
}
function recordPracticeDay(profile, evidence) {
  if (evidence.speaker !== "user") return;
  if (!profile.practiceDays) {
    const days = Object.create(null);
    for (const session of profile.sessions) for (const turn of session.turns) {
      if (turn.speaker === "user") days[dayKey(turn.at)] = (days[dayKey(turn.at)] || 0) + 1;
    }
    profile.practiceDays = Object.entries(days).map(([day, turns]) => ({day, turns}));
    profile.practiceTurnIds = profile.sessions.flatMap((session)=>session.turns).filter((turn)=>turn.speaker==="user").map((turn)=>turn.id).slice(-512);
  }
  if (profile.practiceTurnIds.includes(evidence.id)) return;
  profile.practiceTurnIds.push(evidence.id);
  profile.practiceTurnIds = profile.practiceTurnIds.slice(-512);
  const day = dayKey(evidence.at);
  let activity = profile.practiceDays.find((item)=>item.day===day);
  if (!activity) {activity={day,turns:0};profile.practiceDays.push(activity);}
  activity.turns++;
  profile.practiceDays = profile.practiceDays.sort((a,b)=>a.day.localeCompare(b.day)).slice(-90);
}
function dayKey(at) {
  const date = new Date(at);
  return date.getFullYear() + "-" + String(date.getMonth()+1).padStart(2,"0") + "-" + String(date.getDate()).padStart(2,"0");
}
function progressData(profile) {
  return profile.tracker || {baseline:"", assessments:[], words:[]};
}
function taskEvidence(profile, skill, level, task, at) {
  const records = progressData(profile).assessments.filter((item) => item.skill===skill && item.level===level && item.task===task && item.at<=at && item.at>at-45*DAY).sort((a,b)=>a.at-b.at);
  const days = Object.create(null);
  for (const record of records) days[record.day] = record;
  const recent = Object.values(days).sort((a,b)=>a.at-b.at).slice(-2);
  const latest = recent[recent.length-1];
  const independent = recent.filter((item)=>item.score>=2).length;
  return {latest, independent, coverage:latest ? Math.min(1,latest.score/2)*independent/2 : 0,
    demonstrated:recent.length===2 && independent===2};
}
function journey(profile, at) {
  let demonstrated = "";
  for (const level of LEVELS.slice(1)) {
    if (SKILLS.every((skill)=>[1,2].every((task)=>taskEvidence(profile,skill,level,task,at).demonstrated))) demonstrated=level;
  }
  const baseline = progressData(profile).baseline;
  const starting = demonstrated || baseline || "Pre-A1";
  const target = LEVELS[Math.min(LEVELS.indexOf(starting)+1,6)];
  const skills = SKILLS.map((skill,index)=>{
    const tasks=[1,2].map((task)=>taskEvidence(profile,skill,target,task,at));
    return {skill,label:SKILL_LABELS[index],value:tasks.some((item)=>item.latest)?Math.round(tasks.reduce((sum,item)=>sum+item.coverage,0)*50):null,
      detail:tasks.some((item)=>item.latest)?tasks.filter((item)=>item.demonstrated).length+" / 2 tasks demonstrated on separate days":"Not assessed yet"};
  });
  return {demonstrated,starting,target,skills,percent:Math.round(skills.reduce((sum,item)=>sum+(item.value||0),0)/SKILLS.length),
    assessed:skills.filter((item)=>item.value!==null).length};
}
// SM-2 intervals with once-per-local-day evidence and a bounded one-year interval.
function reviewSchedule(records) {
  let ease=2.5, repetitions=0, interval=0, successes=0;
  const days=Object.create(null);
  for(const record of records) days[record.day]=record;
  const attempts=Object.values(days).sort((a,b)=>a.at-b.at);
  for(const record of attempts) {
    const quality=record.recall;
    if(quality<3) {repetitions=0;interval=1;successes=0;}
    else {interval=repetitions===0?1:repetitions===1?6:Math.ceil(interval*ease);repetitions++;successes++;}
    ease=Math.max(1.3,ease+0.1-(5-quality)*(0.08+(5-quality)*0.02));
    interval=Math.min(365,interval);
  }
  const latest=attempts[attempts.length-1];
  return {dueAt:latest?latest.at+interval*DAY:0,interval,successes,attempts:attempts.length,latest};
}
function wordProgress(profile) {
  const groups=Object.create(null);
  for(const record of progressData(profile).words) {
    const key=record.text.toLowerCase();
    (groups[key]||(groups[key]=[])).push(record);
  }
  return Object.values(groups).map((records)=>{
    records.sort((a,b)=>a.at-b.at);
    const latest=records[records.length-1];
    const audio=records.filter((item)=>item.pronunciation!==null);
    const firstAudio=audio[0], lastAudio=audio[audio.length-1];
    const schedule=reviewSchedule(records);
    return {...schedule,text:latest.text,meaning:latest.meaning,firstAt:records[0].at,
      pronunciation:lastAudio?lastAudio.pronunciation:null,
      improved:!!(firstAudio && lastAudio && firstAudio.day!==lastAudio.day && lastAudio.pronunciation>firstAudio.pronunciation),
      retained:schedule.successes>=3};
  }).sort((a,b)=>a.dueAt-b.dueAt);
}
function captureCheckpoints(profile,session,evidence) {
  const data=tracker(profile);
  // A caption revision replaces its own observations, including a removed marker.
  data.assessments=data.assessments.filter((item)=>item.id!==evidence.id);
  data.words=data.words.filter((item)=>item.id!==evidence.id);
  if(evidence.speaker!=="assistant") return;
  const learner=session.turns.filter((item)=>item.speaker==="user" && item.at<=evidence.at).slice(-1)[0];
  if(!learner || evidence.at-learner.at>10*60_000) return;
  const assessment=/(?:^|[.!?]\s+|\n)Study checkpoint: (listening|conversation|fluency|vocabulary|grammar|pronunciation) (A1|A2|B1|B2|C1|C2) ([12]) ([0-3]); evidence: ([^\n;]{5,240}); audio: (heard|none)\./gim;
  let match, count=0;
  while((match=assessment.exec(evidence.text)) && count++<6) {
    const skill=match[1].toLowerCase();
    if(["pronunciation","listening","fluency"].includes(skill) && match[6].toLowerCase()!=="heard") continue;
    data.assessments.push({id:evidence.id,learnerId:learner.id,skill,level:match[2].toUpperCase(),task:Number(match[3]),score:Number(match[4]),
      evidence:match[5],audio:match[6].toLowerCase(),at:evidence.at,day:dayKey(evidence.at),source:"tutor-observed"});
  }
  const word=/(?:^|[.!?]\s+|\n)Study word: ([^\n;]{1,100}); meaning: ([^\n;]{1,160}); recall: ([0-5]); pronunciation: (unknown|[0-3]); audio: (heard|none)\./gim;
  count=0;
  while((match=word.exec(evidence.text)) && count++<3) {
    if(match[4].toLowerCase()!=="unknown" && match[5].toLowerCase()!=="heard") continue;
    data.words.push({id:evidence.id,learnerId:learner.id,text:match[1].trim(),meaning:match[2].trim(),recall:Number(match[3]),
      pronunciation:match[4].toLowerCase()==="unknown"?null:Number(match[4]),at:evidence.at,day:dayKey(evidence.at),source:"tutor-observed"});
  }
  data.assessments=data.assessments.slice(-480);
  data.words=data.words.slice(-600);
}
function learningContext(profile) {
  const current=journey(profile,Date.now());
  const words=wordProgress(profile);
  const catalogue=SKILLS.map((skill)=>({skill,level:current.target,tasks:TASKS[skill][LEVELS.indexOf(current.target)-1]}));
  const retests=progressData(profile).assessments.filter((item)=>item.score>=2 && item.at<Date.now()-14*DAY)
    .filter((item)=>!progressData(profile).assessments.some((other)=>other.skill===item.skill && other.level===item.level && other.task===item.task && other.at>item.at)).slice(0,3)
    .map((item)=>({skill:item.skill,level:item.level,task:item.task,description:TASKS[item.skill][LEVELS.indexOf(item.level)-1][item.task-1]}));
  return {startingPoint:current.starting,startingPointSource:current.demonstrated?"repeated tutor observations":"self-reported or not assessed",
    provisionalLevel:current.demonstrated||null,target:current.target,taskCoveragePercent:current.percent,skills:current.skills,
    catalogue,retests,checkpointGuide:CHECKPOINT_GUIDANCE,dueWords:words.filter((item)=>item.dueAt<=Date.now()).slice(0,3).map((item)=>({text:item.text,meaning:item.meaning,intervalDays:item.interval})),
    next:learningNext(profile).detail,policy:"Task coverage is a LILO heuristic, not a CEFR percentage or certification. Require two independent observations on separate days; evidence older than 45 days needs reassessment."};
}
function learningNext(profile) {
  if(!profile) return {title:"Start your journey",detail:"Choose a language and talk about what you want to do with it."};
  const now=Date.now(), current=journey(profile,now), words=wordProgress(profile);
  const due=words.filter((item)=>item.dueAt<=now).slice(0,3);
  const missing=current.skills.slice().sort((a,b)=>(a.value??-1)-(b.value??-1))[0];
  const task=[1,2].find((number)=>!taskEvidence(profile,missing.skill,current.target,number,now).demonstrated)||1;
  const activity=TASKS[missing.skill][LEVELS.indexOf(current.target)-1][task-1];
  return {title:due.length?"Make yesterday's words yours":"One small step toward "+current.target,
    detail:(due.length?"Recall without hints, then use in a new sentence: "+due.map((item)=>item.text).join(", ")+". ":"")+activity+". Keep it short; revisit an older task before the session ends.",
    summary:"Next practice: "+activity+". "+due.length+" words are due for a retention check.",context:undefined};
}
function learningWords(profile) {
  if(!profile) return {items:[]};
  return {items:wordProgress(profile).slice(0,64).map((word)=>({label:word.text,
    detail:word.meaning+" · "+(word.retained?"Recalled on at least three separate days":"Growing with practice")+" · "+word.attempts+" review days · "+
      (word.dueAt<=Date.now()?"Review due":"Next review "+dayKey(word.dueAt))+
      (word.pronunciation!==null?" · Tutor pronunciation "+word.pronunciation+" / 3":" · Pronunciation not assessed")+
      (word.improved?" · Pronunciation improved since the first audio checkpoint":""),
    deleteAction:{label:"Forget expression",tool:"study_review_forget",args:{text:word.text}}}))};
}
function learningDashboard(profile) {
  if(!profile) return {title:"Your first small win starts here",detail:"Choose a language. Your journey grows from actual practice, not time spent with the app."};
  const now=Date.now(), current=journey(profile,now), words=wordProgress(profile), data=progressData(profile);
  const days=[];
  let hasLearnerTurns=false;
  for(let index=27;index>=0;index--) {
    const date=new Date(now);date.setHours(12,0,0,0);date.setDate(date.getDate()-index);
    const day=dayKey(date.getTime());
    const turns=profile.practiceDays?profile.practiceDays.find((item)=>item.day===day)?.turns||0:
      profile.sessions.flatMap((session)=>session.turns).filter((turn)=>turn.speaker==="user" && dayKey(turn.at)===day).length;
    if(turns>0) hasLearnerTurns=true;
    const checks=data.assessments.filter((item)=>item.day===day).length+data.words.filter((item)=>item.day===day).length;
    days.push({label:day,value:turns+checks,detail:turns+" recorded learner turns · "+checks+" tutor checkpoints"});
  }
  const activeDays=days.filter((item)=>item.value>0).length;
  let streak=0,index=days.length-1;
  if(days[index].value===0) index--;
  for(;index>=0 && days[index].value>0;index--) streak++;
  const today=dayKey(now);
  const learnedToday=words.filter((item)=>dayKey(item.firstAt)===today).length;
  const improved=words.filter((item)=>item.improved).length;
  const due=words.filter((item)=>item.dueAt<=now).length;
  const skillCheckpointsPending=hasLearnerTurns && data.assessments.length===0;
  return {title:profile.language+" · "+current.starting+" → "+current.target,
    detail:(current.demonstrated?"Provisional oral-task level: "+current.demonstrated:"Starting point: "+current.starting+" (self-reported or awaiting diagnosis)")+". "+current.percent+"% of LILO's next-level task evidence collected; "+current.assessed+" / 6 skills assessed. This is not a certified CEFR result.",
    dashboard:{hero:{label:"Next-level task coverage",value:current.percent,detail:"Two independent checks on separate days. Evidence expires after 45 days."},
      metrics:[{label:"Active days",value:String(activeDays),detail:"Last 28 days"},{label:"Current streak",value:String(streak),detail:"Days with practice; today can still count"},
        {label:"Words taking root",value:String(words.filter((item)=>item.retained).length),detail:words.length+" words tried · "+learnedToday+" new today"},
        {label:"Pronunciation wins",value:String(improved),detail:"Words improved across audio checkpoints"}],
      skills:current.skills.map(({label,value,detail})=>({label,value,detail})),
      series:[{label:"Your daily practice",kind:"bars",max:Math.max(5,...days.map((item)=>item.value)),points:days},
        {label:"Next-level evidence over time · "+current.target,kind:"line",max:100,points:days.map((day)=>{
          const end=new Date(day.label+"T23:59:59").getTime();
          const value=SKILLS.reduce((sum,skill)=>sum+[1,2].reduce((total,task)=>total+taskEvidence(profile,skill,current.target,task,Math.min(end,now)).coverage,0),0)/12*100;
          return {label:day.label,value:Math.round(value),detail:"Task evidence for "+current.target};
        })}],
      highlights:[{label:due?"Ready to reconnect":skillCheckpointsPending?"Skill checkpoints pending":"Keep the thread",detail:due?due+" words are due. Try recalling before seeing the answer.":skillCheckpointsPending?"Your practice turns are counted. Skill coverage remains unassessed until your tutor provides task checkpoints.":"Practice one small task today and return to an older one."},
        {label:"Your next small win",detail:learningNext(profile).detail},
        {label:"How the tracker works",detail:"Tutor observations are provisional. Unassessed skills remain unknown. Spoken checkpoints may be missed by the provider; ordinary captions and study time do not raise your level."}]}};
}

const STUDY_LABELS = {
  pt:{"Learning journey":"Jornada de aprendizado","Your next small win":"Sua próxima conquista","Words taking root":"Palavras se consolidando","Starting point":"Ponto de partida","Self-reported level":"Nível informado por você","Save starting point":"Salvar ponto de partida","Next-level task coverage":"Tarefas do próximo nível","Active days":"Dias ativos","Last 28 days":"Últimos 28 dias","Current streak":"Sequência atual","Days with practice; today can still count":"Dias de prática; hoje ainda pode contar","Pronunciation wins":"Conquistas na pronúncia","Words improved across audio checkpoints":"Palavras que melhoraram nas avaliações por áudio","Listening":"Compreensão oral","Natural conversation":"Conversa natural","Fluency":"Fluência","Vocabulary":"Vocabulário","Grammar":"Gramática","Pronunciation":"Pronúncia","Not assessed yet":"Ainda não avaliado","Your daily practice":"Sua prática diária","Ready to reconnect":"Pronto para retomar","Keep the thread":"Mantenha o ritmo","Skill checkpoints pending":"Avaliações de habilidades pendentes","Your practice turns are counted. Skill coverage remains unassessed until your tutor provides task checkpoints.":"Suas falas de prática estão sendo contadas. As habilidades só serão avaliadas quando o tutor registrar uma avaliação de tarefa.","How the tracker works":"Como funciona o acompanhamento","Two independent checks on separate days. Evidence expires after 45 days.":"Duas avaliações independentes em dias diferentes. As evidências precisam de revisão após 45 dias.","Your tutor's word checkpoints will appear here after practice.":"As avaliações de palavras feitas pelo tutor aparecerão aqui após a prática."},
  it:{"Learning journey":"Percorso di apprendimento","Your next small win":"Il tuo prossimo piccolo traguardo","Words taking root":"Parole che si consolidano","Starting point":"Punto di partenza","Self-reported level":"Livello dichiarato","Save starting point":"Salva punto di partenza","Next-level task coverage":"Attività del prossimo livello","Active days":"Giorni attivi","Last 28 days":"Ultimi 28 giorni","Current streak":"Serie attuale","Days with practice; today can still count":"Giorni di pratica; oggi può ancora contare","Pronunciation wins":"Progressi nella pronuncia","Words improved across audio checkpoints":"Parole migliorate nelle valutazioni audio","Listening":"Comprensione orale","Natural conversation":"Conversazione naturale","Fluency":"Fluidità","Vocabulary":"Vocabolario","Grammar":"Grammatica","Pronunciation":"Pronuncia","Not assessed yet":"Non ancora valutato","Your daily practice":"La tua pratica quotidiana","Ready to reconnect":"Pronto a riprendere","Keep the thread":"Mantieni il ritmo","Skill checkpoints pending":"Valutazioni delle abilità in attesa","Your practice turns are counted. Skill coverage remains unassessed until your tutor provides task checkpoints.":"I turni di pratica sono conteggiati. Le abilità restano non valutate finché il tutor non registra le verifiche.","How the tracker works":"Come funziona il monitoraggio","Two independent checks on separate days. Evidence expires after 45 days.":"Due valutazioni indipendenti in giorni diversi. Le evidenze richiedono una revisione dopo 45 giorni.","Your tutor's word checkpoints will appear here after practice.":"Le valutazioni delle parole appariranno qui dopo la pratica."}
};
