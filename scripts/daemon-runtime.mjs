import { spawn } from "node:child_process";
import { mkdir, chmod, readFile, writeFile, readdir, stat, access } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function managementOrigin(value = "http://localhost:8788") {
  const origin = new URL(value);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("Use an HTTP or HTTPS management origin.");
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Supply only the management origin.");
  return origin;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runtime = join(root, ".tmp", "daemon-runtime");
const data = join(root, ".tmp", "daemon-phone");
const network = "lilo-phone-test";
const browserImage = "lilo-daemon-browser:native";
const daemonImage = "lilo-daemon-runtime:local";
const seccompHash = "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849";

function run(binary, args, { quiet = false, tolerate = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: quiet ? ["ignore", "pipe", "ignore"] : "inherit", windowsHide: true });
    let output = "";
    if (quiet) child.stdout.on("data", chunk => { if (output.length < 64000) output += chunk.toString("utf8"); });
    child.on("error", () => reject(new Error(`${binary} is unavailable. Use the provisioning prerequisites documented in docs/headless-linux.md.`)));
    child.on("exit", code => code === 0 || tolerate ? resolveRun(output.trim()) : reject(new Error(`${binary} failed (${code}).`)));
  });
}
async function prepare() {
  for (const directory of [runtime, data, join(runtime, "browser")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const tokenPath = join(runtime, "browser-token");
  try { await access(tokenPath); } catch { await writeFile(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
  await chmod(tokenPath, 0o600);
  const pairingPath = join(runtime, "management-pairing");
  try { await access(pairingPath); } catch {
    await writeFile(pairingPath, `${randomBytes(32).toString("hex")}.${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  }
  await chmod(pairingPath, 0o600);
  const profile = join(runtime, "browser-seccomp.json");
  let bytes;
  try { bytes = await readFile(profile); } catch {
    const response = await fetch("https://raw.githubusercontent.com/microsoft/playwright/v1.64.0/utils/docker/seccomp_profile.json", { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Browser sandbox profile is unavailable.");
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length > 64000 || createHash("sha256").update(bytes).digest("hex") !== seccompHash) throw new Error("Browser sandbox profile failed verification.");
  await writeFile(profile, bytes, { mode: 0o600 });
  await writeFile(join(runtime, "webkit-seccomp.json"), JSON.stringify(nativeSandboxProfile(JSON.parse(bytes))), { mode: 0o600 });
}

/** Permit browser sandbox filesystem setup inside its unprivileged user namespace. */
export function nativeSandboxProfile(base) {
  return { ...base, syscalls: [...base.syscalls, { names: ["mount", "umount2", "pivot_root", "chroot"], action: "SCMP_ACT_ALLOW" }] };
}

/** Explicit Linux container mounts; desktop systems keep their native runtime. */
export function browserRunArgs({ runtimeDir, pulseServer, platform, uid = 1000 }) {
  const args = ["run", "-d", "--name", "lilo-browser-host", "--init", "--restart", "unless-stopped", "--user", `${uid}:${uid}`, "--network", network,
    "--memory", "1g", "--cpus", "1", "--shm-size", "256m", "--cap-drop", "ALL", "--security-opt", `seccomp=${join(runtimeDir, "webkit-seccomp.json")}`,
    "--mount", `type=bind,src=${join(runtimeDir, "browser-token")},dst=/run/lilo/browser-token,readonly`,
    "--mount", `type=bind,src=${join(runtimeDir, "browser")},dst=/data`];
  if (platform === "linux" && pulseServer?.startsWith("unix:")) {
    args.push("--mount", `type=bind,src=${pulseServer.slice(5)},dst=/run/lilo/pulse`, "-e", "PULSE_SERVER=unix:/run/lilo/pulse");
  }
  args.push(browserImage);
  return args;
}

/** Give the Linux daemon access to the host Pulse-compatible output socket. */
export function daemonRunArgs({ dataDir, runtimeDir, pulseServer, platform, uid = 1000, bind = "127.0.0.1" }) {
  if (!["127.0.0.1", "0.0.0.0"].includes(bind)) throw new Error("Use localhost or the explicit LAN binding.");
  const args = ["run", "-d", "--name", "lilo-daemon-phone", "--init", "--restart", "unless-stopped", "--user", `${uid}:${uid}`, "--network", network,
    "--memory", "256m", "--cpus", "1", "--publish", `${bind}:8788:8788`,
    "--mount", `type=bind,src=${dataDir},dst=/data`,
    "--mount", `type=bind,src=${join(runtimeDir, "browser-token")},dst=/run/lilo/browser-token,readonly`,
    "--mount", `type=bind,src=${join(runtimeDir, "management-pairing")},dst=/run/lilo/management-pairing,readonly`];
  if (platform === "linux" && pulseServer?.startsWith("unix:")) {
    args.push("--mount", `type=bind,src=${pulseServer.slice(5)},dst=/run/lilo/pulse`, "-e", "PULSE_SERVER=unix:/run/lilo/pulse");
  }
  args.push(daemonImage, "--data-dir", "/data", "--manage", "0.0.0.0:8788", "--manage-web", "/opt/lilo/management",
    "--manage-pair-file", "/run/lilo/management-pairing", "--login-browser", "http://lilo-browser-host:8790",
    "--login-browser-token-file", "/run/lilo/browser-token");
  return args;
}

async function main() {
  const command = process.argv[2] ?? "check";
  const uid = process.getuid?.() ?? 1000;
  if (uid === 0) throw new Error("Run this launcher as a regular user with access to Docker.");
  if (await run("docker", ["info", "--format", "{{.OSType}}"], { quiet: true }) !== "linux") throw new Error("A Linux Docker engine is required. No administrator changes are made by this launcher.");
  if (command === "build") {
    if (process.env.LILO_WEB_ASSETS_BUILT !== "1") {
      await run(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm run build:daemon"] : ["run", "build:daemon"]);
      await run(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm run build:daemon-voice"] : ["run", "build:daemon-voice"]);
    }
    await run("docker", ["build", "-f", "packages/daemon-browser-host/Dockerfile", "-t", browserImage, "."]);
    await run("docker", ["build", "-f", "crates/lilo-daemon/Dockerfile", "-t", daemonImage, "."]);
    await prepare();
    console.log("Daemon, mobile assets, browser and audio dependencies are packaged.");
  } else if (command === "start") {
    await prepare();
    await run("docker", ["image", "inspect", browserImage, daemonImage], { quiet: true });
    await run("docker", ["network", "create", network], { quiet: true, tolerate: true });
    for (const name of ["lilo-daemon-phone", "lilo-browser-host"]) {
      await run("docker", ["stop", name], { quiet: true, tolerate: true });
      await run("docker", ["rm", name], { quiet: true, tolerate: true });
    }
    await run("docker", browserRunArgs({ runtimeDir: runtime, pulseServer: process.env.PULSE_SERVER, platform: process.platform, uid }), { quiet: true });
    await run("docker", daemonRunArgs({ dataDir: data, runtimeDir: runtime, pulseServer: process.env.PULSE_SERVER, platform: process.platform, uid, bind: process.env.LILO_MANAGEMENT_BIND ?? "127.0.0.1" }), { quiet: true });
    console.log("Daemon started on port 8788. Use pair [HTTP_OR_HTTPS_ORIGIN] to write the private link for your device address.");
  } else if (command === "stop") {
    for (const name of ["lilo-phone-tunnel", "lilo-daemon-phone", "lilo-browser-host"]) await run("docker", ["stop", name], { quiet: true, tolerate: true });
    console.log("Daemon test runtime stopped. Saved device data remains private.");
  } else if (command === "pair") {
    const files = (await readdir(data)).filter(name => /^phone-access-[a-f0-9-]+\.txt$/.test(name));
    const ordered = await Promise.all(files.map(async name => ({ name, time: (await stat(join(data, name))).mtimeMs })));
    ordered.sort((a, b) => b.time - a.time);
    if (!ordered[0]) throw new Error("Start the daemon before retrieving its private pairing link.");
    const original = (await readFile(join(data, ordered[0].name), "utf8")).trim();
    const suppliedOrigin = process.argv[3];
    const origin = managementOrigin(suppliedOrigin);
    const link = `${origin.origin}/#${original.split("#")[1]}`;
    const destination = join(data, "phone-access-current.txt");
    await writeFile(destination, `${link}\n`, { mode: 0o600 });
    await chmod(destination, 0o600);
    console.log(`Private pairing link written to ${destination}. Open that file privately; do not share or publish its contents.`);
  } else if (command === "bundle") {
    await prepare();
    await run("docker", ["save", "--output", join(runtime, "runtime-images.tar"), browserImage, daemonImage]);
    console.log(`Offline dependency images saved in ${runtime}. They contain no device accounts or pairing secrets. Use matching CPU architectures.`);
  } else if (command === "check") {
    await run("docker", ["ps", "-a", "--filter", "name=lilo-", "--format", "{{.Names}} {{.Status}}"]);
    await run("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}", "lilo-daemon-phone", "lilo-browser-host"], { tolerate: true });
  } else throw new Error("Use build, start, stop, pair [HTTP_OR_HTTPS_ORIGIN], bundle or check.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
