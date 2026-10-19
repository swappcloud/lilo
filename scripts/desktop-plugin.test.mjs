import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const directory = new URL("../examples/plugins/desktop/", import.meta.url);
const source = readFileSync(new URL("desktop.js", directory), "utf8");
const manifest = JSON.parse(readFileSync(new URL("plugin.json", directory), "utf8"));

function plugin(host) {
  const context = createContext({ lilo: host });
  runInContext(source, context);
  return context;
}

test("desktop plugin is opt-in and declares all supported desktop platforms", () => {
  assert.deepEqual(manifest.capabilities, ["desktop:apps", "desktop:text"]);
  assert.deepEqual(manifest.platforms, ["windows", "macos", "linux"]);
  const context = plugin({});
  const description = context.describe();
  const dictation = description.commands.find(({ name }) => name === "desktop.type");
  assert.equal(dictation.requiresConfirm, true);
  assert.ok(dictation.templates[0][1].includes("{!text}"));
  assert.throws(() => context.invoke("desktop_open", { app: "Editor" }), /not been granted/);
});

test("dictation reaches only the scoped host and is omitted from results", () => {
  const calls = [];
  const context = plugin({ desktop(operation, args) {
    calls.push({ operation, args: JSON.parse(JSON.stringify(args)) });
    return JSON.stringify({ ok: true, message: "Text inserted into target field." });
  } });
  const text = "Hello, café!\nThis stays literal.";
  const result = context.invoke("desktop_type", { app: "Editor", text });
  assert.deepEqual(calls, [{ operation: "type", args: { app: "Editor", text } }]);
  assert.equal(result.summary, "Text inserted into target field.");
  assert.ok(!JSON.stringify(result).includes(text));
});

test("unknown tools and unsupported targets never produce false success", () => {
  let calls = 0;
  const context = plugin({ desktop() {
    calls += 1;
    return JSON.stringify({ ok: false, error: { code: "unsupported_field", message: "Choose a supported field." } });
  } });
  assert.throws(() => context.invoke("run_shell", { command: "anything" }), /Unknown desktop tool/);
  assert.equal(calls, 0);
  assert.throws(() => context.invoke("desktop_type", { app: "Editor", text: "hello" }), /supported field/);
  assert.equal(calls, 1);
});

test("headless installations can load the plugin when desktop services are unavailable", () => {
  const context = plugin({ desktop() { throw new Error("No desktop session."); } });
  assert.equal(context.describe().tools.length, 3);
  assert.throws(() => context.invoke("desktop_apps", {}), /No desktop session/);
});

test("natural app launching uses installed names and aliases without a desktop keyword", () => {
  const context = plugin({ desktop(operation) {
    assert.equal(operation, "apps");
    return JSON.stringify({ ok: true, apps: [{ id: "code", name: "Visual Studio Code" }] });
  } });
  const commands = context.describe().commands;
  const natural = commands.find(({ name }) => name === "desktop.openNatural");
  assert.ok(natural.templates.some(([, template]) => template === "(open|launch) {app}"));
  assert.ok(natural.slotWords.app.includes("vscode"));
  assert.ok(natural.slotWords.app.includes("vs"));
  const dictation = commands.find(({ name }) => name === "desktop.type");
  assert.ok(dictation.templates.some(([, template]) => template === "in {app} (write|type) {!text}"));
});
