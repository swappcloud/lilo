import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { browserRunArgs, daemonRunArgs, nativeSandboxProfile, managementOrigin } from "./daemon-runtime.mjs";

test("pairing accepts LAN HTTP origins and rejects credential-bearing or non-HTTP URLs", () => {
  assert.equal(managementOrigin("http://192.168.1.20:8788").origin, "http://192.168.1.20:8788");
  assert.equal(managementOrigin("https://lilo.example").origin, "https://lilo.example");
  assert.equal(managementOrigin().origin, "http://localhost:8788");
  for (const value of ["ftp://lilo.example", "http://user:password@lilo.example", "http://lilo.example/path", "http://lilo.example?key=value", "http://lilo.example#key"]) {
    assert.throws(() => managementOrigin(value));
  }
});

test("LAN exposure is explicit and cannot inject Docker publish arguments", () => {
  const options = { dataDir: "fixture/data", runtimeDir: "fixture/runtime", platform: "linux" };
  assert.ok(daemonRunArgs(options).includes("127.0.0.1:8788:8788"));
  assert.ok(daemonRunArgs({ ...options, bind: "0.0.0.0" }).includes("0.0.0.0:8788:8788"));
  assert.throws(() => daemonRunArgs({ ...options, bind: "--privileged" }), /explicit LAN/);
});

