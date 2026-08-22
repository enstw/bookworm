# Bookworm

A private Chinese-first reader: one Cloudflare Worker (`src/worker.js`), a
vanilla-JS PWA in `public/`, chapters in R2, reading positions in D1.

The v1 contract lives in `REQUIREMENTS.md`. This document is the current
architecture, organised by subsystem: each rule the code obeys, with the why
beside it — read the relevant section before reopening a decision in that
subsystem. Chronology and attribution are `git log`'s job, not this file's;
the pre-publication engineering history lives in the owner's private archive,
and commit bodies carry the investigations since.

## Development

- Fresh checkout: copy `.dev.vars.example` to `.dev.vars`, then
  `pnpm run db:init:local` — without the schema every table read 500s
  (`no such table`), and without the token every admin route 401s.
  Re-applying the schema is always safe (it creates, never deletes).
- `pnpm run dev` — wrangler dev on <http://localhost:8787>. Use pnpm, not
  npm — npm is disabled outright on the owner's machines (`npx` → `pnpm dlx`).
  The machines also set `strictDepBuilds`: a new dependency that carries a
  build script installs with only a warning, then fails the dependency check
  inside `pnpm test` — the fix is an explicit true/false under `allowBuilds:`
  in `pnpm-workspace.yaml` (false whenever only committed dist files are
  vendored; the entries there show the pattern), and
  `pnpm.ignoredBuiltDependencies` in package.json does NOT satisfy it.
- `ADMIN_TOKEN=<value from .dev.vars> pnpm test` — the suite, against a
  running dev server. Before running or writing e2e tests, read the runbook
  in `.claude/skills/e2e/SKILL.md`: it has the suite matrix and the two-stage
  offline runbook (which needs a genuinely dead server — DevTools offline
  emulation does not reach service workers).
- Never run `wrangler deploy` or `scripts/deploy.sh` by hand (a Claude Code
  hook in `.claude/settings.json` enforces this). Every deploy goes through
  the pipeline below.

### The owner's suggestion queues

Start a session by reading `/api/feedback` on the owner's live instance
(plain GET, no key; the origin is deliberately not written into this public
repo — on an owner machine read it from the untracked `.dev.vars`
(`BOOKWORM_ORIGIN=`), in workflows it is the `BOOKWORM_URL` secret, and
humans ask the owner). Each note is an improvement request the owner wrote
from the phone on `/admin` — treat it as a ticket. Only the owner clears
one, with 完成 on `/admin` (`DELETE /api/admin/feedback/<id>`, admin-gated;
the AI holds no key and never calls it), so when you ship a fix, say which
note it addressed so the owner can clear it. Whatever is still readable is
what the owner still considers open. The deploy-time sweep (`schema.sql`
used to empty the table on every apply) is gone: a pull-mode install runs
additive migrations only, so it never reached the host, and it swept
unaddressed notes along with the shipped ones.

The second inbox is `/api/testlog?page=report` (reader key required): each
row is one 🚩 tap on the player bar — book, chapter, char offset, engine and
the exact sentence under the voice at that moment. These are listening
tickets ("this bit sounded wrong") filed mid-session, when typing a note is
not an option; the sentence text is in the row precisely because it is
unreproducible once the session moves on. Rows ride the testlog quota
instead of being cleared by deploys, so cross-check recent ones against the
suggestion queue before treating them as open.

## Delivery pipeline

Merging to `main` does not deploy and does not release. Two dispatch-only
workflows, split by what they may touch:

