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
// The `> ` lines under each heading are what a READER is told (see
// release-notes.mjs); the `- ` lines below them stay the commit ledger. Both
// come from the same module gen-release-notes.mjs uses before the deploy, so
// the file and the shipped JSON cannot drift apart.
//
// Writing an unchanged file is skipped, so a redeploy of the same SHA is a
// no-op and the workflow's diff check finds nothing to commit.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pendingRelease, renderEntry, root } from "./release-notes.mjs";

const release = pendingRelease();
if (release.empty) {
  console.log("✓ nothing shipped since the released tag — RELEASES.md unchanged");
  process.exit(0);
}

// the same text the GitHub release body carries (package-release.mjs)
const entry = renderEntry(release);

const header = `# Releases

One entry per green deploy — the commits that went live, newest first. Written
by scripts/update-releases.mjs from the deploy workflow; the \`released\` tag
marks the last deployed commit. Do not edit entries by hand.

The \`>\` lines are the reader-facing notes, taken from each commit's
\`Release-Note:\` trailer plus the release's dependency bumps. A release with
none says nothing to readers — which is the intended outcome for a week of
pure CI work.

`;
const file = join(root, "RELEASES.md");
let rest = "";
if (existsSync(file)) {
  const current = readFileSync(file, "utf8");
  const firstEntry = current.indexOf("\n## ");
  rest = firstEntry === -1 ? "" : "\n" + current.slice(firstEntry + 1);
}
writeFileSync(file, header + entry + rest);
console.log(
  `✓ RELEASES.md: ${release.date} — ${release.build}, ` +
  `${release.commits.length} commit(s), ${release.notes.length} reader note(s)`,
);
