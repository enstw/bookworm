#!/usr/bin/env node
// Pay Chrome's cold start once, before any suite's clock is running.
//
// The first Chrome launch on a fresh CI runner is the slow one — a cold
// binary on a shared box — and cdp-client's launch() gives it 20 s. On
// ubuntu-24.04 image 20260816 the first browser suite (auth-e2e) took
// 13–18 s on eight green runs, 33.8 s on one, then died twice in a row at
// exactly the deadline with "browser never came up" while every later
// suite's launch was fine (2026-08-20). So run-ci-tests.mjs runs this
// while the dev server boots: the same binary, the same flags launch()
// uses, a throwaway profile, about:blank — and whichever suite launches
// first finds the binary warm. Prints how long it took and which browser
// answered, so the report carries the evidence; exits 1 when nothing
// answered in 90 s, because then every browser suite is about to fail and
// one row naming the cause beats eight saying "never came up".
//
//   node scripts/warm-browser.mjs

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { findBrowser } from "./find-browser.mjs";

const PORT = 9336; // below the suites' 9337–9355
const PROFILE = "/tmp/bookworm-warmup-profile";
const DEADLINE_MS = 90000;

rmSync(PROFILE, { recursive: true, force: true });
const { bin, env } = findBrowser();
const started = Date.now();
const proc = spawn(bin, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, "--no-first-run", "--disable-gpu",
  "--no-sandbox", "--disable-dev-shm-usage", "about:blank",
], { stdio: "ignore", env });

let browser = null;
while (!browser) {
  try {
    browser = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).Browser ?? "unknown";
  } catch { /* not up yet */ }
  if (!browser) {
    if (Date.now() - started > DEADLINE_MS) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}
proc.kill();
const ms = Date.now() - started;
console.log(browser
  ? `browser up in ${ms} ms (${browser}, ${bin})`
  : `browser never came up in ${DEADLINE_MS / 1000} s (${bin})`);
process.exit(browser ? 0 : 1);