- **`release.yml` — the routine act.** `gh workflow run release.yml`: the
  full test gate, then package → publish the release → ledger. It holds
  **no Cloudflare credential** (only the per-job `GITHUB_TOKEN`) and never
  runs `deploy.sh`; `test-deploy-policy.mjs` refuses a version that does.
  Upstream's own host is just the first instance to pull it — armed, soak 0
  (the fleet's canary) — not something the release pre-deploys.
- **`deploy.yml` — the repair tool.** The same gate, then `deploy.sh`
  push-deploys the host (reader, updater, D1 backfills, secrets) and only
  then publishes a release. This is what carries a change the pull path
  cannot: a new updater, a new secret, a column the host's live D1 needs
  before the worker that reads it. Renovate's weekly roll-up dispatches
  this one, so a dependency bump is still live-probed before it is published.

What the release path gives up is the live probe before publish — a build
the gate passed but Cloudflare will not serve can reach `releases/latest`.
What catches it is placed on the instances instead: the health check and
automatic rollback (PM-07), the never-retry rule for a version that failed,
and the fleet's soak behind upstream's zero-soak host. Work lands only
through a PR — the ruleset below rejects direct pushes server-side — so the
path of a change is: branch → PR → green `candidate-gate` → rebase merge,
and when a release is wanted: `release.yml` → gated publish → ledger.

### Landing a PR

Branch before the first commit. The ruleset's rejection surfaces only at
push time: committing on local `main` feels fine right up until the push
dies with `push declined due to repository rule violations`. A batch of
related work is ONE PR, not one per commit: branch, commit there, `gh pr
create`, then `gh pr merge <n> --auto --rebase` and walk away — auto-merge
is on, so GitHub does the waiting and lands it the moment the gate is
green. Rebase, not squash — squash would melt the per-commit
`Release-Note:` trailers the ledger reads. Watch instead (`gh pr checks
<n> --watch`) when you want to see the failure, not the merge. Already
committed on `main` by mistake? `git branch <name>`, `git reset --hard
origin/main`, then PR the branch as usual.

Expect the merge to be refused ONCE even on a green gate — "head branch is
not up to date" or `Required status check "candidate-gate" is expected`.
That is the ledger race, not a failure: a dispatched release or deploy lands
a release-ledger commit on `main` minutes later, and a strict required check
goes stale the moment the base moves — so it bites PRs in flight around a
dispatch, no longer after every merge. The recipe: `git fetch
&& git rebase origin/main && git push --force-with-lease`, which re-runs the
gate. Auto-merge survives that push, so there is no green window to catch by
hand any more — arm it once and the merge fires whenever the re-run lands.
The manual chain (`gh pr checks <n> --watch --fail-fast && gh pr merge <n>
--rebase`) is now only for when you are watching anyway. Give a fresh PR (or
push) a beat before watching: in the first seconds the check suite does not
exist yet and `gh pr checks --watch` dies immediately with `no checks
reported` instead of waiting.

### The deploy gate

The deploy workflow first runs the desktop suite via
`scripts/run-ci-tests.mjs` (the `pnpm test` chain, one log per suite); a red
run publishes a `test-failure-*` pre-release whose notes name the failing
suite and embed its log tail, and the deploy is skipped. The same gate runs
locally with `ADMIN_TOKEN=<value from .dev.vars> node
scripts/run-ci-tests.mjs` — it reuses a dev server already on 8787 or boots
its own.

The workflow splits its permissions per job: the `test` job executes the
pushed code, so it runs with `contents: read` and a credential-free
checkout — a compromised dependency in the suite has no token to write with.
`contents: write` exists only in `failure-report` (publishes the
`test-failure-*` pre-release from the uploaded artifact alone — it never
checks out or runs repository code, and refuses unexpected or oversized
artifact files rather than publish them) and in `deploy`, which starts only
after a green gate and is the only job that sees the Cloudflare/production
secrets. `scripts/test-deploy-policy.mjs` asserts the split and self-tests
that each seeded violation is caught.

### The pre-merge gate

The `candidate` workflow runs the full suite on every PR as a required check
named `candidate-gate` — same containment rules as the deploy test job
(read-only token, credential-free checkout, generated-not-secret env), never
`pull_request_target`. PRs opened with GITHUB_TOKEN (the release ledger,
renovate's roll-up) get their `pull_request` run created *held*
(`action_required`) — GITHUB_TOKEN events never start workflows on their
own — and the ruleset's required check waits on exactly that held run: a
separately dispatched candidate run builds a check suite that never
associates with the PR, so the PR stays blocked however green the dispatch
is. `scripts/wait-candidate-gate.mjs` therefore approves the held run (the
callers hold `actions: write` for this) and follows the check to a
conclusion before the workflow merges.

### The release ledger

The deploy job never pushes to `main` directly: it commits RELEASES.md to an
`automation/release-ledger-<run>` branch, opens a PR, waits for its green
`candidate-gate`, rebase-merges, and only then moves the `released` tag — if
`main` moved mid-gate the merge fails closed and the next release's ledger
covers both ranges.

### Repo settings outside the tree

Settings that live in GitHub, not in any file:

- Secret scanning with push protection is on.
- The ruleset "main: candidate-gate before merge" (that exact name, in
  Settings → Rules) blocks force-push and deletion and requires every
  change to arrive by PR (0 approvals, conversation threads resolved,
  rebase/squash only, linear history) with a green `candidate-gate` check
  from the Actions app, strict mode, no bypass actors — a direct push to
  `main` or a merge over a red gate is rejected server-side. A rebase that
  rewrites any other pushed branch is still fine — the ruleset only guards
  `main`.
- Merge-commit merges are disabled repo-wide, auto-merge is on
  (`allow_auto_merge` true, so `gh pr merge --auto --rebase` is the normal
  way to land one), merged branches auto-delete, and the update-branch
  button is on. In practice:
  `gh pr merge` needs `--rebase` or `--squash` and fails a stale head with
  "head branch is not up to date" — the ledger race in *Landing a PR* above.
  Watch a PR's gate with `gh pr checks <n> --watch` — the workflow's display
  name is `candidate` and the check's is `candidate-gate`, so `gh run list
  --workflow candidate-gate` finds nothing.
- **Actions must be pinned to a full 40-character commit digest**
  (`sha_pinning_required`, repo → Settings → Actions). `uses:
  actions/checkout@v7` no longer runs — write the digest and keep the
  version in a trailing comment, which is the form Renovate updates. A tag
  is a moving pointer, so the tag form means a compromised upstream reaches
  a workflow that already holds deploy credentials; the setting exists so a
  future workflow cannot quietly reintroduce the tag form.
- "Allow GitHub Actions to create and approve pull requests" is on —
  without it the renovate workflow's GITHUB_TOKEN gets a 403 opening the
  roll-up PR (the branch pushes fine, so the failure looks like Renovate
  silently doing nothing). The default workflow token permission stays
  read-only; jobs that write declare it per job.

### Dependencies (Renovate)

The `renovate` workflow runs every Monday morning; Renovate folds every
update — the wasmtts tag, the ENSFont pin, npm, Actions — into one
`renovate/weekly-roll-up` PR (`.github/renovate.json5`), and the workflow
merges it and dispatches the gated deploy. Major updates get their own PR
and wait for review. There is no Renovate App — the CLI runs in Actions, or
by hand via the command in the config header.

A third-party release must be **30 days old** before it can join a roll-up,
so a yanked or compromised publish has time to surface somewhere else first;
expect the pins to sit a release or two behind npm on purpose. Our own
upstreams (`enstw/wasmtts`, `enstw/font`) are exempt — we cut those tags.
The quarantine has one bypass: a dependency with a GitHub advisory gets an
immediate ungrouped PR, because Renovate's `vulnerabilityAlerts` defaults
override the wait.

Containment: the self-hosted Renovate CLI is an exact version, and the job
that runs it cannot dispatch Actions. A second job loaded from `main`
verifies the PR base/head/SHA and allows only monotonic exact dependency
pins, existing Actions' SHA/version lines and Renovate's own exact version
before it receives the separate merge/dispatch permissions. New files,
renamed files, scripts, workflow logic and Renovate config all fail closed
instead of riding the trusted bot branch into `main`. Two checks close the
holes a line diff cannot see: every URL in the lockfile must be the wasmtts
codeload source (a poisoned lockfile is how a clean package.json still
installs attacker code), and every moved action digest is resolved against
the upstream tag it claims (any fork-network commit fits the 40-hex format).
The font pin is deliberately outside the allowlist and outside the roll-up
group — its PR is a work order, not a change (see fetch-font.mjs);
`scripts/test-renovate-policy.mjs` pins the bypass cases.

An **off-schedule roll-up** is three steps, each with a known pit. (1)
Dispatch the `renovate` workflow. (2) If that run ends green yet opens
nothing while the dependency dashboard lists the roll-up under "Other
Branches: pending" — a recurring CI-token mystery; forcing the dashboard
checkbox does not help either — run the CLI by hand with the PAT, the
standalone node 24, and the workflow's own pinned renovate version:
`PATH="$HOME/.cache/node-v24.19.0-darwin-arm64/bin:$PATH"
RENOVATE_TOKEN=$(gh auth token) pnpm dlx renovate@<workflow's version>
--platform=github enstw/bookworm` — same config, PR up in ~30 s. (3) WAIT
for the roll-up PR's green `candidate-gate` (`gh pr checks <n> --watch`)
before dispatching the workflow again to merge and deploy. The wait exists
because of who opened the PR: GITHUB_TOKEN's candidate run is created held
and the merge step approves-then-waits on it, but a PAT-opened PR's run
starts immediately, and `verify-renovate-pr` fails closed on any check not
COMPLETED/SUCCESS — a too-early dispatch dies with "candidate-gate is
IN_PROGRESS" and costs only a rerun. Separately, an orphaned
`renovate/weekly-roll-up` branch (a branch with no PR) makes every later run
abort with "Repository has changed during renovation" — delete the branch
first. Validate any config edit with `pnpm dlx --package renovate
renovate-config-validator`, and keep the one config file: a stray root
`renovate.json` silently shadows `.github/renovate.json5`.

### Release notes

Release notes are written at ship time, never summarised. A reader who came
here for a novel must not be shown "ci: pin every action to a commit
digest", so RELEASES.md's commit subjects are the ledger and not the
message. The reader-facing line rides in the commit that earns it, as a
`Release-Note:` trailer written by whoever ships — the person or agent
making the change is the one who knows what it means, and they know it then,
not later. A commit without the trailer contributes nothing, which is how CI
and refactor work stays out of a reader's face with nobody filtering it, and
a release where nothing carried one says nothing at all. Upstream bumps need
no prose because the version numbers *are* the note: they are read out of
the `package.json` and `FONT_RELEASE` diff across the release, so a roll-up
week says something true even though renovate writes one commit subject for
the lot. **No AI summariser is involved and none is wanted** — and there is
no free way to host one anyway: GitHub Models, which would have been it, is
retired. `scripts/release-notes.mjs` is the single computation;
`gen-release-notes.mjs` writes `public/releases.json` **before** `deploy.sh`
(the deploy uploads it, so it must exist first) and `update-releases.mjs`
writes the same notes into RELEASES.md as `> ` lines **after** (a failed
deploy must not claim a release). Those `> ` lines are also where the
shipped JSON reads its history back from, so there is no second source of
truth. The reader fetches `/releases.json` only once `checkVersion` has
found an update — rare — and walks it down to its own build, so a phone left
alone for a month hears about the whole month and never about the version it
is already running.

### The reader announces itself

`checkVersion` in `app.js` can only run while a page is open, so an
installed phone nobody opened never learns a newer shell exists. The worker
has a cron of its own (`triggers.crons` in `wrangler.jsonc`, every minute)
whose `scheduled` handler, `announceSelf`, pushes 新版本已上線 down the same
channel 新書上架 uses — which is what puts the red dot on a closed app.
Exactly-once is the `announced_builds` row, keyed on the **commit alone** —
re-running the deploy workflow restamps the clock but is the same version,
and a rollback lands on a build that already rang. The first build on a
fresh install is recorded silently (it is the install, not news), a `dev`
stamp never rings at all, and a tick with nothing to do is silent in the
push log too — a line per minute would evict `page=push`'s own quota.
Tapping the banner opens the shell rather than forcing a reload:
`checkVersion` then raises 立即更新, and overriding it here would fight that
note's "seen it, not now" dismissal. Announcing only *some* deploys was
considered and dropped — a `sw.js` SHELL bump is about cache invalidation,
not about whether a change is worth hearing about, and md-only pushes
already skip the deploy entirely.

It used to be an admin route that `deploy.sh` POSTed after the deploy, and
that shape had a race the cron does not have: **the edge can still be
running the previous version seconds after `wrangler deploy` returns**, so
the call landed on the old isolate, which announced *its* stamp, found it
recorded and reported success while the build that had just shipped never
rang (measured on e96279f). The fix was a `?build=` handshake and a 30 s
retry. A version asking about itself from its own cron cannot be stale: an
old isolate that ticks once more finds its build recorded and does nothing,
and the next tick on the new version rings. The handshake, the retry and
the route are gone; the deploy makes no admin call to announce anything,
and the banner arrives within a minute instead of within seconds — once
the cron is live: **a Cron Trigger added for the first time took 20
minutes to start firing** (Cloudflare documents "up to 15"; measured on
the deploy of 34606e8, schedule created 16:26:57Z, first tick recorded
16:47:27Z), and `wrangler deploy` re-PUTs the schedule on every deploy, so
whether an unchanged schedule re-propagates is the next thing to measure
(`announced_builds.created_at` against the deploy log). The same
tick fires the pull-mode plan's four update messages — the reader is the
one Worker that holds the VAPID pair, so it sends and the updater only
records (PM-09). 新版本已上線 broadcasts from `announceSelf`; three go only
to keys marked 管理者, through `pushOwner`: waiting-for-you (`notifyWaiting`
reads the updater's `decide()` verdict in `updater_status.notify_version`),
failed-and-rolled-back (`alarmFailedInstall` reads the guarded install's
outcome), and the silent-updater alarm (`alarmSilentUpdater`, PM-14). Each
dedupes on a `*_for` column so a state that stands for many ticks rings
once.
Locally, `pnpm run dev` runs `wrangler dev --test-scheduled`, which exposes
the tick as `GET /cdn-cgi/handler/scheduled?cron=…` (answering a bare
`ok`); that is how `test:push` drives it. Not the older `/__scheduled`:
that path is not under `run_worker_first`, so the assets layer claims it
and the SPA fallback serves `index.html` with a 200 — a tick that never
ticked, with a green status.

### The release artifact

Every deploy also publishes what it deployed, as a GitHub release per
commit (`release-<sha>`: `manifest.json` + `bookworm-<sha>.zip`), because
the pull-mode design has every instance's
updater poll `releases/latest/download/manifest.json`. `scripts/package-
release.mjs` builds it from a **staging copy** of `src/` and `public/` —
stamps the copies, runs wrangler's `--dry-run --outdir` bundler on them (the
same esbuild pass a deploy runs, no credentials), hashes, zips — so it
works both inside the deploy (where `deploy.sh` has already stamped the
tree; a disagreeing stamp is an error) and from a clean checkout, and never
touches the tree. `scripts/publish-release.mjs` cuts the release after
`deploy.sh` and before the ledger step: only a live build is published, and
a commit that already has a release (re-run, rollback) is re-pointed as
`latest` with its assets untouched, so `released_at` keeps saying when that
build was first published. The stamp formula lives once, in
`scripts/build-id.mjs`: `deploy.sh` seds it into the tree and the manifest
carries it as `version`, and an updater compares the two strings verbatim.
**Reproducible means the clock cannot reach the bytes**: stamp and zip
mtimes are the commit's, and the two deliberate exceptions are
`released_at` (the soak clock — it must say when the release was
*published*) and `public/releases.json` (written from the ledger plus the
commits since the `released` tag, which moves after every deploy). Two
hashes per asset: `sha256` is download integrity, `cfhash` is wrangler's
`blake3(base64 + ext)[:32]` that Cloudflare's upload session keys on, so the
updater never computes it on the edge. A commit that needs a human at every
instance says so with a `Requires-Attention: <why>` trailer, the same shape
as `Release-Note:`; the manifest carries every such commit in history
(`attention`), not just this release's, so an instance that skipped the
middle release still sees it. The manifest's fields are a **stated
contract** pinned by `scripts/test-release-manifest.mjs` — exact field set
and types, hashes re-derived from the zip, two packagings of the same tree
hashing the same, and seeded violations each caught — and
`test-deploy-policy.mjs` refuses a `deploy.yml` that stops publishing or
publishes before the deploy. `artwork/icon-source.png` moved out of
`public/` for this: it is `make-icons.mjs`'s input, nothing fetched it, and
it was 2.9 MB of every upload.

### CI flake policy

A red suite is judged before it is retried. The one shape so far judged
infrastructure, not code: `push-api-e2e` failing with undici `SocketError:
other side closed` against wrangler dev (nine suites green in the same run,
adjacent runs on the same tree green) — a workerd connection drop. One
occurrence does not buy a retry mechanism; if the same shape recurs
(UND_ERR_SOCKET / "other side closed" against the dev server), give the
server-backed suites one automatic re-run in `scripts/run-ci-tests.mjs`
recording an `attempts` field — the wasmtts gate-runner pattern — and do not
start by suspecting the push code. The other known red was ours:
`admin-e2e`'s author assertion raced enrichment (fixed by waiting on
`metaPreview`), so a new `admin-e2e` red is a new problem.

The second shape judged infrastructure is `tts-stream-chain`'s page-turn
fixture, and its tell is `pageStartDiscriminates` reporting `page start 0`.
The suite pages forward with `#content.scrollLeft = -GRID.span` and then
waits a fixed 900 ms for the snap to settle, so a loaded runner can read the
offset before the scroll has landed; `noBackTurn` reporting `undefinedpx` is
collateral of the same miss, not a second defect. The evidence for calling
it infrastructure: the identical commit went green on a plain re-run and
green locally, with the other nineteen suites green in the failing run. If
it recurs often enough to be worth fixing, the fix is a `waitFor` on the
scroll position rather than a retry — a retry would hide a real page-turn
regression behind the same green.

The third shape was fixed rather than retried: the **first browser suite in
the run** dying at `launch()` with `browser never came up`, after exactly
the 20 s `cdp-client.mjs` allows, while every later suite's launch in the
same run is fine. Chrome's first start on a fresh runner is a cold binary
on a shared box. Measured 2026-08-20 on ubuntu-24.04 image 20260816:
`auth-e2e` took 13–18 s on eight green runs (8.6 s on the previous image),
33.8 s on one, then failed twice in a row on an identical commit. A longer
deadline would mean editing the vendored client, and a retry would hide a
real launch regression, so `scripts/run-ci-tests.mjs` now runs
`scripts/warm-browser.mjs` beside the dev-server boot — same binary, same
flags, throwaway profile — and reports it as a `browser-warmup` row with
the cold-start time and the browser that answered. A red `browser-warmup`
row means no browser suite could have passed; read it before any of them.

### Data migrations

This rule governs **upstream's own instance** — the one with a repo and
Actions. A pull-mode instance has neither, so it cannot run a
`workflow_dispatch` migration; its additive schema changes travel in
`manifest.migrations` and the updater applies them before the swap (see the
updater section above, PM-06). A *data reshape* (backfilling a column,
renaming a slug) is still a one-off dispatch here; a *schema addition* is now
declared once in `migrations.sql` and reaches instances through the manifest.

Data migrations are one-off dispatch workflows, not app code. There is
exactly one instance, so a change in stored shape never needs a
compatibility layer living in the app — it needs one migration run, then the
simple code. The recipe, proven by backfilling `books.chapter_chars`:
(1) prefer an existing admin API that already writes the target shape over
new migration code — reindex's upsert *was* the whole migration; (2) run it
from a `workflow_dispatch` workflow, because repo secrets are the only place
the production `ADMIN_TOKEN` exists — Actions is how this repo speaks to
prod (`renormalize-books.yml` set the pattern); (3) the repo is public, so
logs print counts, never titles or slugs; (4) end the job with a read-only
`wrangler d1 execute` assertion, so a green run IS the proof the data
moved — the fallback comes out on evidence, not on "the migration probably
worked"; (5) the PR that removes the fallback deletes the workflow with it,
like any other old form. Note the /admin page cannot be the migration path:
reindex has no button of its own — it runs as step one of 修復, which stays
dark while 健康檢查 finds nothing, and a row that merely predates a column
is not damage; a healthy shelf makes that route unreachable.

## Non-negotiables

- **A book's `id` is permanent; its `slug` is a renameable label.** R2 prefixes,
  D1 rows, cache names (`bw-book-<id>`) and localStorage keys all key on the
  id. Only URLs speak slugs, resolved through `book_slugs`.
- **Position is `(chapter index, character offset)`** — never a page number or
  a scroll offset. Server writes are last-write-wins on a timestamp; a late
  beacon from another device must never clobber a newer position.
- **Content sits behind a reader key, and the gate in `src/worker.js` is the
  list.** Which routes are gated, which are open by design, and which split
  by verb is stated there, beside the code that enforces it — a second copy
  in prose is how the two drift apart. What the gate does not say, and this
  does: a position or setting always belongs to the KEY's user, so
  client-asserted ids are ignored; keys are minted and revoked on `/admin`
  (`POST /api/admin/readers`); the admin Bearer passes the gate but has no
  reading identity; and e2e suites mint their own key, under the rules in
  the e2e runbook.

## Working agreements

How the owner wants agents to work here — stated preferences, kept in the
repo because session memory does not cross machines:

- **Explain before editing — and know which explanations need an answer.**
  Always state the diagnosis, the evidence for it, the planned change and
  how it will be verified, keeping the diagnosis separate from the fix so a
  wrong premise can be challenged on its own. Then judge what to do with it.
  Reversible work inside what was asked for gets done and reported, not
  parked behind a question: agents run here with nobody watching, and a
  question asked into an empty room is just the work not happening. Wait for
  a real answer before changing a rule in this document, before anything
  destructive or outward-facing, and before changing a contract — URLs,
  storage keys, routes, stored shapes. Measure instead of inferring whenever
  measuring is cheap. Verification must *gate* the push (`cmd && git push`),
  never narrate beside it — a `pnpm test | grep -i error; git push` once let
  a parse error deploy.
- **Test inputs come from pins, never working trees.** A harness fetches
  its inputs from the pinned upstream (release tag, manifest revision)
  into its own copy and verifies the SHA-256 — it never reads a live
  checkout's model folder, which is mutable working state and has changed
  mid-experiment. Saving a download is not a reason.
  `scripts/fetch-matcha-weights.mjs` is that fetch for the voice pack;
  `scripts/fetch-font.mjs` takes the typeface the same way, from the
  `FONT_RELEASE` tag rather than from any local font folder.
- **Branch before the first commit — work only lands through a PR.** The
  mechanics, including the ledger race every merge should expect, are in
  *Landing a PR* above.

## The phone is the product

iPhone Safari — usually the installed PWA — is the primary device, and desktop
e2e will not catch any of this:

- Nothing hovers. A `title=` is a desktop nicety; anything the reader has to
  act on belongs in what the control looks like.
- Size a new tap target for a thumb, not a cursor. (The reader toolbar is the
  standing exception: at phone widths its buttons give up padding so the
  chapter title survives.)
- Audio must start inside the tap gesture, never after an `await`.
- iOS drops Cache API contents *and* the service worker registration after
  ~7 days away unless storage was made persistent — call `persistStorage()` on
  any path that starts keeping data for later.
- 直排 (`writing-mode: vertical-rl`) is the default: forward is leftward, the
  scroller is `#content`, and its scroll events do not bubble.

## Security & identity

- **Why the reader key rides a cookie.** `<audio src>`, `sendBeacon` and
  service-worker fetches cannot carry a header, but all carry cookies. The
  cookie is server-set (HttpOnly, SameSite=Lax, 1 year) because Safari ITP
  caps `document.cookie` writes at 7 days and a weekly key prompt reads as
  the app breaking. localStorage keeps a copy only to re-earn the cookie
  after a 401 — one reauth attempt, so a revoked key fails into the gate,
  not into a request loop. Keys are stored in the clear deliberately
  (/admin re-showing one to a wiped device is a feature; D1 read access
  already implies every book and bookmark). Revocation fences the server
  only — chapters a phone already cached keep reading offline, which is the
  right meaning. `readers` has no deploy sweep, unlike `feedback`, or each
  deploy would log out every phone. Cloudflare Access was rejected:
  redirect auth silently turns manifest/beacon/SW fetches into
  302→login-HTML in an installed PWA, and cannot ship with a fork.
- **Identified API responses are `no-store`.** The browser HTTP cache does
  not vary on credentials: `/api/books` once answered the admin Bearer with
  `public, max-age=60`, so on the owner's phone the /admin list fetch
  seeded a cached copy that the reader-cookie shelf then read for the next
  minute — a just-uploaded book missing from the shelf. Every 200 on that
  route is identified (keyless requests 401), so the public copy served no
  one; it is `no-store` for every identity now. Offline loses nothing — the
  shelf's offline path is the app's own `bw_books` copy, never the HTTP
  cache.
- **Secrets hygiene.** The owner's contact address and the live origin were
  scrubbed from the tracked tree before publication and are never
  reintroduced: the contact exists only in the `VAPID_SUBJECT` repo secret,
  the origin only in the `BOOKWORM_URL` secret and each owner machine's
  untracked `.dev.vars` (`BOOKWORM_ORIGIN=`). Actions masks secrets in logs
  but NOT in step summaries, so a workflow must never echo the origin into
  `$GITHUB_STEP_SUMMARY`. The pre-publication history lives only in the
  owner's private archive repo and its local clone
  (`~/workspace/bookworm-archive`); never push any of it here.

## Worker platform

A Worker gets 6 simultaneous open connections and 50 subrequests on the free
plan; anything fanning out over R2 goes through a bounded pool (`mapPool`),
and admin loops are paged so the worst case stays inside the budget.
miniflare enforces none of this — violations are production-only failures —
so the ceiling is asserted directly by `scripts/test-worker-pool.mjs`. Every
route handler must be `return await`ed: a promise settling outside the `try`
escapes as a bare platform 1101 with no message. R2 has no server-side copy;
buffer a copy through `arrayBuffer()` so it holds one connection, not two.

### The second Worker: bookworm-updater

An instance is two Workers on one account.
`bookworm` is everything above — public routes, uploads, `/admin`, the
reader cron. `bookworm-updater` (`src/updater.js`, `wrangler.updater.jsonc`)
is **cron-only: no fetch handler, no route**, so nothing outside Cloudflare
can invoke it. It is the one place that talks to upstream, and it is where
the Cloudflare API token that can rewrite the reader will live (PM-05) —
never in `bookworm`, the largest attack surface (R1), and separate so a
release that bricks the reader cannot take the thing that would roll it back
(R3). Both Workers bind the **same D1**; that shared binding is the only
channel between them. The entry module exports only the handler — workerd
rejects any non-handler export from a Worker's entry — so the logic and the
`UPDATER_VERSION` integer live in `src/updater-core.mjs`, which imports none
of the reader's code (the updater "barely changes", which is what keeps
"update the updater" a rare act).

What landed in PM-04 is the split plus the read-only half of the cron: every
~15 min the updater fetches `UPSTREAM_URL`/`manifest.json` — `https://`
enforced (TLS is the whole trust anchor), `cache: "no-store"` because
`latest/download` is a stable URL with changing contents — and writes what it
saw to the single `updater_status` row, where `/admin` will read it (PM-08)
without ever contacting upstream itself. The configured `upstream_url` rides
every write — success and failure — so the panel can name the feed this
machine follows in plain language, or warn loudly when none is set (the
orphan state is a warning, not a detail string). Display-only, on purpose:
if `/admin` could *set* upstream, a stolen `ADMIN_TOKEN` would become code
execution — point the feed anywhere, install now — so changing it stays an
owner act with Cloudflare credentials (bootstrap re-run or a deploy
dispatch), never the panel (R1). A failed check keeps the last
known-good `upstream_version` and only moves `last_check_at`/`ok`/`detail`, so
a transient outage reads as "checked N ago, failed" rather than erasing the
version. It installs nothing — the upload path, the token and the panel are
PM-05/PM-07/PM-08 — so the Worker deployed to the account today can do no
more than record a version string, and with no `UPSTREAM_URL` secret set it
does not even do that. `checkOnce` takes a store and a fetch seam, so
`scripts/test-updater.mjs` exercises it with no account; `scripts/deploy.sh`
deploys it beside the reader (`--config wrangler.updater.jsonc`) and rewrites
its `database_id` the same way. The bootstrap sets `UPSTREAM_URL` on every
instance it creates, which left the repo-backed host the one install nobody
configures — an orphan whose updater reports "未設定" forever — so
`deploy.sh` defaults the secret to the clone's own GitHub releases feed,
derived from `origin` (`https://github.com/OWNER/REPO/releases/latest/download/`);
the env var overrides, and a non-GitHub origin stays inert as before.

**Trust is TLS, not a signature.** The manifest and bundle are trusted because
they came over `https://` from the release host, and nothing else — there is no
code signature. A signature would be checked by the updater's own verification
code, which is itself part of what a release replaces (R2), and R1 already
concedes that whoever can rewrite the reader Worker has already won; a signature
checked by replaceable code guards against nothing that model does not already
give away. So a malicious or broken release is unrecoverable **by update** — a
one-way door — and the mitigations are placed elsewhere: the health check and
automatic rollback catch a release that breaks *this* instance (R3), and the
minimum-age soak plus upstream's zero-soak canary catch one that breaks the
fleet, before most instances ever fetch it (R9). Neither eliminates the risk;
they are what a design with no diff-review and no signature can still afford.

**The install path** (PM-05, `install()` in `updater-core.mjs`) is the
updater's one risky act: download the release bundle, `sha256`-verify every
file against the manifest (download integrity, not authenticity — TLS to
upstream is the anchor), open an assets-upload session, upload only the files
Cloudflare says it lacks (base64 via `Buffer`, never chunked `btoa` — 5× the
edge CPU, PM-00), and `PUT` the reader script. The `PUT` re-declares **only**
`ASSETS` (it carries the fresh upload token) and keeps every other binding by
type via `keep_bindings` — the types read off the live script before the
swap, so the keep set is exactly what is there — which is how the updater
holds **no reader secret** yet cannot drop `ADMIN_TOKEN`, the VAPID pair, the
D1 id or the bucket (R4). `compatibility_date`/`_flags` and the assets config
come from the manifest, never re-typed (R6). Two guards: the session JWT's
`wrangler_single_asset_uploads` claim is read before any upload and is a
**refusal**, not a fallback (one-file-per-request breaks the subrequest
budget at 42 files, PM-00 fact 2); and after the `PUT`, `install()` re-reads
the script's bindings and secrets and throws if anything that was bound
before is gone — R4's loud failure. Confirmation is CF-API-side because a
Worker cannot fetch the reader over `workers.dev` (error 1042, PM-00); that
the new version actually *serves* is the HTTP health check in PM-07. A
release that needs a schema change carries it in `manifest.migrations`
(from `migrations.sql`, gated additive-only by `src/migrations.mjs`), and
`install()` runs them against the shared D1 **before the `PUT`** (PM-06,
R5): the new code finds its columns, and because every migration is
additive the old code survives them if the swap rolls back. They are
idempotent — a duplicate-column error is a migration already applied on
this instance.

**The safety net** (PM-07, `installWithRollback()`) is what an install is not
allowed to run without. It checks health BEFORE the install, installs, checks
AFTER, and rolls back **only if a working site regressed** — the pre-install
baseline is not optional, or a site already broken oscillates install → red →
rollback forever, blaming each release for damage that predates it. "Healthy"
is two requests in order: `/api/version` **polled** until the new `BUILD`
answers (the swap can take seconds to propagate past the `PUT`, and a check
that runs at once reads the old worker and calls it green), then `/api/books`
— because `BUILD` is a compiled-in constant a release that unbound D1 would
answer cheerfully, while `/api/books` touches the worker, the D1 binding, the
`readers` row and the shelf in one request and is the real verdict. The
updater reaches the reader through a **`READER` service binding**, not the
internet (a Worker fetching its instance over `workers.dev` is error 1042,
PM-00); it authenticates with a reader key it mints in the `readers` table it
already writes (shows on `/admin` as the reader `updater`, revocable, no admin
power). The script it *rewrites* is `env.READER_SCRIPT` — the reader's own
name, set on the updater by the bootstrap so a renamed or throwaway instance
never targets the wrong Worker; upstream's own updater leaves it unset and
falls back to `bookworm`. Rollback is Cloudflare's own version rollback — one `POST
…/deployments` naming the previous `version_id`, script and assets restored
together (PM-00 fact 4), nothing kept on the instance. The outcome (`ok`,
`rolled-back`, `failed`) lands in `updater_status` for the panel (PM-08), a
rolled-back one included.

The whole loop is **wired but gated on a token the owner sets**. The
`scheduled` handler checks every interval and then calls `runInstall()`,
which returns at once unless `CF_API_TOKEN` (and `CF_ACCOUNT_ID`) are on the
updater — so the machine is complete and inert until the owner arms it, and
arming is the single act of setting `UPDATER_CF_API_TOKEN` (`deploy.sh` pushes
both secrets, the account id defaulting to the one the deploy already uses).
Armed, `runInstall()` reads the running version through the reader, the policy
and last install from D1, asks `decide()`, and — only on "install" — takes the
lock and runs `installWithRollback()`, recording the outcome and clearing a
satisfied install-now. The credential arrives with the safety net, never
before it: the token that can rewrite the reader is placed only once the
health check and rollback that catch a bad release are in. Every piece is
proven live against throwaway targets — `install()` took the real published
release (42 assets, 7.6 MB, ~15 s) with every binding and secret surviving;
`installWithRollback()` installed a deliberately broken release (its
`/api/version` answered while `/api/books` 500'd) and put the previous version
back — and `scripts/test-updater.mjs` pins every piece against fakes: verify,
metadata, the single-asset refusal, the dropped-secret throw, the health-check
verdicts, the deployments API, key minting, the rollback matrix with its
no-oscillation guard, and the armed cron loop's own gate (no token → nothing
installs) and glue (installs on "install", skips on "skip", skips a held
lock). And the fleet behaviour itself was proven with two instances side by
side (PM-13): both stood up behind a release and armed, one **automatic** and
one **pinned**, they diverged on their own crons with nobody installing by
hand — the automatic instance took the release (`37f9ab2` → `c907f0e`) and
rolled it in clean while the pinned one stayed put, and production was
untouched.

**When an install may happen** (PM-15, `decide()`) is the decision layer, kept
separate from how (PM-05) and did-it-work (PM-07): three modes — **automatic**
(install once a release has soaked N days), **notify** (push and wait for the
button), **pinned** (stay, still check) — and three overrides that are not the
owner's choice: `requiresAttention` downgrades automatic to notify, a
`minUpdaterVersion` newer than this updater **refuses** (better than half an
install), and a version that failed is **never retried automatically** (or the
next check reinstalls it, fails, rolls back, forever). An `/admin` "install
now" is a deliberate human choice that overrides the soak, the mode, the
attention downgrade and the failed-version block — but never `minUpdaterVersion`.
The default is **automatic after 2 days**, and upstream's own instance runs
with a soak of zero, which makes it the fleet's canary at no code cost: the
author is always first to hit a bad release. `decide()` is pure — every input
passed in — so the table test covers the whole matrix; it decides only, and
`installWithRollback()` acts. One install runs at a time, held by
`install_lock` in D1: `acquireInstallLock()` is a conditional `UPDATE` whose
row-count is the verdict (atomic in the database, not a read-then-write race),
and a lock older than the stale window is reclaimed so a died-mid-install
isolate cannot wedge the updater. `decide()` is called by PM-08's
`runInstall()` in the cron; the policy it reads is stored by the `/admin`
panel.

### The bootstrap: the first install, from a laptop

An instance is a Cloudflare account with no repo, no clone and no CI, so the
FIRST install cannot come from the updater — no Worker can create the D1, R2
and two scripts it has not been placed into yet, and the 12 MB `public/` does
not fit in a scheduled invocation's CPU budget anyway (R8). That first install
is a one-shot the owner runs from a laptop. `src/bootstrap-core.mjs` is the
orchestration over the Cloudflare API: find-or-create the D1 and the R2 bucket,
apply `schema.sql`, upload the reader (its `public/` unzipped from the release
bundle the updater would install, verified against the manifest first) with
FULL bindings — its own D1 id, its bucket, `ASSETS` — and no `keep_bindings`,
because nothing is there to keep yet; set `ADMIN_TOKEN` and the VAPID pair as
secrets AFTER the create (so the updater's `keep_bindings` preserves them on
every later swap); enable the workers.dev subdomain; place the cron-only
updater with the shared D1 and a `READER` service binding, its `UPSTREAM_URL`
and — deliberately — **no `CF_API_TOKEN`, so the instance comes up unarmed**;
and mint the owner's first key (`is_owner = 1`). It is idempotent, because
PM-16 re-runs it to replace the updater in place: an existing database, bucket
and owner key are reused, not clobbered, and a just-created D1 that is not yet
bindable (Cloudflare 10021) is waited out with a retry on the script PUT. A
re-run also keeps secrets: a script that already exists is PUT with
`keep_bindings` for its secret types and a secret already set is not re-set, so
`ADMIN_TOKEN`, the VAPID pair, `UPSTREAM_URL` and a `CF_API_TOKEN` the owner
armed all survive — updating the updater is not a disarm. `BW_MODE=updater`
narrows a re-run to the updater alone (PM-16), the remedy when a release is
refused on `minUpdaterVersion`: the newest `bootstrap.mjs` carries a newer
updater, replaces it in place, and its next check takes the release it had
refused.

The delivery is one self-contained file. `package-release.mjs` esbuild-bundles
`scripts/bootstrap.mjs` — fflate inlined, only `node:` builtins external — with
`schema.sql` and the bundled updater baked in, and `publish-release.mjs`
attaches that `bootstrap.mjs` to every GitHub release beside `manifest.json`
and the reader bundle. The owner downloads the one file and runs it with
`CF_API_TOKEN`, `CF_ACCOUNT_ID` and `UPSTREAM_URL` in the environment (never
argv); the reader release is fetched from `UPSTREAM_URL` at run time, so the
12 MB never rides in the bootstrap. The token is the broad, one-time kind that
can create D1/R2/Workers — deletable the moment it returns — and is a different
principal from the narrow one that later arms the updater. The reader release
manifest and zip are untouched by all this: the bootstrap is its own asset, so
PM-01's strict artifact contract is unchanged. A clone can run the same command
through `scripts/bootstrap-cli.mjs`, which rebuilds the baked payload from the
tree, so the repo never grows a second, diverging install path.

## Reader frontend

- **The paged grid.** Both writing modes page on an integer grid:
  `pitch = floor(width / 每頁行數)` in whole px (iOS snaps line advances to
  whole pixels — a fractional pitch creeps and leaks sliced columns),
  `字級 = pitch × ¾`, and every block spans a whole number of lines by
  construction. In 直排, `#content` is exactly N×pitch wide inside a
  clipping `#pagebox`, so a sliced column is unrenderable; in 橫排 the grid
  is phase-anchored to the reading band below the topbar. Page k is pure
  arithmetic. 字級 is calibrated once, in 直排 portrait (`bw_calibw`);
  rotation and mode switches change the column count, never the text size.
  每頁行數 is per-device and deliberately unsynced — a phone and a tablet
  want the same physical size, which is a different count on each. `bw_font`
  still syncs but renders nothing; dropping it costs a schema change for no
  user-visible gain.
- **iOS applies every relative scroll twice.** An on-device matrix (24
  cases: 3 APIs × anchor on/off × 直/橫排 × element/document scroller)
  proved `scrollBy` double-applies on the tested iOS build, Safari and
  installed PWA alike, while absolute `scrollTo`/`scrollLeft=` are always
  1×. Never reintroduce `scrollBy`; every landing is an absolute assignment
  (`vSnap`/`vSlide`, native smooth `scrollTo`). Chromium is 1×, so e2e can
  only guard the invariant, not reproduce the bug.
- **What syncs and what doesn't.** fontSize/vertical/bg follow the reader id
  through `/api/settings` (LWW, client timestamps clamped server-side to
  now + 60 s, same as positions). Theme, language, 每頁行數 and wake lock
  describe THIS screen and stay per-device on purpose. `resolveSettings`
  runs before `buildReaderShell` so server-wins applies pre-paint; if it
  ever moves after `openChapter`, redo the toggleVertical dance. An identity
  change zeroes `bw_settings_ts` so the device adopts the new id's settings
  instead of clobbering them.
- **"/" resumes the book.** Bare "/" resumes `bw_last_book`, recorded only
  once a manifest actually loads so a typo'd URL can never become what every
  reopen runs into; the shelf's explicit address is `/?shelf`; enrolling via
  `/?key=` still ends on the shelf (a key link is device setup, not
  reading). The resume is all-local, and the position reconcile is capped
  (see the network cap below) — reading must not wait on a bookmark the
  device already holds. The legacy `/<book>/<uid>` route is deleted, not
  shimmed. An online not-found forgets `bw_last_book`; an offline not-found
  forgets nothing.
- **開機的網路上限 — 1 s.** A dying cellular link does not fail fetches, it
  hangs them for 60+ s, so "opening takes forever on bad signal" is never a
  slow answer — it is a question nobody was going to answer. `NET_MS = 1000`
  caps it, once in `public/app.js` (`capped()`) and once in `public/sw.js`.
  Capped, because the device already holds an answer — position, settings,
  slug→id, the shelf list when `bw_books` exists, the manifest when a cached
  copy exists. Uncapped, because the
  network is the only answer and a cap would turn slow into broken — a
  first-ever shelf, a book never cached, an uncached chapter; the sw.js
  handlers get this for free from `res ?? cached ?? net`. Losing a capped
  race cannot lose data: positions and settings are LWW by `updated_at`
  server-side, so the local-wins push that follows a timeout can never
  clobber a fresher row. Measured on the primed offline-e2e profile against
  a server that accepts TCP and never answers: 11.1 s → 3.1 s to rendered
  chapter text. `/api/version` deliberately keeps its 4 s — it blocks
  nothing, and a 1 s cap would just make the update notice never show on a
  slow link.
- **The service worker never improvises a document.** For documents the SPA
  cannot route, the SW never falls back to the cached shell (`OWN_DOCS` in
  `sw.js` — a slow-network `/wasmtest` used to come back as
  「沒有名為《wasmtest》的書」), and those URL names are refused as book
  slugs (`RESERVED_SLUGS` in `split-core.mjs`, enforced in `registerBook`
  and the slug PATCH, skipped by `uniqueSlug` like any collision).
- **The shelf is 書衣, drawn on static markup.** "/"'s screens (gate, shelf,
  install guide, message) are static sections in `index.html`, admin-style:
  `showScreen` raises exactly one, zh defaults live in the markup and the
  shared `applyI18n` in `i18n.js` sweeps `data-i18n` / `data-i18n-title`,
  JS fills only what carries data. A language switch is therefore a sweep
  plus a repaint, never a refetch, and e2e asserts a section's `hidden`,
  never an id's existence — the ids are all still there when a screen is
  down. The shelf paints device-first, the same rule positions follow: a
  cached `bw_books` renders immediately and the capped fetch can only
  improve it (fresh list, or the stale mark). Visually every book wears a
  線裝書 cloth cover with a pasted 題簽 — cloth tone hashed from the
  permanent id so a re-slug keeps its cover; cloth and slip are MATERIAL
  colors, deliberately fixed, picked to stand on all 13 papers and the dark
  theme — and the device's open book (`bw_last_book`, the same book "/"
  resumes) leads as the 續讀 hero card. Progress is the accent 讀線,
  rounded to whole percent: the thread carries the precision. A real cover
  is a pure R2 convention, `books/<id>/cover.jpg`: it paints over the cloth
  and the `<img>`'s error handler removes it, so the cloth is also what
  offline and cover-less books wear. Still no manifest field: the
  enriched-zip upload on /admin (see *Enrichment* under Admin) just PUTs the
  canonical JPEG; the worker serves book images with real content-types and
  a day's cache (replaceable, unlike chapters), and the audit exempts the
  enrichment sidecars from stale-file accounting. Motion budget on the
  shelf: nothing beyond the existing busy-pulse. The reader surface's
  measured decisions (grid, 字級, bars) are untouched by all of this.
