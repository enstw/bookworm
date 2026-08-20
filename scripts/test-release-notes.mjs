// Unit test for the reader-facing release notes (scripts/release-notes.mjs).
//
// Pure node, no server, no browser: it builds a throwaway git repo in a temp
// dir with commits it controls, so the trailer parsing and the dependency-bump
// diff are pinned against known history rather than against whatever this
// repo's log happens to look like this week.
//
//   node scripts/test-release-notes.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerHistory, pendingRelease } from "./release-notes.mjs";

const repo = mkdtempSync(join(tmpdir(), "bw-relnotes-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const gitEnv = (env, ...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } }).trim();
const write = (name, body) => writeFileSync(join(repo, name), body);
const pkg = (deps) => write("package.json", JSON.stringify({ devDependencies: deps }, null, 2));
// `when` (an ISO instant) pins the commit's dates, so a test can assert what
// the release date is derived FROM rather than what today happens to be.
const commit = (message, when) => {
  git("add", "-A");
  const env = when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {};
  gitEnv(env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
};

const out = {};
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  out[name] = a === e ? "ok" : `FAIL got ${a}, want ${e}`;
};

try {
  git("init", "-q", "-b", "main");

  // the baseline release: one commit, tagged `released`
  pkg({ wrangler: "4.120.0", wasmtts: "github:enstw/wasmtts#v1.0.0" });
  write("RELEASES.md", "# Releases\n\nblurb\n\n## 2026-08-01 — `aaaaaaaaaaaa`\n\n> 舊的人話說明\n\n- old: thing (`aaaaaaa`)\n");
  writeFileSync(join(repo, "scripts-fetch-font.placeholder"), "");
  commit("chore: baseline");
  git("tag", "released");

  // a shipped change that speaks to readers, and one that does not
  write("a.txt", "x");
  commit("reader: something\n\nbody here\n\nRelease-Note: 離線後連上網會自己補書籤");
  write("b.txt", "x");
  commit("ci: tighten a workflow");
  // the trap this must survive: git counts only the LAST paragraph as the
  // trailer block, so a note with a Co-Authored-By in a paragraph of its own
  // below it is invisible to %(trailers:…) — and invisible silently
  write("b2.txt", "x");
  commit("reader: another thing\n\nbody\n\nRelease-Note: 分開段落的說明也要看得到\n\nCo-Authored-By: Someone <s@example.com>");
  // the ledger's own bookkeeping must never count as shipped work
  write("c.txt", "x");
  commit("docs: record release deadbeefcafe");
  // a commit that documents the convention indents its example — which is
  // prose about a note, not a note. (Found the hard way: the first real run
  // of this scraped the example out of its own commit message.)
  write("b3.txt", "x");
  commit("docs: explain the convention\n\nWrite it like this:\n\n    Release-Note: THIS-IS-AN-EXAMPLE\n");
  // an upstream bump: the version numbers are the note, no prose needed
  pkg({ wrangler: "4.121.0", wasmtts: "github:enstw/wasmtts#v1.1.0", fflate: "0.8.3" });
  commit("chore(deps): update weekly upstream roll-up");

  const r = pendingRelease(repo);

  eq("commitsCounted", r.commits.length, 5); // the docs: record release one is dropped
  out.ledgerCommitDropped = r.commits.some((l) => l.includes("docs: record release"))
    ? "FAIL the ledger's own commit was counted as shipped"
    : "ok";
  eq("trailer", r.notes.filter((n) => n.includes("補書籤")), ["離線後連上網會自己補書籤"]);
  eq("trailerAboveOtherParagraph", r.notes.filter((n) => n.includes("分開段落")),
    ["分開段落的說明也要看得到"]);
  out.coAuthorNotANote = r.notes.some((n) => /example\.com/.test(n))
    ? "FAIL: a Co-Authored-By leaked into the reader's notes" : "ok";
  out.indentedExampleIgnored = r.notes.some((n) => n.includes("THIS-IS-AN-EXAMPLE"))
    ? "FAIL: an indented example was read as a real note" : "ok";
  out.untrailedSilent = r.notes.some((n) => n.includes("tighten a workflow"))
    ? "FAIL a commit with no trailer reached the reader"
    : "ok";
  eq("bumps", r.notes.filter((n) => /→|^fflate/.test(n)), [
    "fflate 0.8.3",
    "wasmtts v1.0.0 → v1.1.0",
    "wrangler 4.120.0 → 4.121.0",
  ]);

  // the ledger's own past notes are readable back out of the markdown, which
  // is what lets the shipped JSON carry history without a second source
  const history = ledgerHistory(repo);
  eq("historyBuilds", history.map((h) => h.build), ["aaaaaaaaaaaa"]);
  eq("historyNotes", history[0]?.notes, ["舊的人話說明"]);

  // a release that shipped only untrailed work says nothing at all — the
  // whole point: a CI week must not put "ci: ..." in front of a reader
  git("tag", "-f", "released");
  write("d.txt", "x");
  commit("ci: another workflow tweak");
  eq("quietRelease", pendingRelease(repo).notes, []);

  // The date belongs to the commit, not to the clock this runs on. Two things
  // rest on it: public/releases.json ships as an asset, so a wall clock gives
  // the same commit a different hash every day and nobody can re-derive the
  // artifact; and the two callers run either side of the deploy, so a wall
  // clock lets a deploy crossing midnight date the JSON a day off its own
  // ledger entry. The instant below is 23:30 UTC — already the NEXT day in
  // Asia/Taipei — so one assertion pins the source AND the timezone.
  git("tag", "-f", "released");
  write("e.txt", "x");
  commit("reader: dated\n\nRelease-Note: x", "2020-01-02T23:30:00+00:00");
  eq("dateFromCommitNotClock", pendingRelease(repo).date, "2020-01-03");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
