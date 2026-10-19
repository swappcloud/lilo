import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MusicSearch } from "./MusicSearch";

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => ({ tracks: [{ id: "selected-id", title: "Selected song", artist: "Artist", artworkUrl: "https://i.ytimg.com/vi/selected-id/hqdefault.jpg" }] })),
  play: vi.fn(async () => {}),
}));
vi.mock("../../lib/gateway", () => ({ runTool: mocks.search }));
vi.mock("../../store/mediaStore", () => ({ useMediaStore: { getState: () => ({ run: mocks.play }) } }));
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

it("searches only on submit, previews artwork, and plays the selected ID", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<MusicSearch/>));
    expect(mocks.search).not.toHaveBeenCalled();
    const input = element.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Queen");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => element.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.search).toHaveBeenCalledWith("media_search", { query: "Queen", limit: 8 });
    expect(element.querySelector("img")?.getAttribute("src")).toContain("i.ytimg.com");
    await act(async () => element.querySelector<HTMLButtonElement>(".music-search-results button")!.click());
    expect(mocks.play).toHaveBeenCalledWith("media_play", { trackId: "selected-id" });
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
