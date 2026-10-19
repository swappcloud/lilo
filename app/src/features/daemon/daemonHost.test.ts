import { afterEach, expect, test, vi } from "vitest";
import { DaemonHost } from "./daemonHost";

afterEach(() => vi.unstubAllGlobals());

test("pairing stays in the authorization header and server rejection remains a failure", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Pairing expired." }) });
  vi.stubGlobal("fetch", fetch);
  await expect(new DaemonHost("private-pairing-value").call("list_plugins")).rejects.toThrow("Pairing expired.");
  const [url, request] = fetch.mock.calls[0];
  expect(url).toBe("/api");
  expect(request.headers["X-Lilo-Token"]).toBe("private-pairing-value");
  expect(request.credentials).toBe("omit");
  expect(request.body).not.toContain("private-pairing-value");
});

test("a mobile tool request is scoped to its active plugin owner", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ plugins: [{ manifest: { id: "notes" }, tools: ["notes_list"] }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
  vi.stubGlobal("fetch", fetch);
  const host = new DaemonHost("pairing");
  await expect(host.call("run_tool", { name: "notes_list", args: {} })).resolves.toEqual({ items: [] });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ operation: "invoke", id: "notes", tool: "notes_list", args: {} });
  fetch.mockClear().mockResolvedValue({ ok: true, json: async () => ({ plugins: [] }) });
  await expect(host.call("run_tool", { name: "notes_list", args: {} })).rejects.toThrow("No active plugin owns");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("network status and scan use the existing management operations", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: true, networks: [] }) });
  vi.stubGlobal("fetch", fetch);
  const host = new DaemonHost("pairing");
  await host.call("network_status");
  await host.call("network_scan");
  expect(fetch.mock.calls.map(([, request]) => JSON.parse(request.body).operation)).toEqual([
    "networkStatus",
    "networkScan",
  ]);
});

test("Wi-Fi join sends credentials only to the paired daemon management endpoint", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ currentSsid: "home" }) });
  vi.stubGlobal("fetch", fetch);
  await new DaemonHost("pairing").call("network_join", { ssid: "home", password: "secret-pass" });
  expect(fetch.mock.calls[0][0]).toBe("/api");
  expect(fetch.mock.calls[0][1].headers["X-Lilo-Token"]).toBe("pairing");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    operation: "networkJoin",
    ssid: "home",
    password: "secret-pass",
  });
});
