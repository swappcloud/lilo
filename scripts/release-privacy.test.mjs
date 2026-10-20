import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { privacyBuildEnvironment, assertPrivateDataAbsent, discoverTargetArtifacts, verifyPrivacyReport } from "./release-privacy.mjs";

const msvcHost = process.platform === "win32" && execFileSync("rustc", ["-vV"], { encoding: "utf8" }).includes("host: x86_64-pc-windows-msvc");

test("MSVC linker records a portable PDB name and GNU targets retain their linker flags", () => {
  const env = privacyBuildEnvironment({}, "C:\\Users\\Builder", "D:\\project", "win32", "x86_64-pc-windows-msvc");
  const flags = env.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.ok(flags.includes("strip=debuginfo"));
  assert.ok(flags.includes("link-arg=/PDBALTPATH:lilo.pdb"));
  assert.ok(flags.includes("--remap-path-prefix=C:/Users/Builder=/lilo-build/toolchain"));
  assert.ok(flags.includes("--remap-path-prefix=D:/project=/lilo-build/project"));
  assert.ok(flags.includes(String.raw`--remap-path-prefix=\\?\C:\Users\Builder=/lilo-build/toolchain`));
  assert.ok(flags.includes("--remap-path-prefix=//?/D:/project=/lilo-build/project"));
  const gnu = privacyBuildEnvironment({}, "home", "root", "win32", "x86_64-pc-windows-gnu");
  assert.ok(!gnu.CARGO_ENCODED_RUSTFLAGS.includes("strip=debuginfo"));
  assert.ok(!gnu.CARGO_ENCODED_RUSTFLAGS.includes("PDBALTPATH"));
});

test("Windows release binary contains no local PDB path", { skip: !msvcHost }, () => {
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
  assert.equal(privacyBuildEnvironment({ CFLAGS: "existing" }, "home", "root", "darwin").CFLAGS, "existing");
});

test("Windows native compiler remaps source literals while preserving user flags", () => {
  const env = privacyBuildEnvironment({ CFLAGS: "/O2", CFLAGS_x86_64_pc_windows_msvc: "/W3" }, "C:\\Users\\Build User", "D:\\Build Root", "win32", "x86_64-pc-windows-msvc");
  assert.equal(env.CC_SHELL_ESCAPED_FLAGS, "1");
  assert.equal(env.CFLAGS, "/O2");
  assert.equal(env.CFLAGS_x86_64_pc_windows_msvc, '/W3 /experimental:deterministic "/pathmap:D:\\Build Root=/lilo-build/project" "/pathmap:C:\\Users\\Build User=/lilo-build/toolchain"');
  const gnu = privacyBuildEnvironment({ CFLAGS: "existing" }, "home", "root", "win32", "x86_64-pc-windows-gnu");
  assert.equal(gnu.CFLAGS, "existing");
});

test("MSVC native source literals pass the release privacy gate", { skip: !msvcHost && !process.env.LILO_MSVC_CL }, () => {
  mkdirSync(".tmp", { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "native privacy "));
  try {
    const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const compiler = process.env.LILO_MSVC_CL || execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-find", "VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    assert.ok(compiler, "MSVC compiler is required for the native release privacy regression");
    const source = join(directory, "source.c");
    const object = join(directory, "fixture.obj");
    writeFileSync(source, '#define WIDEN_IMPL(x) L##x\n#define WIDEN(x) WIDEN_IMPL(x)\nconst char *fixture(void) { return __FILE__; }\nconst unsigned short *wide_fixture(void) { return WIDEN(__FILE__); }\n');
    // Match cc-rs: an absolute source path, with no Rust involved.
    execFileSync(compiler, ["/nologo", "/c", source, `/Fo${object}`]);
    assert.throws(() => assertPrivateDataAbsent(readFileSync(object), [directory]), /machine path/);
    const env = privacyBuildEnvironment({}, undefined, directory, "win32", "x86_64-pc-windows-msvc");
    const mappings = [...env.CFLAGS_x86_64_pc_windows_msvc.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    execFileSync(compiler, ["/nologo", "/c", "/experimental:deterministic", ...mappings, source, `/Fo${object}`]);
    const bytes = readFileSync(object);
    assertPrivateDataAbsent(bytes, [directory]);
    assert.ok(bytes.includes(Buffer.from("/lilo-build/project")));
    assert.ok(bytes.includes(Buffer.from("/lilo-build/project", "utf16le")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
