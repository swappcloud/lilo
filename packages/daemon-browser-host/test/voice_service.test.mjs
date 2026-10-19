import test from "node:test";
import assert from "node:assert/strict";
import { VoiceService } from "../src/voice_service.mjs";

test("a failed text send is surfaced instead of reported as connected", async () => {
  const browser = {
    mode: "voice",
    status: () => ({ running: false }),
    start: async () => {},
    close: async () => {},
    voiceAction: async action => {
      if (action === "start") return { state: "connected", sessionId: "session-1", events: [] };
      if (action === "text") throw new Error("Voice channel is unavailable.");
      return { state: "connected", sessionId: "session-1", events: [] };
    },
  };
  const providers = new Map([["chatgpt-web", { voice: true }]]);
  const service = new VoiceService(browser, providers);

  await service.handle({
    action: "start",
    providerId: "chatgpt-web",
    account: { accessToken: "fixture", sessionCookie: "fixture" },
    options: {},
  });

  await assert.rejects(
    service.handle({ action: "text", text: "hidden context", hidden: true }),
    /Voice operation failed\./,
  );
});
