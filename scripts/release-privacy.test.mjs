import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { privacyBuildEnvironment, assertPrivateDataAbsent, discoverTargetArtifacts, verifyPrivacyReport } from "./release-privacy.mjs";

test("MSVC linker records a portable PDB name and GNU targets retain their linker flags", () => {
  const env = privacyBuildEnvironment({}, "C:\\Users\\Builder", "D:\\project", "win32", "x86_64-pc-windows-msvc");
  const flags = env.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.ok(flags.includes("link-arg=/PDBALTPATH:lilo.pdb"));
  assert.ok(flags.includes("--remap-path-prefix=C:/Users/Builder=/lilo-build/toolchain"));
  assert.ok(flags.includes("--remap-path-prefix=D:/project=/lilo-build/project"));
  assert.ok(flags.includes(String.raw`--remap-path-prefix=\\?\C:\Users\Builder=/lilo-build/toolchain`));
  assert.ok(flags.includes("--remap-path-prefix=//?/D:/project=/lilo-build/project"));
  const gnu = privacyBuildEnvironment({}, "home", "root", "win32", "x86_64-pc-windows-gnu");
  assert.ok(!gnu.CARGO_ENCODED_RUSTFLAGS.includes("PDBALTPATH"));
});

test("Windows release binary contains no local PDB path", { skip: process.platform !== "win32" }, () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "linker-privacy-"));
  try {
    const source = join(directory, "fixture.rs");
    const binary = join(directory, "fixture.exe");
    writeFileSync(source, 'fn main() { println!("release privacy fixture"); }\n');
    const env = privacyBuildEnvironment(process.env, undefined, directory, "win32", "x86_64-pc-windows-msvc");
    execFileSync("rustc", [source, "--target", "x86_64-pc-windows-msvc", "-C", "debuginfo=2", "-o", binary,
      ...env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")]);
    assertPrivateDataAbsent(readFileSync(binary), [directory]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Linux native compiler flags preserve user flags and anonymize source paths", () => {
  const env = privacyBuildEnvironment({ CFLAGS: "-O2" }, "/home/Build User", "/home/Build User/project", "linux");
  assert.equal(env.CC_SHELL_ESCAPED_FLAGS, "1");
  assert.equal(env.CFLAGS, "-O2 '-ffile-prefix-map=/home/Build User=/lilo-build/toolchain' '-ffile-prefix-map=/home/Build User/project=/lilo-build/project'");
  for (const platform of ["darwin", "win32"]) {
    assert.equal(privacyBuildEnvironment({ CFLAGS: "existing" }, "home", "root", platform).CFLAGS, "existing");
  }
});

test("native source locations are anonymized in compiled output", { skip: process.platform === "win32" }, () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "compiler privacy "));
  try {
    const source = join(directory, "source.c");
    const binary = join(directory, "fixture");
    writeFileSync(source, '#include <stdio.h>\nint main(void) { puts(__FILE__); return 0; }\n');
    execFileSync("cc", [`-ffile-prefix-map=${directory}=/lilo-build/project`, source, "-o", binary]);
    assert.equal(execFileSync(binary, { encoding: "utf8" }).trim(), "/lilo-build/project/source.c");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiler privacy preserves flags and handles paths containing spaces", () => {
  const env = privacyBuildEnvironment({ RUSTFLAGS: "-C debuginfo=0" }, "/Users/Build User", "/Users/Build User/project", "darwin");
  assert.equal(env.RUSTFLAGS, undefined);
  assert.deepEqual(env.CARGO_ENCODED_RUSTFLAGS.split("\x1f"), [
    "-C", "debuginfo=0", "--remap-path-prefix=/Users/Build User=/lilo-build/toolchain",
    "--remap-path-prefix=/Users/Build User/project=/lilo-build/project",
  ]);
  const encoded = privacyBuildEnvironment({ CARGO_ENCODED_RUSTFLAGS: "-C\x1flink-arg=with spaces" }, "C:\\Users\\Builder", "C:\\build");
  assert.ok(encoded.CARGO_ENCODED_RUSTFLAGS.startsWith("-C\x1flink-arg=with spaces\x1f"));
});

