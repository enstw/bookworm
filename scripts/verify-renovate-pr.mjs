#!/usr/bin/env node
// A self-hosted Renovate run acts as the repository owner, so its branch name
// alone is not proof that the PR contains dependency maintenance. This verifier
// is loaded from main, inspects (but never executes) the fetched PR commit, and
// fails closed on every change Renovate does not need for the weekly roll-up.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const REPOSITORY = "enstw/bookworm";
const BASE_BRANCH = "main";
const HEAD_BRANCH = "renovate/weekly-roll-up";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SEMVER_SOURCE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const EXACT_SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);
const ACTION_LINE = /^(\s*-\s+uses:\s+)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?)@([0-9a-f]{40})(\s+#\s+\S.*)?$/;
const RENOVATE_LINE = new RegExp(`^(\\s*- run: pnpm dlx "renovate@)(${SEMVER_SOURCE})(" --platform=github enstw/bookworm\\s*)$`);
// The one non-registry source the lockfile legitimately carries: the wasmtts
// git dependency. Registry packages resolve URL-free (integrity only, host
// from settings), so any other URL in the lockfile is a redirected install.
const LOCKFILE_SOURCE = /^https:\/\/codeload\.github\.com\/enstw\//;

function refuse(message) {
  throw new Error(`unsafe Renovate PR: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dependencyKeys(pkg, field) {
  return Object.keys(pkg[field] ?? {}).sort();
}

function semverParts(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(after, before) {
  const afterNumeric = /^\d+$/.test(after);
  const beforeNumeric = /^\d+$/.test(before);
  if (afterNumeric && beforeNumeric) return Number(after) - Number(before);
  if (afterNumeric !== beforeNumeric) return afterNumeric ? -1 : 1;
  return after.localeCompare(before);
}

export function compareSemver(after, before) {
  const a = semverParts(after);
  const b = semverParts(before);
  if (!a || !b) refuse("version is not exact SemVer");
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function normalizedVersion(name, version) {
  if (name === "wasmtts") {
    return version.match(/^github:enstw\/wasmtts#v(.+)$/)?.[1] ?? null;
  }
  return EXACT_SEMVER.test(version) ? version : null;
}

function owningAction(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const action = lines[cursor].match(ACTION_LINE);
    if (action) return action[2];
    if (/^\s*-\s+(?:run|name):/.test(lines[cursor])) break;
  }
  return null;
}

export function verifyPackageUpdate(baseText, headText) {
  const base = JSON.parse(baseText);
  const head = JSON.parse(headText);
  const baseWithoutDependencies = clone(base);
  const headWithoutDependencies = clone(head);
  for (const field of DEPENDENCY_FIELDS) {
    delete baseWithoutDependencies[field];
    delete headWithoutDependencies[field];
  }
  if (!isDeepStrictEqual(baseWithoutDependencies, headWithoutDependencies)) {
    refuse("package.json changed outside dependency fields");
  }

  let changed = 0;
  for (const field of DEPENDENCY_FIELDS) {
    const beforeKeys = dependencyKeys(base, field);
    const afterKeys = dependencyKeys(head, field);
    if (!isDeepStrictEqual(beforeKeys, afterKeys)) {
      refuse(`package.json changed the key set in ${field}`);
    }
    for (const name of beforeKeys) {
      const before = base[field][name];
      const after = head[field][name];
      if (before === after) continue;
      const beforeVersion = typeof before === "string" ? normalizedVersion(name, before) : null;
      const afterVersion = typeof after === "string" ? normalizedVersion(name, after) : null;
      if (!beforeVersion || !afterVersion) {
        refuse(`${field}.${name} is not pinned to an allowed exact version`);
      }
      if (compareSemver(afterVersion, beforeVersion) <= 0) refuse(`${field}.${name} is not an upgrade`);
      changed += 1;
    }
  }
  if (changed === 0) refuse("package.json changed without a dependency version change");
  return changed;
}

export function verifyLockfileSources(text) {
  const urls = text.match(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`,)\]}]+/g) ?? [];
  for (const url of urls) {
    if (!LOCKFILE_SOURCE.test(url)) refuse(`pnpm-lock.yaml resolves from unexpected source ${url}`);
  }
  return urls.length;
}

