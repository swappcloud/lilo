// Native operations are scoped by the host; this plugin never runs a shell.
function request(operation, args) {
  if (typeof lilo.desktop !== "function") {
    throw new Error("Desktop permissions have not been granted.");
  }
  const result = JSON.parse(lilo.desktop(operation, args || {}));
  if (!result.ok) {
    throw new Error(result.error && result.error.message || "Desktop action is unavailable.");
  }
  return result;
}

function describe() {
  const words = [];
  try {
    for (const app of request("apps", {}).apps) {
      for (const word of app.name.toLowerCase().split(/\s+/)) {
        if (word.length >= 2 && !words.includes(word)) words.push(word);
      }
      if (app.name.toLowerCase() === "visual studio code") {
        for (const alias of ["vscode", "vs"]) if (!words.includes(alias)) words.push(alias);
      }
    }
  } catch (_) {
    // The explicit commands remain available and report the native error.
  }
  return {
    tools: [
      {
        name: "desktop_apps",
        description: "List installed application names without machine paths.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "desktop_open",
        description: "Request launching an installed application by its exact name.",
        parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      },
      {
        name: "desktop_type",
        description: "Insert literal text into a supported, focused field belonging to the named application. Never submit the field.",
        parameters: {
          type: "object",
          properties: { app: { type: "string" }, text: { type: "string" } },
          required: ["app", "text"],
        },
      },
    ],
    commands: [
      {
        name: "desktop.apps", scope: "tool", tool: "desktop_apps",
        descriptions: [["en", "List installed applications."]],
        requiresConfirm: false,
        templates: [["en", "list [installed] applications"]],
      },
      {
        name: "desktop.open", scope: "tool", tool: "desktop_open",
        descriptions: [["en", "Open an installed application by name."]],
        requiresConfirm: false,
        templates: [
          ["en", "(open|launch) [the] (application|program) {app}"],
          ["en", "desktop (open|launch) {app}"],
        ],
      },
      {
        name: "desktop.type", scope: "tool", tool: "desktop_type",
        descriptions: [["en", "Insert dictated text into a named application after confirmation."]],
        requiresConfirm: true,
        templates: [
          ["en", "in {app} (write|type) {!text}"],
          ["en", "(write|type) in {app} text {!text}"],
          ["pt", "no {app} (escreva|escreve|digite) {!text}"],
          ["it", "in {app} (scrivi|digita) {!text}"],
        ],
      },
      ...(words.length ? [{
        name: "desktop.openNatural", scope: "tool", tool: "desktop_open",
        descriptions: [["en", "Open an installed application using its name or known alias."]],
        requiresConfirm: false,
        templates: [
          ["en", "(open|launch) {app}"],
          ["pt", "(abre|abrir|abra) {app}"],
          ["it", "(apri|avvia) {app}"],
        ],
        slotWords: { app: words },
      }] : []),
    ],
    ui: {
      status: [{
        label: "Text entry",
        value: "Experimental. Say: open my VS Code. For literal text, select a field and say: in my VS Code write YOUR WORDS, then confirm or cancel. File creation and code corrections are not available yet.",
        state: "warn",
      }, {
        label: "Privacy",
        value: "This plugin does not store dictated text. Your voice provider and normal conversation history still receive your utterance.",
        state: "warn",
      }],
      actions: [{ label: "List installed applications", tool: "desktop_apps" }],
    },
    prompt: "Desktop control opens installed applications and inserts the user's literal dictated text into a named application's supported field after confirmation. It does not generate, run or submit code, click buttons, or complete multi-step tasks. Report only the actual tool result.",
  };
}

function invoke(tool, args) {
  if (tool === "desktop_apps") {
    const result = request("apps", {});
    return { apps: result.apps, summary: result.apps.map(function (app) { return app.name; }).join(", ") || "No installed applications found." };
  }
  if (tool === "desktop_open") {
    return { summary: request("open", { app: args && args.app }).message };
  }
  if (tool === "desktop_type") {
    return { summary: request("type", { app: args && args.app, text: args && args.text }).message };
  }
  throw new Error("Unknown desktop tool.");
}
