#!/usr/bin/env node
// The build stamp — "<short sha> · <YYYY-MM-DD HH:MM>" in Asia/Taipei — in
// exactly one place. deploy.sh seds it into public/app.js and src/worker.js
// (where /api/version and checkVersion read it), and package-release.mjs
// writes it into the release manifest as `version`; the updater decides
// "differs?" by comparing the two strings verbatim, so a second formula
// anywhere would be a silent fleet-wide "update available" forever.
//
// The time is the COMMIT's, never the clock's: the stamp is baked into
// app.js, which ships as an asset, so a wall clock would give the same commit
// a different hash every minute and nobody could re-derive the artifact from
// the source. Asia/Taipei because the string is read off the shelf by a
// reader whose day is +8 — a bare UTC date can point at yesterday's deploy.
//
//   node scripts/build-id.mjs [ref]     # prints the stamp for HEAD (or ref)

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function buildId(ref = "HEAD", cwd = root) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sha = git("rev-parse", "--short", ref);
  const when = git("log", "-1", "--format=%cI", ref);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(when)).map((p) => [p.type, p.value]),
  );
  return `${sha} · ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(buildId(process.argv[2] ?? "HEAD") + "\n");
}