export function verifyWorkflowUpdate(path, baseText, headText) {
  const before = baseText.split("\n");
  const after = headText.split("\n");
  if (before.length !== after.length) refuse(`${path} added or removed lines`);

  let actionPins = 0;
  let toolPins = 0;
  const actionUpdates = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue;
    const oldAction = before[index].match(ACTION_LINE);
    const newAction = after[index].match(ACTION_LINE);
    if (oldAction && newAction) {
      if (oldAction[1] !== newAction[1] || oldAction[2] !== newAction[2]) {
        refuse(`${path}:${index + 1} changed the action identity`);
      }
      if (oldAction[3] === newAction[3]) refuse(`${path}:${index + 1} changed only the action comment`);
      const oldVersion = oldAction[4]?.match(/^\s+#\s+v(.+)$/)?.[1];
      const newVersion = newAction[4]?.match(/^\s+#\s+v(.+)$/)?.[1];
      if (!oldVersion || !newVersion || compareSemver(newVersion, oldVersion) <= 0) {
        refuse(`${path}:${index + 1} action comment is not an exact version upgrade`);
      }
      actionPins += 1;
      actionUpdates.push({ action: newAction[2], sha: newAction[3], version: newVersion });
      continue;
    }

    const oldRenovate = before[index].match(RENOVATE_LINE);
    const newRenovate = after[index].match(RENOVATE_LINE);
    if (path === ".github/workflows/renovate.yml" && oldRenovate && newRenovate) {
      if (oldRenovate[1] !== newRenovate[1] || oldRenovate[3] !== newRenovate[3]) {
        refuse(`${path}:${index + 1} changed the Renovate command shape`);
      }
      if (compareSemver(newRenovate[2], oldRenovate[2]) <= 0) {
        refuse(`${path}:${index + 1} Renovate is not an exact version upgrade`);
      }
      toolPins += 1;
      continue;
    }

    const oldTool = before[index].match(new RegExp(`^(\\s+)(node-version|version):\\s+(${SEMVER_SOURCE})\\s*$`));
    const newTool = after[index].match(new RegExp(`^(\\s+)(node-version|version):\\s+(${SEMVER_SOURCE})\\s*$`));
    if (oldTool && newTool && oldTool[1] === newTool[1] && oldTool[2] === newTool[2]) {
      const oldOwner = owningAction(before, index);
      const newOwner = owningAction(after, index);
      const expectedOwner = oldTool[2] === "node-version" ? "actions/setup-node" : "pnpm/action-setup";
      if (oldOwner !== expectedOwner || newOwner !== expectedOwner) {
        refuse(`${path}:${index + 1} tool version is not owned by ${expectedOwner}`);
      }
      if (compareSemver(newTool[3], oldTool[3]) <= 0) {
        refuse(`${path}:${index + 1} tool version is not an exact upgrade`);
      }
      toolPins += 1;
      continue;
    }
    refuse(`${path}:${index + 1} changed outside an allowed automation pin`);
  }
  if (actionPins + toolPins === 0) refuse(`${path} contains no allowed automation pin update`);
  return { actionPins, toolPins, actionUpdates };
}

export function parseNameStatus(raw) {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length;) {
    let status = fields[index];
    let path;
    if (status.includes("\t")) {
      const separator = status.indexOf("\t");
      path = status.slice(separator + 1);
      status = status.slice(0, separator);
      index += 1;
    } else {
      index += 1;
      path = fields[index];
      index += 1;
    }
    if (!status || !path) refuse("could not parse git diff --name-status");
    if (/^[RC]/.test(status)) {
      const destination = fields[index];
      index += 1;
      entries.push({ status, path, destination });
    } else {
      entries.push({ status, path });
    }
  }
  return entries;
}

export function verifyMetadata(metadata, baseSha, headSha) {
  if (metadata.state !== "open" || metadata.draft) refuse("PR is not an open, non-draft PR");
  if (metadata.base?.repo?.full_name !== REPOSITORY || metadata.base?.ref !== BASE_BRANCH) {
    refuse("base repository or branch is unexpected");
  }
  if (metadata.head?.repo?.full_name !== REPOSITORY || metadata.head?.ref !== HEAD_BRANCH) {
    refuse("head repository or branch is unexpected");
  }
  if (metadata.base?.sha !== baseSha || metadata.head?.sha !== headSha) {
    refuse("API metadata does not match the fetched commit pair");
  }
}

export function verifyChecks(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) refuse("status checks are unavailable");
  for (const check of statusCheckRollup) {
    if (check.__typename === "StatusContext") {
      if (check.state !== "SUCCESS") refuse(`${check.context ?? "status"} is ${check.state}`);
      continue;
    }
    if (check.__typename === "CheckRun") {
      if (check.status !== "COMPLETED" || check.conclusion !== "SUCCESS") {
        refuse(`${check.name ?? "check"} is ${check.status}/${check.conclusion}`);
      }
      continue;
    }
    refuse("encountered an unknown status-check type");
  }
  return statusCheckRollup.length;
}

