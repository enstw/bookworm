// What a release says to a READER, as opposed to what it says to git.
//
// RELEASES.md has always listed commit subjects — "ci: pin every action to a
// commit digest" — which is the right ledger and the wrong sentence to put in
// front of someone who came here to read a novel. So the reader-facing line is
// written at ship time by whoever ships, in the commit itself:
//
//   reader: pull the bookmark again in the background
//
//   <the usual body>
//
//   Release-Note: 離線開機後連上網，書籤會自己補回來
//
// No summariser is involved and none is wanted: the person (or agent) making
// the change is the one who knows what it means, and they know it then, not
// later. A commit with no trailer contributes nothing — which is how a CI or
// refactor commit stays out of a reader's face without anyone filtering it.
//
// Upstream bumps are the other half and need no prose at all: the version
// numbers ARE the note, so they are read straight out of the package.json (and
// the font pin) diff across the release. That also means a roll-up week says
// something true even though renovate writes one commit subject for the lot.
//
// Both consumers use this module, so the ledger and the shipped JSON can never
// disagree: update-releases.mjs writes RELEASES.md after a green deploy, and
// gen-release-notes.mjs writes public/releases.json before one.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// cwd is a parameter only so the suite can build a throwaway repo with known
// commits and pin the trailer/bump parsing against it; every caller in the
// deploy path uses the default.
// stderr is piped rather than inherited: the misses below are expected (no
// `released` tag on a first run, no fetch-font.mjs in a synthetic repo), and
// execFileSync would otherwise forward git's "fatal:" to the deploy log, where
// an expected miss reads exactly like a broken step.
const gitIn = (cwd) => (...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const orNull = (fn) => (...args) => {
  try { return fn(...args); } catch { return null; }
};

// The pinned versions a reader might notice, read out of one commit's tree.
// devDependencies is where every runtime pin lives (there are no runtime deps
// by rule), and the font is a plain const in a script — the same two places
// renovate is configured to watch.
function pinsAt(gitOrNull, ref) {
  const pins = {};
  const pkg = gitOrNull("show", `${ref}:package.json`);
  if (pkg) {
    let parsed;
    try { parsed = JSON.parse(pkg); } catch { parsed = null; }
    for (const [name, spec] of Object.entries(parsed?.devDependencies ?? {})) {
      // github:enstw/wasmtts#v1.0.0 → v1.0.0; a plain pin is already the version
      pins[name] = spec.includes("#") ? spec.slice(spec.lastIndexOf("#") + 1) : spec;
    }
  }
  const font = gitOrNull("show", `${ref}:scripts/fetch-font.mjs`);
  const m = font?.match(/const FONT_RELEASE = "([^"]+)"/);
  if (m) pins["ENSFont"] = m[1];
  return pins;
}

function bumps(gitOrNull, from, to) {
  if (!from) return []; // no baseline (first ever release): nothing to compare
  const before = pinsAt(gitOrNull, from);
  const after = pinsAt(gitOrNull, to);
  const out = [];
  for (const [name, version] of Object.entries(after)) {
    if (!(name in before)) out.push(`${name} ${version}`);
    else if (before[name] !== version) out.push(`${name} ${before[name]} → ${version}`);
  }
  return out.sort();
}

// The release about to ship (or just shipped): every commit since the
// `released` tag, plus what a reader is told about them.
export function pendingRelease(cwd = root) {
  const git = gitIn(cwd);
  const gitOrNull = orNull(git);
  const from = gitOrNull("rev-parse", "--verify", "released^{commit}");
  const lines = git("log", "--pretty=format:%h %s", from ? "released..HEAD" : "-1")
    .split("\n")
    .filter(Boolean)
    // the ledger's own commits are bookkeeping, never part of what shipped
    .filter((l) => !/^\S+ docs: record release /.test(l));
  const shas = lines.map((l) => l.split(" ")[0]);
  const notes = [];
  for (const sha of shas) {
    // The whole body is scanned rather than asked for with
    // %(trailers:key=Release-Note): git counts only the LAST paragraph as the
    // trailer block, so a note with a blank line between it and the
    // Co-Authored-By below it is invisible to that — and invisible SILENTLY,
    // which is the one failure this must not have. A line is a note if it
    // says it is, wherever the author put it.
    const body = gitOrNull("show", "-s", "--pretty=format:%B", sha) ?? "";
    for (const line of body.split("\n")) {
      // Column 0, no leading space — a commit that TALKS about the convention
      // indents its example, and this scraped exactly that out of its own
      // message the first time it ran. An indented line is prose about a
      // note; a note starts the line.
      const m = line.match(/^Release-Note:[ \t]*(.+?)\s*$/);
      if (m) notes.push(m[1]);
    }
  }
  notes.push(...bumps(gitOrNull, from, "HEAD"));
  return {
    build: git("rev-parse", "--short=12", "HEAD"),
    // The COMMIT's date, not this process's. Two callers run at different
    // moments — gen-release-notes.mjs before the deploy, update-releases.mjs
    // after it — so a wall clock lets a deploy that crosses midnight in
    // Asia/Taipei ship a releases.json dated a day off its own ledger entry,
    // which is exactly the disagreement the header above promises cannot
    // happen. It also keeps the shipped bytes re-derivable from the commit.
    date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" })
      .format(new Date(git("log", "-1", "--format=%cI", "HEAD"))),
    commits: lines,
    notes,
    empty: lines.length === 0,
  };
}

// Past releases, read back out of the ledger. Reader notes are the `> ` lines
// under a heading — one place they are both human-legible in the file and
// machine-legible here, so the shipped JSON needs no second source of truth.
export function ledgerHistory(cwd = root) {
  const file = join(cwd, "RELEASES.md");
  if (!existsSync(file)) return [];
  const out = [];
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const head = line.match(/^## (\S+) — `([0-9a-f]+)`/);
    if (head) {
      current = { date: head[1], build: head[2], notes: [] };
      out.push(current);
      continue;
    }
    const note = line.match(/^> (.+)$/);
    if (note && current) current.notes.push(note[1].trim());
  }
  return out;
}
