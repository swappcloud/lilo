import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ download: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/gateway", () => ({ downloadPluginImage: mocks.download }));
vi.mock("../../store/toastStore", () => ({ toast: mocks.toast }));
import { PluginImageDownload } from "./PluginImageDownload";

const image = { file: "img/1.b64", mime: "image/png" };

async function withButton(test: (button: HTMLButtonElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<PluginImageDownload pluginId="gallery" image={image} />));
    await test(container.querySelector("button")!);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
}

describe("picture downloads", () => {
  it("uses the native export command and prevents duplicate clicks while saving", async () => {
    let finish!: (path: string) => void;
    mocks.download.mockReset().mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    mocks.toast.mockReset();
    await withButton(async (button) => {
      await act(async () => button.click());
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.download).toHaveBeenCalledWith("gallery", "img/1.b64", "image/png");
      await act(async () => finish("Downloads/lilo-1.png"));
      expect(button.disabled).toBe(false);
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("Downloads/lilo-1.png"));
    });
  });

  it("shows save failures and lets the user retry", async () => {
    mocks.download.mockReset().mockRejectedValue(new Error("permission denied"));
    mocks.toast.mockReset();
    await withButton(async (button) => {
      await act(async () => button.click());
      expect(button.disabled).toBe(false);
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    });
  });
});
