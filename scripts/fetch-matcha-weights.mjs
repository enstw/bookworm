#!/usr/bin/env node
// Fill a local weights directory (default ~/.cache/bookworm-matcha) with the
// voice-pack files the gated suites need — tts-wasm, and the
// MATCHA_MODEL_DIR/MATCHA_FST_DIR halves of wasm-frontend / matcha-fst.
// Everything downloads from the pins in the wasmtts dependency's
// matcha-assets.json and is SHA-256-verified before it lands; a file that
// already verifies is skipped, so re-runs are cheap. Never point the suites
// at a live wasmtts checkout instead — a working tree's models are mutable
// owner state (see DESIGN.md's working agreements).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.argv[2] ?? join(homedir(), ".cache", "bookworm-matcha");

const wasmttsDir = realpathSync(join(root, "node_modules", "wasmtts"));
const pack = JSON.parse(readFileSync(join(wasmttsDir, "platform", "matcha-assets.json"), "utf8"));
if (pack.schemaVersion !== 3)
  throw new Error(`wasmtts matcha-assets.json schemaVersion ${pack.schemaVersion} — this fetcher understands 3`);

const matchaRepo = pack.matcha.repository.replace(/\.git$/u, "");
const FILES = [
  { url: `${pack.acoustic.repository}/resolve/${pack.acoustic.revision}/${pack.acoustic.file}`,
    target: join(dir, "matcha-icefall-zh-en", pack.acoustic.file),
    bytes: pack.acoustic.bytes, sha256: pack.acoustic.sha256 },
  { url: pack.vocos.url, target: join(dir, basename(new URL(pack.vocos.url).pathname)),
    bytes: pack.vocos.bytes, sha256: pack.vocos.sha256 },
  ...Object.entries(pack.matcha.files).map(([file, meta]) => ({
    url: `${matchaRepo}/resolve/${pack.matcha.revision}/${file}`,
    target: join(dir, "matcha-icefall-zh-en", file),
    bytes: meta.bytes, sha256: meta.sha256,
  })),
];

const verifies = ({ target, bytes, sha256 }) =>
  existsSync(target) && statSync(target).size === bytes &&
  createHash("sha256").update(readFileSync(target)).digest("hex") === sha256;

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
  MATCHA_FST_DIR=${join(dir, "matcha-icefall-zh-en")}`);
