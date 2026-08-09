#!/usr/bin/env node
// Keep the wasmtts-assets release's ort binary in lockstep with the wasmtts
// pin. CI runs this in the deploy job (after tests, before deploy.sh): if the
// pinned onnxruntime-web's wasm is not on the release under its versioned
// name, upload it — so a repin that moves ort re-cuts the release before the
// worker that asks for the new name goes live. Upload first, sweep stale ort
// versions after: there is never a moment when no version answers. Model and
// FST files are not touched — those change only with a deliberate voice-pack
// re-cut (a new tag, wasmtts-assets-v3).
//
// Needs `gh` authenticated with contents:write on this repo (CI: GH_TOKEN).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "wasmtts-assets-v2";

// same resolution vendor.mjs uses: ort through the wasmtts tree, never a pin here
const ortDir = join(realpathSync(join(root, "node_modules", "wasmtts")), "..", "onnxruntime-web");
const version = JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")).version;
const target = `ort-${version}-wasm-simd-threaded.wasm`;
const local = join(ortDir, "dist", "ort-wasm-simd-threaded.wasm");
const localBytes = statSync(local).size;

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const assets = JSON.parse(gh("release", "view", TAG, "--json", "assets", "--jq", "[.assets[] | {name, size}]"));

const existing = assets.find((a) => a.name === target);
if (existing && existing.size !== localBytes) {
  // same name must always mean same bytes — a silent replace here would defeat
  // the runtime byte gate in wasm-tts.mjs, so refuse and leave it to a human
  console.error(`✗ ${target} on ${TAG} is ${existing.size} B but the pinned package's is ${localBytes} B — same name must mean same bytes`);
  process.exit(1);
}
if (existing) {
  console.log(`✓ ${target} already on ${TAG} (${localBytes} B)`);
} else {
  const staged = join(mkdtempSync(join(tmpdir(), "ort-")), target);
  copyFileSync(local, staged);
  gh("release", "upload", TAG, staged);
  console.log(`✓ uploaded ${target} (${localBytes} B) to ${TAG}`);
}

for (const { name } of assets) {
  if (name !== target && /^ort-.*-wasm-simd-threaded\.wasm$/.test(name)) {
    gh("release", "delete-asset", TAG, name, "--yes");
    console.log(`  deleted stale ${name}`);
  }
}
