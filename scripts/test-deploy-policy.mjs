#!/usr/bin/env node
// Policy gate for .github/workflows/deploy.yml: the test job executes the
// pushed code, so it must never hold a write token or a persisted credential;
// write access belongs only to the jobs that run no repository code from the
// tested commit (failure-report) or run strictly after a green gate (deploy).
// Line-oriented on purpose — a YAML parser would be a dependency this check
// exists to distrust. Same self-testing shape as test-renovate-policy.mjs:
// the real file must pass, and seeded violations must each be caught.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/deploy.yml";

// Split the workflow into the pre-jobs header and one text block per job.
// Job names sit at exactly two spaces of indent under `jobs:`.
export function splitJobs(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, "deploy.yml has no jobs: block");
  const header = lines.slice(0, jobsAt).join("\n");
  const jobs = {};
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const name = line.match(/^  ([A-Za-z_][\w-]*):\s*$/);
    if (name) {
      current = name[1];
      jobs[current] = [];
    } else if (current) {
      jobs[current].push(line);
    }
  }
  return { header, jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join("\n")])) };
}

export function checkDeployPolicy(text) {
  const violations = [];
  const { header, jobs } = splitJobs(text);

  if (/^permissions:/m.test(header)) {
    violations.push("workflow-level permissions block exists; permissions must be per job");
  }

  for (const job of ["test", "failure-report", "deploy"]) {
    if (!(job in jobs)) violations.push(`job ${job} is missing`);
  }

  for (const [name, body] of Object.entries(jobs)) {
    const grants = [...body.matchAll(/^\s+(\w[\w-]*): (write|read)\s*$/gm)]
      .filter(() => /^\s+permissions:/m.test(body));
    const writes = [...body.matchAll(/^\s+(\w[\w-]*): write\s*$/gm)].map((m) => m[1]);
    if (!/^\s{4}permissions:\s*$/m.test(body)) {
      violations.push(`job ${name} has no explicit permissions block`);
      continue;
    }
    if (name === "test") {
      if (writes.length) violations.push(`test job holds write permissions: ${writes.join(", ")}`);
      if (!/^\s+contents: read\s*$/m.test(body)) violations.push("test job is missing contents: read");
    } else if (name === "failure-report" || name === "deploy") {
      if (writes.join(",") !== "contents") {
        violations.push(`job ${name} must hold exactly contents: write, has: ${writes.join(", ") || "none"}`);
      }
    } else if (writes.length) {
      violations.push(`unexpected job ${name} holds write permissions: ${writes.join(", ")}`);
    }
    void grants;
  }

  // the test job runs the pushed code: its checkout must not leave a token
  const test = jobs.test ?? "";
  const checkouts = test.split(/actions\/checkout@/).slice(1);
  if (!checkouts.length) violations.push("test job has no checkout to assert on");
  for (const chunk of checkouts) {
    // persist-credentials must appear in this step's `with:` block, before
    // the next step starts (steps begin with "- " at their indent)
    const step = chunk.split(/\n\s+- /)[0];
    if (!/persist-credentials: false/.test(step)) {
      violations.push("test job checkout persists credentials");
    }
  }

  // failure-report handles the artifact only: no checkout, no repo scripts
  const failure = jobs["failure-report"] ?? "";
  if (/actions\/checkout@/.test(failure)) violations.push("failure-report checks out repository code");
  if (/node scripts\//.test(failure)) violations.push("failure-report executes repository scripts");

  // production secrets stay in deploy (github.token is not in scope: it is
  // the per-job GITHUB_TOKEN, already constrained by the permissions above)
  for (const [name, body] of Object.entries(jobs)) {
    if (name !== "deploy" && /\$\{\{\s*secrets\./.test(body)) {
      violations.push(`job ${name} references repository secrets`);
    }
  }

  return violations;
}

const real = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), "utf8");
assert.deepEqual(checkDeployPolicy(real), [], `${WORKFLOW} violates the permission policy`);

// each seeded violation must be caught — an assertion that can only pass is
// not a gate
const mutations = [
  ["workflow-level permissions", (t) => t.replace("\nconcurrency:", "\npermissions:\n  contents: write\n\nconcurrency:")],
  ["test job write grant", (t) => t.replace("    permissions:\n      contents: read", "    permissions:\n      contents: write")],
  ["persisted checkout credential", (t) => t.replace("          # the suite runs the pushed code; leave no token on disk for it\n          persist-credentials: false\n", "")],
  ["failure-report checkout", (t) => t.replace("      - uses: actions/download-artifact@", "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0\n      - uses: actions/download-artifact@")],
  ["failure-report running repo code", (t) => t.replace("          set -euo pipefail\n", "          set -euo pipefail\n          node scripts/update-releases.mjs\n")],
  ["secrets outside deploy", (t) => t.replace("      ADMIN_TOKEN: bookworm-ci-${{ github.run_id }}", "      ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}")],
  ["deploy job losing its explicit grant", (t) => t.replace("  deploy:\n    needs: test\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write", "  deploy:\n    needs: test\n    runs-on: ubuntu-latest")],
];
for (const [label, mutate] of mutations) {
  const mutated = mutate(real);
  assert.notEqual(mutated, real, `mutation "${label}" did not apply — fixture drifted from deploy.yml`);
  assert.notEqual(checkDeployPolicy(mutated).length, 0, `mutation "${label}" was not caught`);
}

console.log("✓ deploy.yml permission policy");
