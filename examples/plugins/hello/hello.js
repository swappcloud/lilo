// Example LILO plugin: the minimum that works, in one file for every OS.
//
// `"runtime": "quickjs"` in plugin.json means the host runs this in its
// embedded engine — no interpreter to install and no per-platform script.
// The script defines `describe`/`invoke`/`configure`; see docs/plugins.md.

let greeting = "hello";
let loud = false;

function describe() {
  return {
    tools: [
      {
        name: "hello_greet",
        description: "Greet someone by name.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Who to greet." },
          },
          required: [],
        },
      },
    ],
    commands: [
      {
        name: "hello.greet",
        tool: "hello_greet",
        descriptions: [
          ["en", "Greet someone by name."],
          ["pt", "Cumprimenta alguém pelo nome."],
        ],
        requiresConfirm: false,
        templates: [
          ["en", "say hello to {name}"],
          ["pt", "diga olá para {name}"],
        ],
      },
    ],
    ui: {
      settings: [
        {
          key: "greeting",
          kind: "text",
          label: "Greeting word",
          placeholder: "hello",
          // The form starts from declared defaults, so what it shows is what
          // gets saved — and what the plugin already uses.
          default: "hello",
        },
        { key: "loud", kind: "switch", label: "Loud mode", default: false },
      ],
      status: [{ label: "Example plugin", value: "ready", state: "ok" }],
      actions: [
        { label: "Say hello to LILO", tool: "hello_greet", args: { name: "LILO" } },
      ],
    },
    prompt: "Greets someone by name, for example: say hello to Ada.",
  };
}

// Settings are pushed by the host on every change, so a change applies at once.
function configure(settings) {
  if (!settings) return;
  if (typeof settings.greeting === "string" && settings.greeting.trim()) {
    greeting = settings.greeting.trim();
  }
  loud = !!settings.loud;
}

function invoke(tool, args) {
  if (tool !== "hello_greet") throw new Error("unknown tool");
  const name = (args && args.name) || "world";
  const text = greeting + ", " + name;
  const spoken = loud ? text.toUpperCase() : text;
  // `summary` is what the transcript shows, what the model is told happened,
  // and what the plugin page toasts when its action button runs.
  return { greeting: spoken, summary: spoken };
}
