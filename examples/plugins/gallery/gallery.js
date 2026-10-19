// Example LILO plugin: every picture LILO was asked to make, kept in a gallery.
//
// It never talks to a backend. Asking for a picture goes to the voice backend
// in the conversation; one that can make pictures sends it back, and the host
// announces it on `image.created` with the bytes as base64. The plugin keeps
// each picture as base64 text in its own data/ folder; the page's list names
// the file (`image`), and the host reads it there to draw it, so the gallery
// never holds every picture in this script's memory.

const STORE = "gallery.json";
let max = 50;

function describe() {
  return {
    tools: [
      {
        name: "gallery_show",
        description: "Show a picture from the gallery on screen; the newest unless told which, or all of them in turn.",
        parameters: {
          type: "object",
          properties: {
            index: { type: "number", description: "Position in the gallery, 0 is the newest." },
            all: { type: "boolean", description: "Show up to the 8 newest pictures one after another." },
          },
          required: [],
        },
      },
      {
        name: "gallery_create",
        description: "Ask the voice backend to create a picture of what the user describes.",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string", description: "What the picture shows." } },
          required: ["prompt"],
        },
      },
      {
        name: "gallery_list",
        description: "List the pictures LILO made, newest first.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "gallery_delete",
        description: "Delete one picture from the gallery.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The picture's id." } },
          required: ["id"],
        },
      },
      {
        name: "gallery_clear",
        description: "Delete every picture in the gallery.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    commands: [
      {
        name: "gallery.show",
        tool: "gallery_show",
        descriptions: [
          ["en", "Show the latest picture from the gallery."],
          ["pt", "Mostra a última imagem da galeria."],
          ["it", "Mostra l'ultima immagine della galleria."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "show [me] (the|that) (last|latest|newest|previous) (image|picture|photo)"],
          ["en", "show [me] (the|that) (image|picture|photo) [you (created|made|generated)] [before]"],
          ["pt", "mostra [pra mim|para mim] (a|essa) (última|ultima|mais recente) (imagem|foto)"],
          ["pt", "mostra [pra mim|para mim] (a|essa) (imagem|foto) [que você (criou|fez|gerou)] [antes]"],
          ["it", "mostra[mi] (l'ultima|quell'ultima) (immagine|foto)"],
          ["it", "mostra[mi] (l'immagine|la foto) [che hai (creato|fatto|generato)]"],
        ],
      },
      {
        name: "gallery.slideshow",
        tool: "gallery_show",
        args: { all: "true" },
        descriptions: [
          ["en", "Show the pictures in the gallery one after another."],
          ["pt", "Mostra as imagens da galeria, uma depois da outra."],
          ["it", "Mostra le immagini della galleria una dopo l'altra."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "show [me] (the|my) (gallery|images|pictures|photos)"],
          ["en", "show [me] (all|every) [of] (the|my) (images|pictures|photos)"],
          ["pt", "mostra [pra mim|para mim] (a|minha) galeria"],
          ["pt", "mostra [pra mim|para mim] (as|todas as) (imagens|fotos)"],
          ["it", "mostra[mi] (la|la mia) galleria"],
          ["it", "mostra[mi] (le|tutte le) (immagini|foto)"],
        ],
      },
      {
        name: "gallery.create",
        tool: "gallery_create",
        descriptions: [
          ["en", "Create a picture of what the user describes and show it."],
          ["pt", "Cria uma imagem do que o usuário descrever e mostra."],
          ["it", "Crea un'immagine di ciò che l'utente descrive e la mostra."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "(create|make|generate|draw) [me] (an|a) (image|picture|photo) [of|about] {prompt}"],
          ["pt", "(cria|crie|gera|gere|faz|faça|desenha|desenhe) [pra mim|para mim] (uma|um) (imagem|foto|figura) [de|do|da|sobre] {prompt}"],
          ["it", "(crea|genera|fai|disegna) [per me] (un'immagine|una immagine|una foto) [di|del|della|su] {prompt}"],
        ],
      },
      {
        name: "gallery.count",
        tool: "gallery_list",
        descriptions: [
          ["en", "Say how many pictures are in the gallery."],
          ["pt", "Diz quantas imagens há na galeria."],
          ["it", "Dice quante immagini ci sono nella galleria."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "how many (pictures|images) [are there] in [my|the] gallery"],
          ["pt", "quantas (imagens|fotos) (tem|há) na [minha] galeria"],
          ["it", "quante (immagini|foto) ci sono nella [mia] galleria"],
        ],
      },
      {
        name: "gallery.clear",
        tool: "gallery_clear",
        descriptions: [
          ["en", "Delete every picture in the gallery."],
          ["pt", "Apaga todas as imagens da galeria."],
          ["it", "Cancella tutte le immagini della galleria."],
        ],
        requiresConfirm: true,
        templates: [
          ["en", "(clear|empty) [my|the] (picture|image) gallery"],
          ["pt", "(limpa|esvazia) a [minha] galeria [de imagens]"],
          ["it", "(svuota|cancella) la [mia] galleria [di immagini]"],
        ],
      },
    ],
    subscribes: ["image.created"],
    publishes: ["gallery.changed", "image.show"],
    ui: {
      list: {
        title: "Pictures",
        tool: "gallery_list",
        empty: "No pictures yet. Ask LILO to create one on a backend that can.",
      },
      settings: [
        {
          key: "max",
          kind: "range",
          label: "Pictures kept",
          min: 10,
          max: 200,
          default: 50,
          help: "The oldest pictures are deleted past this.",
        },
      ],
      actions: [{ label: "Delete every picture", tool: "gallery_clear" }],
    },
    prompt:
      "Creates pictures when asked (\"create an image of ...\") on a backend that can, shows each one for a moment, and keeps them in a gallery; its page in Settings shows them full size.",
  };
}

