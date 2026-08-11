#!/usr/bin/env node
// Prepend the just-shipped release to RELEASES.md. CI runs this at the end of
// the deploy job (after deploy.sh): the entry lists every commit since the
// `released` tag, newest first; the workflow step then commits the file,
// pushes, and moves the tag onto the DEPLOYED commit ($GITHUB_SHA), not the
// docs commit — so anything that lands on main while a deploy is in flight
// stays inside the next deploy's range. The ledger's own "docs: record
// release" commits are filtered out of entries instead. No tag yet (first
// run, or a local dry run) → the entry covers just HEAD and the ledger
// starts there.
//
// Writing an unchanged file is skipped, so a redeploy of the same SHA is a
// no-op and the workflow's diff check finds nothing to commit.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const hasTag = git("tag", "--list", "released") !== "";
const lines = git("log", "--pretty=format:%h %s", hasTag ? "released..HEAD" : "-1")
  .split("\n")
  .filter(Boolean)
  .filter((l) => !/^\S+ docs: record release /.test(l));
if (lines.length === 0) {
  console.log("✓ nothing shipped since the released tag — RELEASES.md unchanged");
  process.exit(0);
}

const head = git("rev-parse", "--short=12", "HEAD");
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const items = lines.map((l) => {
  const [sha, ...subject] = l.split(" ");
  return `- ${subject.join(" ")} (\`${sha}\`)`;
});
const entry = `## ${date} — \`${head}\`\n\n${items.join("\n")}\n`;

const header = `# Releases

One entry per green deploy — the commits that went live, newest first. Written
by scripts/update-releases.mjs from the deploy workflow; the \`released\` tag
marks the last deployed commit. Do not edit entries by hand.

`;
const file = join(root, "RELEASES.md");
let rest = "";
if (existsSync(file)) {
  const current = readFileSync(file, "utf8");
  const firstEntry = current.indexOf("\n## ");
  rest = firstEntry === -1 ? "" : "\n" + current.slice(firstEntry + 1);
}
writeFileSync(file, header + entry + rest);
console.log(`✓ RELEASES.md: ${date} — ${head}, ${lines.length} commit(s)`);
