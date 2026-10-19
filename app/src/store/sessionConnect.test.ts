import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectOptions, ProviderConversation, VoiceProvider } from "../providers";
import type { ConnectionState, TranscriptTurn } from "../types";

/** A provider whose connect() only finishes when the test says so. */
class FakeProvider {
  connected = false;
  /** Every text the store injected as the user (persona, rule, greeting). */
  readonly sent: string[] = [];
  /** Every screenshot the store relayed to the model. */
  readonly sentImages: Array<{ fileId: string; text: string }> = [];
  private finishConnect: (() => void) | null = null;
  private stateCb: ((state: ConnectionState, detail?: string) => void) | null = null;
  private usageCb: ((seconds: number) => void) | null = null;
  /** The session id the store asked this provider to resume. */
  resumed: string | undefined;
  thread: ProviderConversation | undefined;
  instructions: string | undefined;
  private threadCb: ((thread: ProviderConversation) => void) | null = null;
  private fullCb: (() => void) | null = null;
  onConversation(cb: (thread: ProviderConversation) => void): () => void { this.threadCb = cb; return () => { this.threadCb = null; }; }
  onConversationLimit(cb: () => void): () => void { this.fullCb = cb; return () => { this.fullCb = null; }; }
  reportThread(thread: ProviderConversation): void { this.threadCb?.(thread); }
  reportFull(): void { this.fullCb?.(); }

