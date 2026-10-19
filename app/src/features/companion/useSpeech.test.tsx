import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newConversation, useSessionStore } from "../../store/sessionStore";
import { holdMs } from "./geometry";
import { useSpeech } from "./useSpeech";

function Bubble() { return <p>{useSpeech()}</p>; }

describe("live speech captions", () => {
  const element = document.createElement("div");
  let root: ReturnType<typeof createRoot>;
  const original = useSessionStore.getState();
  const conversation = newConversation();
  const caption = (text: string, final: boolean, speaker: "assistant" | "user" = "assistant") => {
    act(() => useSessionStore.setState({
      activeId: conversation.id,
      connectionState: "connected",
      assistantSpeaking: !final,
      conversations: [{ ...conversation, turns: [{ id: "reply", speaker, text, final, timestamp: Date.now() }] }],
    }));
  };

  beforeEach(() => { vi.useFakeTimers(); root = createRoot(element); act(() => root.render(<Bubble />)); });
  afterEach(() => { act(() => root.unmount()); useSessionStore.setState(original); vi.useRealTimers(); });

  it("shows a final-only caption immediately and holds it for reading", () => {
    caption("Hello there.", true);
    expect(element.textContent).toBe("Hello there.");
    act(() => vi.advanceTimersByTime(holdMs("Hello there.")));
    expect(element.textContent).toBe("");
  });

  it("updates each partial immediately and clears it when the user speaks", () => {
    caption("Hello", false);
    expect(element.textContent).toBe("Hello");
    caption("Hello there.", false);
    expect(element.textContent).toBe("Hello there.");
    caption("Next question", false, "user");
    expect(element.textContent).toBe("");
  });

  it("does not replay old history as live speech when disconnected", () => {
    caption("An earlier reply", true);
    act(() => useSessionStore.setState({ connectionState: "idle" }));
    expect(element.textContent).toBe("");
  });

  it("keeps the current reply visible when a late user caption arrives during speech", () => {
    caption("The answer is still playing.", false);
    act(() => useSessionStore.setState({ outputLevel: 0.4 }));
    act(() => useSessionStore.setState((state) => ({
      conversations: state.conversations.map((item) => ({ ...item, turns: [...item.turns,
        { id: "late-user", speaker: "user" as const, text: "The preceding question", final: true, timestamp: Date.now() },
      ] })),
    })));
    expect(element.textContent).toBe("The answer is still playing.");
  });

  it("holds a final caption throughout audible playback and then allows time to read", () => {
    caption("A reply whose audio outlasts the final caption.", true);
    act(() => useSessionStore.setState({ outputLevel: 0.4 }));
    act(() => vi.advanceTimersByTime(holdMs("A reply whose audio outlasts the final caption.") + 1000));
    expect(element.textContent).toBe("A reply whose audio outlasts the final caption.");
    act(() => useSessionStore.setState({ outputLevel: 0 }));
    act(() => vi.advanceTimersByTime(holdMs("A reply whose audio outlasts the final caption.")));
    expect(element.textContent).toBe("");
  });

  it("does not reuse a previous reply when a new answer starts before its caption", () => {
    caption("Previous reply", false);
    act(() => useSessionStore.setState({ assistantSpeaking: false }));
    act(() => useSessionStore.setState((state) => ({
      assistantSpeaking: true,
      conversations: state.conversations.map((item) => ({ ...item, turns: [...item.turns,
        { id: "next-user", speaker: "user" as const, text: "Next question", final: true, timestamp: Date.now() },
      ] })),
    })));
    expect(element.textContent).toBe("");
  });
});