test("headless installer help and invalid arguments do not install packages", { skip: process.platform === "win32" }, () => {
  const help = spawnSync("sh", ["scripts/install-headless.sh", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--install-system-deps/);
  const invalid = spawnSync("sh", ["scripts/install-headless.sh", "--unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown option/);
});

test("preprovisioned installer builds and starts as a user without sudo", { skip: process.platform !== "linux" }, () => {
  const fixture = mkdtempSync(join(tmpdir(), "lilo-installer-"));
  try {
    const log = join(fixture, "calls");
    for (const binary of ["docker", "node"]) {
      writeFileSync(join(fixture, binary), `#!/bin/sh\nprintf '%s\\n' '${binary}' \"$@\" >> \"$LILO_INSTALL_TEST_LOG\"\n`, { mode: 0o700 });
    }
    writeFileSync(join(fixture, "id"), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o700 });
    writeFileSync(join(fixture, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; esac\n', { mode: 0o700 });
    const result = spawnSync("sh", ["scripts/install-headless.sh", "--lan"], {
      encoding: "utf8", env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH}`, PULSE_SERVER: "unix:/fixture/pulse", LILO_INSTALL_TEST_LOG: log },
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /build:daemon-voice/);
    assert.match(calls, /scripts\/daemon-runtime.mjs\nbuild/);
    assert.match(calls, /scripts\/daemon-runtime.mjs\nstart/);
    assert.doesNotMatch(calls, /sudo/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("WSL audio uses its Unix endpoint without privileged containers or published browser ports", () => {
  const args = browserRunArgs({ runtimeDir: "/fixture/runtime", pulseServer: "unix:/mnt/wslg/PulseServer", platform: "linux" });
  assert.ok(args.includes("PULSE_SERVER=unix:/run/lilo/pulse"));
  assert.ok(args.includes("type=bind,src=/mnt/wslg/PulseServer,dst=/run/lilo/pulse"));
  assert.ok(!args.includes("--privileged"));
  assert.ok(!args.includes("--publish"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(!args.includes("--cap-add"));
  assert.ok(!args.includes("seccomp=unconfined"));
});

test("native sandbox grants only the required namespace mount calls and preserves the base filter", () => {
  const base = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] };
  const profile = nativeSandboxProfile(base);
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.deepEqual(profile.syscalls[0], base.syscalls[0]);
  assert.deepEqual(profile.syscalls[1], { names: ["mount", "umount2", "pivot_root", "chroot"], action: "SCMP_ACT_ALLOW" });
  assert.equal(base.syscalls.length, 1);
});
test("other hosts do not inherit a WSL path or unsupported audio mount", () => {
  const args = browserRunArgs({ runtimeDir: "fixture", pulseServer: "unix:/mnt/wslg/PulseServer", platform: "win32" });
  assert.ok(!args.some(arg => arg.includes("/mnt/wslg")));
  assert.ok(!args.some(arg => arg.includes("PULSE_SERVER=")));
});

test("Linux daemon receives the host Pulse socket while other hosts keep native audio", () => {
  const linux = daemonRunArgs({ dataDir: "/fixture/data", runtimeDir: "/fixture/runtime", pulseServer: "unix:/mnt/wslg/PulseServer", platform: "linux" });
  assert.ok(linux.includes("PULSE_SERVER=unix:/run/lilo/pulse"));
  assert.ok(linux.includes("type=bind,src=/mnt/wslg/PulseServer,dst=/run/lilo/pulse"));
  assert.ok(linux.includes("type=bind,src=/fixture/data,dst=/data"));
  const windows = daemonRunArgs({ dataDir: "fixture/data", runtimeDir: "fixture/runtime", pulseServer: "unix:/mnt/wslg/PulseServer", platform: "win32" });
  assert.ok(!windows.some(arg => arg.includes("/mnt/wslg")));
  assert.ok(!windows.some(arg => arg.includes("PULSE_SERVER=")));
});

test("public daemon installation resolves a release and preserves data across upgrades", { skip: process.platform !== "linux" }, () => {
  mkdirSync(".tmp", { recursive: true });
  const fixture = mkdtempSync(join(process.cwd(), ".tmp", "public-installer-"));
  try {
    const source = join(fixture, "source");
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(join(source, "scripts", "install-headless.sh"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$LILO_TEST_CALLS"\nexit "${LILO_TEST_INSTALL_STATUS:-0}"\n');
    const archive = join(fixture, "source.tar.gz");
    const packed = spawnSync("tar", ["-czf", archive, "-C", fixture, "source"], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "id"), '#!/bin/sh\nprintf "1000\\n"\n', { mode: 0o700 });
    writeFileSync(join(bin, "curl"), `#!/bin/sh
set -eu
output=
for argument in "$@"; do
  if [ "\${previous:-}" = --output ]; then output=$argument; fi
  previous=$argument
done
case "$previous" in
  */releases?per_page=1) printf '[{"tag_name":"v1.0.0","prerelease":true}]' ;;
  */tarball/*) [ "\${LILO_TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22; cp "$LILO_TEST_ARCHIVE" "$output" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    const installDir = join(fixture, "installation with spaces");
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, LILO_INSTALL_DIR: installDir,
      LILO_INSTALL_REF: "", LILO_TEST_ARCHIVE: archive, LILO_TEST_CALLS: join(fixture, "calls") };
    const install = (overrides = {}) => spawnSync("sh", ["scripts/install-daemon.sh", "--install-system-deps", "--lan"], { encoding: "utf8", env: { ...env, ...overrides } });
    const first = install();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(env.LILO_TEST_CALLS, "utf8"), "--install-system-deps\n--lan\n");
    assert.equal(readlinkSync(join(installDir, "current")), join(installDir, "releases", "v1.0.0"));
    const savedData = join(installDir, "data", "daemon-phone", "fixture");
    writeFileSync(savedData, "preserved");
    const upgraded = install({ LILO_INSTALL_REF: "v1.0.1" });
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(readFileSync(join(installDir, "current", ".tmp", "daemon-phone", "fixture"), "utf8"), "preserved");
    const current = readlinkSync(join(installDir, "current"));
    assert.notEqual(install({ LILO_INSTALL_REF: "v1.0.2", LILO_TEST_DOWNLOAD_FAIL: "1" }).status, 0);
    assert.equal(readlinkSync(join(installDir, "current")), current);
    assert.ok(!existsSync(join(installDir, "releases", "v1.0.2")));
    assert.notEqual(install({ LILO_INSTALL_REF: "v1.0.3", LILO_TEST_INSTALL_STATUS: "1" }).status, 0);
    assert.equal(readlinkSync(join(installDir, "current")), current);
    assert.equal(readFileSync(savedData, "utf8"), "preserved");
    assert.notEqual(install({ LILO_INSTALL_REF: ".." }).status, 0);
    assert.equal(readlinkSync(join(installDir, "current")), current);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
