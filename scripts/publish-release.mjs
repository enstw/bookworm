#!/usr/bin/env node
// Put a packaged release (package-release.mjs) on GitHub, where every
// instance's updater polls `releases/latest/download/manifest.json`.
//
// Runs in the deploy job after deploy.sh has succeeded and before the ledger
// moves the `released` tag — a release is cut only for a build that is
// live, and `latest` is by definition what upstream runs. A tag is one
// commit forever: redeploying a commit that already has a release (a
// workflow re-run, a rollback) re-points `latest` at it and uploads
// nothing, so `released_at` keeps saying when that build was first
// published and the soak clock is never reset by a re-run. The
// test-failure-* records are pre-releases, which `latest` skips.
//
//   GH_TOKEN=… node scripts/publish-release.mjs out/release

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  gh("release", "edit", manifest.tag, "--latest", "--prerelease=false");
  console.log(`✓ ${manifest.tag} already published — re-pointed latest at it, assets untouched`);
} else {
  gh("release", "create", manifest.tag,
    join(dir, "manifest.json"), join(dir, manifest.bundle.file),
    "--target", target,
    "--title", manifest.version,
    "--notes-file", join(dir, "notes.md"),
    "--latest");
  console.log(`✓ ${manifest.tag}: manifest.json + ${manifest.bundle.file} (${(manifest.bundle.size / 1048576).toFixed(1)} MB)` +
    (manifest.requiresAttention ? " — requires attention" : ""));
}
console.log(`  https://github.com/${repo}/releases/latest/download/manifest.json`);
