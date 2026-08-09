#!/usr/bin/env node
// The pnpm-test chain, one suite at a time, each with its own log and a
// machine/human report under test-artifacts/ — so a red CI run can say WHICH
// suite broke and show its tail, instead of a 2000-line interleaved scroll.
// deploy.yml runs this as the gate in front of the deploy job; a failure
// becomes a test-failure-* pre-release with report.md as the notes.
//
//   ADMIN_TOKEN=<value from .dev.vars> node scripts/run-ci-tests.mjs
//
// A dev server already answering on BOOKWORM_URL (default :8787) is reused
// and left running; otherwise one wrangler dev is spawned and torn down.
// BOOKWORM_URL is exported to every suite so push-api and shelf-admin reuse
// that one server instead of booting their own workerd against the same
// .wrangler/state sqlite — two workerd on one state dir is a race we do not
// want to debug in CI. The shape mirrors wasmtts's run-release-gates.mjs.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

if (!process.env.ADMIN_TOKEN) {
  console.error("set ADMIN_TOKEN (the value in .dev.vars) — auth/push/shelf suites assert against it");
  process.exit(1);
}
const base = process.env.BOOKWORM_URL ?? "http://localhost:8787";
const out = path.resolve("test-artifacts");
const logs = path.join(out, "logs");
mkdirSync(logs, { recursive: true });

const results = [];
// per-suite cap: a hung suite must die HERE, inside the step, so the
// workflow's failure step still runs and publishes the report — a job-level
// timeout cancels the whole job and takes the pre-release with it
const SUITE_MS = 5 * 60 * 1000;
function run(name, args) {
  const started = Date.now();
  const result = spawnSync(args[0], args.slice(1), {
    env: { ...process.env, BOOKWORM_URL: base },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: SUITE_MS,
    killSignal: "SIGKILL",
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(logs, `${name}.log`), combined);
  const lines = combined.trim().split("\n").filter(Boolean);
  const entry = {
    name,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
    reason: result.status === 0 ? null
      : result.error?.code === "ETIMEDOUT" ? `no verdict after ${SUITE_MS / 1000} s — killed`
      : lines.slice(-3).join(" | ") || result.error?.message || "unknown failure",
  };
  results.push(entry);
  console.log(`${entry.status === "passed" ? "PASS" : "FAIL"} ${name} (${entry.durationMs} ms)`);
  return entry.status === "passed";
}

async function alive() {
  try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

// vendor first: wrangler dev serves public/ off the disk, so the vendored
// files must exist before any page under test asks for them
run("vendor", ["node", "scripts/vendor.mjs"]);

let server = null;
let serverOutput = "";
if (!(await alive())) {
  server = spawn("pnpm", ["exec", "wrangler", "dev", "--port", new URL(base).port || "8787"], {
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
}

// pure-node suites run while the server boots
run("slug", ["node", "scripts/test-slug.mjs"]);
run("split-core", ["node", "scripts/test-split-core.mjs"]);
run("wasm-frontend", ["node", "scripts/test-wasm-frontend.mjs"]);
run("matcha-fst", ["node", "scripts/test-matcha-fst.mjs"]);
run("worker-pool", ["node", "scripts/test-worker-pool.mjs"]);
run("push-crypto", ["node", "scripts/test-push-crypto.mjs"]);

try {
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
    ready = await alive();
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    results.push({ name: "dev-server", status: "failed", exitCode: null, durationMs: 60000, reason: `nothing answering on ${base} after 60 s` });
    console.log("FAIL dev-server");
  } else {
    run("auth-e2e", ["node", "scripts/test-auth-e2e.mjs"]);
    run("push-api-e2e", ["node", "scripts/test-push-api-e2e.mjs"]);
    run("shelf-admin-e2e", ["node", "scripts/test-shelf-admin-e2e.mjs"]);
  }
  run("vertical-e2e", ["node", "scripts/test-vertical-e2e.mjs"]);
  run("bg-e2e", ["node", "scripts/test-bg-e2e.mjs"]);
  run("tts-stream", ["node", "scripts/test-tts-stream-e2e.mjs"]);
  run("tts-stream-chain", ["node", "scripts/test-tts-stream-e2e.mjs", "chain"]);
} finally {
  if (server) {
    server.kill("SIGTERM");
    writeFileSync(path.join(logs, "dev-server.log"), serverOutput);
  }
}

const failed = results.filter((result) => result.status !== "passed");
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  status: failed.length ? "failed" : "passed",
  suites: results,
};
writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(out, "report.md"), [
  "# bookworm test gate",
  "",
  `- Commit: \`${report.commit ?? "local"}\``,
  `- Result: **${report.status.toUpperCase()}**${failed.length ? " — deploy skipped" : ""}`,
  "",
  "| Suite | Result | Duration | Failure reason |",
  "|---|---:|---:|---|",
  ...results.map((result) => `| ${result.name} | ${result.status} | ${result.durationMs} ms | ${(result.reason ?? "").replaceAll("|", "\\|")} |`),
  // the notes must carry the evidence themselves: the pre-release is read on
  // a phone, where "go download the logs artifact" is not an answer
  ...failed.flatMap((result) => {
    let tail = "";
    try { tail = String(spawnSync("tail", ["-n", "60", path.join(logs, `${result.name}.log`)], { encoding: "utf8" }).stdout ?? ""); } catch {}
    return ["", `## ${result.name} — last lines`, "", "```", tail.trim() || "(no output captured)", "```"];
  }),
  "",
].join("\n"));
if (failed.length) process.exit(1);
