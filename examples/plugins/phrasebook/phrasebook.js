// A small offline travel scenario; session metadata selects explanations, never a provider id.
if (typeof lilo.session !== "function") throw new Error("Update LILO: this phrasebook needs session context.");
const phrases = [
  {phrase: "Vorrei un caffè, per favore.", en: "I would like a coffee, please.", pt: "Eu gostaria de um café, por favor.", it: "Una richiesta cortese al bar."},
  {phrase: "Quanto costa il biglietto?", en: "How much does the ticket cost?", pt: "Quanto custa a passagem?", it: "Una domanda sul prezzo del biglietto."},
  {phrase: "Può parlare più lentamente?", en: "Could you speak more slowly?", pt: "Pode falar mais devagar?", it: "Una richiesta per capire meglio."}
];
function describe() {
  return {
    tools: [{name:"phrasebook_today", description:"Read Italian travel phrases with explanations in the support language.",
      parameters:{type:"object",properties:{}}}],
    commands: [{name:"phrasebook.today",tool:"phrasebook_today",templates:[["en","read my travel phrases"],
      ["pt","le minhas frases de viagem"],["it","leggi le mie frasi di viaggio"]]}],
    subscribes:["session.changed"], publishes:["phrasebook.changed"], contextTool:"phrasebook_today",
    ui:{actions:[{label:"Read travel phrases",tool:"phrasebook_today"}],
      list:{title:"Italian travel phrases",tool:"phrasebook_today"},
      localized:{pt:{"Read travel phrases":"Ler frases de viagem","Italian travel phrases":"Frases de viagem em italiano"},
        it:{"Read travel phrases":"Leggi le frasi di viaggio","Italian travel phrases":"Frasi di viaggio in italiano"}}},
    prompt:"Explain the offline phrasebook in the user's support language; Italian is the practice language. Request live delivery only when the declared provider supports text. Missing live text means this content is available through the result, panel and next opening context; do not claim it was sent mid-call."
  };
}
function invoke(tool) {
  if (tool !== "phrasebook_today") throw new Error("Unknown phrasebook tool.");
  const session = lilo.session();
  const locale = (session.supportLanguage || "en").split("-")[0].toLowerCase();
  const items = phrases.map((entry) => ({label:entry.phrase, detail:entry[locale] || entry.en}));
  const liveText = session.state === "connected" && !!(session.provider && session.provider.outbound.text);
  return {summary:items[0].label + " " + items[0].detail, items,
    context:JSON.stringify({supportLanguage:session.supportLanguage, phrases:items, liveText,
      delivery:liveText ? "Live text is declared; the host routes this result." : "Use the panel or next opening context; no live text channel is available."})};
}
function event(topic, payload, source) {
  if (topic === "session.changed" && source === "host") lilo.publish("phrasebook.changed", {});
}
