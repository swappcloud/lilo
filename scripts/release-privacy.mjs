/** Compiler path anonymization and a fail-closed release upload gate. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function privacyBuildEnvironment(input, home = homedir(), root = process.cwd(), platform = process.platform) {
  const env = { ...input };
  // Release artifacts never inherit a developer certificate or Apple account.
  env.APPLE_SIGNING_IDENTITY = "-";
  env.LILO_SIGN_IDENTITY = "-";
  for (const key of ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"]) delete env[key];
  const flags = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
    : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  flags.push(`--remap-path-prefix=${home}=/lilo-build/toolchain`, `--remap-path-prefix=${root}=/lilo-build/project`);
  env.CARGO_ENCODED_RUSTFLAGS = flags.join("\x1f");
  delete env.RUSTFLAGS;
  // Rust flags do not cover native C dependencies compiled by cc-rs.
  if (platform === "linux") {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    env.CC_SHELL_ESCAPED_FLAGS = "1";
    env.CFLAGS = [env.CFLAGS, quote(`-ffile-prefix-map=${home}=/lilo-build/toolchain`),
      quote(`-ffile-prefix-map=${root}=/lilo-build/project`)].filter(Boolean).join(" ");
  }
  return env;
}

export function assertPrivateDataAbsent(data, forbiddenPaths = []) {
  const texts = [data.toString("utf8"), data.toString("utf16le")];
  for (const text of texts) {
    if (forbiddenPaths.filter(Boolean).some((path) => text.includes(path)) ||
      /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^/\\\s\0<>]+/.test(text)) {
      throw new Error("Release privacy check failed: machine path");
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{35,}|AKIA[A-Z0-9]{16})\b/.test(text)) {
      throw new Error("Release privacy check failed: credential");
    }
    if (/\b[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook|icloud|yahoo|protonmail)\.[A-Za-z]{2,}\b/i.test(text)) {
      throw new Error("Release privacy check failed: personal email");
    }
  }
}

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

const payload = (file) => /(?:\.dmg|\.exe|\.deb|\.AppImage|\.app\.tar\.gz|\.sig)$/.test(file);
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Only explicit app outputs are scanned; browser profiles and accounts are never inputs. */
export function auditBuildOutputs(root, target, version, env = process.env, nativeLayout = false) {
  const directory = env.CARGO_TARGET_DIR ? resolve(root, env.CARGO_TARGET_DIR) : join(root, "target");
  const release = nativeLayout ? join(directory, "release") : join(directory, target, "release");
  const binary = join(release, target.includes("windows") ? "lilo.exe" : "lilo");
  if (!existsSync(binary)) throw new Error("Release privacy check failed: missing application binary");
  const candidates = [binary, ...files(join(root, "dist")).filter((file) => /\.(?:js|html|css)$/.test(file))];
  if (target.includes("apple-darwin")) {
    candidates.push(join(release, "bundle", "macos", "LILO.app", "Contents", "MacOS", "lilo"));
    const helper = join(root, "src-tauri", "binaries", "LiloWake.app", "Contents", "MacOS", "lilo-wake");
    if (!existsSync(helper)) throw new Error("Release privacy check failed: missing wake helper");
    candidates.push(helper);
  }
  for (const file of candidates) {
    try {
      assertPrivateDataAbsent(readFileSync(file), [homedir(), root]);
    } catch (error) {
      // Identify the build output without printing the rejected private value.
      throw new Error(`${error.message} in ${basename(file)}`);
    }
  }
  const bundle = join(release, "bundle");
  const artifacts = {};
  for (const file of files(bundle).filter(payload)) {
    const name = basename(file);
    if (name in artifacts) throw new Error("Release privacy check failed: duplicate artifact name");
    artifacts[name] = digest(file);
  }
  if (!Object.keys(artifacts).length) throw new Error("Release privacy check failed: missing installer outputs");
  const report = { schema: 1, version, target, artifacts };
  writeFileSync(join(bundle, "privacy.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

/** Publication verifies the audited bytes, even after transporting artifacts. */
export function verifyPrivacyReport(found, target, version) {
  const reports = found.filter((file) => basename(file) === "privacy.json");
  if (reports.length !== 1) throw new Error(`Missing privacy report for ${target}`);
  const report = JSON.parse(readFileSync(reports[0], "utf8"));
  if (report.schema !== 1 || report.target !== target || report.version !== version) {
    throw new Error(`Invalid privacy report for ${target}`);
  }
  const artifacts = found.filter(payload);
  if (artifacts.length !== Object.keys(report.artifacts ?? {}).length ||
    artifacts.some((file) => report.artifacts?.[basename(file)] !== digest(file))) {
    throw new Error(`Privacy report does not match artifact bytes for ${target}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [target, version, root = process.cwd()] = process.argv.slice(2);
  if (!target || !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: release-privacy.mjs <target> <version> [workspace]");
  auditBuildOutputs(resolve(root), target, version);
  console.log(`Privacy audit passed for ${target}`);
}
