// Example LILO plugin: pomodoro focus timers, one file for every OS.
//
// The host calls `tick()` a few times a second, which is where the timer
// lives: no child process, no sleep loop. State sits in `data/state.json`, so
// a restarted plugin picks a running timer up where it left off.

let config = { focus: 25, short: 5, long: 15, rounds: 4, auto: true };
let state = { phase: "idle", ends: 0, round: 0, paused: false, left: 0 };

function describe() {
  return {
    tools: [
      {
        name: "pomodoro_start",
        description: "Start a pomodoro focus session.",
        parameters: {
          type: "object",
          properties: {
            minutes: {
              type: "number",
              description: "Focus length in minutes; the setting when omitted.",
            },
          },
          required: [],
        },
      },
      {
        name: "pomodoro_break",
        description: "Start a pomodoro break.",
        parameters: {
          type: "object",
          properties: {
            minutes: {
              type: "number",
              description: "Break length in minutes; the short break setting when omitted.",
            },
          },
          required: [],
        },
      },
      {
        name: "pomodoro_stop",
        description: "Stop the pomodoro and reset the round count.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "pomodoro_status",
        description: "How much time is left, and how many rounds are done.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "pomodoro_pause",
        description: "Pause the running focus or break.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "pomodoro_resume",
        description: "Resume a paused focus or break.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "pomodoro_skip",
        description: "End the current focus or break now and move to the next one.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ],
    commands: [
      {
        name: "pomodoro.start_minutes",
        tool: "pomodoro_start",
        descriptions: [
          ["en", "Start a focus session of a given length."],
          ["pt", "Começa um foco com a duração pedida."],
          ["it", "Avvia una sessione di concentrazione della durata indicata."],
        ],
        templates: [
          ["en", "start [a] {minutes} minute (pomodoro|focus|timer)"],
          ["pt", "(comeca|inicia) [um] pomodoro de {minutes} minutos"],
          ["it", "(avvia|inizia) [un] pomodoro di {minutes} minuti"],
        ],
        slotWords: {
          minutes: ["5", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55", "60", "75", "90", "120"],
        },
      },
      {
        name: "pomodoro.start",
        tool: "pomodoro_start",
        descriptions: [
          ["en", "Start a pomodoro."],
          ["pt", "Começa um pomodoro."],
          ["it", "Avvia un pomodoro."],
        ],
        templates: [
          ["en", "start [a|the|my] pomodoro"],
          ["en", "start [a|my] focus (session|timer)"],
          ["pt", "(comeca|inicia|comecar|iniciar) [um|o] pomodoro"],
          ["it", "(avvia|inizia) [un|il] pomodoro"],
        ],
      },
      {
        name: "pomodoro.break",
        tool: "pomodoro_break",
        descriptions: [
          ["en", "Start a pomodoro break."],
          ["pt", "Começa a pausa do pomodoro."],
          ["it", "Avvia la pausa del pomodoro."],
        ],
        templates: [
          ["en", "take a pomodoro break"],
          ["en", "start [a|the] (break|pause) timer"],
          ["pt", "pausa do pomodoro"],
          ["it", "pausa (del|dal) pomodoro"],
        ],
      },
      {
        name: "pomodoro.stop",
        tool: "pomodoro_stop",
        descriptions: [
          ["en", "Stop the pomodoro."],
          ["pt", "Para o pomodoro."],
          ["it", "Ferma il pomodoro."],
        ],
        templates: [
          ["en", "(stop|cancel|end|reset) [the|my] pomodoro"],
          ["en", "(stop|cancel) [the|my] focus timer"],
          ["pt", "(para|cancela|encerra|zera|reinicia) o pomodoro"],
          ["it", "(ferma|annulla|azzera) il pomodoro"],
        ],
      },
      {
        name: "pomodoro.pause",
        tool: "pomodoro_pause",
        descriptions: [
          ["en", "Pause the pomodoro."],
          ["pt", "Pausa o pomodoro."],
          ["it", "Mette in pausa il pomodoro."],
        ],
        templates: [
          ["en", "(pause|hold) [the|my] pomodoro"],
          ["en", "pause [the|my] (focus|break) timer"],
          ["pt", "(pausa|pausar) o pomodoro"],
          ["it", "metti in pausa il pomodoro"],
        ],
      },
      {
        name: "pomodoro.resume",
        tool: "pomodoro_resume",
        descriptions: [
          ["en", "Resume the pomodoro."],
          ["pt", "Retoma o pomodoro."],
          ["it", "Riprende il pomodoro."],
        ],
        templates: [
          ["en", "(resume|continue|unpause) [the|my] pomodoro"],
          ["pt", "(retoma|continua|retomar|continuar) o pomodoro"],
          ["it", "riprendi il pomodoro"],
        ],
      },
      {
        name: "pomodoro.skip",
        tool: "pomodoro_skip",
        descriptions: [
          ["en", "Skip to the next focus or break."],
          ["pt", "Pula para a próxima etapa."],
          ["it", "Passa alla fase successiva."],
        ],
        templates: [
          ["en", "skip [the|this] (pomodoro|focus|break)"],
          ["pt", "(pula|pular) [o|a] (pomodoro|foco|pausa)"],
          ["it", "salta [il|la] (pomodoro|pausa)"],
        ],
      },
      {
        name: "pomodoro.status",
        tool: "pomodoro_status",
        descriptions: [
          ["en", "How much time is left."],
          ["pt", "Quanto tempo falta."],
          ["it", "Quanto tempo manca."],
        ],
        templates: [
          ["en", "how (much time|long) is left [on|in] [the|my|this] (pomodoro|timer|focus|break)"],
          ["en", "pomodoro status"],
          ["pt", "quanto tempo falta [no|do|para o] (pomodoro|timer|foco)"],
          ["it", "quanto manca [al|del] (pomodoro|timer)"],
        ],
      },
    ],
    publishes: ["notify", "statusbar"],
    ui: {
      settings: [
        { key: "focus", kind: "range", label: "Focus (minutes)", min: 5, max: 90, default: 25 },
        { key: "short", kind: "range", label: "Short break (minutes)", min: 1, max: 30, default: 5 },
        { key: "long", kind: "range", label: "Long break (minutes)", min: 5, max: 60, default: 15 },
        { key: "rounds", kind: "range", label: "Focus rounds before a long break", min: 2, max: 8, default: 4 },
        {
          key: "auto",
          kind: "switch",
          label: "Start breaks automatically",
          help: "When a focus ends, the break starts on its own.",
          default: true,
        },
      ],
      status: [{ label: "By voice", value: "start a pomodoro · how much time is left on the timer" }],
      actions: [
        { label: "Start a focus", tool: "pomodoro_start" },
        { label: "Take a break", tool: "pomodoro_break" },
        { label: "Pause", tool: "pomodoro_pause" },
        { label: "Resume", tool: "pomodoro_resume" },
        { label: "Skip to the next", tool: "pomodoro_skip" },
        { label: "Time left", tool: "pomodoro_status" },
        { label: "Reset", tool: "pomodoro_stop" },
      ],
    },
    prompt:
      "Runs pomodoro focus timers: start a pomodoro (optionally for a number of minutes), take a pomodoro break, stop it, and ask how much time is left. Starting a focus ends the voice call so LILO stops listening; the countdown shows in the menu bar, and LILO announces when a focus or a break ends.",
  };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clamp(value, fallback, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number)) number = Number(fallback);
  return Math.min(max, Math.max(min, Math.round(number)));
}

function loadState() {
  const raw = lilo.read("state.json");
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    state = {
      phase: String(saved.phase || "idle"),
      ends: Number(saved.ends) || 0,
      round: Number(saved.round) || 0,
      paused: !!saved.paused,
      left: Number(saved.left) || 0,
    };
  } catch (error) {
    lilo.log("state.json is unreadable, starting idle");
    state = { phase: "idle", ends: 0, round: 0, paused: false, left: 0 };
  }
}

function saveState() {
  lilo.write("state.json", JSON.stringify(state));
}

function label() {
  switch (state.phase) {
    case "focus":
      return "Focus";
    case "short":
      return "Break";
    case "long":
      return "Long break";
    default:
      return "";
  }
}

function showTimer() {
  const name = label();
  if (name && state.paused) {
    lilo.publish("statusbar", {
      label: name + " (paused)",
      left: state.left,
      actions: [
        { label: "Resume", tool: "pomodoro_resume" },
        { label: "Reset", tool: "pomodoro_stop" },
      ],
    });
  } else if (name) {
    lilo.publish("statusbar", {
      label: name,
      endsAt: state.ends,
      actions: [
        { label: "Pause", tool: "pomodoro_pause" },
        { label: "Skip", tool: "pomodoro_skip" },
        { label: "Reset", tool: "pomodoro_stop" },
      ],
    });
  } else {
    lilo.publish("statusbar", {});
  }
}

function notify(summary) {
  lilo.publish("notify", { summary });
}

function leftText() {
  let seconds = state.ends - nowSec();
  if (seconds < 0) seconds = 0;
  if (seconds >= 60) {
    const minutes = Math.floor((seconds + 59) / 60);
    return minutes === 1 ? "1 minute" : minutes + " minutes";
  }
  return seconds + " seconds";
}

function phaseName(phase) {
  if (phase === "short") return "break";
  if (phase === "long") return "long break";
  return "focus";
}

function begin(phase, minutes) {
  state.phase = phase;
  state.paused = false;
  state.left = 0;
  state.ends = nowSec() + minutes * 60;
  saveState();
  showTimer();
}

// Ends the phase that just ran out. Returns whether a new one was started.
function advance() {
  if (state.phase === "focus") {
    state.round += 1;
    if (config.auto) {
      if (state.round % config.rounds === 0) {
        begin("long", config.long);
        notify("Focus done, round " + state.round + ". Take a " + config.long + "-minute long break.");
      } else {
        begin("short", config.short);
        notify("Focus done, round " + state.round + ". Take a " + config.short + "-minute break.");
      }
      return true;
    }
    state.phase = "idle";
    saveState();
    showTimer();
    notify("Focus done, round " + state.round + ". Say take a pomodoro break when you are ready.");
    return false;
  }
  if (state.phase === "short" || state.phase === "long") {
    state.phase = "idle";
    saveState();
    showTimer();
    notify("Break over. Say start a pomodoro to focus again.");
    return false;
  }
  return false;
}

function start(args) {
  if (state.phase === "focus" && state.paused) {
    return {
      summary:
        "A focus is already paused with " + leftText() +
        " left. Say resume the pomodoro, or stop the pomodoro to end it.",
      phase: "focus",
      paused: true,
      alreadyRunning: true,
    };
  }
  if (state.phase === "focus") {
    return {
      summary:
        "A pomodoro is already running with " + leftText() +
        " left. Say stop the pomodoro to end it.",
      phase: "focus",
      alreadyRunning: true,
      secondsLeft: state.ends - nowSec(),
    };
  }
  const minutes = clamp(args && args.minutes, config.focus, 1, 180);
  begin("focus", minutes);
  return {
    summary:
      "Pomodoro started: " + minutes + " minutes of focus, round " +
      ((state.round % config.rounds) + 1) + " of " + config.rounds + ".",
    phase: "focus",
    minutes: minutes,
    endSession: true,
  };
}

function takeBreak(args) {
  const minutes = clamp(args && args.minutes, config.short, 1, 90);
  begin("short", minutes);
  return { summary: "Break started: " + minutes + " minutes.", phase: "short", minutes: minutes };
}

function stop() {
  const was = state.phase;
  state = { phase: "idle", ends: 0, round: 0, paused: false, left: 0 };
  saveState();
  showTimer();
  return was === "idle"
    ? { summary: "No pomodoro is running.", phase: "idle" }
    : { summary: "Pomodoro stopped.", phase: "idle" };
}

function status() {
  if (state.phase === "idle") {
    return {
      summary: "No pomodoro is running. " + state.round + " rounds done so far.",
      phase: "idle",
      round: state.round,
    };
  }
  if (state.paused) {
    // leftText reads `ends`; a paused timer has none, so restore it in memory.
    state.ends = nowSec() + state.left;
    return {
      summary:
        "Paused with " + leftText() + " left in this " + phaseName(state.phase) + ". " +
        state.round + " rounds done.",
      phase: state.phase,
      paused: true,
      secondsLeft: state.left,
      round: state.round,
    };
  }
  return {
    summary:
      leftText() + " left in this " + phaseName(state.phase) + ". " + state.round +
      " rounds done.",
    phase: state.phase,
    secondsLeft: state.ends - nowSec(),
    round: state.round,
  };
}

function pause() {
  if (state.phase === "idle") return { summary: "No pomodoro is running.", phase: "idle" };
  if (state.paused) {
    return { summary: "The pomodoro is already paused.", phase: state.phase, paused: true };
  }
  let left = state.ends - nowSec();
  if (left < 1) left = 1;
  state.left = left;
  state.paused = true;
  state.ends = 0;
  saveState();
  showTimer();
  state.ends = nowSec() + left;
  return {
    summary: "Paused with " + leftText() + " left in this " + phaseName(state.phase) + ".",
    phase: state.phase,
    paused: true,
    secondsLeft: left,
  };
}

function resume() {
  if (state.phase === "idle") return { summary: "No pomodoro is running.", phase: "idle" };
  if (!state.paused) {
    return { summary: "The pomodoro is already running.", phase: state.phase };
  }
  state.ends = nowSec() + state.left;
  state.paused = false;
  state.left = 0;
  saveState();
  showTimer();
  return {
    summary: "Resumed: " + leftText() + " left in this " + phaseName(state.phase) + ".",
    phase: state.phase,
    secondsLeft: state.ends - nowSec(),
  };
}

function skip() {
  if (state.phase === "idle") return { summary: "No pomodoro is running.", phase: "idle" };
  state.paused = false;
  state.left = 0;
  if (advance()) {
    return {
      summary:
        "Skipped ahead: " + leftText() + " left in this " + phaseName(state.phase) + ".",
      phase: state.phase,
    };
  }
  return { summary: "Skipped ahead. The pomodoro is waiting for you.", phase: "idle" };
}

function rearm() {
  if (state.phase === "idle") return;
  if (state.paused) {
    showTimer();
    return;
  }
  if (state.ends <= nowSec()) {
    state.phase = "idle";
    saveState();
  }
  showTimer();
}

function configure(settings) {
  if (!settings) return;
  config.focus = clamp(settings.focus, config.focus, 1, 180);
  config.short = clamp(settings.short, config.short, 1, 60);
  config.long = clamp(settings.long, config.long, 1, 90);
  config.rounds = clamp(settings.rounds, config.rounds, 2, 8);
  if (settings.auto !== undefined && settings.auto !== null) config.auto = !!settings.auto;
}

function invoke(tool, args) {
  switch (tool) {
    case "pomodoro_start":
      return start(args);
    case "pomodoro_break":
      return takeBreak(args);
    case "pomodoro_stop":
      return stop();
    case "pomodoro_status":
      return status();
    case "pomodoro_pause":
      return pause();
    case "pomodoro_resume":
      return resume();
    case "pomodoro_skip":
      return skip();
    default:
      return { error: "unknown tool" };
  }
}

// A timer that was running when the plugin stopped picks up where it was.
loadState();
rearm();

function tick() {
  if (state.phase !== "idle" && !state.paused && nowSec() >= state.ends) advance();
}
