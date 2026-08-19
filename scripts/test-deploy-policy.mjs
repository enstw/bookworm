#!/usr/bin/env node
// Policy gate for every workflow that can reach production: deploy.yml,
// candidate.yml, and the three hand-run ops workflows.
//
// deploy.yml: the test job executes the pushed code, so it must never hold a
// write token or a persisted credential; write access belongs only to the
// jobs that run no repository code from the tested commit (failure-report) or
// run strictly after a green gate (deploy). candidate.yml lives by the test
// job's rules. The ops workflows hold ADMIN_TOKEN against the live site, so
// they stay hand-dispatched, read-only, and inside the production
// environment. Line-oriented on purpose — a YAML parser would be a dependency
// this check exists to distrust. Same self-testing shape as
// test-renovate-policy.mjs: the real file must pass, and seeded violations
// must each be caught.

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
    } else if (name === "failure-report") {
      if (writes.join(",") !== "contents") {
        violations.push(`job ${name} must hold exactly contents: write, has: ${writes.join(", ") || "none"}`);
      }
    } else if (name === "deploy") {
      // contents for the ledger/tag, pull-requests + actions to open the
      // ledger PR and dispatch its candidate-gate (H-03) — nothing else
      if (writes.sort().join(",") !== "actions,contents,pull-requests") {
        violations.push(`deploy job must hold exactly actions/contents/pull-requests write, has: ${writes.join(", ") || "none"}`);
      }
      // M-01: the production secrets live in an environment whose branch
      // policy admits main alone; the reference is what admits this job
      if (!/^\s{4}environment: production\s*$/m.test(body)) {
        violations.push("deploy job does not name the production environment");
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
    if (name !== "deploy" && /^\s{4}environment:/m.test(body)) {
      violations.push(`job ${name} names an environment`);
    }
  }

  return violations;
}

