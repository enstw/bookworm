# Bookworm

A private Chinese-first reader: one Cloudflare Worker (`src/worker.js`), a
vanilla-JS PWA in `public/`, chapters in R2, reading positions in D1.

The v1 contract lives in `REQUIREMENTS.md`. The engineering history predates
this repo's publication and lives in the owner's private archive; commit
bodies carry the prose from here on. The standing decisions below are the
ones that still govern the code: read the relevant one before reopening a
decision in that subsystem.

## Commands

- Fresh checkout: copy `.dev.vars.example` to `.dev.vars`, then
  `pnpm run db:init:local` — without the schema every table read 500s
  (`no such table`), and without the token every admin route 401s.
  Re-applying the schema is always safe, and also empties the local feedback
  queue — the local rehearsal of the deploy-sweep.
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
  hook in `.claude/settings.json` enforces this). Every push to main deploys
  through GitHub Actions; md-only pushes are skipped. The deploy is gated
  (2026-08-10): the workflow first runs the desktop suite via
  `scripts/run-ci-tests.mjs` (the `pnpm test` chain, one log per suite); a
  red run publishes a `test-failure-*` pre-release whose notes name the
  failing suite and embed its log tail, and the deploy is skipped. The same
  gate runs locally with `ADMIN_TOKEN=<value from .dev.vars> node
  scripts/run-ci-tests.mjs` — it reuses a dev server already on 8787 or
  boots its own. Dependencies release once a week (2026-08-10): the
  `renovate` workflow runs every Monday morning, Renovate folds every
  update — the wasmtts tag, the ENSFont pin, npm, Actions — into one
  `renovate/weekly-roll-up` PR (`.github/renovate.json5`), and the
  workflow merges it and dispatches this gated deploy. Major updates get
  their own PR and wait for review; there is no Renovate App — the CLI
  runs in Actions, or by hand via the command in the config header. An
  **off-schedule roll-up** (proven 2026-08-15, shipping wasmtts v1.1.0 on
  a Friday) is three steps, each with a known pit. (1) Dispatch the
  `renovate` workflow. (2) When that run ends green yet opens nothing
  while the dependency dashboard lists the roll-up under "Other
  Branches: pending" — a recurring CI-token mystery (2026-08-11, again
  2026-08-15); forcing the dashboard checkbox does not help either — run
  the CLI by hand with the PAT, the standalone node 24, and the
  workflow's own pinned renovate version:
  `PATH="$HOME/.cache/node-v24.19.0-darwin-arm64/bin:$PATH"
  RENOVATE_TOKEN=$(gh auth token) pnpm dlx renovate@<workflow's version>
  --platform=github enstw/bookworm` — same config, first try, PR up in
  ~30 s. (3) WAIT for the roll-up PR's green `candidate-gate`
  (`gh pr checks <n> --watch`) before dispatching the workflow again to
  merge and deploy. The wait exists because of who opened the PR:
  GITHUB_TOKEN's candidate run is created held and the merge step
  approves-then-waits on it, but a PAT-opened PR's run starts
  immediately, and `verify-renovate-pr` fails closed on any check not
  COMPLETED/SUCCESS — a too-early dispatch dies with "candidate-gate is
  IN_PROGRESS" and costs only a rerun. Separately, an orphaned
  `renovate/weekly-roll-up` branch (a branch with no PR) makes every
  later run abort with "Repository has changed during renovation" —
  delete the branch first. Validate any config edit with `pnpm dlx
  --package renovate renovate-config-validator`, and keep the one config
  file: a stray root `renovate.json` silently shadows
  `.github/renovate.json5`. A
  third-party release must be **30 days old** before it can join a roll-up,
  so a yanked or compromised publish has time to surface somewhere else
  first; expect the pins to sit a release or two behind npm on purpose. Our
  own upstreams (`enstw/wasmtts`, `enstw/font`) are exempt — we cut those
  tags. The quarantine has one bypass: a dependency with a GitHub advisory
  gets an immediate ungrouped PR, because Renovate's `vulnerabilityAlerts`
  defaults override the wait. The self-hosted Renovate CLI is an exact
  version, and the job that runs it cannot dispatch Actions. A second job
  loaded from `main` verifies the PR base/head/SHA and allows only monotonic
  exact dependency pins, existing Actions' SHA/version lines and Renovate's
  own exact version before it receives the separate merge/dispatch
  permissions. New files, renamed files, scripts, workflow logic and Renovate
  config all fail closed instead of riding the trusted bot branch into `main`.
  Two checks close the holes a line diff cannot see: every URL in the lockfile
  must be the wasmtts codeload source (a poisoned lockfile is how a clean
  package.json still installs attacker code), and every moved action digest is
  resolved against the upstream tag it claims (any fork-network commit fits
  the 40-hex format). The font pin is deliberately outside the allowlist and
  outside the roll-up group — its PR is a work order, not a change (see
  fetch-font.mjs); `scripts/test-renovate-policy.mjs` pins the bypass cases.
  The deploy workflow itself splits its permissions per job (2026-08-13):
  the `test` job executes the pushed code, so it runs with `contents: read`
  and a credential-free checkout — a compromised dependency in the suite has
  no token to write with. `contents: write` exists only in `failure-report`
  (publishes the `test-failure-*` pre-release from the uploaded artifact
  alone — it never checks out or runs repository code, and refuses unexpected
  or oversized artifact files rather than publish them) and in `deploy`,
  which starts only after a green gate and is the only job that sees the
  Cloudflare/production secrets. `scripts/test-deploy-policy.mjs` asserts
  the split and self-tests that each seeded violation is caught.
  Merges into `main` have their own pre-merge gate (2026-08-13): the
  `candidate` workflow runs the full suite on every PR as a required check
  named `candidate-gate` — same containment rules as the deploy test job
  (read-only token, credential-free checkout, generated-not-secret env),
  never `pull_request_target`. PRs opened with GITHUB_TOKEN (the release
  ledger, renovate's roll-up) get their `pull_request` run created *held*
  (`action_required`) — GITHUB_TOKEN events never start workflows on their
  own — and the ruleset's required check waits on exactly that held run: a
  separately dispatched candidate run builds a check suite that never
  associates with the PR, so the PR stays blocked however green the
  dispatch is. `scripts/wait-candidate-gate.mjs` therefore approves the
  held run (the callers hold `actions: write` for this) and follows the
  check to a conclusion before the workflow merges. The release ledger
  itself stopped pushing to `main` directly: the deploy job commits
  RELEASES.md to an `automation/release-ledger-<run>` branch, opens a PR,
  waits for its green `candidate-gate`, rebase-merges, and only then moves
  the `released` tag — if `main` moved mid-gate the merge fails closed and
  the next release's ledger covers both ranges.
- The repo settings that no file records (2026-08-12): secret scanning with
  push protection is on; a ruleset on `main` ("main: candidate-gate before
  merge", expanded 2026-08-13) blocks force-push and deletion and now also
  requires every change to arrive by PR (0 approvals, conversation threads
  resolved, rebase/squash only, linear history) with a green `candidate-gate`
  check from the Actions app, strict mode, no bypass actors — a direct push
  to `main` or a merge over a red gate is rejected server-side (a rebase that
  rewrites any other pushed branch is still fine — the ruleset only guards
  `main`). Merge-commit merges are disabled repo-wide, merged branches
  auto-delete, and the update-branch button is on. In practice: `gh pr
  merge` needs `--rebase` or `--squash` and fails a stale head with "head
  branch is not up to date"; every non-md merge deploys and the deploy
  lands a release-ledger commit on `main` afterwards, so back-to-back PRs
  always start with `git fetch && git rebase origin/main && git push
  --force-with-lease` (which re-runs the gate). Watch a PR's gate with
  `gh pr checks <n> --watch` — the workflow's display name is `candidate`
  and the check's is `candidate-gate`, so `gh run list --workflow
  candidate-gate` finds nothing. Also on: **Actions must
  be pinned to a full 40-character commit
  digest** (`sha_pinning_required`, repo → Settings → Actions). `uses:
  actions/checkout@v7` no longer runs — write the digest and keep the
  version in a trailing comment, which is the form Renovate updates. A tag
  is a moving pointer, so the tag form means a compromised upstream reaches
  a workflow that already holds deploy credentials. Everything under
  `.github/` was already pinned when this was enabled; the setting exists so
  a future workflow cannot quietly reintroduce the tag form. Also on
  (2026-08-13): "Allow GitHub Actions to create and approve pull requests" —
  without it the renovate workflow's GITHUB_TOKEN gets a 403 opening the
  roll-up PR (the branch pushes fine, so the failure looks like Renovate
  silently doing nothing). The default workflow token permission stays
  read-only; jobs that write declare it per job.

## The owner's suggestion queue

Start a session by reading `/api/feedback` on the owner's live instance
(plain GET, no key; the origin is deliberately not written into this public
repo — on an owner machine read it from the untracked `.dev.vars`
(`BOOKWORM_ORIGIN=`), in workflows it is the `BOOKWORM_URL` secret, and
humans ask the owner). Each note is
an improvement request the owner wrote from the phone on
`/admin` — treat it as a ticket. Deploying clears the queue (`schema.sql`
empties the table on every apply), so whatever is still readable is still
undone. There is no delete route; shipping the fix is how a note gets
cleared.

## Non-negotiables

- **No build step, no framework, no bundler.** Files in `public/` are served
  byte-for-byte. Browser libraries are vendored into `public/vendor/`
  (gitignored) by `scripts/vendor.mjs` — never link a CDN, never add a runtime
  dependency.
- **Every user-facing string lives in `public/i18n.js`, under both `zh` and
  `en`.** The chrome is 中文 first (`BW_DEFAULT_LANG = "zh"`). A whole sentence
  is the unit of translation — never assemble one from a prefix plus a suffix,
  because the two languages order the pieces differently. A literal in
  `app.js`, `player.mjs` or `admin.html` is a bug; call `t("key")`.
- **Bump `SHELL` in `public/sw.js`** whenever a font or icon changes. Those are
  served cache-first from unversioned URLs, so an installed phone otherwise
  keeps the old bytes forever. Shell assets (`app.js`, `app.css`, …) need no
  bump — they are network-first and refresh themselves.
- **A book's `id` is permanent; its `slug` is a renameable label.** R2 prefixes,
  D1 rows, cache names (`bw-book-<id>`) and localStorage keys all key on the
  id. Only URLs speak slugs, resolved through `book_slugs`.
- **Position is `(chapter index, character offset)`** — never a page number or
  a scroll offset. Server writes are last-write-wins on a timestamp; a late
  beacon from another device must never clobber a newer position.
- **Content sits behind a reader key.** `/api/books`, `/books/*`, TTS,
  positions and settings 401 without one; a position or setting always
  belongs to the KEY's user — client-asserted ids are ignored. Keys are
  minted/revoked on `/admin` (`POST /api/admin/readers`); the admin Bearer
  passes the gate but has no reading identity. Open by design: the shell,
  `/api/feedback`, push vapid/unsubscribe. `/api/testlog` needs a credential
  both ways — a reader key to read, the `bw_tlog` admin cookie to write. e2e
  suites mint their own key — the e2e runbook has the rules.

## Working agreements

How the owner wants agents to work here — stated preferences, kept in the
repo because session memory does not cross machines:

- **Explain before editing.** For anything beyond a typo: state the
  diagnosis, the evidence for it, the planned change and how it will be
  verified — then wait for the go-ahead. Keep the diagnosis separate from
  the fix so a wrong premise can be challenged on its own, and measure
  instead of inferring whenever measuring is cheap. Verification must
  *gate* the push (`cmd && git push`), never narrate beside it — a
  `pnpm test | grep -i error; git push` once let a parse error deploy.
- **One user, one install.** The owner is the sole reader and the only
  installed PWA. When a contract changes (URLs, storage keys, routes),
  delete the old form instead of shimming it; the owner re-enrolls their
  own devices. (The retired `/<book>/<uid>` route is the precedent.)
- **Test inputs come from pins, never working trees.** A harness fetches
  its inputs from the pinned upstream (release tag, manifest revision)
  into its own copy and verifies the SHA-256 — it never reads a live
  checkout's model folder, which is mutable working state and has changed
  mid-experiment. Saving a download is not a reason.
  `scripts/fetch-matcha-weights.mjs` is that fetch for the voice pack.

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

## Standing decisions

The living distillation of the engineering log. Each entry is a rule the code
still obeys plus the why; the full investigations are in the commit bodies of
the pre-publication history, which lives in the owner's private archive.

- **Worker platform limits (2026-07-29).** A Worker gets 6 simultaneous open
  connections and 50 subrequests on the free plan; anything fanning out over
  R2 goes through a bounded pool (`mapPool`), and admin loops are paged so
  the worst case stays inside the budget. miniflare enforces none of this —
  violations are production-only failures — so the ceiling is asserted
  directly by `scripts/test-worker-pool.mjs`. Every route handler must be
  `return await`ed: a promise settling outside the `try` escapes as a bare
  platform 1101 with no message. R2 has no server-side copy; buffer a copy
  through `arrayBuffer()` so it holds one connection, not two.
- **iOS applies every relative scroll twice (2026-07-28).** The on-device
  matrix (24 cases: 3 APIs × anchor on/off × 直/橫排 × element/document
  scroller) proved `scrollBy` double-applies everywhere on this iOS build,
  Safari and installed PWA alike, while absolute `scrollTo`/`scrollLeft=`
  are always 1×. Never reintroduce `scrollBy`; every landing is an absolute
  assignment (`vSnap`/`vSlide`, native smooth `scrollTo`). Chromium is 1×,
  so e2e can only guard the invariant, not reproduce the bug. Filing it at
  bugs.webkit.org is still open, low priority.
- **The paged grid (2026-07-28).** Both writing modes page on an integer
  grid: `pitch = floor(width / 每頁行數)` in whole px (iOS snaps line
  advances to whole pixels — a fractional pitch creeps and leaks sliced
  columns), `字級 = pitch × ¾`, and every block spans a whole number of
  lines by construction. In 直排, `#content` is exactly N×pitch wide inside
  a clipping `#pagebox`, so a sliced column is unrenderable; in 橫排 the
  grid is phase-anchored to the reading band below the topbar. Page k is
  pure arithmetic. 字級 is calibrated once, in 直排 portrait (`bw_calibw`);
  rotation and mode switches change the column count, never the text size.
  每頁行數 is per-device and deliberately unsynced — a phone and a tablet
  want the same physical size, which is a different count on each. `bw_font`
  still syncs but renders nothing; dropping it costs a schema change for no
  user-visible gain.
- **What syncs and what doesn't.** fontSize/vertical/bg follow the reader id
  through `/api/settings` (LWW, client timestamps clamped server-side to
  now + 60 s, same as positions). Theme, language, 每頁行數 and wake lock
  describe THIS screen and stay per-device on purpose. `resolveSettings`
  runs before `buildReaderShell` so server-wins applies pre-paint; if it
  ever moves after `openChapter`, redo the toggleVertical dance. An identity
  change zeroes `bw_settings_ts` so the device adopts the new id's settings
  instead of clobbering them.
- **Why the reader key rides a cookie (2026-08-01).** `<audio src>`,
  `sendBeacon` and service-worker fetches cannot carry a header, but all
  carry cookies. The cookie is server-set (HttpOnly, SameSite=Lax, 1 year)
  because Safari ITP caps `document.cookie` writes at 7 days and a weekly
  key prompt reads as the app breaking. localStorage keeps a copy only to
  re-earn the cookie after a 401 — one reauth attempt, so a revoked key
  fails into the gate, not into a request loop. Keys are stored in the clear
  deliberately (/admin re-showing one to a wiped device is a feature; D1
  read access already implies every book and bookmark). Revocation fences
  the server only — chapters a phone already cached keep reading offline,
  which is the right meaning. `readers` has no deploy sweep, unlike
  `feedback`, or each deploy would log out every phone. Cloudflare Access
  was rejected: redirect auth silently turns manifest/beacon/SW fetches
  into 302→login-HTML in an installed PWA, and cannot ship with a fork.
- **"/" resumes the book (2026-08-02).** Bare "/" resumes `bw_last_book`,
  recorded only once a manifest actually loads so a typo'd URL can never
  become what every reopen runs into; the shelf's explicit address is
  `/?shelf`; enrolling via `/?key=` still ends on the shelf (a key link is
  device setup, not reading). The resume is all-local, and the position
  reconcile is capped (see 開機的網路上限 below) — reading must not wait on a
  bookmark the device already holds. The legacy
  `/<book>/<uid>` route is deleted, not shimmed. An online not-found forgets
  `bw_last_book`; an offline not-found forgets nothing.
- **開機的網路上限 — 1 s (2026-08-04).** A dying cellular link does not fail
  fetches, it hangs them for 60+ s, so "opening takes forever on bad signal"
  is never a slow answer — it is a question nobody was going to answer.
  `NET_MS = 1000` caps it, once in `public/app.js` (`capped()`) and once in
  `public/sw.js`, and the rule for applying it is the same in both: **cap a
  request only when losing it costs nothing.** Capped, because the device
  already holds an answer — position, settings, slug→id, the shelf list when
  `bw_books` exists, the manifest when a cached copy exists. Uncapped,
  because the network is the only answer and a cap would turn slow into
  broken — a first-ever shelf, a book never cached, an uncached chapter; the
  sw.js handlers get this for free from `res ?? cached ?? net`. Losing a
  capped race cannot lose data: positions and settings are LWW by
  `updated_at` server-side, so the local-wins push that follows a timeout
  can never clobber a fresher row. Measured on the primed offline-e2e
  profile against a server that accepts TCP and never answers: 11.1 s → 3.1 s
  to rendered chapter text. `/api/version` deliberately keeps its 4 s — it
  blocks nothing, and a 1 s cap would just make the update notice never show
  on a slow link.
- **TTS (2026-07-15 onward).** Three engines in `player.mjs`: WASM
  (offline Matcha, preferred when the voice pack is cached), STREAM
  (`ManagedMediaSource`, one
  continuous mp3 timeline — no chunk boundary ever needs `play()` while
  the screen is locked) where supported, CHAIN (double-buffered element
  swap) elsewhere; `globalThis.bwPlayer` says which. The online backend
  speaks Microsoft Edge read-aloud (protocol gotchas commented in
  `src/edge-tts.js`); real Mandarin rate ≈ 4.5 chars/s; TTS chunk 0 is
  always the chapter heading alone. **The online engines are out of
  service in practice (owner, 2026-08-14): every reading device has held
  the Matcha pack since 2026-08-08, so all listening — including every
  pronunciation report in the feedback queue — happens on the WASM
  engine. Diagnose against Matcha first; reach for the edge-tts path only
  when the report is from a pack-less device (fresh install, evicted
  cache, `bw_tts="stream"`), which is the only traffic it still serves.**
  Verify any backend change by
  Whisper-transcribing a sample — duration checks cannot hear garbage,
  which is how the Workers-AI MeloTTS breakage was confirmed. Rejected
  alternatives: Web Speech API (iOS pauses it on lock), Azure/OpenAI TTS
  (~$200/novel).
- **Offline TTS (2026-08-02, voice swapped to Matcha 2026-08-08).**
  `wasm-tts.mjs` runs Matcha zh-en (`matcha-icefall-zh-en`) under
  onnxruntime-web in a Worker, ONE wasm thread, `executionProviders:
  ["wasm"]` — **no WebGPU, ever**: it measured slower than CPU for VITS-shaped
  graphs (small, numerous ops; the GPU round-trip eats the win) and the
  option is deleted rather than kept as a tempting fallback. TWO sessions
  are live at once: the acoustic model emits a mel spectrogram and Vocos
  turns it into magnitude plus cos/sin phase — **not a waveform** — so the
  inverse FFT and overlap-add in `matcha-synthesis.js` are what produce
  audio at all, at ~1.4% of synthesis time. The raw ONNX buffers are
  transferred into the worker and nulled the moment the sessions exist;
  that is ~124 MiB and load-bearing on a phone, not an optimisation.
  Matcha replaced piper 華言 on quality — 90 vs 60 in a blind listening
  test (Kokoro 80), piper marked 外國腔 — at comparable cost: measured RTF
  0.1317–0.1360 (×7.3–7.6 realtime) single-threaded on desktop, and
  verified on the phone by the owner before the swap, and the integration —
  pack download, MediaSource timeline, lock-screen readout — passed on device
  after it (2026-08-08). piper, its espeak
  phonemizer and the melo-era 台灣讀音 overlay live in git history.
  **簡繁直輸: traditional and simplified text go straight into the lexicon,
  with no OpenCC anywhere.** The cost is measured and accepted, not
  unknown: 70.5% of the lexicon's 47,113 multi-char entries are
  unreachable from traditional input, 19.3% of those get ≥1 syllable wrong
  via per-char fallback, and real traditional prose comes out ~16% wrong —
  銀行 as yín xíng, 看著 as kàn zhù, 會計 as huì jì. Corrections accrue in
  `OVERRIDES` one line at a time from listening tests, each with a pinned
  case in `scripts/test-wasm-frontend.mjs`; a flat table cannot disambiguate
  著, and guessing entries up front just moves the error. **Numbers are read
  by sherpa's own zh rule FSTs, applied by the real kaldifst (2026-08-10,
  previously in JS from 2026-08-08).** The applier is wasmtts's standalone
  kaldifst 1.8.0 + OpenFST wasm (338 KB, its own 16 MiB linear memory,
  instantiated in the synth worker from a blob URL), so the three 212 KB
  tables (`phone`, `date`, `number`, in that order) run without the 512 MiB
  sherpa-onnx bundle they normally ship inside. Its predecessor
  `matcha-fst.js` — a from-scratch JS OpenFST reader reproducing kaldifst's
  `TextNormalizer::Normalize`, verified byte-identical to kaldifst 1.8.0 on
  13,625 cases (2,547 generated plus 11,078 real book sentences) — survives
  as the node tests' oracle, and that verified equivalence is why the swap
  changed no reading. The one subtle part is the tie-break: these tables leave several
  readings at exactly equal cost, and OpenFST's `ShortestPath` uses an
  `AutoQueue` — a `TopOrderQueue` on an acyclic FST — so states relax in DFS
  reverse postorder with parents replaced only on a *strict* improvement. A
  plain Dijkstra finds the same cost and a different string, disagreeing on 33
  of 2,547 cases (`8.0` → 八.零, whose stray period becomes a sentence break).
  `scripts/test-matcha-fst.mjs` pins that with a hand-built fixture whose
  answer came from kaldifst itself. The tables are NOT adopted whole: measured
  against them, they are worse than the JS rules on three things for a Taiwan
  reader — `%` survives into text where it is in neither the lexicon nor
  `tokens.txt` and is dropped silently, `:` survives as a token the model
  vocalizes (~0.25 s of voiced artifact, not a pause — phone A/B 2026-08-08),
  and a 10-digit TW mobile falls past `phone.fst` (11-digit mainland
  only) into `number.fst` as 零九亿一千二百三十四万五千六百七十八. So
  `normalizeLocalForms` reframes those shapes first, keeping the digits so the
  tables still do the reading, and the JS rules stay behind the chain as the
  whole reading for a device whose pack predates the tables. Verified inert on
  all 11,078 prose sentences. **Pauses are the
  model's own, unedited: `silenceScale: 1`** (2026-08-08), overriding the
  ported default of 0.2 — `scaleSilence` is not a pause generator but a pause
  *cutter*, a hand-written pass that finds every silence over 0.2 s and
  shortens it to a fifth, and at 1 it returns the waveform untouched.
  Measured on one paragraph, silent runs at 0.2 vs 1: **， 55 ms → 280 ms,
  。 147 ms → 740 ms.** wasmtts ships the same 0.2 default, so the bench it
  came from is no counter-example: it suppresses commas there too. The
  piper-era `PAUSE_MS` splicing existed only because espeak ate the commas
  and is not coming back. One caveat measured at the same time: an isolated
  sentence carries ~590 ms of trailing and ~140 ms of leading silence, so a
  unit JOIN pays both (740 ms) where the model rendering the same two
  sentences in one pass pauses 306 ms. If that ever reads as draggy the fix
  is packing several sentences into one unit, not re-arming the cutter. One
  sentence is one unit (`segments()`, reusing `ENDERS`/`CLOSERS` from
  `tts-core.mjs` so the two splitters cannot drift); the worker
  lame-encodes each to mp3 and playback appends them to ONE
  ManagedMediaSource timeline (plain MediaSource on Chrome, so the same
  path is testable headless): chain-swapping blob WAVs died after ~5 min
  locked with a `play()` that never settled — no new-element `play()`
  survives the lock screen long-term, same lesson as the STREAM engine.
  The engine's flight recorder mirrors the timeline to
  `/api/testlog?page=player`. COOP/COEP is gone (`public/_headers`
  deleted): nothing needs `crossOriginIsolated` now that the threaded
  experiments are, and the engine was verified running with it false. The
  ~145 MB voice pack (five model files plus the three rule tables) is
  downloaded only through `downloadPack` in `wasm-tts.mjs` — the `/wasmtest`
  diagnostic and the stale-pack pill share it, and every entry is an explicit
  tap that names the megabytes (never ▶ itself — cellular) — into the
  `bw-wasmtts` cache;
  `packReady()` flips the reader to this engine, eviction falls back to
  STREAM, `localStorage bw_tts="stream"` forces the online engines. The
  cache sweep is a keep-set, not a name list, so it reclaims the whole
  piper/melo/fanchen era in one pass and never needs editing again. The
  same-origin JS modules and vendor bundles are fetched network-first at
  init (`cachedBuf` fresh mode; the service worker bounds it at 1 s and
  answers offline) because the copy parked in `bw-wasmtts` outlives every
  SHELL bump — the phone once inited the 1.26-dev ort UMD against the
  1.27.0 wasm exactly that way. Cache-first stays correct only for the
  release binaries, whose filenames carry their version.
  Binaries come from the `wasmtts-assets-v2` GitHub release via the
  allowlisted `/api/wasmtts/` proxy; `/wasmtest` imports the real engine
  rather than carrying its own copy, because a bench that drifts from what
  ships measures the wrong thing. **The engine code itself is vendored from
  the wasmtts git dependency (2026-08-10)** — `matcha-frontend.js`,
  `matcha-synthesis.js`, the kaldifst wasm and its wrapper, plus the
  `matcha-fst.js` test oracle land in `public/vendor/wasmtts/` via
  `vendor.mjs`, never hand-copied into `public/` again: the hand copies had
  drifted both ways (bookworm held the fromCharCode and colon fixes, upstream
  held the ruleNormalizer interface), and upstream's release gates (FST
  golden, RTF, 512 MiB, Whisper CER) test what this repo cannot. The pin is
  a release tag Renovate bumps; bookworm's fixes were upstreamed first
  (wasmtts PRs #1 #2) so the vendored file needs no local patches. **ort is
  pinned exactly, and since 2026-08-10 the pin lives upstream**: wasmtts
  declares `onnxruntime-web` (and `lamejs`) in its `dependencies`, and
  `vendor.mjs` resolves both through the wasmtts tree — this repo holds no
  ort version of its own, so ort can only move together with a gated engine
  release, never alone. History of the pin (2026-08-08, currently
  `1.27.0`) — it was the dev build `1.26.0-dev.20260416-b7804b056c`
  because that is what the first phone verification ran on; stable was
  adopted once it had been re-verified, because a dev version gets no
  security fixes and cannot be meaningfully bumped. Desktop e2e put
  1.26.0-dev at ×7.33, 1.26.0 at ×7.42 and 1.27.0 at ×7.28–7.37 — all
  run-to-run noise, so speed decided nothing and `latest` won on runway.
  The pin has no `^`: the wasm's byte length is asserted at init, so a
  floating range would break the engine on a lockfile refresh. **The
  release asset re-cuts itself (2026-08-10)**: `vendor.mjs` derives the
  versioned filename + byte length from the wasmtts tree into
  `public/vendor/wasmtts/ort-manifest.mjs` (the only place the app learns
  them; `wasm-tts.mjs` imports it, the worker allowlist admits the name by
  shape), and the deploy job runs `scripts/sync-wasmtts-assets.mjs` before
  `deploy.sh` — it uploads the pinned package's wasm under that name to
  `wasmtts-assets-v2` if absent, refuses a same-name-different-bytes
  replace, and then deletes stale ort versions (sole install, no
  backward-compat window). So an ort bump is: upstream repins → gated tag →
  bookworm repins one line → CI re-cuts and deploys. **Since 2026-08-15 the
  whole voice pack rides the same rail**: upstream's `matcha-assets.json`
  (schemaVersion 3) is the pack's canonical definition — per-asset
  packName/bytes/SHA-256, under the invariant that changed bytes change the
  packName — and `vendor.mjs` bakes it into `pack-manifest.mjs`, which
  `wasm-tts.mjs`, the worker allowlist and the tts-wasm e2e all read;
  `sync-wasmtts-assets.mjs` fetches any asset the pin names that the
  release lacks from its pinned source (SHA-verified) and sweeps names the
  pin dropped. No model filename exists in this repo's code — the steps-3
  pack outliving the v1.1.0 engine bump was exactly the drift this closes.
  A pack change reaches a phone as `packReady()` false: the reader falls
  back to STREAM and `player.mjs` offers the re-download as a one-tap pill
  (`player.packStale`), because a silent engine downgrade reads as the app
  losing a feature it used to have. The pill downloads in place (owner
  request 2026-08-15: leaving the book for `/wasmtest` felt like a detour)
  with its button naming the missing MB; narration keeps playing online and
  the offline engine returns at the next ▶ — never mid-session, because
  `useWasm()` is consulted live throughout playback. A same-name asset can
  still never change bytes, and a sync failure 404s loudly on device. Note
  `env.versions.common` reports *onnxruntime-common*, not the web package,
  so the drift guard checks the wasm's byte length instead. **A transcript
  diff cannot verify an ort bump**: Matcha samples fresh noise every call at
  noiseScale 1, so the same text through the same build renders different
  takes — two consecutive 1.27.0 renders of one sentence transcribed
  他觉得等钱得接到 and 他觉得的前进街道. What is stable across runs and
  across versions is identical, known 簡繁 defects included. Verify a
  runtime bump on the reader, not `/wasmtest`: the diagnostic plays a
  two-`<audio>` chain and cannot exercise backgrounded playback at all.
- **吃字調查:鏈路洗清,真兇是聲學模型的隨機發音劣化 (2026-08-14).**
  A full-chain local harness (real 劍來 chapters → `chunkChapter` →
  `ttsPrompt` → `segments` → the real worker's mp3 units → sequence-mode
  SourceBuffer appended *while playing*, with an AudioContext
  ScriptProcessor tap recording the PCM the element actually played)
  cleared every layer except synthesis. Text layer: all 1,182 chapters
  (12.9M chars) through the frontend drop **zero** Chinese characters
  (`unknown` catches only ASCII `-`/`*`/letters), so lexicon 簡繁
  completion would rescue nothing — both single-char spellings are already
  present, and a word entry for a non-破音字 word (前輩) yields the same
  phones as per-char fallback. mp3 concat + MSE junctions: zero loss at
  the *sample* level — capture PCM cross-correlates against the decoded
  unit concatenation at one constant offset (the start latency) with NCC
  0.92–1.00 at all 32 unit heads across two runs, and capture duration =
  concat + latency to ~10 ms. The real defect: a steps-3 render
  occasionally articulates one syllable as a different sound (人耳
  confirmed 老 → 近似「巧」/「蓝」in the probe 這位老前輩說。, ~2–4 of 50
  renders; which syllable is fragile depends on the carrier sentence).
  **No true silent deletion was ever confirmed** — every "missing
  syllable" flag turned out to be ASR error — so the on-device 體感
  「沒發聲」 is this mis-articulation being perceived as a skip.
  `noise_scale` 0.667 vs 1: no measurable difference, so the deliberate
  noise-1 setting is not the culprit; mitigation is wasmtts-side (more ODE
  steps or a different acoustic model), and the release gate's CER 骰運壓線
  is very likely this same phenomenon. **ASR calibration for any future
  listening test**: whisper-small alone is untrustworthy (its substitution
  flags were wrong on human check), a lone large model back-fills weak
  syllables via its LM; trust a flag only when small AND large-v3 mishear
  the *same* syllable (2/2 human-confirmed so far), and treat any deletion
  verdict as unproven until a human ear signs off. large-v3 int8 runs
  ~2–4 s per 2 s clip on desktop CPU. The harnesses (chain e2e with PCM
  tap, junction cross-correlation audit, dual-ASR consensus report) lived
  in a session scratchpad and are NOT checked in — rebuild from this
  description if needed. **The mitigation sweep came back negative
  (2026-08-15)**: ODE steps 2/3/4/6 (upstream ModelScope
  `dengcunqin/matcha_tts_zh_en_20251010` ships the full export set) ×
  `noise_scale` 0.3/0.5/0.667/1.0 all leave the mis-articulation rate
  unmoved — 2–5 consensus flags per 50 renders in every cell, statistical
  noise. The error mode is a neighbouring-syllable intrusion (老前輩 →
  「前」侵入 老, 再來找 → 再再找): alignment slippage inherent to the
  checkpoint, not noise amplitude, so more solver steps cannot buy it
  back. And the consensus detector itself is calibrated per carrier
  sentence: on the calibrated probe it is human-confirmed, but on a new
  carrier both whisper models share the same LM preference and it
  false-positives wholesale (21/50 on a sentence a human hears as fine),
  while long carriers trigger whisper's temperature fallback (~3 h for
  200 clips) — compare rates only on calibrated short sentences.
  Remaining routes: a different acoustic model or checkpoint, or accept
  the rate and promote the calibrated-sentence consensus rate to a
  release-gate metric.
- **iOS lock-screen ground truth (2026-08-08, measured on iOS 18.7 with a
  LAN probe replaying real per-sentence mp3 units through the reader's exact
  MediaSource + Media Session discipline).** Four facts, three of them
  platform ceilings no code change moves: (1) Media Session handlers are
  load-bearing — with none registered, iOS discards the Now Playing session
  ~3 s after a lock-screen pause and hands the card to another app, so the
  play/pause handlers stay registered even though a frozen page cannot
  always run them. (2) iOS freezes the page ~9–16 s after
  paused-while-locked (heartbeat gaps prove it); within that window
  lock-screen resume works — eight for eight in the logs — and after it the
  tap is queued and fires the handler the instant the phone unlocks, so
  "resume on unlock" is the designed outcome, not a bug. (3) The ~0.7 s
  fade after a lock-screen pause is the OS session ramp: the pause event
  lands instantly, then the clock records the ramp (`pause @X`, next
  `play @X+0.7`); visible-page pauses have no tail. Muting before pausing
  kills the ramp AND the Now Playing card instantly — rejected, the card is
  worth more than the tail. (4) The one genuine failure mode is OURS to
  catch: a resume can leave the element claiming "playing" with currentTime
  frozen and a full buffer, for minutes, across visibility changes — the ♥
  heartbeat in `player.mjs` watchdogs it (two stuck beats → micro-seek
  nudge, then a rebuild at the narration position). The toggle binding of
  both lock-screen buttons to `playerPlayPause` was suspected and cleared:
  the `playing` flag matched element truth at every logged invocation.
- **A reading opens at the visible page (2026-08-08).** 🔊 — and ▶ after
  navigating away while paused — starts at the first character of the page
  on screen (`pageStartOffset()`, per-char Range rects inside the straddling
  paragraph), never at the tracked `state.off`: that offset is
  paragraph-grained and sticky, so it routinely points a page or more behind
  the eye. The wasm engine synthesizes the first chunk from the sentence
  holding that char (`sentenceStartFor` in `tts-core.mjs` — the one
  ENDERS/CLOSERS walk shared with both splitters); the stream and chain
  engines seek proportionally into the first chunk instead. The ≤1-sentence
  pre-roll before the requested start is held by a one-shot floor — no page
  turn, no bookmark write — cleared on arrival and on ⏮/⏭. ✕ ends the
  session; the next 🔊 is a fresh reading from whatever page is then open.
  Following and restoring page on the SPOKEN character's rect
  (`offsetRect`), not the paragraph's start edge, so a paragraph spanning
  pages turns mid-paragraph and a mid-paragraph bookmark reopens on its own
  page. Accepted: the pre-roll re-reads up to one sentence that began on
  the previous page — a complete sentence beats starting mid-clause. The
  e2e page-start scenario runs on a one-paragraph multi-page chapter, the
  one shape paragraph-grained following could never turn. The audio suites
  pass `--mute-audio`: every assertion reads the media clock, never the
  speaker.
- **The spoken sentence is marked, the bar floats (2026-08-08).** While a
  reading plays, the sentence holding the spoken char carries a wash
  (color token `--hl`). NOT via the CSS Custom Highlight API: WebKit never
  repaints replaced or removed custom highlights — open bugs 266250
  ("painting does not invalidate properly when removing highlights",
  confirmed by a WebKit engineer as a paint-invalidation bug) and 259897
  ("sometimes does not repaint when live ranges are changed") — so on
  device every sentence ever spoken stayed washed (screenshot report
  2026-08-08). Instead the wash is self-painted: `#ttsHl` inside
  `#content` holds one absolutely-positioned rect per line fragment of the
  sentence's Range (content-space coords, so the rects ride page glides
  natively), replaced wholesale on every mark — ordinary DOM painting,
  which WebKit always invalidates — and removed on ✕. `#content` carries
  `position: relative; isolation: isolate` so the rects sit at `z-index:
  -1`, behind the glyphs but above the page background. Out-of-flow, so
  the paged grid and per-char rect maths are untouched; works below iOS
  17.2 too. Bounds come from `sentenceStartFor`/`sentenceEndFor` on the
  chunk's own text — the same ENDERS/CLOSERS walk as the splitters — so
  mark and audio can never disagree; a force-split run-on marks its whole
  chunk-sized piece, and the chapter-title announcement marks nothing (the
  heading renders as `<h2>`, not `p[data-off]`). Pause keeps the mark (it
  shows where you stopped); ✕ clears it. After rotation or a grid change
  the rects are stale for ≤1 timeupdate tick until the next mark repaints
  — the page-follow tolerance. The player bar itself is near-transparent
  (35% of `--bar-bg` over the blur, no shadow) with 1.4rem icon buttons,
  so it floats over the page instead of hiding it.
- **The shelf is 書衣, drawn on static markup (2026-08-13).** "/"'s screens
  (gate, shelf, install guide, message) are static sections in `index.html`,
  admin-style: `showScreen` raises exactly one, zh defaults live in the
  markup and the shared `applyI18n` in `i18n.js` sweeps `data-i18n` /
  `data-i18n-title`, JS fills only what carries data. A language switch is
  therefore a sweep plus a repaint, never a refetch, and e2e asserts a
  section's `hidden`, never an id's existence — the ids are all still there
  when a screen is down. The shelf paints device-first, the same rule
  positions follow: a cached `bw_books` renders immediately and the capped
  fetch can only improve it (fresh list, or the stale mark). Visually every
  book wears a 線裝書 cloth cover with a pasted 題簽 — cloth tone hashed
  from the permanent id so a re-slug keeps its cover; cloth and slip are
  MATERIAL colors, deliberately fixed, picked to stand on all 13 papers and
  the dark theme — and the device's open book (`bw_last_book`, the same
  book "/" resumes) leads as the 續讀 hero card. Progress is the accent
  讀線, rounded to whole percent: the thread carries the precision. A real
  cover is a pure R2 convention, `books/<id>/cover.jpg`: it paints over the
  cloth and the `<img>`'s error handler removes it, so the cloth is also
  what offline and cover-less books wear. Still no manifest field: the
  enriched-zip upload on /admin (see the enrichment entry below) just PUTs
  the canonical JPEG; the worker serves book images with real content-types
  and a day's cache (replaceable, unlike chapters), and the audit exempts
  the enrichment sidecars from stale-file accounting. Motion budget on the shelf: nothing beyond the
  existing busy-pulse. The reader surface's measured decisions (grid, 字級,
  bars) are untouched by all of this.
- **Enrichment rides sidecars, and a human carries the payload
  (2026-08-13).** An agent — any vendor, per `docs/enrich-a-book.md` —
  prepares an enriched zip named after the book (byte-faithful `book.txt`,
  researched `meta.json`, a flat front-cover image — the real one when
  findable, else generated to the runbook's designed-cover spec; the
  filename matters because /admin pre-fills title and slug from it) and
  the owner uploads it on /admin.
  No tokens, no agent API access to the site: the runbook can be pasted
  into any Claude/Codex project precisely because there is nothing in it to
  leak. All normalization is client-side in the upload page, where the
  owner is watching — cover transcoded to the canonical `cover.jpg`
  (1200 px long edge, JPEG), meta filtered to the four-key contract
  (title/author/synopsis/source, capped 100/100/2000/500). The sidecars
  live beside the book in R2 and survive republish: a plain `.txt`
  re-upload keeps the enrichment, because the sidecars are not the
  manifest's to rebuild. The author is the one meta field surfaced into
  D1 (`books.author`) — re-read from the sidecar by `sidecarAuthor()` at
  every `registerBook` call site (publish, reindex, retitle), returned by
  `/api/books` only when non-empty, and signed on the 題簽 in smaller
  落款 characters. Schema evolution: `schema.sql` is re-applied with
  `IF NOT EXISTS`, which never alters a live table — a new column must
  also ship a guarded `ALTER` in `scripts/deploy.sh`.
- **Identified API responses are `no-store` (2026-08-13).** The browser
  HTTP cache does not vary on credentials: `/api/books` used to answer the
  admin Bearer with `public, max-age=60`, so on the owner's phone the
  /admin list fetch seeded a cached copy that the reader-cookie shelf then
  read for the next minute — a just-uploaded book missing from the shelf.
  Every 200 on that route is identified (keyless requests 401), so the
  public copy served no one; it is `no-store` for every identity now.
  Offline loses nothing — the shelf's offline path is the app's own
  `bw_books` copy, never the HTTP cache.
- **Push stays healed, not assumed (2026-07-28).** The VAPID public key is
  derived from the private JWK at runtime, so `applicationServerKey` and the
  JWT can never drift. The phone's 已訂閱 is only its own opinion:
  `healPush()` re-upserts the device's real subscription at every open, and
  `forceRefresh` unsubscribes and retires the server row BEFORE
  unregistering the service worker, which is what destroys the
  subscription. iOS shows nothing unless every push shows a notification,
  and the app-icon red dot is an explicit `setAppBadge` call. The whole
  chain — worker send, push-service status, SW receipt, badge — logs to
  `testlog` page=push, and the 測試 button pushes the phone itself so each
  outcome names a different fix.
- **Release notes are written at ship time, never summarised (2026-08-12).**
  A reader who came here for a novel must not be shown "ci: pin every action
  to a commit digest", so RELEASES.md's commit subjects are the ledger and
  not the message. The reader-facing line rides in the commit that earns it,
  as a `Release-Note:` trailer written by whoever ships — the person or agent
  making the change is the one who knows what it means, and they know it
  then, not later. A commit without the trailer contributes nothing, which is
  how CI and refactor work stays out of a reader's face with nobody
  filtering it, and a release where nothing carried one says nothing at all.
  Upstream bumps need no prose because the version numbers *are* the note:
  they are read out of the `package.json` and `FONT_RELEASE` diff across the
  release, so a roll-up week says something true even though renovate writes
  one commit subject for the lot. **No AI summariser is involved and none is
  wanted** — GitHub Models, which would have been the free way to run one,
  was retired 2026-07-30 anyway. `scripts/release-notes.mjs` is the single
  computation; `gen-release-notes.mjs` writes `public/releases.json`
  **before** `deploy.sh` (the deploy uploads it, so it must exist first) and
  `update-releases.mjs` writes the same notes into RELEASES.md as `> ` lines
  **after** (a failed deploy must not claim a release). Those `> ` lines are
  also where the shipped JSON reads its history back from, so there is no
  second source of truth. The reader fetches `/releases.json` only once
  `checkVersion` has found an update — rare — and walks it down to its own
  build, so a phone left alone for a month hears about the whole month and
  never about the version it is already running.
- **A deploy announces itself (2026-08-08).** `checkVersion` in `app.js` can
  only run while a page is open, so an installed phone nobody opened never
  learns a newer shell exists. `deploy.sh` POSTs `/api/admin/announce-build`
  after every successful deploy and `announceBuild` pushes 新版本已上線 down
  the same channel 新書上架 uses, which is what puts the red dot on a closed
  app. The worker announces its **own** stamp, never one the caller supplies:
  the deploy hook says *when* to ring, the worker says *what shipped*.
  Exactly-once is the `announced_builds` row, keyed on the **commit alone** —
  re-running the deploy workflow restamps the clock but is the same version,
  and a rollback lands on a build that already rang. The first build on a
  fresh install is recorded silently (it is the install, not news), and a
  `dev` stamp never rings at all. Tapping the banner opens the shell rather
  than forcing a reload: `checkVersion` then raises 立即更新, and overriding
  it here would fight that note's "seen it, not now" dismissal. Announcing
  only *some* deploys was considered and dropped — a `sw.js` SHELL bump is
  about cache invalidation, not about whether a change is worth hearing
  about, and md-only pushes already skip the deploy entirely. The hook does
  pass the stamp it deployed, for one reason: **the edge can still be running
  the previous version seconds after `wrangler deploy` returns.** The deploy
  of `e96279f` landed on the old isolate, which announced *its* stamp, found
  it already recorded and reported success — so the build that had just
  shipped never rang and never would. A mismatch now answers `stale worker`
  and `deploy.sh` retries for 30 s.
- **testlog is the phone's console, and it is split by verb (2026-08-08).**
  An iPhone has no console and a push lands with no page alive, so the
  diagnostic pages (`/vhtest`, `/pgtest`, `/scrolltest`, `/pagedtest`,
  `/wasmtest`, `/speechtest`, linked from /admin), the player's flight
  recorder and the service worker all drop their readouts here — a permanent
  tenant. **Reads are gated**: the rows quote the book (dropped glyphs,
  synthesis prompts), and that is content. Read them with
  `curl -H "authorization: Bearer $ADMIN_TOKEN" '<origin>/api/testlog?page=…&limit=5'`.
- **Writing the testlog needs a cookie, because the writers cannot send a
  header (2026-08-12).** `POST /api/testlog` was open until now, on the
  argument that the writer that matters most cannot authenticate. The half of
  that which is true is narrower than it looked: sendBeacon takes only
  `(url, data)` — no headers argument exists — and it is what every uploader
  uses, because it is the only send that survives `pagehide`; a service worker
  has no page to read a token from either. What that rules out is a *header*,
  not a *credential*. Cookies are exactly the carrier this codebase already
  uses for `<audio src>`, sendBeacon and SW fetches (see the reader key
  below), so /admin now mints `bw_tlog` from the Bearer on every unlock and
  the three sendBeacon call sites did not change by one character.
  It is **not** the admin token in a cookie: the value is a stateless
  `<exp>.<HMAC(ADMIN_TOKEN, "testlog:<exp>")>` — no session table, no D1 read
  on the write path, and rotating `ADMIN_TOKEN` invalidates every outstanding
  one at once. It cannot reach `/api/admin/*` either, and not because of a
  `SameSite` rule: `handleAdmin` checks the Bearer header itself and never
  reads a cookie, so the route structurally cannot see this credential.
  The cost, accepted deliberately: a device with only a reader key stops
  logging. `player.mjs` (page=player) and `app.js` (page=push) run in the
  reader app, so on someone else's phone those go silent — "did THEIR phone
  get the notification" is no longer answerable from the log. The alternatives
  were worse. A body token needs a `fetch` probe to be observable at all,
  because sendBeacon returns whether the UA *queued* the request and never
  the status — a 401 is invisible, so a stale token is permanent silence with
  no signal anywhere. And a signature is not merely expensive but
  structurally impossible on the path that matters: WebCrypto is async, and
  a `pagehide` handler cannot await.
- **The testlog quota is per page, because a shared window is won by the
  loudest writer (2026-08-12).** The table self-pruned to the newest 500 rows
  overall, and that budget was not shared, it was raced for. `player.mjs`
  heartbeats every 10 s and coalesces on a 1.5 s timer, so roughly six rows a
  minute: one 83-minute listening session evicted the entire table — including
  the `page=push` breadcrumbs, which are the lowest-volume and highest-value
  rows in it, and the only witness to whether a phone got a notification.
  Auth does not fix this; it happened on one device, to itself. So the same
  500 rows are now split by page (`TESTLOG_PAGES` in `src/worker.js`:
  player 200, push 120, six diagnostic pages 30 each), which also makes the
  page list load-bearing — a quota is per bucket, so an unlisted page name
  would be an unbounded row count, and `ELSE 0` drops rows in pages nobody
  lists (which is how pre-quota rows clean themselves up). The prune runs on
  every 25th insert rather than every one: it is a full-table scan, and on
  D1's free plan rows-**read** binds long before rows-written — every-insert
  pruning cost ~3000 reads a minute with the recorder running. The table
  drifts at most 24 rows over quota in between, which buys a 25× margin.
  `testlog (page, id DESC)` indexes both readers: the gated GET and the
  prune's window function.
- **/admin is folds, not one scroll (2026-08-12).** Eight panels stacked open
  made the page 1959 px on a 430×932 phone — over two screens before the
  first tap. Each panel below the key gate is a `<details class="fold">`
  now, so closed the whole page is a stack of headings at 932 px: one
  screen, exactly. `<details>` is the entire mechanism — it collapses with
  no script, so a failed module load leaves a usable page rather than a
  blank one, and the e2e suites keep driving it because a JS `.click()`
  fires inside a closed fold. Which folds are open lives in
  `bookworm:admin-open` (localStorage), restored at load rather than in
  `unlock()` — the elements exist while still `hidden`, and `unlock()` can
  run twice in a session, which would double the `toggle` listeners. First
  visit opens 書架上的書 alone. 認證 stays a plain `<section>` (a gate that
  folds is a gate you can lock yourself out of looking at) and so does
  上傳預覽, which appears as the RESULT of 分析章節 and must not need a
  second tap. The 裝置診斷 links became one tap target per row at the same
  time: they were bare inline `<a>`s with no CSS at all, running together
  into one ambiguous smear on a phone. An anchor-nav was the alternative
  and was rejected — with the folds closed the page is already one screen,
  so a second navigation system would be furniture for a problem that no
  longer exists.
- **The diagnostic-upload switch is a door on your own house (2026-08-12).**
  `/admin` → 裝置診斷 has a checkbox that stops THIS device's diagnostic pages
  from POSTing readouts (`bw_testlog` in localStorage, read by
  `public/testlog.js` before every send). It is not the gate — the gate is the
  `bw_tlog` cookie in the worker, a different door on a different wall, and
  nothing in `testlog.js` reads or sends that cookie because it rides
  sendBeacon by itself. What the switch buys is the source of noise the gate
  cannot see, since the noise is your own: six pages uploading on a redraw
  loop will fill their own quotas by themselves, and turning them off needs no
  deploy. The service worker's push breadcrumb deliberately does
  **not** ride the flag — a SW cannot read localStorage, reaching it would
  cost a message channel, it is one row per push rather than a loop, and it
  is the line most worth having in the field. The five copies of the upload
  block collapsed into `testlog.js` at the same time: a flag checked in five
  copies is a flag that works in four. A device with uploads off says so on
  the console once per page, because the failure mode is otherwise
  silent — you curl the log, see nothing, and blame the phone.
- **Check and fix are different buttons (2026-07-30).** On /admin, 健康檢查
  is read-only and 修復 is the only thing that writes — a check that
  mutates what it is checking is not a check, and the check treats the D1
  index as evidence under audit, never as a premise (the files are the
  book; a row is an opinion). Every destructive request re-verifies its own
  premise server-side (`?expect=gone|bad-manifest|incomplete`, 409 on
  mismatch) rather than trusting a scan from an earlier request, and checks
  carry no silent caps — a truncated report reads as a clean bill of
  health, the one thing it must never do. An incomplete book is swept whole
  and re-uploaded (owner's rule, made twice: if the index cannot account
  for it, don't rescue it). Carrying the book id across a re-upload was
  considered and rejected — positions would survive pointing into re-split
  text, and a silently wrong position is worse than a zeroed one.
- **Runaway-bookmark defenses (2026-07-26).** `savePos` no-ops when
  (chapter, offset) is unchanged, so opening a link never re-confirms a
  stale position; tap paging parks while a chapter is loading; a synced
  position ≥ 2 chapters from this device's own last record shows the
  dismissible jumpnote pill with one-tap restore. The original +100-chapter
  jump was never conclusively reproduced, so the recovery UI is the
  load-bearing fix.
- **The bookmark pull runs in the background (2026-08-12).** `resolvePosition`
  reconciles once, when the book opens — and an installed PWA is *reopened*,
  not reloaded, so that one answer used to stand for as long as the app
  stayed alive. A device that opened offline kept a stale bookmark even after
  the network came back: the `online` handler only ever pushed. Both
  directions now recover. `checkRemotePosition` re-runs the reconcile on the
  foreground flip (how a phone "reopens") and after the online flush, and
  answers with the same pill vocabulary as the runaway defense above — it
  **never moves the page**, because "the other device is ahead" is a weaker
  claim than "this reader asked to go there". Its rules: it stands down while
  `state.dirty`, since a row that has not seen our own writes has nothing to
  teach; it takes the looser 4 s cap rather than `NET_MS`, on
  `checkVersion`'s reasoning — it blocks nothing, and a 1 s cap on a slow
  link would just mean the notice never arrives; each remote `updated_at` is
  offered exactly once, so a dismissal stays dismissed; and a same-chapter
  difference is silent, because the pill would name the chapter the reader is
  already in and two devices a few paragraphs apart resolve themselves on the
  next LWW write. Direction is not a criterion — a phone that jumped
  backwards is news too. Settings deliberately do NOT get this treatment: a
  background `resolveSettings` would reflow a rendered chapter, which is the
  one thing its own comment forbids. Reader event listeners moved into
  `wireReaderEvents()` behind a once-guard at the same time: `initReader`
  re-enters (a repaired 401, the key gate's retry) and today both paths turn
  back before the tail, so nothing doubles — the guard is what keeps that
  from being load-bearing. `test:sync` pins all of it, counting window
  listeners per registration *site* rather than per type (app.js and
  player.mjs both own a `pagehide`, correctly).
- **Chapter bodies are blank-line free (2026-08-03).** The reader renders one
  `<p>` per line that survives `trim()`, so a blank line is pure char-offset
  padding — and "blank" must mean *takes no ink*, not just whitespace: scraped
  novels pad chapters with zero-width spaces, braille blanks (U+2800), and
  Hangul fillers, which pass `trim()` and render as empty paragraphs.
  `normalizeBody` in `split-core.mjs` strips zero-width characters
  (`GHOST_CHARS`) outright, drops ink-free lines, and runs at import — CLI and
  /admin both pass through `piecesToEntries` — while
  `scripts/renormalize-books.mjs` applies the identical, idempotent rule to
  books already in the store through the admin API (chapters first, manifest
  last with fresh chars/bytes/generatedAt so `?v=` caches bust and the shelf
  index stays honest; the log prints removed codepoints and 1-based chapter
  numbers, never titles).
- **CI flake ledger (2026-08-10).** One red so far judged infrastructure,
  not code: `push-api-e2e` failed once with undici `SocketError: other
  side closed` against wrangler dev (nine suites green in the same run,
  adjacent runs on the same tree green) — a workerd connection drop. One
  occurrence does not buy a retry mechanism; if the same shape recurs
  (UND_ERR_SOCKET / "other side closed" against the dev server), give the
  server-backed suites one automatic re-run in `scripts/run-ci-tests.mjs`
  recording an `attempts` field — the wasmtts gate-runner pattern — and
  do not start by suspecting the push code. The other red in the ledger
  was ours: `admin-e2e`'s author assertion raced enrichment (fixed in
  PR #37 by waiting on `metaPreview`), so a new `admin-e2e` red is a new
  problem.
- **Deploy & ops.** The custom domain is added in the Cloudflare dashboard
  only — the deploy token has no zone permissions, so putting the domain in
  `wrangler.jsonc` `routes` breaks `deploy.sh`. `deploy.sh` captures
  `wrangler whoami` output and prints it only on failure: it names the
  account's email, and a public repo's Actions logs are world-readable.
  README screenshots are staged on an isolated `wrangler dev --persist-to`
  scratch instance with public-domain books from 維基文庫, captured over
  CDP at 390×844 @2× — never against the live shelf. The owner's contact
  address and the live origin were scrubbed from the tracked tree before
  publication and are never reintroduced: the contact exists only in the
  `VAPID_SUBJECT` repo secret, the origin only in the `BOOKWORM_URL`
  secret and each owner machine's untracked `.dev.vars`
  (`BOOKWORM_ORIGIN=`). Actions masks secrets in logs but NOT in step
  summaries, so a workflow must never echo the origin into
  `$GITHUB_STEP_SUMMARY`. The pre-publication history lives only in the
  owner's private archive repo and its local clone
  (`~/workspace/bookworm-archive`); never push any of it here.

## Backlog

- Surface the rest of the enrichment meta: `synopsis` (and `source`)
  are already in the sidecar; a place to show them (long-press? the
  reader's 書衣 page?) is undesigned.
- Multi-lingual beyond the UI chrome: per-book `lang` in the manifest; TTS
  voice and chunker per language (ENDERS/PAUSES/CHARS_PER_SEC are CJK
  today); font stack and break rules per language; offer 直排 only for CJK
  books; chapter-title detection beyond 第…回／章.
- R2 `_tts/` eviction (lifecycle rule or admin sweep) if storage grows.
- 吃字 mitigation (see 吃字調查 2026-08-14/15): higher ODE steps and
  noise_scale are measured dead ends; what is left is a different acoustic
  model or checkpoint — candidates are hunted in the owner's separate
  `mytts` lab repo (an own zh_TW-accented voice inside the huayan CPU
  budget) — or promoting the calibrated-sentence consensus rate to a
  wasmtts release gate.
- Playback speed control (`audio.playbackRate`) in the player bar.
- File the iOS scrollBy-doubles bug at bugs.webkit.org (evidence is in the
  archive's 2026-07-28 commits; low priority).

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
which costs were accepted. Decisions worth keeping are distilled into
**Standing decisions** above; superseded entries are deleted, not annotated.
