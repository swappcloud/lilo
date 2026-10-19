// Example LILO plugin: the songs LILO played, newest first, one tap to replay.
//
// It never touches the player. The host announces every track that starts on
// `media.playing` (a voice command, a button, or the queue moving on), and a
// replay is a `play` request in a tool result, which the host runs through
// the same search as "play <song>". The page's list is read from
// `history_list`; publishing `history.changed` tells an open page to re-read.

const STORE = "history.json";
let max = 50;

function describe() {
  return {
    tools: [
      {
        name: "history_list",
        description: "List the songs LILO played recently, newest first.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "history_replay",
        description: "Play a song from the history again.",
        parameters: {
          type: "object",
          properties: {
            index: { type: "number", description: "Position in the history, 0 is the latest." },
          },
          required: [],
        },
      },
      {
        name: "history_clear",
        description: "Forget every song in the history.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "history_remove",
        description: "Remove one song from the history.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Song id from the history row." },
            at: { type: "number", description: "Play timestamp from the history row." },
          },
          required: ["id", "at"],
        },
      },
    ],
    commands: [
      {
        name: "history.recent",
        tool: "history_list",
        descriptions: [
          ["en", "Say which songs were played recently."],
          ["pt", "Diz quais músicas tocaram recentemente."],
          ["it", "Dice quali canzoni sono state riprodotte di recente."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "what (songs|music) did you play"],
          ["en", "what did you play [before|earlier]"],
          ["pt", "(quais|que) músicas você tocou"],
          ["pt", "o que você tocou [antes]"],
          ["it", "(quali|che) canzoni hai (suonato|riprodotto)"],
        ],
      },
    ],
    subscribes: ["media.playing"],
    publishes: ["history.changed"],
    ui: {
      list: {
        title: "Recently played",
        tool: "history_list",
        empty: "Nothing played yet. Ask LILO for a song.",
      },
      settings: [
        {
          key: "max",
          kind: "range",
          label: "Songs kept",
          min: 10,
          max: 200,
          default: 50,
          help: "The oldest songs are forgotten past this.",
        },
      ],
      actions: [{ label: "Clear history", tool: "history_clear" }],
    },
    prompt:
      "Remembers the songs LILO played and can say what played recently; its page in Settings lists them and replays any of them with one click.",
  };
}

function configure(settings) {
  if (!settings) return;
  const value = Number(settings.max);
  if (Number.isFinite(value) && value >= 1) max = Math.round(value);
}

function readHistory() {
  const raw = lilo.read(STORE);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (error) {
    lilo.log("history file unreadable, starting over: " + error);
    return [];
  }
}

function writeHistory(list) {
  lilo.write(STORE, JSON.stringify(list.slice(0, max)));
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

function event(topic, payload) {
  if (topic !== "media.playing" || !payload || !payload.title) return;
  const list = readHistory();
  // The same track still at the top is one play, not two: the host
  // re-announces after a restart of the plugin.
  if (list.length > 0 && list[0].id === payload.id) return;
  list.unshift({
    id: String(payload.id || ""),
    title: String(payload.title),
    artist: String(payload.artist || ""),
    at: Date.now(),
  });
  writeHistory(list);
  lilo.publish("history.changed", { count: Math.min(list.length, max) });
}

function replay(list, index) {
  const entry = list[index];
  if (!entry) {
    return { summary: list.length === 0 ? "nothing has played yet" : "that song is not in the history" };
  }
  return {
    summary: "playing again: " + entry.title,
    play: { track: entry.title, artist: entry.artist },
  };
}

function invoke(tool, args) {
  switch (tool) {
    case "history_list": {
      const list = readHistory();
      const recent = list
        .slice(0, 3)
        .map((entry) => entry.title)
        .join("; ");
      return {
        items: list.map((entry, index) => ({
          label: entry.title,
          detail: (entry.artist ? entry.artist + " · " : "") + when(entry.at),
          action: { label: "Play", tool: "history_replay", args: { index: index } },
          deleteAction: {
            label: "Remove from history",
            tool: "history_remove",
            args: { id: entry.id, at: entry.at },
          },
        })),
        summary: list.length > 0 ? "recently played: " + recent : "nothing has played yet",
      };
    }
    case "history_replay": {
      const index = Math.max(0, Math.round(Number((args && args.index) || 0)));
      return replay(readHistory(), index);
    }
    case "history_remove": {
      const id = String((args && args.id) || "");
      const at = Number(args && args.at);
      const list = readHistory();
      const index = list.findIndex((entry) => entry.id === id && entry.at === at);
      if (index < 0) return { summary: "song is no longer in history" };
      const [removed] = list.splice(index, 1);
      writeHistory(list);
      lilo.publish("history.changed", { count: list.length });
      return { summary: "removed from history: " + removed.title };
    }
    case "history_clear": {
      const before = readHistory().length;
      writeHistory([]);
      lilo.publish("history.changed", { count: 0 });
      return { summary: "forgot " + before + (before === 1 ? " song" : " songs") };
    }
    default:
      throw new Error("unknown tool " + tool);
  }
}
