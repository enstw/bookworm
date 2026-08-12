#!/usr/bin/env node
// Wait for the candidate-gate check run to conclude on a commit, and exit 0
// only on success. Used by the two workflows that merge into main on their
// own authority (the deploy's release-ledger PR and renovate's roll-up):
// their branches are pushed with GITHUB_TOKEN, which never fires
// pull_request, so they dispatch the candidate workflow explicitly and then
// sit here until the check lands on the head SHA they are about to merge.
//
//   GH_TOKEN=… node scripts/wait-candidate-gate.mjs <head-sha> [timeout-minutes]
//
// Fail-closed on every path: no check after the timeout, a non-success
// conclusion, or an API error all exit non-zero — the caller then refuses
// to merge.

const [sha, timeoutArg] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
  console.error("usage: wait-candidate-gate.mjs <40-hex head sha> [timeout-minutes]");
  process.exit(1);
}
const repo = process.env.GITHUB_REPOSITORY ?? "enstw/bookworm";
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GH_TOKEN is not set");
  process.exit(1);
}
const deadline = Date.now() + Number(timeoutArg ?? 25) * 60 * 1000;

while (true) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=candidate-gate&filter=latest`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    console.error(`check-runs API answered ${response.status}`);
    process.exit(1);
  }
  const { check_runs: runs } = await response.json();
  const run = runs[0];
  if (run?.status === "completed") {
    if (run.conclusion === "success") {
      console.log(`candidate-gate succeeded on ${sha.slice(0, 12)}`);
      process.exit(0);
    }
    console.error(`candidate-gate concluded ${run.conclusion} on ${sha.slice(0, 12)}`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error(`candidate-gate did not conclude on ${sha.slice(0, 12)} in time`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
