#!/usr/bin/env node
// Keep the wasmtts-assets release in lockstep with the wasmtts pin. CI runs
// this in the deploy job (after tests, before deploy.sh): any pack file the
// pinned engine names that is not on the release under its packName is
// fetched from its pinned source (SHA-256 verified) and uploaded — so a pin
// bump that moves a model, the compiled lexicon or ort re-cuts the release
// before the worker that asks for the new name goes live. Upload first,
// sweep stale names after: there is never a moment when no version answers.
// Upstream's invariant — bytes change ⇒ packName changes — is why a
// same-name asset may never change bytes, and why finding one is a refusal,
// not a repair.
//
// The list is packEntries in wasmtts-pin.mjs: models, tokens and rule tables
// from their upstream hosts, the compiled lexicon from the engine tarball,
// ort's wasm from the pinned npm package — every source is the pin's own.
//
// Needs `gh` authenticated with contents:write on this repo (CI: GH_TOKEN).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEngine, packEntries, readAssets, sha256 } from "./wasmtts-pin.mjs";

const TAG = "wasmtts-assets-v2";

const engine = await ensureEngine();
const WANTED = packEntries(readAssets(engine), engine);

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const assets = JSON.parse(gh("release", "view", TAG, "--json", "assets", "--jq", "[.assets[] | {name, size}]"));
const staging = mkdtempSync(join(tmpdir(), "wasmtts-assets-"));

async function ensure({ name, bytes, sha256: want, url, local }) {
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
  const hash = sha256(readFileSync(staged));
  if (hash !== want) throw new Error(`${name}: SHA-256 ${hash}, pin says ${want}`);
  gh("release", "upload", TAG, staged);
  console.log(`✓ uploaded ${name} (${bytes} B) to ${TAG}`);
}

for (const want of WANTED) await ensure(want);

// sweep everything the pin no longer names (sole install, no backward-compat
// window) — only after the uploads, so every current name always answers
const keep = new Set(WANTED.map((w) => w.name));
for (const { name } of assets) {
  if (!keep.has(name)) {
    gh("release", "delete-asset", TAG, name, "--yes");
    console.log(`  deleted stale ${name}`);
  }
}
