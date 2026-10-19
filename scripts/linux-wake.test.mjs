import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyPaths, licensePackageNames } from "./prepare-linux-wake.mjs";

test("Linux wake packaging includes native dependencies without bundling the host C ABI", () => {
  assert.deepEqual(dependencyPaths(`
    libsphinxbase.so.3 => /usr/lib/libsphinxbase.so.3 (0x123)
    libpulsecommon-16.1.so => /usr/lib/pulseaudio/libpulsecommon-16.1.so (0x345)
    libc.so.6 => /usr/lib/libc.so.6 (0x456)
    libm.so.6 => /usr/lib/libm.so.6 (0x789)
    /lib64/ld-linux-x86-64.so.2 (0x321)
  `), ["/usr/lib/libsphinxbase.so.3", "/usr/lib/pulseaudio/libpulsecommon-16.1.so"]);
  assert.throws(() => dependencyPaths("libpocketsphinx.so.3 => not found"), /missing/);
});

test("Linux wake packaging finds package owners across merged usr library paths", () => {
  const packages = licensePackageNames(["/usr/lib/libgcc_s.so.1", "/lib/libdbus-1.so.3"], (path) => {
    if (path === "/lib/libgcc_s.so.1") return "libgcc-s1:amd64: /lib/libgcc_s.so.1";
    if (path === "/usr/lib/libdbus-1.so.3") return "libdbus-1-3:amd64: /usr/lib/libdbus-1.so.3";
    throw new Error("package owner not found");
  });
  assert.ok(packages.has("libgcc-s1"));
  assert.ok(packages.has("libdbus-1-3"));
  assert.throws(
    () => licensePackageNames(["/usr/lib/libunknown.so"], () => { throw new Error("package owner not found"); }),
    /package owner not found/,
  );
});
