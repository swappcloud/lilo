import { describe, expect, it } from "vitest";
import { conversationForProvider, conversationProvider } from "./conversationScope";
const turns = [{ text: "Play music" }];
describe("provider conversation boundaries", () => {
  it("does not reuse another provider's requests or a legacy mixed conversation", () => {
    const first = { id: "one", providerId: "fixture-a", turns, updatedAt: 1 };
    const mixed = { id: "mixed", turns, updatedAt: 2, sessions: { "fixture-a": "one", "fixture-b": "two" } };
    expect(conversationForProvider([first, mixed], "one", "fixture-b")).toBeUndefined();
    expect(conversationProvider(mixed)).toBeUndefined();
  });
  it("returns to the selected provider's most recent conversation", () => {
    const first = { id: "one", providerId: "fixture-a", turns, updatedAt: 1 };
    const second = { id: "two", providerId: "fixture-b", turns, updatedAt: 2 };
    expect(conversationForProvider([first, second], "one", "fixture-b")).toBe(second);
  });
  it("can bind an empty draft and infer a legacy history belonging to only one provider", () => {
    const draft = { id: "draft", turns: [], updatedAt: 0 };
    expect(conversationForProvider([draft], "draft", "fixture-a")).toBe(draft);
    expect(conversationProvider({ id: "old", turns, updatedAt: 1, threads: { "fixture-a": {} } })).toBe("fixture-a");
  });
});
