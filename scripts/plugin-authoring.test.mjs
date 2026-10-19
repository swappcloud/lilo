import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

test("the English author guide's complete notebook example persists and exposes context", async () => {
  const guide = (await readFile("docs/plugin-authoring.md", "utf8")).replace(/\r\n/g, "\n");
  const manifest = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  const script = guide.match(/```js\n([\s\S]*?)\n```/)[1];
  assert.equal(manifest.runtime, "quickjs");
  assert.equal(manifest.entry, "notebook.js");
  const files = new Map();
  const events = [];
  function runtime() {
    const context = vm.createContext({ lilo: {
      read: (path) => files.get(path) ?? null,
      write: (path, text) => files.set(path, text),
      publish: (topic, payload) => events.push({ topic, payload }),
    } });
    vm.runInContext(script, context);
    return context;
  }
  let context = runtime();
  const describe = context.describe();
  assert.equal(describe.contextTool, "acme_notebook_context");
  assert.ok(describe.tools.some((tool) => tool.name === describe.ui.list.tool));
  context.configure({ limit: 2 });
  context.invoke("acme_notebook_add", { text: "Learn Italian" });
  context.invoke("acme_notebook_add", { text: "Practice tomorrow" });
  assert.equal(events.length, 2);
  context = runtime();
  assert.equal(context.invoke("acme_notebook_list", {}).items.length, 2);
  assert.match(context.invoke("acme_notebook_context", {}).context, /Practice tomorrow/);
  assert.throws(() => context.invoke("acme_notebook_add", { text: " " }));
});

test("translation authors can export the complete current key set without editing the app", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lilo-translations-"));
  try {
    const output = join(directory, "new-folder", "en.json");
    execFileSync(process.execPath, [resolve("scripts/export-translations.mjs"), output]);
    const messages = JSON.parse(await readFile(output, "utf8"));
    assert.equal(messages["language.title"], "Language");
    assert.ok(Object.keys(messages).length > 400);
    assert.ok(Object.values(messages).every((text) => typeof text === "string"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
