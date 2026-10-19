/** Package the Linux recognizer, model, capture tool and redistribution notices. */
import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function dependencyPaths(output) {
  if (/not found/.test(output)) throw new Error("A Linux wake runtime library is missing.");
  return [...new Set([...output.matchAll(/=>\s+(\/[^\s]+)|^\s*(\/[^\s]+)/gm)]
    .map(match => match[1] ?? match[2])
    .filter(path => !/\/(?:libc\.so|libm\.so|ld-linux|ld64)/.test(path)))];
}

export function prepareLinuxWake(root, { model = "/usr/share/pocketsphinx/model/en-us", capture = "/usr/bin/parec" } = {}) {
  const output = join(root, ".tmp", "linux-wake");
  if (!existsSync(join(model, "en-us")) || !existsSync(join(model, "cmudict-en-us.dict")) || !existsSync(capture)) {
    throw new Error("Linux wake build packages are missing. Run the repository setup before building.");
  }
  const cache = execFileSync("ldconfig", ["-p"], { encoding: "utf8" });
  const libraries = ["libpocketsphinx.so.3", "libsphinxbase.so.3"].map(name => {
    const line = cache.split("\n").find(line => line.trim().startsWith(`${name} `));
    if (!line) throw new Error(`Missing Linux wake library: ${name}`);
    return line.split("=>")[1].trim();
  });
  for (const directory of ["model", "bin", "lib", "licenses"]) mkdirSync(join(output, directory), { recursive: true });
  cpSync(join(model, "en-us"), join(output, "model", "en-us"), { recursive: true });
  copyFileSync(join(model, "cmudict-en-us.dict"), join(output, "model", "cmudict-en-us.dict"));
  copyFileSync(capture, join(output, "bin", "parec"));
  const all = new Set(libraries);
  for (const file of [...libraries, capture]) {
    for (const path of dependencyPaths(execFileSync("ldd", [file], { encoding: "utf8" }))) all.add(path);
  }
  const files = {};
  for (const path of all) {
    const name = basename(path);
    copyFileSync(realpathSync(path), join(output, "lib", name));
    files[`/usr/lib/${name}`] = `../.tmp/linux-wake/lib/${name}`;
  }
  // Keep package copyright files with redistributed native libraries and models.
  const packages = new Set(["pocketsphinx-en-us", "pulseaudio-utils"]);
  for (const path of all) {
    const ownership = execFileSync("dpkg-query", ["-S", realpathSync(path)], { encoding: "utf8" });
    for (const line of ownership.trim().split("\n")) packages.add(line.split(": ")[0].split(":")[0]);
  }
  for (const name of packages) {
    const notice = `/usr/share/doc/${name}/copyright`;
    if (!existsSync(notice)) throw new Error(`Missing Linux wake redistribution notice: ${name}`);
    copyFileSync(notice, join(output, "licenses", `${name}.copyright`));
  }
  const config = { bundle: { resources: { "../.tmp/linux-wake/": "wake/linux/" }, linux: {
    deb: { depends: ["libpocketsphinx3", "libsphinxbase3", "pulseaudio-utils"] }, appimage: { files },
  } } };
  writeFileSync(join(root, ".tmp", "tauri-linux-wake.conf.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.platform !== "linux") throw new Error("Linux wake packaging must run on Linux.");
  prepareLinuxWake(dirname(dirname(fileURLToPath(import.meta.url))));
  console.log("Linux wake model, libraries and license notices prepared.");
}
