#!/usr/bin/env node
// Release and await the candidate-gate check on a commit, and exit 0 only on
// success. Used by the two workflows that merge into main on their own
// authority (the deploy's release-ledger PR and renovate's roll-up).
//
// Their branches and PRs are created with GITHUB_TOKEN, and GITHUB_TOKEN
// events never start workflows on their own: GitHub creates the PR's
// pull_request run *held* (conclusion `action_required`) instead. The main
// ruleset's required check waits on exactly that held run — a separately
// dispatched `workflow run candidate` builds a different check suite that
// never associates with the PR, so the PR stays BLOCKED however green the
// dispatched run is (probed 2026-08-13 on run 31633613497 / PR #25). The
// official release valve is approving the held run, which both callers'
// `actions: write` grant permits — so this script approves it, then sits on
// the check-runs API until candidate-gate concludes on the head SHA.
//
//   GH_TOKEN=… node scripts/wait-candidate-gate.mjs <head-sha> [timeout-minutes]
//
// Fail-closed on every path: no held run appearing, a refused approval, no
// check after the timeout, a non-success conclusion, or an API error all
// exit non-zero — the caller then refuses to merge.

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

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  return response;
}

// Phase 1: find the PR's own candidate run for this SHA and approve it if it
// is being held. An already-running or already-concluded run needs nothing.
const findDeadline = Date.now() + 3 * 60 * 1000;
while (true) {
  const response = await api(`/actions/runs?event=pull_request&head_sha=${sha}`);
  if (!response.ok) {
    console.error(`actions/runs API answered ${response.status}`);
    process.exit(1);
  }
  const { workflow_runs: workflowRuns } = await response.json();
  const run = workflowRuns.find((r) => r.name === "candidate");
  if (run) {
    if (run.conclusion === "action_required") {
      const approval = await api(`/actions/runs/${run.id}/approve`, { method: "POST" });
      if (!approval.ok) {
        console.error(`approving held candidate run ${run.id} answered ${approval.status}`);
        process.exit(1);
      }
      console.log(`approved held candidate run ${run.id}`);
    }
    break;
  }
  if (Date.now() > findDeadline) {
    console.error(`no pull_request candidate run appeared for ${sha.slice(0, 12)}`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

// Phase 2: wait for the check run the required status check watches.
const deadline = Date.now() + Number(timeoutArg ?? 25) * 60 * 1000;
while (true) {
  const response = await api(`/commits/${sha}/check-runs?check_name=candidate-gate&filter=latest`);
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
