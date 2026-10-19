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
});
