import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src-tauri/src/providers/chatgpt_history.rs", import.meta.url), "utf8");
const template = source.split('const HISTORY_SCRIPT: &str = r#"')[1].split('"#;')[0];

async function request(data, ok = true) {
  const window = { location: { href: "" } };
  const paths = [];
  const context = vm.createContext({ window, TextEncoder, AbortController, setTimeout, clearTimeout,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    fetch: async (path) => {
      paths.push(path);
      return path === "/api/auth/session"
        ? { ok: true, json: async () => ({ accessToken: "runtime-only-token" }) }
        : { ok, status: ok ? 200 : 403, json: async () => data };
    },
  });
  await vm.runInContext(template.replace("__REQUEST__", '"request"').replace("__CONVERSATION__", '"chat-1"'), context);
  const encoded = window.location.href.split("request:")[1];
  const reply = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return { reply, paths };
}

const node = (id, parent, role, text, time) => ({ parent, message: { id, author: { role }, content: { parts: [text] }, create_time: time } });

test("history sync reads the selected branch, excludes private roles, and preserves UTF-8", async () => {
  const { reply, paths } = await request({ current_node: "last", mapping: {
    first: node("m1", null, "user", "My project is Atlas", 1),
    private: node("private", "first", "system", "Internal instructions", 2),
    last: node("m2", "private", "assistant", "A café project", 3),
    branch: node("wrong-branch", "first", "assistant", "Alternate response", 4),
  } });
  assert.deepEqual(paths, ["/api/auth/session", "/backend-api/conversation/chat-1"]);
  const data = JSON.parse(reply.answerSdp);
  assert.equal(data.conversationId, "chat-1");
  assert.equal(data.parentMessageId, "last");
  assert.deepEqual(data.turns.map((turn) => turn.id), ["m1", "m2"]);
  assert.equal(data.turns[1].text, "A café project");
  assert.equal(data.turns[1].timestamp, 3000);
  assert.ok(!reply.answerSdp.includes("runtime-only-token"));
});

test("history sync bounds messages, cycles and callback size", async () => {
  const mapping = Object.create(null);
  for (let i = 0; i < 500; i++) mapping[`n${i}`] = node(`m${i}`, i ? `n${i - 1}` : "n499", i % 2 ? "assistant" : "user", "x".repeat(20_000), i);
  const { reply } = await request({ current_node: "n499", mapping });
  const data = JSON.parse(reply.answerSdp);
  assert.ok(reply.answerSdp.length <= 128_000);
  assert.ok(data.turns.length <= 200);
  assert.ok(data.turns.every((turn) => turn.text.length <= 16_000));
  assert.ok(data.turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 96_000);
  const cyclic = await request({ current_node: "n1", mapping: { n1: node("m1", "n1", "user", "One turn", 1) } });
  assert.equal(JSON.parse(cyclic.reply.answerSdp).turns.length, 1);
});

test("failed remote refresh returns no account data and no replacement chat", async () => {
  const { reply, paths } = await request({}, false);
  assert.equal(reply.ok, false);
  assert.equal(reply.error, "Could not sync the linked ChatGPT conversation");
  assert.equal(reply.answerSdp, undefined);
  assert.ok(!JSON.stringify(reply).includes("runtime-only-token"));
  assert.ok(paths.every((path) => !path.includes("realtime/wm")));
});