// The candidate workflow executes PR code pre-merge, so it lives by the test
// job's rules: read-only token, credential-free checkout, no repository
// secrets — and never the pull_request_target trigger, which would hand
// untrusted code a privileged context.
export function checkCandidatePolicy(text) {
  const violations = [];
  if (/^\s*pull_request_target:/m.test(text)) violations.push("candidate uses pull_request_target");
  if (/\$\{\{\s*secrets\./.test(text)) violations.push("candidate references repository secrets");
  if (/^\s+environment:/m.test(text)) violations.push("candidate names an environment");
  const { jobs } = splitJobs(text);
  const gate = jobs["candidate-gate"];
  if (!gate) return [...violations, "job candidate-gate is missing"];
  const writes = [...gate.matchAll(/^\s+(\w[\w-]*): write\s*$/gm)].map((m) => m[1]);
  if (writes.length) violations.push(`candidate-gate holds write permissions: ${writes.join(", ")}`);
  if (!/^\s+contents: read\s*$/m.test(gate)) violations.push("candidate-gate is missing contents: read");
  if (!/persist-credentials: false/.test(gate)) violations.push("candidate-gate checkout persists credentials");
  return violations;
}

// The trigger list of a workflow: the keys one level under `on:`.
export function triggersOf(text) {
  const lines = text.split("\n");
  const onAt = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onAt === -1) return null;
  const out = [];
  for (const line of lines.slice(onAt + 1)) {
    if (/^[A-Za-z]/.test(line)) break;
    const key = line.match(/^  ([a-z_]+):/);
    if (key) out.push(key[1]);
  }
  return out;
}

// M-04: publish-book, push-test and renormalize-books hold ADMIN_TOKEN and
// BOOKWORM_URL against the live site. Nothing about that was asserted — the
// jobs were safe by convention alone. They stay hand-run only, read-only,
// and reachable only through the production environment.
export function checkOpsPolicy(text) {
  const violations = [];
  const triggers = triggersOf(text);
  if (!triggers) return ["ops workflow has no on: block"];
  const unexpected = triggers.filter((t) => t !== "workflow_dispatch");
  if (unexpected.length) violations.push(`ops workflow runs on more than a hand dispatch: ${unexpected.join(", ")}`);
  const writes = [...text.matchAll(/^\s+(\w[\w-]*): write\s*$/gm)].map((m) => m[1]);
  if (writes.length) violations.push(`ops workflow grants write permissions: ${writes.join(", ")}`);
  const { jobs } = splitJobs(text);
  for (const [name, body] of Object.entries(jobs)) {
    if (!/^\s{4}permissions:\s*$/m.test(body)) {
      violations.push(`ops job ${name} has no explicit permissions block`);
    }
    if (/\$\{\{\s*secrets\./.test(body) && !/^\s{4}environment: production\s*$/m.test(body)) {
      violations.push(`ops job ${name} reads secrets outside the production environment`);
    }
  }
  return violations;
}

const real = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), "utf8");
assert.deepEqual(checkDeployPolicy(real), [], `${WORKFLOW} violates the permission policy`);

const CANDIDATE = ".github/workflows/candidate.yml";
const candidate = readFileSync(new URL(`../${CANDIDATE}`, import.meta.url), "utf8");
assert.deepEqual(checkCandidatePolicy(candidate), [], `${CANDIDATE} violates the permission policy`);

// each seeded violation must be caught — an assertion that can only pass is
// not a gate
const mutations = [
  ["workflow-level permissions", (t) => t.replace("\nconcurrency:", "\npermissions:\n  contents: write\n\nconcurrency:")],
  ["test job write grant", (t) => t.replace("    permissions:\n      contents: read", "    permissions:\n      contents: write")],
  ["persisted checkout credential", (t) => t.replace("          # the suite runs the pushed code; leave no token on disk for it\n          persist-credentials: false\n", "")],
  ["failure-report checkout", (t) => t.replace("      - uses: actions/download-artifact@", "      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0\n      - uses: actions/download-artifact@")],
  ["failure-report running repo code", (t) => t.replace("          set -euo pipefail\n", "          set -euo pipefail\n          node scripts/update-releases.mjs\n")],
  ["secrets outside deploy", (t) => t.replace("      ADMIN_TOKEN: bookworm-ci-${{ github.run_id }}", "      ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}")],
  ["deploy job gaining an extra grant", (t) => t.replace("      pull-requests: write\n      actions: write", "      pull-requests: write\n      actions: write\n      issues: write")],
  ["deploy job losing a grant", (t) => t.replace("      pull-requests: write\n      actions: write", "      pull-requests: write")],
  ["deploy job leaving the production environment", (t) => t.replace(/^ {4}environment: production\n/m, "")],
  ["test job joining the production environment", (t) => t.replace("  test:\n", "  test:\n    environment: production\n")],
];
for (const [label, mutate] of mutations) {
  const mutated = mutate(real);
  assert.notEqual(mutated, real, `mutation "${label}" did not apply — fixture drifted from deploy.yml`);
  assert.notEqual(checkDeployPolicy(mutated).length, 0, `mutation "${label}" was not caught`);
}

const candidateMutations = [
  ["pull_request_target trigger", (t) => t.replace("on:\n  pull_request:", "on:\n  pull_request_target:")],
  ["candidate-gate write grant", (t) => t.replace("    permissions:\n      contents: read", "    permissions:\n      contents: write")],
  ["candidate secrets reference", (t) => t.replace("      ADMIN_TOKEN: bookworm-ci-${{ github.run_id }}", "      ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}")],
  ["candidate naming an environment", (t) => t.replace("  candidate-gate:\n", "  candidate-gate:\n    environment: production\n")],
  ["candidate persisted credential", (t) => t.replace("          # this job runs the PR's code; leave no token on disk for it\n          persist-credentials: false\n", "")],
];
for (const [label, mutate] of candidateMutations) {
  const mutated = mutate(candidate);
  assert.notEqual(mutated, candidate, `mutation "${label}" did not apply — fixture drifted from candidate.yml`);
  assert.notEqual(checkCandidatePolicy(mutated).length, 0, `mutation "${label}" was not caught`);
}

const OPS = [
  ".github/workflows/publish-book.yml",
  ".github/workflows/push-test.yml",
  ".github/workflows/renormalize-books.yml",
];
const opsMutations = [
  ["ops workflow gaining an automatic trigger", (t) => t.replace("on:\n  workflow_dispatch:", "on:\n  push:\n  workflow_dispatch:")],
  ["ops workflow gaining a write grant", (t) => t.replace("      contents: read", "      contents: write")],
  ["ops workflow leaving the production environment", (t) => t.replace(/^ {4}environment: production\n/m, "")],
];
for (const path of OPS) {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.deepEqual(checkOpsPolicy(text), [], `${path} violates the ops policy`);
  for (const [label, mutate] of opsMutations) {
    const mutated = mutate(text);
    assert.notEqual(mutated, text, `mutation "${label}" did not apply — fixture drifted from ${path}`);
    assert.notEqual(checkOpsPolicy(mutated).length, 0, `mutation "${label}" was not caught in ${path}`);
  }
}

console.log("✓ deploy.yml + candidate.yml + ops workflow permission policy");
