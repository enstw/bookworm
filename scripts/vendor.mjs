#!/usr/bin/env node
// Copy the browser bundles the /admin page uses from the pinned npm packages
// into public/vendor/ (gitignored). Runs automatically before `pnpm run dev`
// and `pnpm run deploy`, so the served assets always match package.json —
// Dependabot bumps a version, the next deploy ships it.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "vendor");

const BUNDLES = [
  // simplified→traditional only (1.0MB); the full bi-directional bundle is not needed
  { pkg: "opencc-js", src: "dist/esm/cn2t.js", dst: "opencc-cn2t.js" },
  // traditional→simplified, for /wasmtest's MeloTTS frontend: its lexicon
  // has simplified multi-char words, and word-level matches carry the tone
  // sandhi that per-char fallback loses
  { pkg: "opencc-js", src: "dist/esm/t2cn.js", dst: "opencc-t2cn.js" },
  { pkg: "fflate", src: "esm/browser.js", dst: "fflate.js" },
  // /wasmtest glue (small files only). The large binaries these load — the
  // huayan VITS model, piper_phonemize.data, ort-wasm-simd.wasm — are NOT
  // deployed as assets: the page fetches them from the wasmtts-assets GitHub
  // release, so the deploy stays small and files may exceed the 25 MiB
  // per-asset limit. Versions here must match that release's contents.
  { pkg: "@diffusionstudio/piper-wasm", src: "build/piper_phonemize.js", dst: "wasmtts/piper_phonemize.js" },
  { pkg: "@diffusionstudio/piper-wasm", src: "build/piper_phonemize.wasm", dst: "wasmtts/piper_phonemize.wasm" },
  // UMD build: the page's inference worker loads it via importScripts
  { pkg: "onnxruntime-web", src: "dist/ort.min.js", dst: "wasmtts/ort-umd.min.js" },
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
console.log(`✓ vendored to public/vendor/: ${Object.entries(versions).map(([p, v]) => `${p}@${v}`).join(", ")}`);
