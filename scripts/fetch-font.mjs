#!/usr/bin/env node
// Refresh public/fonts/ENSFont.woff2 from the pinned enstw/font release.
//
// The release ships TTFs only; the reader serves a woff2 conversion of
// ENSFont-Regular (full glyph set, no subsetting — the checked-in file carries
// all 36k glyphs). Conversion runs through uv's fonttools, so the only machine
// prerequisite is uv itself. Deploys never run this: the woff2 is a committed
// asset, and fonts are served cache-first from an unversioned URL — which is
// why this script also bumps SHELL in public/sw.js whenever the bytes change
// (and the shell test's golden with it): that is the half of the font rule
// that is otherwise forgotten, so it is enforced here rather than written
// down somewhere and hoped for.
//
// Renovate bumps FONT_RELEASE in the weekly roll-up and runs this script on
// the branch itself (renovate.json5's enstw/font packageRule), so the woff2,
// sw.js and the golden ride the same commit; the merge job's verifier then
// rebuilds the woff2 from the release with buildWoff2 below and refuses a
// byte that differs. fonttools and brotli are therefore PINNED: the bytes
// must come out identical on the branch and in the verifier. By hand, the
// same one command:
//
//   node scripts/fetch-font.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FONT_RELEASE = "v4.4.0_lxgw1.522_nerd3.5.0";
// the converter, pinned for reproducible bytes (see the header)
const FONTTOOLS = "fonttools[woff]==4.63.0";
const BROTLI = "brotli==1.2.0";

export const RELEASE_ASSET = "ENSFont-Regular.ttf";
export const releaseUrl = (release) => `https://github.com/enstw/font/releases/download/${release}/${RELEASE_ASSET}`;

// the woff2 bytes for a release: download its TTF, compress with the pinned
// fonttools. Pure in the sense that matters — same release, same bytes.
export async function buildWoff2(release) {
  const url = releaseUrl(release);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status} — does the release carry ${RELEASE_ASSET}?`);
  const work = mkdtempSync(join(tmpdir(), "ensfont-"));
  try {
    const ttf = join(work, RELEASE_ASSET);
    writeFileSync(ttf, Buffer.from(await res.arrayBuffer()));
    const woff2 = join(work, "ENSFont.woff2");
    execFileSync("uvx", ["--from", FONTTOOLS, "--with", BROTLI, "fonttools", "ttLib.woff2", "compress", "-o", woff2, ttf],
      { stdio: ["ignore", "inherit", "inherit"] });
    return readFileSync(woff2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// SHELL in sw.js and the golden that confirms it in test-shell-policy.mjs
// move together, by exactly one — the verifier holds the branch to this.
export function bumpShell(swText, shellTestText) {
  const m = swText.match(/const SHELL = "bw-shell-v(\d+)"/);
  if (!m) throw new Error("could not find the SHELL constant in public/sw.js — bump it by hand");
  const next = `bw-shell-v${Number(m[1]) + 1}`;
  const sw = swText.replace(m[0], `const SHELL = "${next}"`);
  const golden = shellTestText.replace(/const GOLDEN_SHELL = "bw-shell-v\d+"/, `const GOLDEN_SHELL = "${next}"`);
  if (golden === shellTestText) throw new Error("could not find GOLDEN_SHELL in scripts/test-shell-policy.mjs — bump it by hand");
  return { sw, golden, next };
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dest = join(root, "public", "fonts", "ENSFont.woff2");
  console.log(`↓ ${releaseUrl(FONT_RELEASE)}`);
  const next = await buildWoff2(FONT_RELEASE);
  let current = null;
  try { current = readFileSync(dest); } catch { /* first run on a fork */ }
  if (current && current.equals(next)) {
    console.log(`✓ ENSFont.woff2 already matches ${FONT_RELEASE} — nothing to do`);
    return;
  }
  writeFileSync(dest, next);
  // The other half of the rule: fonts are cache-first under an unversioned
  // URL, so without a SHELL bump an installed phone keeps the old glyphs
  // forever. Bump it here, atomically with the bytes.
  const swPath = join(root, "public", "sw.js");
  const shellTestPath = join(root, "scripts", "test-shell-policy.mjs");
  const bumped = bumpShell(readFileSync(swPath, "utf8"), readFileSync(shellTestPath, "utf8"));
  writeFileSync(swPath, bumped.sw);
  writeFileSync(shellTestPath, bumped.golden);
  console.log(`✓ ENSFont.woff2 ← ${FONT_RELEASE} (${(next.length / 1048576).toFixed(1)} MiB), SHELL → ${bumped.next} — commit the font, sw.js and test-shell-policy.mjs`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
