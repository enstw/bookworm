#!/usr/bin/env node
// Copy the browser bundles the /admin page uses from the pinned npm packages
// into public/vendor/ (gitignored). Runs automatically before `pnpm run dev`
// and `pnpm run deploy`, so the served assets always match package.json —
// Renovate bumps a version, the next deploy ships it.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  // release 404s loudly. This repo does NOT pin ort (or lamejs) itself: both
  // resolve through the wasmtts git dependency (`via`), whose exact pins are
  // what upstream's release gates actually tested — the version can only move
  // together with the engine, never on its own.
  //
  // ort.wasm.min.js is the wasm-only UMD build — no webgpu code at all, which
  // is what we want: the engine runs one wasm thread and nothing else. The
  // synth worker loads it via importScripts.
  { pkg: "onnxruntime-web", via: "wasmtts", src: "dist/ort.wasm.min.js", dst: "wasmtts/ort-wasm.min.js" },
  // ort import()s this glue by URL, so unlike every other binary it cannot
  // arrive as a cached blob — it ships as a same-origin asset and rides the
  // service worker's SHELL_ASSETS to stay available offline.
  { pkg: "onnxruntime-web", via: "wasmtts", src: "dist/ort-wasm-simd-threaded.mjs", dst: "wasmtts/ort-wasm-simd-threaded.mjs" },
  // mp3 encoder for the offline TTS engine: iOS only keeps lock-screen
  // audio alive on ONE continuous ManagedMediaSource timeline, and MSE
  // does not eat WAV — the synth worker encodes each unit to mp3 frames.
  // importScripts-style global (the npm main entry has the MPEGMode bug;
  // this bundle is self-contained). LGPL-2.1 — see lamejs's LICENSE.
  { pkg: "lamejs", via: "wasmtts", src: "lame.min.js", dst: "wasmtts/lame.min.js" },
  // The Matcha engine itself, vendored whole from the wasmtts git dependency
  // (pinned in package.json, bumped by Renovate) instead of hand-copied into
  // public/ — upstream runs the release gates (FST golden, RTF, memory, ASR
  // CER) this repo cannot, and the hand-copies had already drifted both ways
  // by the time they were retired. matcha-fst.js is the JS applier the node
  // tests use as their FST oracle; the product worker runs the real kaldifst
  // wasm (matcha-kaldifst-normalizer.*, built and committed upstream).
  { pkg: "wasmtts", src: "platform/matcha-frontend.js", dst: "wasmtts/matcha-frontend.js" },
  // The taiwan reading layer: upstream's dictionary-and-ear-reviewed phrase
  // overrides and contextual rules (得/著/長/還…), plus the review ledger they
  // are compiled from. The engine loads both — the profile is part of the
  // product voice, not a diagnostic extra (owner ruling 2026-08-15).
  { pkg: "wasmtts", src: "platform/matcha-taiwan-profile.js", dst: "wasmtts/matcha-taiwan-profile.js" },
  { pkg: "wasmtts", src: "platform/matcha-g2p-review.json", dst: "wasmtts/matcha-g2p-review.json" },
  { pkg: "wasmtts", src: "platform/matcha-synthesis.js", dst: "wasmtts/matcha-synthesis.js" },
  { pkg: "wasmtts", src: "platform/matcha-fst.js", dst: "wasmtts/matcha-fst.js" },
  { pkg: "wasmtts", src: "platform/kaldifst-normalizer.js", dst: "wasmtts/kaldifst-normalizer.js" },
  { pkg: "wasmtts", src: "platform/kaldifst-wasm/dist/matcha-kaldifst-normalizer.js", dst: "wasmtts/matcha-kaldifst-normalizer.js" },
  { pkg: "wasmtts", src: "platform/kaldifst-wasm/dist/matcha-kaldifst-normalizer.wasm", dst: "wasmtts/matcha-kaldifst-normalizer.wasm" },
];

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "wasmtts"), { recursive: true });
const versions = {};
const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies;
for (const { pkg, via, src, dst } of BUNDLES) {
  // `via` resolves through that dependency's own tree (pnpm keeps a package's
  // deps as siblings of its real location in the virtual store), so the copy
  // is the version the UPSTREAM declares, not one pinned here
  const pkgDir = via
    ? join(realpathSync(join(root, "node_modules", via)), "..", pkg)
    : join(root, "node_modules", pkg);
  copyFileSync(join(pkgDir, src), join(outDir, dst));
  // the wasmtts git dependency carries no version field — record the pinned
  // spec (its release tag) so versions.json still says what shipped
  versions[pkg] = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? declared[pkg];
}
writeFileSync(join(outDir, "versions.json"), JSON.stringify(versions, null, 2) + "\n");

