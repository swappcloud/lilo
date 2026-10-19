#!/usr/bin/env node
/**
 * One-command machine setup after a fresh clone.
 *
 * Never asks for administrator rights:
 *   - Windows with MSVC C++ build tools already present: the official Tauri
 *     path, nothing to install.
 *   - Windows without them: the GNU (MinGW) fallback — a portable toolchain
 *     under %LOCALAPPDATA%\lilo that needs no elevation. Tauri officially
 *     supports MSVC only, so MSVC is preferred whenever it is there.
 *   - macOS/Linux: rustup, and on macOS the wake-word helper. Linux uses
 *     whatever WebKitGTK packages the distribution provides.
 * Then the npm dependencies. Idempotent: running it again costs a few checks.
 *
 * Usage:
 *   npm run setup     # Node 22 is already there
 *   .\scripts\setup.cmd  # Windows, installs Node first when missing
 *   ./scripts/setup.sh   # macOS/Linux
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const CARGO_BIN = join(homedir(), ".cargo", "bin");
const TOOLS_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "lilo", "tools");
const MINGW = join(TOOLS_DIR, "w64devkit");
const MINGW_VERSION = "2.10.0";
const MINGW_URL = `https://github.com/skeeto/w64devkit/releases/download/v${MINGW_VERSION}/w64devkit-x64-${MINGW_VERSION}.7z.exe`;
const MINGW_SHA256 = "18d0a4c71a166f8401ab6305781bec5882b40b5e06ba9807c61cb5f3b3c6325e";
const WEBVIEW2_BOOTSTRAPPER = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

function log(step) {
  console.log(`==> ${step}`);
}

function die(message) {
  console.error(`\n[setup] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", ...options });
}

function capture(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) die(`download failed: ${url} (${response.status})`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) return;
  die(
    `Node 22 or newer is required (found ${process.version}).\n` +
      "  Windows: winget install OpenJS.NodeJS.22\n" +
      "  macOS:   brew install node@22",
  );
}

function rustup(args) {
  const exe = join(CARGO_BIN, IS_WINDOWS ? "rustup.exe" : "rustup");
  return run(exe, args);
}

function ensureRust() {
  if (capture(join(CARGO_BIN, IS_WINDOWS ? "cargo.exe" : "cargo"), ["--version"]).status === 0) {
    log("Rust is already installed");
    return Promise.resolve();
  }
  log("installing Rust (stable)");
  if (IS_WINDOWS) {
    // rustup-init only installs when its own file name is exactly that: the
    // same binary doubles as the `rustup` proxy and keys off argv[0].
    const installer = join(tmpdir(), "rustup-init.exe");
    return download("https://win.rustup.rs/x86_64", installer).then(() => {
      const result = run(installer, [
        "-y",
        "--default-toolchain",
        "stable",
        "--profile",
        "default",
      ]);
      if (result.status !== 0) die("rustup-init failed");
      process.env.PATH = `${CARGO_BIN};${process.env.PATH}`;
    });
  }
  const result = run("sh", [
    "-c",
    "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | " +
      "sh -s -- -y --default-toolchain stable --profile default",
  ]);
  if (result.status !== 0) die("rustup failed");
  process.env.PATH = `${CARGO_BIN}:${process.env.PATH}`;
}

/// The canonical way to find the MSVC C++ tools; installed by VS Build Tools
/// and friends. Empty means "no usable MSVC".
function msvcPath() {
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) return null;
  const result = capture(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]);
  const path = (result.stdout ?? "").trim();
  return path.length > 0 ? path : null;
}

function mingwReady() {
  if (!existsSync(join(MINGW, "bin", "gcc.exe"))) return false;
  const marker = join(MINGW, ".version");
  return existsSync(marker) && readFileSync(marker, "utf8").trim() === MINGW_VERSION;
}

/// w64devkit ships `libgcc.a` only, while Rust's windows-gnu link line asks
/// for `-lgcc_eh` (the unwinder lives in the same archive). Give the linker
/// the name it looks for.
function fixLibgccEh() {
  const gccRoot = join(MINGW, "lib", "gcc", "x86_64-w64-mingw32");
  if (!existsSync(gccRoot)) return;
  for (const version of readdirSync(gccRoot)) {
    const dir = join(gccRoot, version);
    const libgcc = join(dir, "libgcc.a");
    const libgccEh = join(dir, "libgcc_eh.a");
    if (existsSync(libgcc) && !existsSync(libgccEh)) copyFileSync(libgcc, libgccEh);
  }
}

function addToUserPath(dir) {
  const script = [
    `$dir = "${dir}"`,
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($p -notlike \"*$dir*\") { [Environment]::SetEnvironmentVariable('Path', \"$dir;$p\", 'User') }",
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-Command", script]);
}

async function ensureMingw() {
  if (mingwReady()) {
    log("MinGW (w64devkit) is already installed");
    return;
  }
  log(`downloading the MinGW toolchain (w64devkit ${MINGW_VERSION}, ~67 MB)`);
  const sfx = join(tmpdir(), `w64devkit-${MINGW_VERSION}.exe`);
  await download(MINGW_URL, sfx);
  const actual = sha256(sfx);
  if (actual !== MINGW_SHA256) {
    rmSync(sfx, { force: true });
    die(`w64devkit failed its checksum — refusing to run it (got ${actual})`);
  }
  mkdirSync(TOOLS_DIR, { recursive: true });
  rmSync(MINGW, { recursive: true, force: true });
  const result = run(sfx, ["-y", `-o${TOOLS_DIR}`]);
  if (result.status !== 0 || !existsSync(join(MINGW, "bin", "gcc.exe"))) {
    die("could not extract w64devkit");
  }
  fixLibgccEh();
  writeFileSync(join(MINGW, ".version"), `${MINGW_VERSION}\n`);
  addToUserPath(join(MINGW, "bin"));
  log("MinGW installed");
}

function ensureWebView2() {
  const clients = [
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  ];
  const installed = clients.some(
    (key) => spawnSync("reg", ["query", key, "/v", "pv"], { stdio: "ignore" }).status === 0,
  );
  if (installed) {
    log("WebView2 runtime is already installed");
    return Promise.resolve();
  }
  log("installing the WebView2 runtime (user scope, no elevation)");
  // Microsoft's evergreen bootstrapper always fetches the current runtime, so
  // it cannot be digest-pinned the way the media binaries are.
  const installer = join(tmpdir(), "MicrosoftEdgeWebview2Setup.exe");
  return download(WEBVIEW2_BOOTSTRAPPER, installer).then(() => {
    const result = run(installer, ["/silent", "/install"]);
    if (result.status !== 0) {
      die(
        "WebView2 install failed — get it from:\n" +
          "  https://developer.microsoft.com/microsoft-edge/webview2/",
      );
    }
  });
}

async function ensureWindowsToolchain() {
  await ensureRust();
  if (msvcPath()) {
    log("MSVC C++ build tools found — using the official Tauri toolchain");
    if (rustup(["default", "stable"]).status !== 0) die("could not select the stable toolchain");
  } else {
    log("no MSVC found — using the GNU (MinGW) fallback");
    if (rustup(["toolchain", "install", "stable-x86_64-pc-windows-gnu"]).status !== 0) {
      die("could not install the GNU toolchain");
    }
    if (rustup(["default", "stable-x86_64-pc-windows-gnu"]).status !== 0) {
      die("could not select the GNU toolchain");
    }
    await ensureMingw();
  }
  await ensureWebView2();
}

function buildWakeHelper() {
  if (!IS_MAC) return;
  if (spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status !== 0) {
    log("Xcode command line tools are missing — run `xcode-select --install`");
    return;
  }
  log("building the macOS wake-word helper");
  const result = run("bash", [join(ROOT, "scripts", "build-wake.sh")], { cwd: ROOT });
  if (result.status !== 0) die("wake helper build failed");
}

function installDependencies() {
  log("installing npm dependencies");
  const result = run("npm", ["install"], { cwd: ROOT, shell: IS_WINDOWS });
  if (result.status !== 0) die("npm install failed");
}

function ensureLinuxWake() {
  if (process.platform !== "linux") return;
  const model = "/usr/share/pocketsphinx/model/en-us/en-us";
  if (existsSync(model) && capture("parec", ["--version"]).status === 0 &&
      capture("ldconfig", ["-p"]).stdout?.includes("libpocketsphinx.so.3")) return;
  if (capture("apt-get", ["--version"]).status !== 0) {
    log("Automatic wake provisioning supports Debian/Ubuntu. Packaged Linux AppImages include the wake runtime.");
    return;
  }
  const root = process.getuid?.() === 0;
  const command = root ? "apt-get" : "sudo";
  const prefix = root ? [] : ["apt-get"];
  log("provisioning Linux wake recognition and audio packages");
  if (run(command, [...prefix, "update"]).status !== 0 ||
      run(command, [...prefix, "install", "-y", "--no-install-recommends", "libpocketsphinx3", "pocketsphinx-en-us", "pulseaudio-utils"]).status !== 0) {
    die("Linux wake package provisioning failed.");
  }
}

async function main() {
  checkNode();
  if (IS_WINDOWS) {
    await ensureWindowsToolchain();
  } else {
    await ensureRust();
    buildWakeHelper();
    ensureLinuxWake();
  }
  installDependencies();
  console.log("\n[setup] all set — start the app with: npm run dev");
}

main().catch((error) => die(error?.message ?? String(error)));
