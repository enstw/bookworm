#!/usr/bin/env node
// Keep the wasmtts-assets release in lockstep with the wasmtts pin. CI runs
// this in the deploy job (after tests, before deploy.sh): any pack file or
// ort binary the pinned tree names that is not on the release under its
// packName is fetched from its pinned source (SHA-256 verified) and uploaded
// — so a pin bump that moves a model re-cuts the release before the worker
// that asks for the new name goes live. Upload first, sweep stale names
// after: there is never a moment when no version answers. Upstream's
// invariant — bytes change ⇒ packName changes — is why a same-name asset may
// never change bytes, and why finding one is a refusal, not a repair.
//
// Needs `gh` authenticated with contents:write on this repo (CI: GH_TOKEN).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "wasmtts-assets-v2";

// same resolution vendor.mjs uses: everything through the wasmtts tree,
// never a pin held here
const wasmttsDir = realpathSync(join(root, "node_modules", "wasmtts"));
const pack = JSON.parse(readFileSync(join(wasmttsDir, "platform", "matcha-assets.json"), "utf8"));
if (pack.schemaVersion !== 3)
  throw new Error(`wasmtts matcha-assets.json schemaVersion ${pack.schemaVersion} — this sync understands 3`);

const matchaRepo = pack.matcha.repository.replace(/\.git$/u, "");
const WANTED = [
  { name: pack.acoustic.packName, bytes: pack.acoustic.bytes, sha256: pack.acoustic.sha256,
    url: `${pack.acoustic.repository}/resolve/${pack.acoustic.revision}/${pack.acoustic.file}` },
  { name: pack.vocos.packName, bytes: pack.vocos.bytes, sha256: pack.vocos.sha256, url: pack.vocos.url },
  ...Object.entries(pack.matcha.files).map(([file, meta]) => ({
    name: meta.packName, bytes: meta.bytes, sha256: meta.sha256,
    url: `${matchaRepo}/resolve/${pack.matcha.revision}/${file}`,
  })),
];

// ort ships from the pinned package's own dist, not a download
const ortDir = join(wasmttsDir, "..", "onnxruntime-web");
const ortVersion = JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")).version;
const ortTarget = `ort-${ortVersion}-wasm-simd-threaded.wasm`;
const ortLocal = join(ortDir, "dist", "ort-wasm-simd-threaded.wasm");

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const assets = JSON.parse(gh("release", "view", TAG, "--json", "assets", "--jq", "[.assets[] | {name, size}]"));
const staging = mkdtempSync(join(tmpdir(), "wasmtts-assets-"));

async function ensure({ name, bytes, sha256, url, local }) {
  const existing = assets.find((a) => a.name === name);
  if (existing && existing.size !== bytes) {
    // same name must always mean same bytes — a silent replace would defeat
    // cache-first serving and the runtime byte gates, so refuse loudly
    console.error(`✗ ${name} on ${TAG} is ${existing.size} B but the pin says ${bytes} B — same name must mean same bytes`);
    process.exit(1);
  }
  if (existing) { console.log(`✓ ${name} already on ${TAG} (${bytes} B)`); return; }
  const staged = join(staging, name);
  if (local) {
    copyFileSync(local, staged);
  } else {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(staged, Buffer.from(await res.arrayBuffer()));
  }
  const size = statSync(staged).size;
  if (size !== bytes) throw new Error(`${name}: fetched ${size} B, pin says ${bytes} B`);
  if (sha256) {
    const hash = createHash("sha256").update(readFileSync(staged)).digest("hex");
    if (hash !== sha256) throw new Error(`${name}: SHA-256 ${hash}, pin says ${sha256}`);
  }
  gh("release", "upload", TAG, staged);
  console.log(`✓ uploaded ${name} (${bytes} B) to ${TAG}`);
}

for (const want of WANTED) await ensure(want);
await ensure({ name: ortTarget, bytes: statSync(ortLocal).size, local: ortLocal });

// sweep everything the pin no longer names (sole install, no backward-compat
// window) — only after the uploads, so every current name always answers
const keep = new Set([...WANTED.map((w) => w.name), ortTarget]);
for (const { name } of assets) {
  if (!keep.has(name)) {
    gh("release", "delete-asset", TAG, name, "--yes");
    console.log(`  deleted stale ${name}`);
  }
}
