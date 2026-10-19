import { messages } from "../types";

/** Transcript, conversation rail and the phone sign-in sheet. */
export const session = messages({
  en: {
    "transcript.copy": "Copy message",
    "transcript.copied": "Copied",
    "transcript.copyFailed": "Could not copy message",

    "transcript.title": "Transcript",
    "transcript.live": "live",
    "transcript.empty":
      "No messages yet. Start a session and speak — captions stream here.",
    "transcript.suggestion1": "What time is it?",
    "transcript.suggestion2": "Search the web for the Eiffel Tower",
    "transcript.suggestion3": "Give me a fun fact",

    "conversations.title": "Conversations",
    "conversations.new": "New conversation",
    "conversations.newTitle": "New conversation",
    "conversations.help":
      "Calls continue the selected conversation and its linked provider chat. Switching providers carries conversation context. Start a new conversation whenever you want; a full conversation opens a continuation.",
    "conversations.rename": "Rename",
    "conversations.today": "Today",
    "conversations.yesterday": "Yesterday",
    "conversations.week": "This week",
    "conversations.earlier": "Earlier",
    "conversations.noPreview": "Nothing said yet",
    "conversations.delete": "Delete conversation",
    "conversations.deleteShort": "Delete",
    "conversations.confirmDelete":
      "Delete “{title}”? The transcript goes with it.",
    "conversations.deletePrompt": "Delete this conversation?",

    "phone.title": "Sign in with your phone",
    "phone.starting": "Starting the helper server…",
    "phone.sameWifi": "Phone and PC must be on the same Wi-Fi. Scan or open:",
    "phone.copy": "Copy link",
    "phone.copied": "Copied",
    "phone.step1": "On the phone page, enter the e-mail of your {backend} account.",
    "phone.step2": "{backend} e-mails you a code — type it on the phone page.",
    "phone.step3": "Your PC signs in to {backend} by itself and LILO connects.",
    "phone.noApps":
      "Nothing to install: the phone only relays what the sign-in page on your PC asks for.",
    "phone.waiting": "Waiting for phone…",
    "phone.cancel": "Cancel",
    "phone.signedIn": "Signed in as {email}",
    "phone.network": "Computer network",
    "phone.networkHelp": "If the phone cannot open the link, select the Wi-Fi or Ethernet network it shares with this computer and scan the new QR code.",
    "phone.windowsFirewall": "If the page opens on the PC but not on the phone, allow LILO through Windows Firewall on your private network. Keep this screen open while signing in.",
  },
  pt: {
    "transcript.copy": "Copiar mensagem",
    "transcript.copied": "Copiado",
    "transcript.copyFailed": "Não foi possível copiar a mensagem",

    "transcript.title": "Transcrição",
    "transcript.live": "ao vivo",
    "transcript.empty":
      "Nenhuma mensagem ainda. Inicie uma sessão e fale — as legendas aparecem aqui.",
    "transcript.suggestion1": "Que horas são?",
    "transcript.suggestion2": "Pesquise na web sobre a Torre Eiffel",
    "transcript.suggestion3": "Me dê uma curiosidade",

    "conversations.title": "Conversas",
    "conversations.new": "Nova conversa",
    "conversations.newTitle": "Nova conversa",
    "conversations.help":
      "As chamadas continuam a conversa selecionada e o chat vinculado do provedor. Ao trocar de provedor, o contexto acompanha a conversa. Você pode iniciar outra quando quiser; uma conversa cheia abre uma continuação.",
    "conversations.rename": "Renomear",
    "conversations.today": "Hoje",
    "conversations.yesterday": "Ontem",
    "conversations.week": "Esta semana",
    "conversations.earlier": "Antes",
    "conversations.noPreview": "Nada dito ainda",
    "conversations.delete": "Excluir conversa",
    "conversations.deleteShort": "Excluir",
    "conversations.confirmDelete":
      "Excluir “{title}”? O histórico vai junto.",
    "conversations.deletePrompt": "Excluir esta conversa?",

    "phone.title": "Entrar com seu celular",
    "phone.starting": "Iniciando o servidor auxiliar…",
    "phone.sameWifi":
      "Celular e PC precisam estar no mesmo Wi-Fi. Escaneie ou abra:",
    "phone.copy": "Copiar link",
    "phone.copied": "Copiado",
    "phone.step1": "Na página do celular, digite o e-mail da sua conta {backend}.",
    "phone.step2": "O {backend} envia um código por e-mail — digite-o na página do celular.",
    "phone.step3": "O seu PC entra no {backend} sozinho e o LILO conecta.",
    "phone.noApps":
      "Nada para instalar: o celular só repassa o que a página de login no seu PC pede.",
    "phone.waiting": "Aguardando o celular…",
    "phone.cancel": "Cancelar",
    "phone.signedIn": "Conectado como {email}",
    "phone.network": "Rede do computador",
    "phone.networkHelp": "Se o celular não abrir o link, selecione a rede Wi-Fi ou Ethernet que ele compartilha com este computador e escaneie o novo QR.",
    "phone.windowsFirewall": "Se a página abre no PC mas não no celular, permita o LILO no Firewall do Windows na sua rede privada. Mantenha esta tela aberta durante o login.",
  },
  it: {
    "transcript.copy": "Copia messaggio",
    "transcript.copied": "Copiato",
    "transcript.copyFailed": "Impossibile copiare il messaggio",

    "transcript.title": "Trascrizione",
    "transcript.live": "in diretta",
    "transcript.empty":
      "Ancora nessun messaggio. Avvia una sessione e parla — i sottotitoli compaiono qui.",
    "transcript.suggestion1": "Che ore sono?",
    "transcript.suggestion2": "Cerca sul web la Torre Eiffel",
    "transcript.suggestion3": "Dimmi una curiosità",

    "conversations.title": "Conversazioni",
    "conversations.new": "Nuova conversazione",
    "conversations.newTitle": "Nuova conversazione",
    "conversations.help":
      "Le chiamate continuano la conversazione selezionata e la chat collegata del provider. Cambiando provider, viene trasferito il contesto. Puoi iniziarne una nuova quando vuoi; una conversazione piena apre una continuazione.",
    "conversations.rename": "Rinomina",
    "conversations.today": "Oggi",
    "conversations.yesterday": "Ieri",
    "conversations.week": "Questa settimana",
    "conversations.earlier": "Prima",
    "conversations.noPreview": "Ancora niente",
    "conversations.delete": "Elimina conversazione",
    "conversations.deleteShort": "Elimina",
    "conversations.confirmDelete":
      "Eliminare “{title}”? La trascrizione se ne va con lei.",
    "conversations.deletePrompt": "Eliminare questa conversazione?",

    "phone.title": "Accedi con il telefono",
    "phone.starting": "Avvio del server ausiliario…",
    "phone.sameWifi":
      "Telefono e PC devono essere sulla stessa Wi-Fi. Scansiona o apri:",
    "phone.copy": "Copia link",
    "phone.copied": "Copiato",
    "phone.step1": "Nella pagina del telefono, inserisci l'e-mail del tuo account {backend}.",
    "phone.step2": "{backend} ti invia un codice via e-mail — scrivilo nella pagina del telefono.",
    "phone.step3": "Il PC accede a {backend} da solo e LILO si connette.",
    "phone.noApps":
      "Niente da installare: il telefono inoltra solo ciò che chiede la pagina di accesso sul PC.",
    "phone.waiting": "In attesa del telefono…",
    "phone.cancel": "Annulla",
    "phone.signedIn": "Connesso come {email}",
    "phone.network": "Rete del computer",
    "phone.networkHelp": "Se il telefono non apre il link, seleziona la rete Wi-Fi o Ethernet che condivide con questo computer e scansiona il nuovo QR.",
    "phone.windowsFirewall": "Se la pagina si apre sul PC ma non sul telefono, consenti LILO nel Firewall di Windows sulla rete privata. Tieni aperta questa schermata durante l'accesso.",
  },
});