export function verifyRenovateChange({ metadata, statusCheckRollup, entries, baseSha, headSha, readGitFile, resolveActionTag }) {
  verifyMetadata(metadata, baseSha, headSha);
  const checkCount = verifyChecks(statusCheckRollup);
  if (entries.length === 0) refuse("PR has no changed files");
  if (metadata.changed_files !== entries.length) refuse("GitHub and git disagree on changed-file count");

  const paths = new Set();
  for (const entry of entries) {
    if (entry.status !== "M") refuse(`${entry.path} has disallowed change type ${entry.status}`);
    if (paths.has(entry.path)) refuse(`${entry.path} appears more than once`);
    paths.add(entry.path);
    const allowed = entry.path === "package.json"
      || entry.path === "pnpm-lock.yaml"
      || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path);
    if (!allowed) refuse(`${entry.path} is outside the dependency-update allowlist`);
  }

  const hasPackage = paths.has("package.json");
  const hasLockfile = paths.has("pnpm-lock.yaml");
  if (hasPackage !== hasLockfile) refuse("package.json and pnpm-lock.yaml must change together");

  let dependencyPins = 0;
  let actionPins = 0;
  let toolPins = 0;
  if (hasPackage) {
    dependencyPins = verifyPackageUpdate(
      readGitFile(baseSha, "package.json"),
      readGitFile(headSha, "package.json"),
    );
  }
  if (hasLockfile) verifyLockfileSources(readGitFile(headSha, "pnpm-lock.yaml"));
  const actionUpdates = [];
  for (const path of paths) {
    if (!path.startsWith(".github/workflows/")) continue;
    const pins = verifyWorkflowUpdate(path, readGitFile(baseSha, path), readGitFile(headSha, path));
    actionPins += pins.actionPins;
    toolPins += pins.toolPins;
    actionUpdates.push(...pins.actionUpdates);
  }
  // A 40-hex digest is unverifiable offline: any commit in the action's fork
  // network would satisfy the line format, so the claimed `# vX.Y.Z` must be
  // confirmed against the tag upstream actually serves.
  if (actionUpdates.length > 0 && typeof resolveActionTag !== "function") {
    refuse("action pin changed but no tag resolver is available");
  }
  for (const update of actionUpdates) {
    const resolved = resolveActionTag(update.action, update.version);
    if (resolved !== update.sha) {
      refuse(`${update.action}@${update.sha} does not match upstream tag v${update.version} (${resolved})`);
    }
  }
  return { changedFiles: entries.length, dependencyPins, actionPins, toolPins, checkCount };
}

function gitFile(sha, path) {
  return execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8" });
}

function ghApi(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
}

// owner/repo/subdir actions resolve tags on owner/repo; annotated tags need
// one dereference to reach the commit.
function ghResolveActionTag(action, version) {
  const repo = action.split("/").slice(0, 2).join("/");
  let object;
  try {
    object = ghApi(`repos/${repo}/git/ref/tags/v${version}`).object;
    if (object.type === "tag") object = ghApi(`repos/${repo}/git/tags/${object.sha}`).object;
  } catch (error) {
    refuse(`could not resolve ${repo} tag v${version}: ${error.message}`);
  }
  if (object.type !== "commit") refuse(`${repo} tag v${version} points at a ${object.type}, not a commit`);
  return object.sha;
}

function main() {
  const [metadataPath, checksPath, baseSha, headSha] = process.argv.slice(2);
  if (!metadataPath || !checksPath || !/^[0-9a-f]{40}$/.test(baseSha ?? "") || !/^[0-9a-f]{40}$/.test(headSha ?? "")) {
    console.error("usage: verify-renovate-pr.mjs <metadata.json> <checks.json> <base-sha> <head-sha>");
    process.exit(2);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const { statusCheckRollup } = JSON.parse(readFileSync(checksPath, "utf8"));
  const rawDiff = execFileSync("git", ["diff", "--name-status", "-z", baseSha, headSha], { encoding: "utf8" });
  const result = verifyRenovateChange({
    metadata,
    statusCheckRollup,
    entries: parseNameStatus(rawDiff),
    baseSha,
    headSha,
    readGitFile: gitFile,
    resolveActionTag: ghResolveActionTag,
  });
  console.log(`✓ Renovate PR #${metadata.number}: ${result.changedFiles} files, ${result.dependencyPins} dependency pins, ${result.actionPins} action pins, ${result.toolPins} tool pins`);
  if (result.checkCount === 0) console.log("  no PR checks reported; the required candidate gate is tracked separately");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
