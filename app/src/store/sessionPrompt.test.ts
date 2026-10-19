import { describe, expect, it, vi } from "vitest";

import { aboutLilo, openingPrompt } from "./sessionPrompt";
import type { ProtocolCapabilities } from "../providers";

const { promptBridge, openingBridge } = vi.hoisted(() => ({ promptBridge: vi.fn(), openingBridge: vi.fn() }));
vi.mock("../lib/gateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/gateway")>(),
  commandPromptLine: promptBridge,
  buildOpeningPrompt: openingBridge,
}));

it("fetches shared learning memory for live-text and upfront-context providers", async () => {
  const common = {inbound:{userText:true,assistantText:true,nativeToolCalls:false,images:false},
    outbound:{text:true,stopSpeaking:true,systemPrompt:true,toolResult:false,image:false}} satisfies ProtocolCapabilities;
  promptBridge.mockResolvedValueOnce("Saved learning memory: goal work meetings; next lesson introductions.");
  openingBridge.mockImplementationOnce(async (input) => ({ ...input, persona: "Canonical persona", manifest: `${input.commandContext} ${input.surfaceFacts}`, directive: "Canonical language rule", recap: input.recap, full: ["Canonical persona", input.commandContext, input.surfaceFacts, input.recap, "Canonical language rule"].filter(Boolean).join("\n\n") }));
  const first = await openingPrompt(common);
  expect(first.manifest).toContain("next lesson introductions");
  expect(first.persona).toBe("Canonical persona");
  expect(openingBridge).toHaveBeenLastCalledWith(expect.objectContaining({
    customPersona: null,
    commandContext: expect.stringContaining("next lesson introductions"),
    surfaceFacts: expect.stringContaining("runs on my computer"),
  }));
  expect(promptBridge).toHaveBeenLastCalledWith(true);
  promptBridge.mockResolvedValueOnce("Saved learning memory: goal work meetings; next lesson short role-plays.");
  openingBridge.mockImplementationOnce(async (input) => ({ ...input, persona: "Canonical persona", manifest: `${input.commandContext} ${input.surfaceFacts}`, directive: "Canonical language rule", recap: input.recap, full: ["Canonical persona", input.commandContext, input.surfaceFacts, input.recap, "Canonical language rule"].filter(Boolean).join("\n\n") }));
  const other = await openingPrompt({...common,outbound:{...common.outbound,text:false}});
  expect(other.full).toContain("next lesson short role-plays");
  expect(other.full).toContain("goal work meetings");
  expect(other.full).not.toContain("next lesson introductions");
  expect(promptBridge).toHaveBeenLastCalledWith(false);
});

describe("aboutLilo", () => {
  it("names the wake phrase when it is on", () => {
    const text = aboutLilo({ wakeWord: true, wakePhrase: "lilo" }, "companion");
    expect(text).toContain('by saying "lilo"');
    expect(text).toContain("tray icon");
  });

  it("says the wake phrase is off instead of offering it", () => {
    const text = aboutLilo({ wakeWord: false, wakePhrase: "lilo" }, "classic");
    expect(text).not.toContain('"lilo"');
    expect(text).toContain("turned off");
    expect(text).toContain("panels");
  });
});