// The ort wasm binary's release filename and byte length, derived from the
// same tree the glue above was copied from. wasm-tts.mjs imports this instead
// of hardcoding either, and CI's sync-wasmtts-assets step uploads the binary
// under this name — so a repin that moves ort updates the manifest, the
// release and the runtime gate in one motion, with nothing to keep in step by
// hand. (Node tests that import wasm-tts.mjs therefore need vendor to have
// run first; every test entry point already does.)
const wasmttsDir = realpathSync(join(root, "node_modules", "wasmtts"));
const ortDir = join(wasmttsDir, "..", "onnxruntime-web");
const ortManifest = {
  name: `ort-${JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")).version}-wasm-simd-threaded.wasm`,
  bytes: statSync(join(ortDir, "dist", "ort-wasm-simd-threaded.wasm")).size,
};
writeFileSync(join(outDir, "wasmtts", "ort-manifest.mjs"),
  `// generated by scripts/vendor.mjs — do not edit\nexport const ORT_WASM = ${JSON.stringify(ortManifest)};\n`);

// The voice pack's file list, derived the same way from upstream's canonical
// pack definition (platform/matcha-assets.json, schemaVersion 3). packName is
// the flat name the release and /api/wasmtts serve under; upstream's
// invariant — bytes change ⇒ packName changes — is what keeps cache-first
// serving honest. wasm-tts.mjs and the worker allowlist import this instead
// of naming files, so the served pack can no longer sit on a different model
// than the engine the same pin shipped (steps-3 outliving the v1.1.0 bump
// was exactly that drift). The .fst key order is the FST application order —
// load-bearing upstream and here.
const pack = JSON.parse(readFileSync(join(wasmttsDir, "platform", "matcha-assets.json"), "utf8"));
if (pack.schemaVersion !== 3)
  throw new Error(`wasmtts matcha-assets.json schemaVersion ${pack.schemaVersion} — this vendor step understands 3`);
const packFile = ({ packName, bytes }) => ({ name: packName, bytes });
const packManifest = {
  acoustic: packFile(pack.acoustic),
  vocos: packFile(pack.vocos),
  lexicon: packFile(pack.matcha.files["lexicon.txt"]),
  tokens: packFile(pack.matcha.files["tokens.txt"]),
  rules: Object.entries(pack.matcha.files).filter(([f]) => f.endsWith(".fst")).map(([, meta]) => packFile(meta)),
};
const packNames = [packManifest.acoustic, packManifest.vocos, packManifest.lexicon, packManifest.tokens, ...packManifest.rules]
  .map((f) => f.name);
writeFileSync(join(outDir, "wasmtts", "pack-manifest.mjs"),
  `// generated by scripts/vendor.mjs — do not edit\nexport const PACK = ${JSON.stringify(packManifest)};\nexport const PACK_NAMES = ${JSON.stringify(packNames)};\n`);

// Drop anything this run did not produce. CI deploys from a fresh checkout, so
// public/vendor/ there holds exactly the BUNDLES above; a long-lived working
// copy otherwise keeps serving files from deps that were removed months ago,
// and a stale bundle that only exists locally is how "works on my machine"
// starts. Pruning makes the two match.
const keep = new Set([...BUNDLES.map(({ dst }) => dst), "versions.json", "wasmtts/ort-manifest.mjs", "wasmtts/pack-manifest.mjs"]);
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
