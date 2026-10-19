/** Release notes are maintained with the code, then frozen at a version bump. */
function section(text, name) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`Missing changelog section: ${name}`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return { lines, start, end, body: lines.slice(start + 1, end).join("\n").trim() };
}

export function releaseChanges(text, version) {
  const { body } = section(text, version);
  if (!/^\s*- \S/m.test(body)) throw new Error(`No release changes recorded for ${version}`);
  return body;
}

export function freezeChanges(text, version, date = new Date().toISOString().slice(0, 10)) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid changelog version or date");
  if (text.includes(`## [${version}]`)) throw new Error(`Changelog already contains ${version}`);
  const { lines, start, end, body } = section(text, "Unreleased");
  if (!/^\s*- \S/m.test(body)) throw new Error("Describe this release in CHANGELOG.md before bumping the version");
  return [...lines.slice(0, start), "## [Unreleased]", "", `## [${version}] - ${date}`, "", body, "", ...lines.slice(end)].join("\n");
}
