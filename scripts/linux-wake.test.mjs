import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencyPaths } from "./prepare-linux-wake.mjs";

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
