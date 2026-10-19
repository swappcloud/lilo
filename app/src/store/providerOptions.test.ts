import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Options belong to the provider that declared them: the ChatGPT voice and the
 * mock's must never overwrite each other, and the single global voice older
 * versions stored has to fold into the providers that had one.
 */
describe("provider options", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("keeps each provider's options apart", async () => {
    const { useSessionStore } = await import("./sessionStore");
    useSessionStore.getState().setProviderOption("chatgpt-web", "voice", "ember");
    useSessionStore.getState().setProviderOption("mock", "voice", "orbit");

    const options = useSessionStore.getState().providerOptions;
    expect(options["chatgpt-web"].voice).toBe("ember");
    expect(options.mock.voice).toBe("orbit");
  });

  it("folds the old global voice into the providers on load", async () => {
    localStorage.setItem(
      "lilo/state.v2",
      JSON.stringify({
        conversations: [
          { id: "c1", title: "Older", createdAt: 1, updatedAt: 1, turns: [] },
        ],
        activeId: "c1",
        providerId: "chatgpt-web",
        voice: "glimmer",
        voiceMode: "advanced",
      }),
    );

    const { useSessionStore } = await import("./sessionStore");
    const options = useSessionStore.getState().providerOptions;
    expect(options["chatgpt-web"].voice).toBe("glimmer");
    expect(options["chatgpt-web"].voiceMode).toBe("advanced");
    // The mock had a voice too; it inherits the last one the user picked.
    expect(options.mock.voice).toBe("glimmer");
  });

  it("falls back to the declared default when nothing is stored", async () => {
    const { useSessionStore } = await import("./sessionStore");
    const options = useSessionStore.getState().providerOptions;
    expect(options["chatgpt-web"]).toEqual({ voice: "cove", voiceMode: "wingman" });
  });
});
