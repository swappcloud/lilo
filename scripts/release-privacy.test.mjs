import assert from "node:assert/strict";
import { test } from "node:test";
import { privacyBuildEnvironment, assertPrivateDataAbsent } from "./release-privacy.mjs";

test("compiler privacy preserves flags and handles paths containing spaces", () => {
  const env = privacyBuildEnvironment({ RUSTFLAGS: "-C debuginfo=0" }, "/Users/Build User", "/Users/Build User/project");
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
      assert.equal(error.message, "Release privacy check failed: machine path");
      assert.ok(!error.message.includes("Build User"));
      return true;
    });
  }
  assert.doesNotThrow(() => assertPrivateDataAbsent(Buffer.from("/lilo-build/project/source.rs"), ["/Users/Build User"]));
});

test("privacy gate rejects credentials and personal email addresses", () => {
  const fixtures = ["-----BEGIN PRIVATE KEY-----", "ghp_" + "x".repeat(36), "sk-proj-" + "x".repeat(48), ["private-user", "gmail.com"].join("@")];
  for (const value of fixtures) assert.throws(() => assertPrivateDataAbsent(Buffer.from(value), []), /Release privacy check failed/);
});

test("privacy gate allows public signing material and platform paths", () => {
  assert.doesNotThrow(() => assertPrivateDataAbsent(Buffer.from("/System/Library/Frameworks RWQpublic-updater-key com.lilo.app"), []));
});


test("anonymized dependency paths pass the strict privacy gate on every encoding", () => {
  for (const encoding of ["utf8", "utf16le"]) {
    assert.doesNotThrow(() => assertPrivateDataAbsent(Buffer.from("/lilo-build/toolchain/.cargo/registry/src/dependency/source.rs", encoding)));
    assert.throws(() => assertPrivateDataAbsent(Buffer.from("/home/runner/.cargo/registry/src/dependency/source.rs", encoding)), /machine path/);
  }
});