test("privacy gate rejects UTF-8 and UTF-16 machine paths without revealing values", () => {
  const privatePath = "/Users/Build User/project/source.rs";
  for (const encoding of ["utf8", "utf16le"]) {
    assert.throws(() => assertPrivateDataAbsent(Buffer.from(privatePath, encoding), ["/Users/Build User"]), (error) => {
      assert.equal(error.message, "Release privacy check failed: machine path (toolchain home)");
      assert.ok(!error.message.includes("Build User"));
      return true;
    });
  }
  assert.throws(() => assertPrivateDataAbsent(Buffer.from("D:/runner/work/project"), ["C:/Users/Runner", "D:/runner/work/project"]),
    /machine path \(workspace\)/);
  assert.doesNotThrow(() => assertPrivateDataAbsent(Buffer.from("/lilo-build/project/source.rs"), ["/Users/Build User"]));
});

test("privacy gate rejects credentials and personal email addresses", () => {
  const fixtures = ["-----BEGIN PRIVATE KEY-----", "ghp_" + "x".repeat(36), "sk-proj-" + "x".repeat(48), ["private-user", "gmail.com"].join("@")];
  for (const value of fixtures) assert.throws(() => assertPrivateDataAbsent(Buffer.from(value), []), /Release privacy check failed/);
});

test("privacy gate allows public signing material and platform paths", () => {
  assert.doesNotThrow(() => assertPrivateDataAbsent(Buffer.from("/System/Library/Frameworks RWQpublic-updater-key com.lilo.app"), []));
});

test("privacy verification accepts old reports with unuploaded Debian signatures", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "privacy-report-"));
  try {
    const appImage = Buffer.from("published AppImage");
    const debSignature = Buffer.from("unpublished Debian signature");
    const report = join(directory, "privacy.json");
    const appImagePath = join(directory, "LILO_0.1.0_amd64.AppImage");
    writeFileSync(appImagePath, appImage);
    writeFileSync(report, JSON.stringify({ schema: 1, version: "0.1.0", target: "x86_64-unknown-linux-gnu", artifacts: {
      "LILO_0.1.0_amd64.AppImage": createHash("sha256").update(appImage).digest("hex"),
      "LILO_0.1.0_amd64.deb.sig": createHash("sha256").update(debSignature).digest("hex"),
    } }));
    assert.doesNotThrow(() => verifyPrivacyReport([report, appImagePath], "x86_64-unknown-linux-gnu", "0.1.0"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release artifacts are discovered from privacy reports after flat or nested extraction", () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "release-artifact-layout-"));
  try {
    const flat = join(directory, "flat");
    const nested = join(directory, "nested", "lilo-x86_64-pc-windows-msvc");
    for (const group of [flat, nested]) {
      mkdirSync(group, { recursive: true });
      const installer = join(group, "LILO_0.1.0_x64-setup.exe");
      const bytes = Buffer.from("audited installer");
      writeFileSync(installer, bytes);
      writeFileSync(join(group, "privacy.json"), JSON.stringify({ schema: 1, version: "0.1.0",
        target: "x86_64-pc-windows-msvc", artifacts: { [installer.split(/[\\/]/).pop()]: createHash("sha256").update(bytes).digest("hex") } }));
    }
    const flatGroups = discoverTargetArtifacts(flat);
    assert.deepEqual(Object.keys(flatGroups), ["x86_64-pc-windows-msvc"]);
    verifyPrivacyReport(flatGroups["x86_64-pc-windows-msvc"], "x86_64-pc-windows-msvc", "0.1.0");
    const nestedGroups = discoverTargetArtifacts(join(directory, "nested"));
    assert.deepEqual(Object.keys(nestedGroups), ["x86_64-pc-windows-msvc"]);
    verifyPrivacyReport(nestedGroups["x86_64-pc-windows-msvc"], "x86_64-pc-windows-msvc", "0.1.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("anonymized dependency paths pass the strict privacy gate on every encoding", () => {
  for (const encoding of ["utf8", "utf16le"]) {
    assert.doesNotThrow(() => assertPrivateDataAbsent(Buffer.from("/lilo-build/toolchain/.cargo/registry/src/dependency/source.rs", encoding)));
    assert.throws(() => assertPrivateDataAbsent(Buffer.from("/home/runner/.cargo/registry/src/dependency/source.rs", encoding)), /machine path/);
  }
});
