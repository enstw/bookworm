#!/usr/bin/env node
// Refresh public/fonts/ENSFont.woff2 from the pinned enstw/font release.
//
// The release ships TTFs only; the reader serves a woff2 conversion of
// ENSFont-Regular (full glyph set, no subsetting — the checked-in file carries
// all 36k glyphs). Conversion runs through uv's fonttools, so the only machine
// prerequisite is uv itself. Deploys never run this: the woff2 is a committed
// asset, and fonts are served cache-first from an unversioned URL — which is
// why this script also bumps SHELL in public/sw.js whenever the bytes change:
// that is the half of the font rule that is otherwise forgotten, so it is
// enforced here rather than written down somewhere and hoped for.
//
// Renovate bumps FONT_RELEASE when enstw/font publishes (see renovate.json);
// the bump PR does NOT regenerate the woff2 — run this script on the bump
// branch and commit both the font and sw.js:
//
//   node scripts/fetch-font.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FONT_RELEASE = "v4.4.0_lxgw1.522_nerd3.5.0";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "fonts", "ENSFont.woff2");
const work = mkdtempSync(join(tmpdir(), "ensfont-"));

try {
  const url = `https://github.com/enstw/font/releases/download/${FONT_RELEASE}/ENSFont-Regular.ttf`;
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status} — does the release carry ENSFont-Regular.ttf?`);
  const ttf = join(work, "ENSFont-Regular.ttf");
  writeFileSync(ttf, Buffer.from(await res.arrayBuffer()));

  const woff2 = join(work, "ENSFont.woff2");
  execFileSync("uvx", ["--from", "fonttools[woff]", "fonttools", "ttLib.woff2", "compress", "-o", woff2, ttf],
    { stdio: "inherit" });

  const next = readFileSync(woff2);
  let current = null;
  try { current = readFileSync(dest); } catch { /* first run on a fork */ }
  if (current && current.equals(next)) {
    console.log(`✓ ENSFont.woff2 already matches ${FONT_RELEASE} — nothing to do`);
    process.exit(0);
  }

  writeFileSync(dest, next);
  // The other half of the rule: fonts are cache-first under an unversioned
  // URL, so without a SHELL bump an installed phone keeps the old glyphs
  // forever. Bump it here, atomically with the bytes.
  const swPath = join(root, "public", "sw.js");
  const sw = readFileSync(swPath, "utf8");
  const bumped = sw.replace(/const SHELL = "bw-shell-v(\d+)"/, (_, n) => `const SHELL = "bw-shell-v${Number(n) + 1}"`);
  if (bumped === sw) throw new Error("could not find the SHELL constant in public/sw.js — bump it by hand");
  writeFileSync(swPath, bumped);

  console.log(`✓ ENSFont.woff2 ← ${FONT_RELEASE} (${(next.length / 1048576).toFixed(1)} MiB), SHELL bumped — commit both files`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
