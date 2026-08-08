#!/usr/bin/env node
// Copy the browser bundles the /admin page uses from the pinned npm packages
// into public/vendor/ (gitignored). Runs automatically before `pnpm run dev`
// and `pnpm run deploy`, so the served assets always match package.json —
// Dependabot bumps a version, the next deploy ships it.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "vendor");

const BUNDLES = [
  // simplified→traditional only (1.0MB); the full bi-directional bundle is not needed
  { pkg: "opencc-js", src: "dist/esm/cn2t.js", dst: "opencc-cn2t.js" },
  { pkg: "fflate", src: "esm/browser.js", dst: "fflate.js" },
  // Offline TTS glue (small files only). The binaries these load — the two
  // Matcha ONNX models, the lexicon, and ort's own 13.5MB wasm — are NOT
  // deployed as assets: the page fetches them from the wasmtts-assets GitHub
  // release, so the deploy stays small and files may exceed the 25 MiB
  // per-asset limit. Versions here must match that release's contents: ort's
  // release filename carries its version, so a bump that forgets to re-cut the
  // release 404s loudly. The pin is exact (no ^) because the wasm's byte length
  // is asserted in wasm-tts.mjs — a floating range would break the engine on a
  // routine lockfile refresh.
  //
  // ort.wasm.min.js is the wasm-only UMD build — no webgpu code at all, which
  // is what we want: the engine runs one wasm thread and nothing else. The
  // synth worker loads it via importScripts.
  { pkg: "onnxruntime-web", src: "dist/ort.wasm.min.js", dst: "wasmtts/ort-wasm.min.js" },
  // ort import()s this glue by URL, so unlike every other binary it cannot
  // arrive as a cached blob — it ships as a same-origin asset and rides the
  // service worker's SHELL_ASSETS to stay available offline.
  { pkg: "onnxruntime-web", src: "dist/ort-wasm-simd-threaded.mjs", dst: "wasmtts/ort-wasm-simd-threaded.mjs" },
  // mp3 encoder for the offline TTS engine: iOS only keeps lock-screen
  // audio alive on ONE continuous ManagedMediaSource timeline, and MSE
  // does not eat WAV — the synth worker encodes each unit to mp3 frames.
  // importScripts-style global (the npm main entry has the MPEGMode bug;
  // this bundle is self-contained). LGPL-2.1 — see node_modules/lamejs/LICENSE.
  { pkg: "lamejs", src: "lame.min.js", dst: "wasmtts/lame.min.js" },
];

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "wasmtts"), { recursive: true });
const versions = {};
for (const { pkg, src, dst } of BUNDLES) {
  const pkgDir = join(root, "node_modules", pkg);
  copyFileSync(join(pkgDir, src), join(outDir, dst));
  versions[pkg] = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
}
writeFileSync(join(outDir, "versions.json"), JSON.stringify(versions, null, 2) + "\n");

// Drop anything this run did not produce. CI deploys from a fresh checkout, so
// public/vendor/ there holds exactly the BUNDLES above; a long-lived working
// copy otherwise keeps serving files from deps that were removed months ago,
// and a stale bundle that only exists locally is how "works on my machine"
// starts. Pruning makes the two match.
const keep = new Set([...BUNDLES.map(({ dst }) => dst), "versions.json"]);
const stale = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    else if (!keep.has(relative(outDir, abs))) { rmSync(abs); stale.push(relative(outDir, abs)); }
  }
};
walk(outDir);

console.log(`✓ vendored to public/vendor/: ${Object.entries(versions).map(([p, v]) => `${p}@${v}`).join(", ")}`);
if (stale.length) console.log(`  pruned ${stale.length} stale file(s): ${stale.join(", ")}`);
