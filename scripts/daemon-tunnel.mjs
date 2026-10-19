import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { if (output.length < 1024) output += chunk.toString("utf8"); });
    child.on("error", () => reject(new Error("Docker is unavailable.")));
    child.on("exit", code => resolve(code === 0 ? output.trim() : null));
  });
}

async function main() {
  const running = await docker(["inspect", "lilo-phone-tunnel", "--format", "{{.State.Running}}"]);
  if (running === "true") throw new Error("The phone tunnel is already running.");
  if (running === "false") await docker(["rm", "lilo-phone-tunnel"]);
  const child = spawn("docker", ["run", "--rm", "--name", "lilo-phone-tunnel", "--network", "lilo-phone-test",
    "cloudflare/cloudflared@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07",
    "tunnel", "--no-autoupdate", "--url", "http://lilo-daemon-phone:8788"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  let reported = false;
  const timer = setTimeout(() => { if (!reported) { console.error("The tunnel has not supplied an address yet."); } }, 30000);
  const address = async chunk => {
    if (reported) return;
    buffer = (buffer + chunk.toString("utf8")).slice(-8192);
    const origin = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
    if (!origin) return;
    reported = true; clearTimeout(timer);
    await mkdir(join(root, ".tmp", "daemon-runtime"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".tmp", "daemon-runtime", "tunnel-origin.txt"), `${origin}\n`, { mode: 0o600 });
    console.log(`Public tunnel: ${origin}`);
    const pair = spawn(process.execPath, [join(root, "scripts", "daemon-runtime.mjs"), "pair", origin], { cwd: root, stdio: "inherit", windowsHide: true });
    pair.on("error", () => console.error("Private pairing link could not be prepared."));
  };
  child.stdout.on("data", chunk => { void address(chunk).catch(() => console.error("Tunnel address could not be saved.")); });
  child.stderr.on("data", chunk => { void address(chunk).catch(() => console.error("Tunnel address could not be saved.")); });
  child.on("error", () => { clearTimeout(timer); console.error("The tunnel runtime is unavailable."); process.exitCode = 1; });
  child.on("exit", code => { clearTimeout(timer); if (code) process.exitCode = code; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void docker(["stop", "lilo-phone-tunnel"]); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