function configure(settings) {
  if (!settings) return;
  const value = Number(settings.max);
  if (Number.isFinite(value) && value >= 1) {
    max = Math.round(value);
    writeGallery(readGallery());
  }
}

function readGallery() {
  const raw = lilo.read(STORE);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (error) {
    lilo.log("gallery file unreadable, starting over: " + error);
    return [];
  }
}

// The data API can write but not remove: a forgotten picture's file is
// emptied, which the host refuses to draw.
function forget(entry) {
  lilo.write(entry.file, "");
}

function writeGallery(list) {
  list.slice(max).forEach(forget);
  lilo.write(STORE, JSON.stringify(list.slice(0, max)));
}

const MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function event(topic, payload) {
  if (topic !== "image.created" || !payload || typeof payload.data !== "string" || !payload.data) return;
  const id = String(payload.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const mime = MIMES.indexOf(payload.mime) >= 0 ? payload.mime : "";
  if (!id || !mime) return;
  const list = readGallery();
  // The host re-delivers its last picture when the plugin restarts.
  if (list.some((entry) => entry.id === id)) return;
  const file = "img/" + id + ".b64";
  lilo.write(file, payload.data);
  list.unshift({
    id: id,
    file: file,
    mime: mime,
    prompt: String(payload.prompt || "").slice(0, 500),
    provider: String(payload.provider || ""),
    at: Number(payload.createdAt) || Date.now(),
  });
  writeGallery(list);
  lilo.publish("gallery.changed", { count: Math.min(list.length, max) });
}

function pad(number) {
  return number < 10 ? "0" + number : String(number);
}

// Local date and time without Intl: the embedded engine has no locale data.
function when(ms) {
  const date = new Date(ms);
  const today = new Date();
  const time = pad(date.getHours()) + ":" + pad(date.getMinutes());
  if (date.toDateString() === today.toDateString()) return time;
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + time;
}

function count(n) {
  return n + (n === 1 ? " picture" : " pictures");
}

function invoke(tool, args) {
  switch (tool) {
    case "gallery_create": {
      const prompt = String((args && args.prompt) || "").trim().slice(0, 500);
      if (!prompt) return { summary: "say what the picture should show" };
      // The host hands the request to the live session's backend.
      return { summary: "creating a picture: " + prompt, imagine: { prompt: prompt } };
    }
    case "gallery_show": {
      const list = readGallery();
      const index = Math.max(0, Math.round(Number((args && args.index) || 0)));
      if (args && (args.all === true || args.all === "true")) {
        if (list.length === 0) return { summary: "the gallery is empty" };
        const items = list.slice(0, 8).map((entry) => ({ file: entry.file, mime: entry.mime, prompt: entry.prompt }));
        lilo.publish("image.show", { items: items });
        return { summary: "showing " + count(items.length) + " from the gallery" };
      }
      const entry = list[index];
      if (!entry) return { summary: list.length === 0 ? "the gallery is empty" : "that picture is not in the gallery" };
      // The host reads the file and shows it as a thought.
      lilo.publish("image.show", { file: entry.file, mime: entry.mime, prompt: entry.prompt });
      return { summary: "showing the picture" + (entry.prompt ? ": " + entry.prompt : "") };
    }
    case "gallery_list": {
      const list = readGallery();
      return {
        items: list.map((entry) => ({
          label: entry.prompt || "Picture",
          detail: when(entry.at),
          image: { file: entry.file, mime: entry.mime },
          action: { label: "Delete", tool: "gallery_delete", args: { id: entry.id } },
        })),
        summary: list.length > 0 ? count(list.length) + " in the gallery" : "the gallery is empty",
      };
    }
    case "gallery_delete": {
      const id = String((args && args.id) || "");
      const list = readGallery();
      const entry = list.find((candidate) => candidate.id === id);
      if (!entry) return { summary: "that picture is not in the gallery" };
      forget(entry);
      writeGallery(list.filter((candidate) => candidate !== entry));
      lilo.publish("gallery.changed", { count: list.length - 1 });
      return { summary: "deleted the picture" };
    }
    case "gallery_clear": {
      const list = readGallery();
      list.forEach(forget);
      writeGallery([]);
      lilo.publish("gallery.changed", { count: 0 });
      return { summary: "deleted " + count(list.length) };
    }
    default:
      throw new Error("unknown tool " + tool);
  }
}
