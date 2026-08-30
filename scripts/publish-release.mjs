#!/usr/bin/env node
// Put a packaged release (package-release.mjs) on GitHub, where every
// instance's updater polls `releases/latest/download/manifest.json`.
//
// Runs in the release and deploy jobs after packaging (in deploy, after
// deploy.sh has succeeded) and before the ledger moves the `released` tag —
// a release is cut only for a build that is live, and `latest` is by
// definition what upstream runs. Releases are immutable (repo setting —
// DESIGN, "Repo settings outside the tree"): a published tag's assets and
// its `latest` standing are frozen, so a commit that already has a release
// (a workflow re-run) is left exactly as it is — nothing uploaded,
// `released_at` still saying when that build was first published, the soak
// clock never reset. `latest` can never move backwards, and that is the
// point: a bad release is superseded by a new commit and a new release,
// never by re-pointing — so a re-run whose tag is no longer `latest` fails
// here rather than pretend the site and the feed agree. The test-failure-*
// records are pre-releases, which `latest` skips.
//
//   GH_TOKEN=… node scripts/publish-release.mjs out/release

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/publish-release.mjs <outDir>");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? manifest.bundle.url.match(/github\.com\/([^/]+\/[^/]+)\//)[1];
const target = process.env.GITHUB_SHA
  ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const gh = (...args) =>
  execFileSync("gh", [...args, "-R", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let exists = true;
try {
  gh("release", "view", manifest.tag, "--json", "tagName");
} catch {
  exists = false;
}

if (exists) {
  const latest = gh("release", "list", "--json", "tagName,isLatest", "--jq", ".[] | select(.isLatest) | .tagName");
  if (latest !== manifest.tag) {
    console.error(`${manifest.tag} is already published but latest is ${latest}: releases are immutable, ` +
      "latest never moves backwards — fix forward with a new commit and a new release");
    process.exit(1);
  }
  console.log(`✓ ${manifest.tag} already published — immutable, still latest, nothing to do`);
} else {
  // the one-shot bootstrap rides along (PM-10): one self-contained file an owner
  // downloads to stand up a whole instance — no fork, no Actions, no clone
  const boot = join(dir, "bootstrap.mjs");
  const assets = [join(dir, "manifest.json"), join(dir, manifest.bundle.file), ...(existsSync(boot) ? [boot] : [])];
  gh("release", "create", manifest.tag, ...assets,
    "--target", target,
    "--title", manifest.version,
    "--notes-file", join(dir, "notes.md"),
    "--latest");
  console.log(`✓ ${manifest.tag}: manifest.json + ${manifest.bundle.file} (${(manifest.bundle.size / 1048576).toFixed(1)} MB)` +
    (existsSync(boot) ? " + bootstrap.mjs" : "") + (manifest.requiresAttention ? " — requires attention" : ""));
}
console.log(`  https://github.com/${repo}/releases/latest/download/manifest.json`);