- **The shelf list is one D1 round trip, and it authenticates itself.**
  `/api/books` used to answer in a flat ~1.1 s from Taiwan — measured, not
  load: authenticate, the list, the reader's positions were three
  *sequential* D1 round trips, then an R2 manifest read per in-progress
  book for the chars-before-bookmark sum. The fix is structural, twice
  over. Per-chapter char counts ride the index row (`books.chapter_chars`,
  JSON, written by `registerBook`; pre-column rows were backfilled once by
  a dispatch workflow — see *Data migrations* — and the R2 manifest
  fallback was removed with it, so the route never touches R2). And
  listBooks left the shared gate: it runs its own single `env.DB.batch` —
  key lookup, shelf, positions joined by the same key subquery — with
  identical credentials and 401s, which is the one deliberate exception to
  "the gate authenticates every content route" (documented at the gate).
  The client keeps a safety margin on top: the shelf's capped fetch allows
  2.5 s before painting the cached list as stale, because at the old 1 s
  cap a well-connected shelf sat permanently — and wrongly — marked 離線.
- **Chapter bodies are blank-line free.** The reader renders one `<p>` per
  line that survives `trim()`, so a blank line is pure char-offset
  padding — and "blank" must mean *takes no ink*, not just whitespace:
  scraped novels pad chapters with zero-width spaces, braille blanks
  (U+2800), and Hangul fillers, which pass `trim()` and render as empty
  paragraphs. `normalizeBody` in `split-core.mjs` strips zero-width
  characters (`GHOST_CHARS`) outright, drops ink-free lines, and runs at
  import — CLI and /admin both pass through `piecesToEntries` — while
  `scripts/renormalize-books.mjs` applies the identical, idempotent rule to
  books already in the store through the admin API (chapters first,
  manifest last with fresh chars/bytes/generatedAt so `?v=` caches bust and
  the shelf index stays honest; the log prints removed codepoints and
  1-based chapter numbers, never titles).

