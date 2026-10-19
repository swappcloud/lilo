import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../src-tauri/assets/phone-login.html", import.meta.url), "utf8");
const source = page.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace("__NAME_JSON__", JSON.stringify("Fixture provider"))
  .replace("__PHONES__", "false");

async function fixture(status, language = "en", throws = false) {
  const elements = new Map();
  const timers = [];
  let closes = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, textContent: "", value: "private-fixture", addEventListener() {},
    });
    return elements.get(id);
  };
  const context = {
    URLSearchParams, location: { search: "?k=fixture-key" },
    navigator: { language },
    document: { documentElement: {}, getElementById: element, querySelectorAll: () => [] },
    window: { closed: false, close() { closes++; if (throws) throw new Error("Blocked"); } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); },
    fetch: async () => ({ ok: true, json: async () => status }),
  };
  vm.runInNewContext(source, context);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return { context, elements, timers, closes: () => closes };
}

test("successful phone login stops polling and attempts closure only after five seconds", async () => {
  const flow = await fixture({ done: true });
  assert.equal(flow.closes(), 0);
  assert.deepEqual(flow.timers.map(timer => timer.delay), [5000]);
  assert.equal(flow.elements.get("value").value, "");
  flow.timers[0].fn();
  assert.equal(flow.closes(), 1);
  assert.match(flow.elements.get("done-text").textContent, /close this tab/);
});

test("a pending phone login keeps polling without scheduling closure", async () => {
  const flow = await fixture({ done: false, progress: { step: "working" } });
  assert.equal(flow.closes(), 0);
  assert.deepEqual(flow.timers.map(timer => timer.delay), [900]);
});

test("confirmed form completion also closes and blocked browsers retain localized instructions", async () => {
  for (const [language, expected] of [["pt", /fechar esta aba/], ["it", /chiudere questa scheda/]]) {
    const flow = await fixture({ progress: { step: "done" } }, language, true);
    assert.equal(flow.timers[0].delay, 5000);
    assert.doesNotThrow(() => flow.timers[0].fn());
    assert.equal(flow.closes(), 1);
    assert.match(flow.elements.get("done-text").textContent, expected);
  }
});
