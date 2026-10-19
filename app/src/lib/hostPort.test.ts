import { expect, test, vi } from "vitest";

const native = vi.hoisted(() => vi.fn().mockResolvedValue("native-result"));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native }));
import { call, hasHost } from "./gateway";
import { installHostPort } from "./hostPort";

test("native IPC retains its command and arguments; only another entry point opts into a remote host", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  expect(hasHost()).toBe(true);
  await expect(call("existing-command", { value: 7 })).resolves.toBe("native-result");
  expect(native).toHaveBeenCalledWith("existing-command", { value: 7 });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  await expect(call("existing-command")).rejects.toThrow("Tauri IPC is unavailable");
  const remote = vi.fn().mockResolvedValue("remote-result");
  installHostPort({ call: remote });
  await expect(call("existing-command", { value: 8 })).resolves.toBe("remote-result");
  expect(remote).toHaveBeenCalledWith("existing-command", { value: 8 });
  expect(native).toHaveBeenCalledTimes(1);
});