## Positions & sync

- **Runaway-bookmark defenses.** `savePos` no-ops when (chapter, offset) is
  unchanged, so opening a link never re-confirms a stale position; tap
  paging parks while a chapter is loading; a synced position ≥ 2 chapters
  from this device's own last record shows the dismissible jumpnote pill
  with one-tap restore. The original +100-chapter jump was never
  conclusively reproduced, so the recovery UI is the load-bearing fix.
- **The bookmark pull runs in the background.** `resolvePosition`
  reconciles once, when the book opens — and an installed PWA is
  *reopened*, not reloaded, so that one answer used to stand for as long as
  the app stayed alive: a device that opened offline kept a stale bookmark
  even after the network came back, because the `online` handler only ever
  pushed. Both directions now recover. `checkRemotePosition` re-runs the
  reconcile on the foreground flip (how a phone "reopens") and after the
  online flush, and answers with the same pill vocabulary as the runaway
  defense above — it **never moves the page**, because "the other device is
  ahead" is a weaker claim than "this reader asked to go there". Its rules:
  it stands down while `state.dirty`, since a row that has not seen our own
  writes has nothing to teach; it takes the looser 4 s cap rather than
  `NET_MS`, on `checkVersion`'s reasoning — it blocks nothing, and a 1 s
  cap on a slow link would just mean the notice never arrives; each remote
  `updated_at` is offered exactly once, so a dismissal stays dismissed; and
  a same-chapter difference is silent, because the pill would name the
  chapter the reader is already in and two devices a few paragraphs apart
  resolve themselves on the next LWW write. Direction is not a criterion —
  a phone that jumped backwards is news too. Settings deliberately do NOT
  get this treatment: a background `resolveSettings` would reflow a
  rendered chapter, which is the one thing its own comment forbids. Reader
  event listeners live in `wireReaderEvents()` behind a once-guard:
  `initReader` re-enters (a repaired 401, the key gate's retry) and today
  both paths turn back before the tail, so nothing doubles — the guard is
  what keeps that from being load-bearing. `test:sync` pins all of it,
  counting window listeners per registration *site* rather than per type
  (app.js and player.mjs both own a `pagehide`, correctly).

## Push

- **Push stays healed, not assumed.** The VAPID public key is derived from
  the private JWK at runtime, so `applicationServerKey` and the JWT can
  never drift. The phone's 已訂閱 is only its own opinion: `healPush()`
  re-upserts the device's real subscription at every open, and
  `forceRefresh` unsubscribes and retires the server row BEFORE
  unregistering the service worker, which is what destroys the
  subscription. iOS shows nothing unless every push shows a notification,
  and the app-icon red dot is an explicit `setAppBadge` call. The whole
  chain — worker send, push-service status, SW receipt, badge — logs to
  `testlog` page=push, and the 測試 button pushes the phone itself so each
  outcome names a different fix.
- **The owner-only channel rides the key, not the user.** Some messages are
  the owner's business and nobody else's — an update waiting for a
  decision, an install rolled back, the updater gone silent (the pull-mode
  plan, *Who gets told*). `readers.is_owner` marks the owner's devices and
  `pushOwner()` in the worker is the one sender for all of them; it selects
  `push_subs` rows by the **key** that registered them (`push_subs.key`,
  written by subscribe from the authenticated identity, '' for the admin
  Bearer), because a household may share a `user` and the owner may carry
  two phones — a user-level join would have rung the family tablet. Rows
  from before the column fill themselves in: `healPush()` re-upserts at
  every open, so no migration. **With no key marked, nothing is sent** —
  never a broadcast fallback — and the silence is said out loud in two
  places: the push log line and the 讀者鑰匙 fold on /admin, which names the
  three messages that are currently going nowhere. The fold's 測試管理者通知
  button (`POST /api/admin/owner-test`, fixed payload, admin-gated) rings the
  marked devices and only those, and its response tells "no key marked"
  (`owners: 0`) apart from "marked but that phone never subscribed"
  (`owners: 1, subs: 0`) — the same two-silences rule the 測試 button
  follows. A generic "push this text to the owner" admin route was
  considered and refused: a door that rings the owner's phone with
  arbitrary text is a door. `test:push` pins the routing with two keys under
  one user. Schema evolution as everywhere: `schema.sql` gains the columns
  for fresh installs, `scripts/deploy.sh` carries the guarded `ALTER`s for
  the live table.
- **Marking pushes read means close(), because iOS never unlists what the
  user swept away.** The SW sets the app-icon badge to
  `registration.getNotifications().length` when a push lands, so the number
  is accumulation, never "how many pushes this release sent": consecutive
  version announcements log 系統列出 N 則 with N growing by one each time.
  The sharp edge: that list is the registration's own store, NOT the
  notification center — sweeping the center clean and waiting ten minutes
  does not shrink it (measured: a 測試 push after exactly that still logged
  系統列出 6 則, which is what killed the first reading, "iOS purges cleared
  entries lazily"). The only removal the app controls is
  `notification.close()`, and
  when the only close anywhere was the tapped notification, every untapped
  one lived on as a ghost the badge re-counted forever. So opening the app
  closes every shown notification (clearNews in app.js, the same moment the
  badge clears): "opening the app is what marks the news read" does what it
  says. Sends are not the suspect — the push log shows each delivered
  exactly once. Verify on the phone after a deploy: sweep the tray, open
  the app once, 測試 — the push log should read 系統列出 1 則；badge 1.

## Diagnostics (testlog)

- **testlog is the phone's console, and it is split by verb.** An iPhone
  has no console and a push lands with no page alive, so the diagnostic
  pages (`/vhtest`, `/pgtest`, `/scrolltest`, `/pagedtest`, `/wasmtest`,
  `/speechtest`, linked from /admin), the player's flight recorder and the
  service worker all drop their readouts here — a permanent tenant.
  **Reads are gated**: the rows quote the book (dropped glyphs, synthesis
  prompts), and that is content. Read them with
  `curl -H "authorization: Bearer $ADMIN_TOKEN" '<origin>/api/testlog?page=…&limit=5'`.
  **Against production that curl 401s from a dev machine every time**: the
  `ADMIN_TOKEN` in `.dev.vars` is the local dev token, and the production
  token lives only in `wrangler secret`, which cannot be read back. The
  testlog GET gate also accepts a reader key, so agents use one: a
  production reader key lives untracked in `.dev.vars` as
  `BOOKWORM_READER_KEY` (minted by the owner in /admin) —
  `curl -H "x-reader-key: $BOOKWORM_READER_KEY" "$BOOKWORM_ORIGIN/api/testlog?page=…&limit=15"`.
  If the slot is empty on this machine, the fallback that needs no new
  credential: the owner's signed-in browser carries the same kind of key as
  a cookie — drive Chrome (claude-in-chrome tools) to the URL and read the
  JSON off the page. When reading `page=push`, one push involves up to
  three writers per event: `device:page` (the 測試 button's preflight),
  `device:worker` (one line per send, with per-endpoint push-service
  status), `device:sw` (one line per push the phone actually received,
  ending `系統列出 N 則；badge N`). "How many pushes really landed" is the
  count of sw lines — the badge number is read off the sw line, never
  inferred.
- **Writing the testlog needs a cookie, because the writers cannot send a
  header.** `POST /api/testlog` takes the `bw_tlog` cookie, not a Bearer:
  sendBeacon takes only `(url, data)` — no headers argument
  exists — and it is what every uploader uses, because it is the only send
  that survives `pagehide`; a service worker has no page to read a token
  from either. What that rules out is a *header*, not a *credential*.
  Cookies are exactly the carrier this codebase already uses for
  `<audio src>`, sendBeacon and SW fetches (see *Security & identity*), so
  /admin mints `bw_tlog` from the Bearer on every unlock and the three
  sendBeacon call sites carry it for free. It is **not** the admin token in
  a cookie: the value is a stateless
  `<exp>.<HMAC(ADMIN_TOKEN, "testlog:<exp>")>` — no session table, no D1
  read on the write path, and rotating `ADMIN_TOKEN` invalidates every
  outstanding one at once. It cannot reach `/api/admin/*` either, and not
  because of a `SameSite` rule: `handleAdmin` checks the Bearer header
  itself and never reads a cookie, so the route structurally cannot see
  this credential. The cost, accepted deliberately: a device with only a
  reader key does not log. `player.mjs` (page=player) and `app.js`
  (page=push) run in the reader app, so on someone else's phone those go
  silent — "did THEIR phone get the notification" is not answerable from
  the log. The alternatives were worse. A body token needs a `fetch` probe
  to be observable at all, because sendBeacon returns whether the UA
  *queued* the request and never the status — a 401 is invisible, so a
  stale token is permanent silence with no signal anywhere. And a signature
  is not merely expensive but structurally impossible on the path that
  matters: WebCrypto is async, and a `pagehide` handler cannot await.
- **The testlog quota is per page, because a shared window is won by the
  loudest writer.** A single newest-500-rows prune was not shared, it was
  raced for: `player.mjs` heartbeats every 10 s and coalesces on a 1.5 s
  timer, roughly six rows a minute, and one 83-minute listening session
  evicted the entire table — including the `page=push` breadcrumbs, the
  lowest-volume and highest-value rows in it, and the only witness to
  whether a phone got a notification. Auth does not fix this; it happened
  on one device, to itself. So rows are budgeted per page instead
  (`TESTLOG_PAGES` in `src/worker.js`: player 200, push 120, report 40, six
  diagnostic pages 30 each), which also makes the page list load-bearing — a
  quota is per bucket, so an unlisted page name would be an unbounded row
  count, and
  `ELSE 0` drops rows in pages nobody lists (which is how pre-quota rows
  clean themselves up). The prune runs on every 25th insert rather than
  every one: it is a full-table scan, and on D1's free plan rows-**read**
  binds long before rows-written — every-insert pruning cost ~3000 reads a
  minute with the recorder running. The table drifts at most 24 rows over
  quota in between, which buys a 25× margin. `testlog (page, id DESC)`
  indexes both readers: the gated GET and the prune's window function.
- **The diagnostic-upload switch is a door on your own house.** `/admin` →
  裝置診斷 has a checkbox that stops THIS device's diagnostic pages from
  POSTing readouts (`bw_testlog` in localStorage, read by
  `public/testlog.js` before every send). It is not the gate — the gate is
  the `bw_tlog` cookie in the worker, a different door on a different wall,
  and nothing in `testlog.js` reads or sends that cookie because it rides
  sendBeacon by itself. What the switch buys is the source of noise the
  gate cannot see, since the noise is your own: six pages uploading on a
  redraw loop will fill their own quotas by themselves, and turning them
  off needs no deploy. The service worker's push breadcrumb deliberately
  does **not** ride the flag — a SW cannot read localStorage, reaching it
  would cost a message channel, it is one row per push rather than a loop,
  and it is the line most worth having in the field. The upload block lives
  once in `testlog.js`, not copied per page — a flag checked in five copies
  is a flag that works in four. A device with uploads off says so on the
  console once per page, because the failure mode is otherwise silent — you
  curl the log, see nothing, and blame the phone.

## Admin

- **/admin is folds, not one scroll.** Eight panels stacked open made the
  page 1959 px on a 430×932 phone — over two screens before the first tap.
  Each panel below the key gate is a `<details class="fold">`, so closed
  the whole page is a stack of headings at 932 px: one screen, exactly.
  `<details>` is the entire mechanism — it collapses with no script, so a
  failed module load leaves a usable page rather than a blank one, and the
  e2e suites keep driving it because a JS `.click()` fires inside a closed
  fold. Which folds are open lives in `bookworm:admin-open` (localStorage),
  restored at load rather than in `unlock()` — the elements exist while
  still `hidden`, and `unlock()` can run twice in a session, which would
  double the `toggle` listeners. First visit opens 書架上的書 alone. 認證
  stays a plain `<section>` (a gate that folds is a gate you can lock
  yourself out of looking at) and so does 上傳預覽, which appears as the
  RESULT of 分析章節 and must not need a second tap. The 裝置診斷 links are
  one tap target per row — bare inline `<a>`s ran together into one
  ambiguous smear on a phone. An anchor-nav was the alternative and was
  rejected — with the folds closed the page is already one screen, so a
  second navigation system would be furniture for a problem that no longer
  exists.
- **The 更新 fold is a mirror of D1, never a call upstream.** The pull-mode
  panel (PM-08, `src/update-panel.mjs`) shows the running version, what the
  updater last saw of upstream, when it last checked, the updater's own
  version and the last install's outcome — all read from the shared D1 the
  updater writes (`GET /api/admin/update`). The reader holds no relationship
  with upstream and must not acquire one: the moment `/admin` fetched upstream
  itself, the largest attack surface would reacquire the trust the design
  keeps solely in the updater. The mode/soak controls write `updater_policy`
  (`POST …/update/policy`), and 立即安裝 queues the request in D1
  (`…/update/install-now`) for the updater to pick up on its next check —
  never a call into the updater, which has no door (an install
  button, without giving the updater a door). Absent an updater the panel
  reads "never checked" and does no harm. A **silent updater** is warned about
  (PM-14, R10): a cron-only Worker fails invisibly — token expired, cron
  stopped, all identical from outside — so the reader's own cron
  (`alarmSilentUpdater`) watches `last_check_at`, and past `SILENT_THRESHOLD_MS`
  the fold shows a warning and the owner is pushed once per stall (`pushOwner`;
  a dead updater cannot report its own death, which is why the reader raises
  it). A never-checked updater never nags.
- **Check and fix are different buttons.** On /admin, 健康檢查 is read-only
  and 修復 is the only thing that writes — a check that mutates what it is
  checking is not a check, and the check treats the D1 index as evidence
  under audit, never as a premise (the files are the book; a row is an
  opinion). Every destructive request re-verifies its own premise
  server-side (`?expect=gone|bad-manifest|incomplete`, 409 on mismatch)
  rather than trusting a scan from an earlier request, and checks carry no
  silent caps — a truncated report reads as a clean bill of health, the one
  thing it must never do. An incomplete book is swept whole and re-uploaded
  (the owner's rule: if the index cannot account for it, don't rescue it).
  Carrying the book id across a re-upload was considered and rejected —
  positions would survive pointing into re-split text, and a silently wrong
  position is worse than a zeroed one.
- **Enrichment rides sidecars, and a human carries the payload.** An
  agent — any vendor, per `docs/enrich-a-book.md` — prepares an enriched
  zip named after the book (byte-faithful `book.txt`, researched
  `meta.json`, a flat front-cover image — the real one when findable, else
  generated to the runbook's designed-cover spec; the filename matters
  because /admin pre-fills title and slug from it) and the owner uploads it
  on /admin. No tokens, no agent API access to the site: the runbook can be
  pasted into any Claude/Codex project precisely because there is nothing
  in it to leak. All normalization is client-side in the upload page, where
  the owner is watching — cover transcoded to the canonical `cover.jpg`
  (1200 px long edge, JPEG), meta filtered to the four-key contract
  (title/author/synopsis/source, capped 100/100/2000/500). The sidecars
  live beside the book in R2 and survive republish: a plain `.txt`
  re-upload keeps the enrichment, because the sidecars are not the
  manifest's to rebuild. The author is the one meta field surfaced into D1
  (`books.author`) — re-read from the sidecar by `sidecarAuthor()` at every
  `registerBook` call site (publish, reindex, retitle), returned by
  `/api/books` only when non-empty, and signed on the 題簽 in smaller 落款
  characters. Schema evolution: `schema.sql` is re-applied with
  `IF NOT EXISTS`, which never alters a live table — a new column must also
  ship a guarded `ALTER` in `scripts/deploy.sh`.

## Ops

The custom domain is added in the Cloudflare dashboard only — the deploy
token has no zone permissions, so putting the domain in `wrangler.jsonc`
`routes` breaks `deploy.sh`. `deploy.sh` captures `wrangler whoami` output
and prints it only on failure: it names the account's email, and a public
repo's Actions logs are world-readable. README screenshots are staged on an
isolated `wrangler dev --persist-to` scratch instance with public-domain
books from 維基文庫, captured over CDP at 390×844 @2× — never against the
live shelf.

## TTS

### Three engines

`player.mjs` drives three engines: WASM (offline Matcha, preferred when the
voice pack is cached), STREAM (`ManagedMediaSource`, one continuous mp3
timeline — no chunk boundary ever needs `play()` while the screen is locked)
where supported, CHAIN (double-buffered element swap) elsewhere;
`globalThis.bwPlayer` says which. The online backend speaks Microsoft Edge
read-aloud (protocol gotchas commented in `src/edge-tts.js`); real Mandarin
rate ≈ 4.5 chars/s; TTS chunk 0 is always the chapter heading alone. **The
WASM engine serves all real listening: `packReady()` prefers it whenever the
voice pack is cached, and every reading device holds the pack — the online
engines are only reachable from a pack-less device (fresh install, evicted
cache, `bw_tts="stream"`). A pronunciation report in the feedback queue
therefore describes Matcha unless the player log says otherwise; diagnose
there first.** Rejected alternatives: Web Speech API (iOS pauses it on
lock), Azure/OpenAI TTS (~$200/novel).

### The offline engine

`wasm-tts.mjs` runs Matcha zh-en (`matcha-icefall-zh-en`) under
onnxruntime-web in a Worker, ONE wasm thread, `executionProviders:
["wasm"]` — **no WebGPU, ever**: it measured slower than CPU for VITS-shaped
graphs (small, numerous ops; the GPU round-trip eats the win) and the option
is deleted rather than kept as a tempting fallback. TWO sessions are live at
once: the acoustic model emits a mel spectrogram and Vocos turns it into
magnitude plus cos/sin phase — **not a waveform** — so the inverse FFT and
overlap-add in `matcha-synthesis.js` are what produce audio at all, at ~1.4%
of synthesis time. The raw ONNX buffers are transferred into the worker and
nulled the moment the sessions exist; that is ~124 MiB and load-bearing on a
phone, not an optimisation. Matcha replaced piper 華言 on quality — 90 vs 60
in a blind listening test (Kokoro 80), piper marked 外國腔 — at comparable
cost: measured RTF 0.1317–0.1360 (×7.3–7.6 realtime) single-threaded on
desktop, verified on the phone before the swap and on device after it — pack
download, MediaSource timeline, lock-screen readout, which is the checklist
any future voice or engine swap owes. piper, its espeak phonemizer
and the melo-era 台灣讀音 overlay live in git history.

COOP/COEP is gone (`public/_headers` deleted): nothing needs
`crossOriginIsolated` now that the threaded experiments are, and the engine
was verified running with it false.

### The text frontend: 簡繁直輸

**Traditional and simplified text go straight into the lexicon, with no
OpenCC anywhere.** The cost is measured and accepted, not unknown: 70.5% of
the lexicon's 47,113 multi-char entries are unreachable from traditional
input, 19.3% of those get ≥1 syllable wrong via per-char fallback, and real
traditional prose comes out ~16% wrong — 銀行 as yín xíng, 會計 as huì jì.
**Corrections arrive as upstream's taiwan profile — the reviewed reading
layer is part of the product voice, not an optional extra:**
`matcha-taiwan-profile.js` and its `matcha-g2p-review.json` ledger ride the
pin through vendor.mjs and the sw shell, and compile to ~120 phrase
overrides plus 16 contextual rules (得/著/長/還/乾…, dictionary- and
corpus-reviewed upstream) applied in the synth worker — which is what fixed
看著 to kàn zhe. `OVERRIDES` in wasm-tts.mjs is local staging on top: an
entry lands there when a listening test here catches a reading the review
has not reached, wins over the profile, and leaves once upstream absorbs it
(垃圾→lè sè made that trip). Every reading change gets a pinned case in
`scripts/test-wasm-frontend.mjs`.

### Numbers ride kaldifst

Numbers are read by sherpa's own zh rule FSTs, applied by the real kaldifst.
The applier is wasmtts's standalone kaldifst 1.8.0 + OpenFST wasm (338 KB,
its own 16 MiB linear memory, instantiated in the synth worker from a blob
URL), so the three 212 KB tables (`phone`, `date`, `number`, in that order)
run without the 512 MiB sherpa-onnx bundle they normally ship inside. Its
predecessor `matcha-fst.js` — a from-scratch JS OpenFST reader reproducing
kaldifst's `TextNormalizer::Normalize`, verified byte-identical to kaldifst
1.8.0 on 13,625 cases (2,547 generated plus 11,078 real book sentences) —
survives as the node tests' oracle, and that verified equivalence is why the
swap changed no reading. The one subtle part is the tie-break: these tables
leave several readings at exactly equal cost, and OpenFST's `ShortestPath`
uses an `AutoQueue` — a `TopOrderQueue` on an acyclic FST — so states relax
in DFS reverse postorder with parents replaced only on a *strict*
improvement. A plain Dijkstra finds the same cost and a different string,
disagreeing on 33 of 2,547 cases (`8.0` → 八.零, whose stray period becomes
a sentence break). `scripts/test-matcha-fst.mjs` pins that with a hand-built
fixture whose answer came from kaldifst itself.

The tables are NOT adopted whole: measured against them, they are worse than
the JS rules on three things for a Taiwan reader — `%` survives into text
where it is in neither the lexicon nor `tokens.txt` and is dropped silently,
`:` survives as a token the model vocalizes (~0.25 s of voiced artifact, not
a pause — phone A/B test), and a 10-digit TW mobile falls past `phone.fst`
(11-digit mainland only) into `number.fst` as
零九亿一千二百三十四万五千六百七十八. So `normalizeLocalForms` reframes
those shapes first, keeping the digits so the tables still do the reading,
and the JS rules stay behind the chain as the whole reading for a device
whose pack predates the tables. Verified inert on all 11,078 prose
sentences.

### Pauses are the model's own

**`silenceScale: 1`, unedited** — `scaleSilence` is not a pause generator
but a pause *cutter*, a hand-written pass that finds every silence over
0.2 s and shortens it to a fifth, and at 1 it returns the waveform
untouched. Measured on one paragraph, silent runs at 0.2 vs 1: **， 55 ms →
280 ms, 。 147 ms → 740 ms.** wasmtts keeps 0.2 as its *benchmark* config,
so its bench is no counter-example: it suppresses commas there too. The
whole playback recipe — silence 1, with the equally deliberate noise 1 (not
sherpa's 0.667) and length 1 — rides in from the pin: the pack manifest's
`synthesis` block (upstream matcha-assets.json) is the recipe, the worker
spreads it into `createEngine` verbatim, and `vendor.mjs` fails the build if
a pin ships without it — this repo hardcodes no knob. The piper-era
`PAUSE_MS` splicing existed only because espeak ate the commas and is not
coming back. One caveat measured at the same time: an isolated sentence
carries ~590 ms of trailing and ~140 ms of leading silence, so a unit JOIN
pays both (740 ms) where the model rendering the same two sentences in one
pass pauses 306 ms. If that ever reads as draggy the fix is packing several
sentences into one unit, not re-arming the cutter.

### Units and playback

One sentence is one unit (`segments()`, reusing `ENDERS`/`CLOSERS` from
`tts-core.mjs` so the two splitters cannot drift); the worker lame-encodes
each to mp3 and playback appends them to ONE ManagedMediaSource timeline
(plain MediaSource on Chrome, so the same path is testable headless):
chain-swapping blob WAVs died after ~5 min locked with a `play()` that never
settled — no new-element `play()` survives the lock screen long-term, same
lesson as the STREAM engine. The engine's flight recorder mirrors the
timeline to `/api/testlog?page=player`.

### The voice pack

The ~145 MB voice pack (five model files plus the three rule tables) is
downloaded only through `downloadPack` in `wasm-tts.mjs` — the `/wasmtest`
diagnostic and the stale-pack pill share it, and every entry is an explicit
tap that names the megabytes (never ▶ itself — cellular) — into the
`bw-wasmtts` cache; `packReady()` flips the reader to this engine, eviction
falls back to STREAM, `localStorage bw_tts="stream"` forces the online
engines. The cache sweep is a keep-set, not a name list, so it reclaims the
whole piper/melo/fanchen era in one pass and never needs editing again. The
same-origin JS modules and vendor bundles are fetched network-first at init
(`cachedBuf` fresh mode; the service worker bounds it at 1 s and answers
offline) because the copy parked in `bw-wasmtts` outlives every SHELL bump —
a phone once inited a stale cached ort UMD against a newer wasm exactly that
way. Cache-first stays correct only for the release binaries, whose
filenames carry their version.

A pack change reaches a phone as `packReady()` false: the reader falls back
to STREAM and `player.mjs` offers the re-download as a one-tap pill
(`player.packStale`) — the voice pack is a reader feature, not
diagnostic-page lore, and a silent engine downgrade reads as the app losing
a feature it used to have. The pill downloads in place with its button
naming the missing MB; narration keeps playing online and the offline
engine returns at the next ▶ — never mid-session, because `useWasm()` is
consulted live throughout playback. A device that never held the pack gets
the same pill as a plain offer (`player.packOffer`) — first download and
re-download are the one flow, and `/wasmtest` keeps only the per-file
diagnostic timeline.

### Vendoring and pins

Binaries come from the `wasmtts-assets-v2` GitHub release via the
allowlisted `/api/wasmtts/` proxy; `/wasmtest` imports the real engine
rather than carrying its own copy, because a bench that drifts from what
ships measures the wrong thing. **The engine code itself is vendored from
the wasmtts git dependency** — `matcha-frontend.js`, `matcha-synthesis.js`,
the kaldifst wasm and its wrapper, plus the `matcha-fst.js` test oracle land
in `public/vendor/wasmtts/` via `vendor.mjs`, never hand-copied into
`public/`: hand copies drift both ways (bookworm held the fromCharCode and
colon fixes while upstream held the ruleNormalizer interface — each side
missing the other's), and upstream's release gates (FST
golden, RTF, 512 MiB, Whisper CER) test what this repo cannot. The pin is a
release tag Renovate bumps; bookworm's fixes are upstreamed first so the
vendored files need no local patches.

**ort is pinned exactly, and the pin lives upstream**: wasmtts declares
`onnxruntime-web` (and `lamejs`) in its `dependencies`, and `vendor.mjs`
resolves both through the wasmtts tree — this repo holds no ort version of
its own, so ort can only move together with a gated engine release, never
alone. The pin has no `^`: the wasm's byte length is asserted at init, so a
floating range would break the engine on a lockfile refresh. A dev build is
not an acceptable pin — it gets no security fixes and cannot be
meaningfully bumped — and measured RTF differences between ort versions are
run-to-run noise, so a bump is judged on runway and security, never speed.
Note `env.versions.common` reports *onnxruntime-common*, not the web
package, so the drift guard checks the wasm's byte length instead.

**The release asset re-cuts itself**: `vendor.mjs` derives the versioned
filename + byte length from the wasmtts tree into
`public/vendor/wasmtts/ort-manifest.mjs` (the only place the app learns
them; `wasm-tts.mjs` imports it, the worker allowlist admits the name by
shape), and the deploy job runs `scripts/sync-wasmtts-assets.mjs` before
`deploy.sh` — it uploads the pinned package's wasm under that name to
`wasmtts-assets-v2` if absent, refuses a same-name-different-bytes replace,
and then deletes stale ort versions (sole install, no backward-compat
window). So an ort bump is: upstream repins → gated tag → bookworm repins
one line → CI re-cuts and deploys.

**The whole voice pack rides the same rail**: upstream's
`matcha-assets.json` (schemaVersion 3) is the pack's canonical definition —
per-asset packName/bytes/SHA-256, under the invariant that changed bytes
change the packName — and `vendor.mjs` bakes it into `pack-manifest.mjs`,
which `wasm-tts.mjs`, the worker allowlist and the tts-wasm e2e all read;
`sync-wasmtts-assets.mjs` fetches any asset the pin names that the release
lacks from its pinned source (SHA-verified) and sweeps names the pin
dropped. No model filename exists in this repo's code — a pack outliving an
engine bump is exactly the drift this closes. A same-name asset can still
never change bytes, and a sync failure 404s loudly on device.

### Verifying engine changes

Verify any backend change by Whisper-transcribing a sample — duration checks
cannot hear garbage, which is how the Workers-AI MeloTTS breakage was
confirmed. **A transcript diff cannot verify an ort bump**: Matcha samples
fresh noise every call at noiseScale 1, so the same text through the same
build renders different takes — two consecutive same-build renders of one
sentence transcribed 他觉得等钱得接到 and 他觉得的前进街道. What is stable
across runs and across versions is identical, known 簡繁 defects included.
Verify a runtime bump on the reader, not `/wasmtest`: the diagnostic plays a
two-`<audio>` chain and cannot exercise backgrounded playback at all.

### Known defect: random mis-articulation (吃字體感)

A full-chain local harness (real 劍來 chapters → `chunkChapter` →
`ttsPrompt` → `segments` → the real worker's mp3 units → sequence-mode
SourceBuffer appended *while playing*, with an AudioContext ScriptProcessor
tap recording the PCM the element actually played) cleared every layer
except synthesis. Text layer: all 1,182 chapters (12.9M chars) through the
frontend drop **zero** Chinese characters (`unknown` catches only ASCII
`-`/`*`/letters), so lexicon 簡繁 completion would rescue nothing — both
single-char spellings are already present, and a word entry for a non-破音字
word (前輩) yields the same phones as per-char fallback. mp3 concat + MSE
junctions: zero loss at the *sample* level — capture PCM cross-correlates
against the decoded unit concatenation at one constant offset (the start
latency) with NCC 0.92–1.00 at all 32 unit heads across two runs, and
capture duration = concat + latency to ~10 ms. The real defect: a render
occasionally articulates one syllable as a different sound (人耳 confirmed
老 → 近似「巧」/「蓝」in the probe 這位老前輩說。, ~2–4 of 50 renders; which
syllable is fragile depends on the carrier sentence). **No true silent
deletion was ever confirmed** — every "missing syllable" flag turned out to
be ASR error — so the on-device 體感「沒發聲」 is this mis-articulation
being perceived as a skip.

**The mitigation sweep came back negative**: ODE steps 2/3/4/6 (upstream
ModelScope `dengcunqin/matcha_tts_zh_en_20251010` ships the full export
set) × `noise_scale` 0.3/0.5/0.667/1.0 all leave the mis-articulation rate
unmoved — 2–5 consensus flags per 50 renders in every cell, statistical
noise — so the deliberate noise-1 setting is not the culprit. The error mode
is a neighbouring-syllable intrusion (老前輩 → 「前」侵入 老, 再來找 →
再再找): alignment slippage inherent to the checkpoint, not noise amplitude,
so more solver steps cannot buy it back. A borderline Whisper-CER result on
upstream's release gate is very likely this same phenomenon rather than a
regression in whatever change is being gated — start there before
suspecting the diff. Remaining routes: a different acoustic model or
checkpoint, or accept the rate and promote the calibrated-sentence
consensus rate to a release-gate metric.

**ASR calibration for any listening test**: whisper-small alone is
untrustworthy (its substitution flags were wrong on human check), and a lone
large model back-fills weak syllables via its LM; trust a flag only when
small AND large-v3 mishear the *same* syllable (2/2 human-confirmed so far),
and treat any deletion verdict as unproven until a human ear signs off.
large-v3 int8 runs ~2–4 s per 2 s clip on desktop CPU. The consensus
detector is calibrated per carrier sentence: on the calibrated probe it is
human-confirmed, but on a new carrier both whisper models share the same LM
preference and it false-positives wholesale (21/50 on a sentence a human
hears as fine), while long carriers trigger whisper's temperature fallback
(~3 h for 200 clips) — compare rates only on calibrated short sentences. The
harnesses (chain e2e with PCM tap, junction cross-correlation audit,
dual-ASR consensus report) lived in a session scratchpad and are NOT checked
in — rebuild from this description if needed.

### iOS lock-screen ground truth

Measured on iOS 18.7 with a LAN probe replaying real per-sentence mp3 units
through the reader's exact MediaSource + Media Session discipline. Four
facts, three of them platform ceilings no code change moves: (1) Media
Session handlers are load-bearing — with none registered, iOS discards the
Now Playing session ~3 s after a lock-screen pause and hands the card to
another app, so the play/pause handlers stay registered even though a frozen
page cannot always run them. (2) iOS freezes the page ~9–16 s after
paused-while-locked (heartbeat gaps prove it); within that window
lock-screen resume works — eight for eight in the logs — and after it the
tap is queued and fires the handler the instant the phone unlocks, so
"resume on unlock" is the designed outcome, not a bug. (3) The ~0.7 s fade
after a lock-screen pause is the OS session ramp: the pause event lands
instantly, then the clock records the ramp (`pause @X`, next `play @X+0.7`);
visible-page pauses have no tail. Muting before pausing kills the ramp AND
the Now Playing card instantly — rejected, the card is worth more than the
tail. (4) The one genuine failure mode is OURS to catch: a resume can leave
the element claiming "playing" with currentTime frozen and a full buffer,
for minutes, across visibility changes — the ♥ heartbeat in `player.mjs`
watchdogs it (two stuck beats → micro-seek nudge, then a rebuild at the
narration position). The toggle binding of both lock-screen buttons to
`playerPlayPause` was suspected and cleared: the `playing` flag matched
element truth at every logged invocation.

### A reading opens at the visible page

🔊 — and ▶ after navigating away while paused — starts at the first
character of the page on screen (`pageStartOffset()`, per-char Range rects
inside the straddling paragraph), never at the tracked `state.off`: that
offset is paragraph-grained and sticky, so it routinely points a page or
more behind the eye. The wasm engine synthesizes the first chunk from the
sentence holding that char (`sentenceStartFor` in `tts-core.mjs` — the one
ENDERS/CLOSERS walk shared with both splitters); the stream and chain
engines seek proportionally into the first chunk instead. The ≤1-sentence
pre-roll before the requested start is held by a one-shot floor — no page
turn, no bookmark write — cleared on arrival and on ⏮/⏭. ✕ ends the
session; the next 🔊 is a fresh reading from whatever page is then open.
Following and restoring page on the SPOKEN character's rect (`offsetRect`),
not the paragraph's start edge, so a paragraph spanning pages turns
mid-paragraph and a mid-paragraph bookmark reopens on its own page.
Accepted: the pre-roll re-reads up to one sentence that began on the
previous page — a complete sentence beats starting mid-clause. The e2e
page-start scenario runs on a one-paragraph multi-page chapter, the one
shape paragraph-grained following could never turn. The audio suites pass
`--mute-audio`: every assertion reads the media clock, never the speaker.

### The spoken sentence is marked, the bar floats

While a reading plays, the sentence holding the spoken char carries a wash
(color token `--hl`). NOT via the CSS Custom Highlight API: WebKit never
repaints replaced or removed custom highlights — open bugs 266250 ("painting
does not invalidate properly when removing highlights", confirmed by a
WebKit engineer as a paint-invalidation bug) and 259897 ("sometimes does not
repaint when live ranges are changed") — so on device every sentence ever
spoken stayed washed. Instead the wash is self-painted: `#ttsHl` inside
`#content` holds one absolutely-positioned rect per line fragment of the
sentence's Range (content-space coords, so the rects ride page glides
natively), replaced wholesale on every mark — ordinary DOM painting, which
WebKit always invalidates — and removed on ✕. `#content` carries
`position: relative; isolation: isolate` so the rects sit at `z-index: -1`,
behind the glyphs but above the page background. Out-of-flow, so the paged
grid and per-char rect maths are untouched; works below iOS 17.2 too.
Bounds come from `sentenceStartFor`/`sentenceEndFor` on the chunk's own
text — the same ENDERS/CLOSERS walk as the splitters — so mark and audio
can never disagree; a force-split run-on marks its whole chunk-sized piece,
and the chapter-title announcement marks nothing (the heading renders as
`<h2>`, not `p[data-off]`). Pause keeps the mark (it shows where you
stopped); ✕ clears it. After rotation or a grid change the rects are stale
for ≤1 timeupdate tick until the next mark repaints — the page-follow
tolerance. The player bar itself is near-transparent (35% of `--bar-bg`
over the blur, no shadow) with 1.4rem icon buttons, so it floats over the
page instead of hiding it.

## Backlog

- Surface the rest of the enrichment meta: `synopsis` (and `source`) are
  already in the sidecar; a place to show them (long-press? the reader's
  書衣 page?) is undesigned.
- Multi-lingual beyond the UI chrome: per-book `lang` in the manifest; TTS
  voice and chunker per language (ENDERS/PAUSES/CHARS_PER_SEC are CJK
  today); font stack and break rules per language; offer 直排 only for CJK
  books; chapter-title detection beyond 第…回／章.
- R2 `_tts/` eviction (lifecycle rule or admin sweep) if storage grows.
- 吃字 mitigation (see *Known defect* under TTS): higher ODE steps and
  noise_scale are measured dead ends; what is left is a different acoustic
  model or checkpoint — candidates are hunted in the owner's separate
  `mytts` lab repo (an own zh_TW-accented voice inside the huayan CPU
  budget) — or promoting the calibrated-sentence consensus rate to a
  wasmtts release gate.
- Playback speed control (`audio.playbackRate`) in the player bar.
- File the iOS scrollBy-doubles bug at bugs.webkit.org (the on-device
  matrix evidence is in the owner's archive; low priority).

## Code conventions

- Comments explain **why**, in full sentences, at the density of the file
  around them. Never restate what the line already says.
- e2e scripts click **ids** (`#offlineBtn`, `.book-row[data-slug=…]`), never
  titles or visible text — those move with the interface language.
- Prefer a plain function to a class or a new abstraction. This code is read
  far more often than it is extended.
- The route dispatch near the top of `app.js` runs during script evaluation,
  before the `const`s further down are initialised. Anything reached
  synchronously from there must be a function declaration.

## Commits

`<area>: <one lowercase sentence saying what changed and why>` — e.g.
`clean: delete an incomplete book instead of reporting it`. The body is prose:
what the old behaviour claimed, what it actually did, what the new rule is, and
which costs were accepted. Decisions worth keeping are distilled into the
relevant subsystem section of this document; superseded rules are deleted, not
annotated.