  connect(options?: ConnectOptions): Promise<void> {
    this.resumed = options?.sessionId;
    this.thread = options?.conversation;
    this.instructions = options?.instructions;
    return new Promise((resolve) => {
      this.finishConnect = () => {
        this.connected = true;
        this.stateCb?.("connected");
        resolve();
      };
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Release a connect() the test started. */
  settleConnect(): void {
    this.finishConnect?.();
  }

  /** Report a remaining voice budget, like the backend does. */
  reportUsage(seconds: number): void {
    this.usageCb?.(seconds);
  }

  getSessionId(): string | undefined {
    return "session";
  }

  onState(cb: (state: ConnectionState, detail?: string) => void): () => void {
    this.stateCb = cb;
    return () => {
      if (this.stateCb === cb) this.stateCb = null;
    };
  }

  private captionCb: ((turn: TranscriptTurn) => void) | null = null;
  onCaption(cb: (turn: TranscriptTurn) => void): () => void {
    this.captionCb = cb;
    return () => { if (this.captionCb === cb) this.captionCb = null; };
  }
  reportCaption(turn: TranscriptTurn): void { this.captionCb?.(turn); }

  onLevel(): () => void {
    return () => {};
  }

  onUsage(cb: (seconds: number) => void): () => void {
    this.usageCb = cb;
    return () => {
      if (this.usageCb === cb) this.usageCb = null;
    };
  }

  onError(): () => void {
    return () => {};
  }

  sendText(text: string): void {
    this.sent.push(text);
  }

  sendImage(image: { fileId: string }, text: string): void {
    this.sentImages.push({ fileId: image.fileId, text });
  }
}

const created: FakeProvider[] = [];

vi.mock("../providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers")>();
  return {
    ...actual,
    createProvider: () => {
      const provider = new FakeProvider();
      created.push(provider);
      return provider as unknown as VoiceProvider;
    },
  };
});

// Session-store tests run without the native Tauri host. Prompt composition is
// covered by sessionPrompt.test.ts; keep these tests focused on connection
// lifecycle and provider callbacks.
vi.mock("./sessionPrompt", () => ({
  openingPrompt: async () => ({
    persona: "",
    manifest: "",
    directive: "",
    recap: "",
    full: "",
  }),
}));

import { newConversation, selectVoiceBudget, useSessionStore } from "./sessionStore";

/** Let the pending microtasks of a connect() run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("connect()", () => {
  beforeEach(() => {
    created.length = 0;
    useSessionStore.setState({ connectionState: "idle" });
  });

  it("lets a newer attempt supersede one still in flight", async () => {
    const store = useSessionStore.getState();
    const first = store.connect();
    await flush();
    const second = useSessionStore.getState().connect();
    await flush();
    expect(created).toHaveLength(2);

    // The slow first attempt finishes last: it must tear itself down instead
    // of answering next to the live session.
    created[0].settleConnect();
    await first;
    created[1].settleConnect();
    await second;

    expect(created[0].connected).toBe(false);
    expect(created[1].connected).toBe(true);
    expect(useSessionStore.getState().connectionState).toBe("connected");
  });

  it("resumes a conversation only on the backend that issued its id", async () => {
    const original = useSessionStore.getState().providerId;
    const first = useSessionStore.getState().connect();
    await flush();
    created[0].settleConnect();
    await first;
    await useSessionStore.getState().disconnect();

    useSessionStore.setState({ providerId: "grok-web", connectionState: "idle" });
    const other = useSessionStore.getState().connect();
    await flush();
    expect(created[1].resumed).toBeUndefined();
    created[1].settleConnect();
    await other;
    await useSessionStore.getState().disconnect();

    useSessionStore.setState({ providerId: original, connectionState: "idle" });
    const back = useSessionStore.getState().connect();
    await flush();
    expect(created[2].resumed).toBe("session");
    created[2].settleConnect();
    await back;
    await useSessionStore.getState().disconnect();
  });

  it("persists the durable thread and sends it only to its owning provider", async () => {
    const original = useSessionStore.getState().providerId;
    const fresh = newConversation(1, useSessionStore.getState().providerId);
    useSessionStore.setState({ conversations: [fresh], activeId: fresh.id });
    let pending = useSessionStore.getState().connect(); await flush();
    created[0].settleConnect(); await pending;
    created[0].reportThread({ conversationId: "chat-123", parentMessageId: "message-2" });
    await useSessionStore.getState().disconnect();
    useSessionStore.setState({ providerId: "grok-web" });
    pending = useSessionStore.getState().connect(); await flush();
    expect(created[1].thread).toBeUndefined();
    created[1].settleConnect(); await pending;
    await useSessionStore.getState().disconnect();
    useSessionStore.setState({ providerId: original });
    pending = useSessionStore.getState().connect(); await flush();
    expect(created[2].thread).toEqual({ conversationId: "chat-123", parentMessageId: "message-2" });
    created[2].settleConnect(); await pending;
    await useSessionStore.getState().disconnect();
  });

  it("opens a successor only for an explicit capacity signal and carries context", async () => {
    const fresh = newConversation(1, useSessionStore.getState().providerId);
    fresh.turns = [{ id: "before-full", speaker: "user", text: "Keep the Atlas project details", final: true, timestamp: 1 }];
    useSessionStore.setState({ conversations: [fresh], activeId: fresh.id });
    const pending = useSessionStore.getState().connect(); await flush();
    created[0].settleConnect(); await pending;
    created[0].reportFull(); await flush(); await flush();
    const state = useSessionStore.getState();
    expect(state.activeId).not.toBe(fresh.id);
    const next = state.conversations.find((conversation) => conversation.id === state.activeId)!;
    expect(next.continuationOf).toBe(fresh.id);
    expect(next.continuationContext).toContain("Keep the Atlas project details");
    expect(state.conversations.find((conversation) => conversation.id === fresh.id)?.turns[0].text).toContain("Atlas");
    expect(created[1].thread).toBeUndefined();
    created[1].settleConnect(); await flush();
    created[1].reportFull(); await flush();
    expect(created).toHaveLength(2);
    expect(useSessionStore.getState().connectionState).toBe("idle");
    expect(useSessionStore.getState().lastError).toBeTruthy();
    await useSessionStore.getState().disconnect();
  });

  it("switches an active call without carrying another provider's requests", async () => {
    const fresh = newConversation(1, "chatgpt-web");
    fresh.turns = [{ id: "early-fact", speaker: "user", text: "My project is Atlas", final: true, timestamp: 1 }];
    useSessionStore.setState({ conversations: [fresh], activeId: fresh.id, providerId: "chatgpt-web" });
    const pending = useSessionStore.getState().connect(); await flush();
    created[0].settleConnect(); await pending;
    useSessionStore.getState().setProviderId("grok-web"); await flush(); await flush();
    expect(created[0].connected).toBe(false);
    expect(useSessionStore.getState().activeId).not.toBe(fresh.id);
    expect(useSessionStore.getState().conversations.find((conversation) => conversation.id === fresh.id)?.turns[0].text).toBe("My project is Atlas");
    expect(created[1].thread).toBeUndefined();
    expect(created[1].instructions).not.toContain("My project is Atlas");
    created[1].settleConnect(); await flush();
    await useSessionStore.getState().disconnect();
  });

  it("keeps the voice budget the backend reports", async () => {
    const pending = useSessionStore.getState().connect();
    await flush();
    created[0].settleConnect();
    await pending;

    created[0].reportUsage(1800);
    const state = useSessionStore.getState();
    expect(selectVoiceBudget(state)).toBe(1800);
    // Another backend's account has its own budget, unknown until it reports.
    useSessionStore.setState({ providerId: "claude-web" });
    expect(selectVoiceBudget(useSessionStore.getState())).toBeNull();
    useSessionStore.setState({ providerId: state.providerId });
    expect(selectVoiceBudget(useSessionStore.getState())).toBe(1800);
  });

  it("records how long the session ran when it ends", async () => {
    vi.useFakeTimers();
    try {
      const pending = useSessionStore.getState().connect();
      await vi.advanceTimersByTimeAsync(0);
      created[0].settleConnect();
      await pending;
      await vi.advanceTimersByTimeAsync(65_000);

      const stopping = useSessionStore.getState().disconnect();
      await vi.advanceTimersByTimeAsync(0);
      await stopping;

      const state = useSessionStore.getState();
      const conversation = state.conversations.find((c) => c.id === state.activeId)!;
      const last = conversation.turns[conversation.turns.length - 1];
      expect(last.speaker).toBe("system");
      expect(last.text).toContain("1:05");
    } finally {
      vi.useRealTimers();
    }
  });

  it("greets a new conversation, never one that is being continued", async () => {
    vi.useFakeTimers();
    try {
      // A conversation with real speech in it: this call continues it, and a
      // greeting again would make the model answer "hi, I'm LILO" on every wake.
      const continued = {
        id: "conv-continued",
        providerId: useSessionStore.getState().providerId,
        title: "Continued",
        createdAt: 0,
        updatedAt: 0,
        turns: [
          {
            id: "turn-1",
            speaker: "user" as const,
            text: "play something",
            final: true,
            timestamp: 0,
          },
        ],
      };
      useSessionStore.setState({ conversations: [continued], activeId: continued.id });

      const pending = useSessionStore.getState().connect({ greeting: "Say hi." });
      await vi.advanceTimersByTimeAsync(0);
      created[0].settleConnect();
      await pending;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(created[0].sent).not.toContain("Say hi.");

      // A conversation that has not started yet still gets its greeting.
      const fresh = newConversation(1, useSessionStore.getState().providerId);
      useSessionStore.setState({ conversations: [fresh], activeId: fresh.id });
      const second = useSessionStore.getState().connect({ greeting: "Say hi." });
      await vi.advanceTimersByTimeAsync(0);
      created[1].settleConnect();
      await second;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(created[1].sent).toContain("Say hi.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a screenshot only to a backend that can see images", async () => {
    const pending = useSessionStore.getState().connect();
    await flush();
    created[0].settleConnect();
    await pending;
    const provider = created[0];

    // chatgpt-web declares outbound.image: the screen tool's event lands here.
    useSessionStore.setState({ providerId: "chatgpt-web" });
    const image = (fileId: string) => ({
      fileId,
      name: "screen.jpg",
      mime: "image/jpeg",
      size: 1,
      width: 1,
      height: 1,
    });
    useSessionStore.getState().relayImage(image("file_1"), "look at this");
    expect(provider.sentImages).toEqual([{ fileId: "file_1", text: "look at this" }]);

    // claude-web does not, and the store must not pretend otherwise.
    useSessionStore.setState({ providerId: "claude-web" });
    useSessionStore.getState().relayImage(image("file_2"), "look at this");
    expect(provider.sentImages).toHaveLength(1);
  });

  it("drops an attempt the user cancelled with disconnect()", async () => {
    const store = useSessionStore.getState();
    const pending = store.connect();
    await flush();

    const stopping = useSessionStore.getState().disconnect();
    created[0].settleConnect();
    await pending;
    await stopping;

    expect(created[0].connected).toBe(false);
    expect(useSessionStore.getState().connectionState).toBe("idle");
  });
});


describe("streaming caption storage", () => {
  it("marks the first assistant caption as speaking after a long quiet interval", async () => {
    const connecting = useSessionStore.getState().connect();
    await flush();
    const provider = created.at(-1)!;
    provider.settleConnect();
    await connecting;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      provider.reportCaption({ id: "first-reply", speaker: "assistant", text: "Hello", final: false, timestamp: Date.now() });
      expect(useSessionStore.getState().assistantSpeaking).toBe(true);
    } finally {
      clock.mockRestore();
      await useSessionStore.getState().disconnect();
    }
  });

  it("updates the live conversation before saving and coalesces revisions", async () => {
    const connecting = useSessionStore.getState().connect();
    await flush();
    const provider = created.at(-1)!;
    provider.settleConnect();
    await connecting;
    const write = vi.spyOn(Storage.prototype, "setItem");
    vi.useFakeTimers();
    try {
      const turn: TranscriptTurn = { id: "live-caption", speaker: "assistant", text: "Hello", final: false, timestamp: Date.now() };
      provider.reportCaption(turn);
      provider.reportCaption({ ...turn, text: "Hello there." });
      const state = useSessionStore.getState();
      const active = state.conversations.find((c) => c.id === state.activeId);
      expect(active?.turns.at(-1)?.text).toBe("Hello there.");
      expect(write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(write).toHaveBeenCalledOnce();
      expect(write.mock.calls[0][1]).toContain("Hello there.");
    } finally {
      vi.useRealTimers();
      write.mockRestore();
      await useSessionStore.getState().disconnect();
    }
  });
});
