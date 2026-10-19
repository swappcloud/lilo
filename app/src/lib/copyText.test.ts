import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

describe("copyText", () => {
  afterEach(() => vi.restoreAllMocks());
  it("uses the system clipboard where it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable:true, value:{writeText} });
    await copyText("Saved language note");
    expect(writeText).toHaveBeenCalledWith("Saved language note");
  });
  it("uses a temporary field in restricted webviews", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable:true, value:undefined });
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {configurable:true,value:exec});
    await copyText("Saved tutor answer");
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
