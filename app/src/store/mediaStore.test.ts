import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startMediaPolling, stopMediaPolling, useMediaStore } from "./mediaStore";

const mocks = vi.hoisted(() => ({ report: vi.fn(async () => ({
  playerFound: true, nowPlaying: { title: "Song", artist: "Artist", url: "", queueLength: 0, paused: false, volume: 70 },
})) }));
vi.mock("../lib/gateway", () => ({ hasHost: () => true, mediaReport: mocks.report, runTool: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.report.mockClear();
  useMediaStore.setState({ nowPlaying: null, playerFound: false });
});
afterEach(() => {
  stopMediaPolling();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reads now-playing state through a non-Tauri host", async () => {
  await useMediaStore.getState().refresh();
  expect(useMediaStore.getState().playerFound).toBe(true);
  expect(useMediaStore.getState().nowPlaying?.title).toBe("Song");
});

it("keeps desktop polling active when its window is hidden", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  startMediaPolling();
  await vi.advanceTimersByTimeAsync(4000);
  expect(mocks.report).toHaveBeenCalledTimes(2);
});

it("pauses phone requests while hidden and resumes when visible", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  startMediaPolling({ pauseWhenHidden: true });
  await vi.advanceTimersByTimeAsync(4000);
  expect(mocks.report).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(4000);
  expect(mocks.report).toHaveBeenCalledTimes(1);
});
