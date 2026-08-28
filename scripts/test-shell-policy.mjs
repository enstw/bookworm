#!/usr/bin/env node
// Two policies about public/sw.js's SHELL_ASSETS that were each broken once
// without anything noticing.
//
// The offline TTS engine loads a dozen same-origin files by URL from inside a
// Worker (its scripts, ort's loader glue, the kaldifst wasm, the runtime
// profile); the service worker's shell list is a hand copy of that set, and
// a classic service worker cannot import the module that knows. So the list
// is derived here from the two sources of truth — wasm-tts.mjs's own static
// imports, and what vendor.mjs put under public/vendor/wasmtts/ (every file
// there is served by URL to the worker or the page) — and compared.
//
//   node scripts/test-shell-policy.mjs   (vendor must have run first)

import { readdirSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sw = read("public/sw.js");
const engine = read("public/wasm-tts.mjs");
const out = {};

const SHELL = sw.match(/const SHELL = "([^"]+)"/)?.[1];
const SHELL_ASSETS = JSON.parse(sw.match(/const SHELL_ASSETS = (\[[^\]]+\])/)?.[1] ?? "null");

// 1. every same-origin /vendor/ file the engine needs rides the shell.
// Static imports (how v20 broke) plus everything vendor.mjs produced for the
// engine (the worker importScripts its scripts by URL; ort import()s its glue
// by URL; the profile and the pack manifest are fetched). The pack's own
// binaries are NOT in scope — they arrive through /api/wasmtts/ into the
// worker's cache, on an explicit tap that names the megabytes.
const imports = [...engine.matchAll(/from "\.\/(vendor\/[^"]+)"/g)].map((m) => `/${m[1]}`);
const vendored = readdirSync(new URL("../public/vendor/wasmtts/", import.meta.url)).map((f) => `/vendor/wasmtts/${f}`);
const needed = [...new Set([...imports, ...vendored])].sort();
const missing = needed.filter((p) => !SHELL_ASSETS?.includes(p));
const extra = (SHELL_ASSETS ?? []).filter((p) => p.startsWith("/vendor/") && !needed.includes(p));
out.engineFilesRideTheShell = missing.length === 0 && extra.length === 0
  ? `ok (${needed.length} /vendor/ files: ${imports.length} imported, ${vendored.length} vendored)`
  : `FAIL ${missing.length ? `missing from SHELL_ASSETS in public/sw.js: ${missing.join(", ")}` : ""}`
    + `${extra.length ? ` not vendored any more: ${extra.join(", ")}` : ""}`
    + " — fix the list AND bump SHELL, or an installed phone never precaches them";

// 2. the list cannot move without SHELL moving.
// SHELL_ASSETS is precached at install, so a device that already installed
// only re-runs addAll when the cache NAME changes. Adding an entry and
// leaving SHELL alone ships a list that reaches new installs only — which
// looks fixed on a fresh profile and is still broken on the owner's phone,
// the one device that matters. Update both lines below when this is red:
// the golden is meant to be edited deliberately, not regenerated.
// (scripts/fetch-font.mjs bumps both lines itself when the font moves.)
const GOLDEN_SHELL = "bw-shell-v23";
const GOLDEN_ASSETS = [
  "/", "/app.css", "/i18n.js", "/app.js", "/player.mjs", "/tts-core.mjs", "/wasm-tts.mjs",
  "/vendor/wasmtts/continuous-stream-player.mjs", "/vendor/wasmtts/kaldifst-normalizer.js",
  "/vendor/wasmtts/lamejs-1.2.1.min.js", "/vendor/wasmtts/matcha-assets.json",
  "/vendor/wasmtts/matcha-engine.js", "/vendor/wasmtts/matcha-frontend.js",
  "/vendor/wasmtts/matcha-kaldifst-normalizer.js", "/vendor/wasmtts/matcha-kaldifst-normalizer.wasm",
  "/vendor/wasmtts/matcha-lexicon.meta.json", "/vendor/wasmtts/matcha-producer.mjs",
  "/vendor/wasmtts/matcha-profile.runtime.json", "/vendor/wasmtts/matcha-synthesis.js",
  "/vendor/wasmtts/matcha-taiwan-profile.js", "/vendor/wasmtts/matcha-worker.js",
  "/vendor/wasmtts/ort-1.27.0-wasm-simd-threaded.mjs", "/vendor/wasmtts/ort-1.27.0-wasm.min.js",
  "/vendor/wasmtts/pack-manifest.mjs",
  "/manifest.webmanifest",
];
const sameList = JSON.stringify(SHELL_ASSETS) === JSON.stringify(GOLDEN_ASSETS);
out.shellBumpsWithTheList = sameList
  ? (SHELL === GOLDEN_SHELL
    ? `ok (${SHELL}, ${SHELL_ASSETS.length} assets)`
    : `FAIL SHELL moved to ${SHELL} with no change to SHELL_ASSETS — update GOLDEN_SHELL here`)
  : (SHELL === GOLDEN_SHELL
    ? `FAIL SHELL_ASSETS changed but SHELL is still ${SHELL} — bump it, or installed devices keep the old list`
    : `FAIL SHELL_ASSETS changed (now ${SHELL}) — update GOLDEN_SHELL and GOLDEN_ASSETS here to confirm the bump is deliberate`);

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
