#!/usr/bin/env node
// Fill a local weights directory (default ~/.cache/bookworm-matcha) with the
// voice-pack files the gated suites need — tts-wasm, and the
// MATCHA_MODEL_DIR/MATCHA_FST_DIR halves of wasm-frontend / matcha-fst.
// Everything downloads from the pins in the wasmtts engine's
// matcha-assets.json and is SHA-256-verified before it lands; a file that
// already verifies is skipped, so re-runs are cheap. The compiled lexicon is
// not fetched here: it ships in the engine tarball, which wasmtts-pin.mjs
// already holds under node_modules/.cache/wasmtts-engine/<tag>/. Never point
// the suites at a live wasmtts checkout instead — a working tree's models are
// mutable owner state (see DESIGN.md's working agreements).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureEngine, packEntries, readAssets, sha256 } from "./wasmtts-pin.mjs";

const dir = process.argv[2] ?? join(homedir(), ".cache", "bookworm-matcha");

const engine = await ensureEngine();
// the upstream-hosted half of the pack; the lexicon (tarball) and ort's wasm
// (npm) are already on disk and the suites read them from where they are
const FILES = packEntries(readAssets(engine), engine).filter((e) => e.url).map((e) => ({
  ...e,
  target: e.name.startsWith("matcha-vocos") ? join(dir, e.file) : join(dir, "matcha-icefall-zh-en", e.file),
}));

const verifies = ({ target, bytes, sha256: want }) =>
  existsSync(target) && statSync(target).size === bytes && sha256(readFileSync(target)) === want;

for (const f of FILES) {
  if (verifies(f)) { console.log(`✓ ${basename(f.target)} (cached)`); continue; }
  const res = await fetch(f.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  mkdirSync(dirname(f.target), { recursive: true });
  writeFileSync(f.target, Buffer.from(await res.arrayBuffer()));
  if (!verifies(f)) throw new Error(`${basename(f.target)}: downloaded file does not match the pin (bytes/SHA-256)`);
  console.log(`✓ ${basename(f.target)} (${f.bytes} B)`);
}
console.log(`weights ready in ${dir}
  MATCHA_MODEL_DIR=${dir}
  MATCHA_FST_DIR=${join(dir, "matcha-icefall-zh-en")}
  lexicon: ${engine}`);
