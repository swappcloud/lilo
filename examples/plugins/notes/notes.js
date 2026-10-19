// Voice notebook with stable row identities and migration of the original text file.
const STORE = "notes.txt";
let max = 20;
let revision = 0;
const atomic = typeof lilo.memory === "function" && typeof lilo.hostInfo === "function" &&
  lilo.hostInfo().permissions.includes("storage:self");
const parameters = (properties, required) => ({type:"object",properties,required:required||[]});
const textField = {type:"string",maxLength:2000};

function describe() {
  return {
    tools:[
      {name:"notes_add",description:"Save a short text note.",parameters:parameters({text:textField},["text"])},
      {name:"notes_list",description:"Read saved notes and their editing controls.",parameters:parameters({})},
      {name:"notes_edit",description:"Replace a saved note using its exact previous text to avoid overwriting a changed note.",parameters:parameters({id:{type:"integer"},text:textField,replacement:textField},["text","replacement"])},
      {name:"notes_delete",description:"Delete one saved note by stable ID or exact text.",parameters:parameters({id:{type:"integer"},text:textField})},
      {name:"notes_clear",description:"Delete every saved note after confirmation.",parameters:parameters({})},
    ],
    commands:[
      noteCommand("add","notes_add",["note that {!text}","make a note {!text}"],["anota que {!text}","anota {!text}"],["annota {!text}"]),
      noteCommand("list","notes_list",["read my notes","what are my notes"],["quais são minhas notas","lê minhas anotações"],["leggi le mie note"]),
      noteCommand("edit","notes_edit",["change my note {!text} to {!replacement}"],["edita minha nota {!text} para {!replacement}"],["modifica la mia nota {!text} in {!replacement}"]),
      noteCommand("delete","notes_delete",["delete my note {!text}"],["apaga minha nota {!text}"],["elimina la mia nota {!text}"],true),
      noteCommand("clear","notes_clear",["clear my notes","delete all my notes"],["apaga minhas anotações","limpa minhas anotações"],["elimina tutte le mie note"],true),
    ],
    publishes:["notes.changed"],
    localized:{
      pt:{"My voice notes":"Minhas notas por voz","No notes yet. Add one here or by voice.":"Nenhuma nota ainda. Adicione aqui ou por voz.","New note":"Nova nota","Note":"Nota","Save note":"Salvar nota","Edit note":"Editar nota","Delete note":"Excluir nota","Maximum notes":"Máximo de notas","Older notes are replaced when this limit is reached.":"Notas mais antigas são substituídas quando este limite é atingido.","Storage":"Armazenamento","Local to this device":"Local neste dispositivo"},
      it:{"My voice notes":"Le mie note vocali","No notes yet. Add one here or by voice.":"Nessuna nota. Aggiungine una qui o a voce.","New note":"Nuova nota","Note":"Nota","Save note":"Salva nota","Edit note":"Modifica nota","Delete note":"Elimina nota","Maximum notes":"Numero massimo di note","Older notes are replaced when this limit is reached.":"Le note più vecchie vengono sostituite quando si raggiunge il limite.","Storage":"Archiviazione","Local to this device":"Locale su questo dispositivo"},
    },
    ui:{
      status:[{label:"Storage",value:"Local to this device"}],
      settings:[{key:"max",kind:"range",label:"Maximum notes",min:1,max:50,default:20,help:"Older notes are replaced when this limit is reached."}],
      list:{title:"My voice notes",tool:"notes_list",empty:"No notes yet. Add one here or by voice."},
      forms:[{title:"New note",tool:"notes_add",submitLabel:"Save note",fields:[{key:"text",label:"Note",kind:"text",required:true,maxLength:600}]}],
    },
    prompt:"Keep a local voice notebook. Save, read and edit notes when requested; ask for confirmation before deleting. Notes also appear automatically on the plugin page with copy, edit and delete controls.",
  };
}
function noteCommand(name,tool,en,pt,it,confirm) {
  return {name:"notes."+name,tool,requiresConfirm:!!confirm,
    descriptions:[["en","Manage saved notes."],["pt","Gerencie notas salvas."],["it","Gestisci le note salvate."]],
    templates:en.map((text)=>["en",text]).concat(pt.map((text)=>["pt",text]),it.map((text)=>["it",text]))};
}
function configure(settings) {
  const value=Number(settings&&settings.max);
  if(Number.isFinite(value) && value>=1) max=Math.min(50,Math.round(value));
}
function empty() {return {version:1,nextId:1,notes:[]};}
function load() {
  if(atomic) {
    const record=lilo.memory("read",{key:"notes"});revision=record.revision;
    if(record.found) {
      validate(record.value);
      // A migrated plaintext file must not retain deleted or edited notes.
      if(lilo.read(STORE)) lilo.write(STORE,"");
      return record.value;
    }
  }
  const raw=lilo.read(STORE);
  if(!raw) return empty();
  let value;
  if(raw.startsWith('{"version":')) {value=JSON.parse(raw);validate(value);}
  else {
    value=empty();
    value.notes=raw.split("\n").filter((line)=>line.length>0).map((text)=>({id:value.nextId++,text,at:null}));
  }
  if(atomic) {
    revision=lilo.memory("write",{key:"notes",schemaVersion:1,expectedRevision:revision,value,purgePrevious:true}).revision;
    lilo.write(STORE,"");
  }
  return value;
}
function validate(value) {
  if(!value || value.version!==1 || !Number.isInteger(value.nextId) || !Array.isArray(value.notes) ||
    value.notes.some((note)=>!Number.isInteger(note.id)||typeof note.text!=="string"))
    throw new Error("Unsupported note storage. Existing notes were preserved.");
}
function persist(value,forgetting) {
  if(atomic) revision=lilo.memory("write",{key:"notes",schemaVersion:1,expectedRevision:revision,value,purgePrevious:!!forgetting}).revision;
  else lilo.write(STORE,JSON.stringify(value));
  lilo.publish("notes.changed",{});
}
function validText(value) {
  if(typeof value!=="string" || !value.trim() || value.trim().length>2000) throw new Error("Provide a note of 1 to 2000 characters.");
  return value.trim();
}
function invoke(tool,args) {
  args=args||{};
  const value=load();
  if(tool==="notes_list") return {
    notes:value.notes.map((note)=>note.text),count:value.notes.length,
    summary:value.notes.length?value.notes.map((note)=>note.text).join("; "):"No notes yet.",
    items:value.notes.slice().reverse().map((note)=>({label:note.text.slice(0,60),detail:note.text,
      edit:{label:"Edit note",tool:"notes_edit",matchParameter:"text",valueParameter:"replacement",args:{id:note.id}},
      deleteAction:{label:"Delete note",tool:"notes_delete",args:{id:note.id,text:note.text}}})),
  };
  if(tool==="notes_add") {
    const text=validText(args.text);
    value.notes.push({id:value.nextId++,text,at:Date.now()});
    const trimmed=value.notes.length>max;
    value.notes=value.notes.slice(-max);persist(value,trimmed);
    return {saved:text,summary:"Note saved."};
  }
  if(tool==="notes_clear") {
    const count=value.notes.length;value.notes=[];persist(value,true);
    return {cleared:count,summary:"Deleted "+count+" notes."};
  }
  if(tool!=="notes_edit" && tool!=="notes_delete") throw new Error("Unknown notes tool.");
  const index=args.id!==undefined?value.notes.findIndex((note)=>note.id===args.id):value.notes.findIndex((note)=>note.text===args.text);
  if(index<0) throw new Error("That saved note was not found. Refresh the list.");
  const note=value.notes[index];
  if(args.text!==undefined && note.text!==args.text) throw new Error("That note changed. Refresh the list before editing or deleting it.");
  if(tool==="notes_edit") {note.text=validText(args.replacement);note.at=Date.now();}
  else value.notes.splice(index,1);
  persist(value,true);
  return {summary:tool==="notes_edit"?"Note updated.":"Note deleted."};
}
