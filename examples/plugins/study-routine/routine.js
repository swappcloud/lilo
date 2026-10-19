// The durable routine belongs to the learner; the interview belongs to one call.
const OWNER = "com.lilo.study-routine";
if (typeof lilo.interaction !== "function") throw new Error("Update LILO: this interview requires linked interactions.");
const loaded = lilo.memory("read", {key:"routine"});
if (loaded.found && loaded.schemaVersion !== 1) throw new Error("Unsupported routine schema; existing data was preserved.");
let revision = loaded.revision;
let routine = loaded.found ? loaded.value : {minutes:null,confirmedAt:null};
if (!routine || (routine.minutes !== null && (!Number.isFinite(routine.minutes) || routine.minutes < 5 || routine.minutes > 60))) {
  throw new Error("Invalid saved routine; existing data was preserved.");
}
let pendingId = null;
let lastStatus = "idle";
const prompts = {
  en:{question:"How many minutes can you study each day? Say a number from five to sixty.",
    confirmation:"You said {answer} minutes per day. Is that correct?",prefixes:["I can study","I have"],suffixes:["minutes","minutes per day"],
    accept:["yes","correct"],reject:["no","incorrect"],cancel:["cancel","stop"]},
  pt:{question:"Quantos minutos você pode estudar por dia? Diga um número entre cinco e sessenta.",
    confirmation:"Você disse {answer} minutos por dia. Está correto?",prefixes:["posso estudar","tenho"],suffixes:["minutos","minutos por dia"],
    accept:["sim","correto"],reject:["não","nao"],cancel:["cancela","cancelar"]},
  it:{question:"Quanti minuti puoi studiare ogni giorno? Di un numero tra cinque e sessanta.",
    confirmation:"Hai detto {answer} minuti al giorno. È corretto?",prefixes:["posso studiare","ho"],suffixes:["minuti","minuti al giorno"],
    accept:["sì","si","corretto"],reject:["no","non corretto"],cancel:["annulla","cancella"]}
};
function describe() {
  return {
    tools:[
      {name:"routine_interview",description:"Ask for and confirm a daily study budget; never save an unconfirmed answer.",parameters:{type:"object",properties:{}}},
      {name:"routine_status",description:"Read the confirmed routine and pending interview status.",parameters:{type:"object",properties:{}}},
      {name:"routine_cancel",description:"Cancel this interview while preserving the saved routine.",parameters:{type:"object",properties:{}}}
    ],
    commands:[{name:"routine.interview",tool:"routine_interview",templates:[["en","plan my daily study time"],
      ["pt","planeja meu tempo de estudo diario"],["it","pianifica il mio tempo di studio giornaliero"]]},
      {name:"routine.status",tool:"routine_status",templates:[["en","read my study routine"],["pt","le minha rotina de estudo"],["it","leggi la mia routine di studio"]]},
      {name:"routine.cancel",tool:"routine_cancel",templates:[["en","cancel my study interview"],["pt","cancela minha entrevista de estudo"],["it","annulla la mia intervista di studio"]]}],
    subscribes:["interaction.changed"], publishes:["routine.changed","notify"], contextTool:"routine_status",
    ui:{status:[{label:"Daily study time",value:"Start an interview by voice; a separate confirmation is required."}],
      actions:[{label:"Ask daily study time",tool:"routine_interview"},{label:"Read saved routine",tool:"routine_status"},
        {label:"Cancel interview",tool:"routine_cancel"}]},
    prompt:"The interview asks for a daily time budget, then separately confirms the learner's answer. Never infer a confirmed answer from your own suggestion or a revised caption. Only claim saving after the plugin reports confirmed memory. An unsupported provider can read the saved routine but cannot conduct this linked voice interview. Do not open a new course when switching providers."
  };
}
function status() {
  return {summary:routine.minutes === null ? "No confirmed study routine yet. Interview status: " + lastStatus :
    "Confirmed study routine: " + routine.minutes + " minutes per day. Interview status: " + lastStatus,
    context:JSON.stringify({routine,interviewStatus:lastStatus,pendingId,evidence:"Explicit user-confirmed budget, not a proficiency assessment."})};
}
function invoke(tool) {
  if (tool === "routine_status") return status();
  if (tool === "routine_cancel") {
    if (pendingId) lilo.interaction("cancel",{id:pendingId});
    pendingId = null;
    lastStatus = "canceled";
    return status();
  }
  if (tool !== "routine_interview") throw new Error("Unknown routine tool.");
  const session = lilo.session();
  const locale = (session.supportLanguage || "en").split("-")[0].toLowerCase();
  const prompt = prompts[locale] || prompts.en;
  // Plain numeric answers work too; localized prefixes are explicitly optional here.
  const response = lilo.interaction("ask",{question:prompt.question,
    answer:{kind:"number",min:5,max:60,prefixes:prompt.prefixes,suffixes:prompt.suffixes},
    confirmation:{question:prompt.confirmation,accept:prompt.accept,reject:prompt.reject},
    cancel:prompt.cancel,timeoutMs:30000,retries:1});
  lastStatus = response.status;
  pendingId = response.status === "waitingDelivery" ? response.id : null;
  return status();
}
function event(topic, payload, source) {
  if (source !== "host" || topic !== "interaction.changed" || !payload || payload.pluginId !== OWNER || payload.id !== pendingId) return;
  lastStatus = payload.status;
  if (payload.status === "confirmed") {
    // A terminal answer is consumed once, even when durable storage fails.
    pendingId = null;
    if (!Number.isFinite(payload.answer) || payload.answer < 5 || payload.answer > 60) throw new Error("Invalid confirmed budget.");
    const next = {minutes:payload.answer,confirmedAt:Date.now()};
    let saved;
    try {
      saved = lilo.memory("write",{key:"routine",schemaVersion:1,expectedRevision:revision,value:next,purgePrevious:true});
    } catch (error) {
      lastStatus = "failed";
      throw error;
    }
    revision = saved.revision;
    routine = saved.value;
    lilo.publish("routine.changed",{});
    lilo.publish("notify",{summary:"Your confirmed study routine was saved: " + routine.minutes + " minutes per day."});
  } else if (["canceled","declined","timedOut","unsupported","failed"].includes(payload.status)) {
    pendingId = null;
    lilo.publish("routine.changed",{});
  }
}
