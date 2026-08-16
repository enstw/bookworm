#!/usr/bin/env node
// The service worker's precache list against the module that actually needs
// it — the one hand copy in this repo that has already shipped broken twice.
//
// public/sw.js is a classic service worker, so it cannot import the module
// that knows which files the offline TTS engine loads; SHELL_ASSETS is a copy
// of that knowledge, typed by hand, and a copy that nobody checks is a copy
// that drifts. It drifted into v20 (pack-manifest.mjs, a static import added
// without touching sw.js) and it was still drifted when this test was
// written (ort-wasm.min.js and lame.min.js, fetched at engine init).
//
// The failure is quiet, which is why it survives review: everything works
// online, because the network answers. It only bites the device that
// downloaded the voice pack and then went offline before ever playing —
// /wasmtest and the download pill fetch the pack (/api/wasmtts/*) and never
// /vendor/*, so nothing parks these files in bw-wasmtts. cachedBuf's fresh
// mode then finds no network and no parked copy, throws, and the reader falls
// back to the online engine it also cannot reach: silence, on a phone holding
// a complete voice pack.
//
//   node scripts/test-shell-policy.mjs

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sw = read("public/sw.js");
const engine = read("public/wasm-tts.mjs");
const out = {};

const SHELL = sw.match(/const SHELL = "([^"]+)"/)?.[1];
const SHELL_ASSETS = JSON.parse(sw.match(/const SHELL_ASSETS = (\[[^\]]+\])/)?.[1] ?? "null");

// 1. every same-origin /vendor/ file the engine needs rides the shell.
// Both ways in count: a static import (how v20 broke) and a cachedBuf load at
// init (how ort-wasm.min.js and lame.min.js broke). The pack's own binaries
// are NOT in scope — they arrive through /api/wasmtts/ into bw-wasmtts, on an
// explicit tap that names the megabytes.
const imports = [...engine.matchAll(/from "\.\/(vendor\/[^"]+)"/g)].map((m) => `/${m[1]}`);
const initLoads = [...engine.matchAll(/cachedBuf\("(\/vendor\/[^"]+)"/g)].map((m) => m[1]);
const needed = [...new Set([...imports, ...initLoads])];
const missing = needed.filter((p) => !SHELL_ASSETS?.includes(p));
out.engineFilesRideTheShell = missing.length === 0
  ? `ok (${needed.length} /vendor/ files: ${imports.length} imported, ${initLoads.length} loaded at init)`
  : `FAIL missing from SHELL_ASSETS in public/sw.js: ${missing.join(", ")}`
    + " — add them AND bump SHELL, or an installed phone never precaches them";

// 2. the list cannot move without SHELL moving.
// SHELL_ASSETS is precached at install, so a device that already installed
// only re-runs addAll when the cache NAME changes. Adding an entry and
// leaving SHELL alone ships a list that reaches new installs only — which
// looks fixed on a fresh profile and is still broken on the owner's phone,
// the one device that matters. Update both lines below when this is red:
// the golden is meant to be edited deliberately, not regenerated.
const GOLDEN_SHELL = "bw-shell-v21";
const GOLDEN_ASSETS = [
  "/", "/app.css", "/i18n.js", "/app.js", "/player.mjs", "/tts-core.mjs", "/wasm-tts.mjs",
  "/vendor/wasmtts/matcha-frontend.js", "/vendor/wasmtts/matcha-taiwan-profile.js",
  "/vendor/wasmtts/matcha-g2p-review.json", "/vendor/wasmtts/matcha-synthesis.js",
  "/vendor/wasmtts/kaldifst-normalizer.js", "/vendor/wasmtts/matcha-kaldifst-normalizer.js",
  "/vendor/wasmtts/matcha-kaldifst-normalizer.wasm", "/vendor/wasmtts/ort-wasm-simd-threaded.mjs",
  "/vendor/wasmtts/ort-wasm.min.js", "/vendor/wasmtts/lame.min.js",
  "/vendor/wasmtts/ort-manifest.mjs", "/vendor/wasmtts/pack-manifest.mjs",
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
