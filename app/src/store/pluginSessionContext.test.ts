import { expect, it } from "vitest";
import { publicSessionContext, SessionContextPublisher } from "./pluginSessionContext";

it("publishes only public fields, clones capabilities and handles an empty provider registry", () => {
  const protocol = {inbound: {userText: true, assistantText: true, nativeToolCalls: false, images: false},
    outbound: {text: false, stopSpeaking: true, systemPrompt: true, toolResult: false, image: false}, token: "private"};
  const state = {pluginSessionId: "voice-local", connectionState: "connected" as const, loginEmail: "private", accounts: ["private"]};
  const context = publicSessionContext(state, "pt-BR", protocol);
  expect(context.supportLanguage).toBe("pt-BR");
  expect(context.sessionId).toBe("voice-local");
  expect(JSON.stringify(context)).not.toContain("private");
  protocol.outbound.text = true;
  expect(context.provider?.outbound.text).toBe(false);
  expect(publicSessionContext({pluginSessionId: null, connectionState: "disconnected"}, "it-IT", null))
    .toEqual({supportLanguage: "it-IT", sessionId: null, state: "idle", provider: null});
});

it("serializes changing session snapshots, skips duplicates and allows retry after errors", async () => {
  const events: unknown[] = [];
  const reports: unknown[] = [];
  let fail = true;
  const publisher = new SessionContextPublisher(async (topic, context) => {
    expect(topic).toBe("session.changed");
    if (fail) { fail = false; throw new Error("Unavailable"); }
    events.push(context);
  }, (error) => reports.push(error));
  const idle = publicSessionContext({pluginSessionId: null, connectionState: "idle"}, "en-US", null);
  await publisher.update(idle);
  expect(reports).toHaveLength(1);
  await publisher.update(idle);
  await publisher.update(idle);
  const connected = {...idle, state: "connected" as const, sessionId: "voice-1"};
  const first = publisher.update(connected);
  const last = publisher.update(idle);
  await Promise.all([first, last]);
  expect(events).toEqual([idle, connected, idle]);
});
