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
- `pnpm run dev` — wrangler dev on <http://localhost:8787>. Use pnpm, not npm.
- `ADMIN_TOKEN=<value from .dev.vars> pnpm test` — the suite, against a
  running dev server. Before running or writing e2e tests, read the runbook
  in `.claude/skills/e2e/SKILL.md`: it has the suite matrix and the two-stage
  offline runbook (which needs a genuinely dead server — DevTools offline
  emulation does not reach service workers).
- Never run `wrangler deploy` or `scripts/deploy.sh` by hand (a Claude Code
  hook in `.claude/settings.json` enforces this). Every push to main deploys
  through GitHub Actions; md-only pushes are skipped.

## The owner's suggestion queue

Start a session by reading `/api/feedback` on the owner's live instance
(plain GET, no key; the origin is deliberately not written into this public
repo — agents keep it in local memory, humans ask the owner). Each note is
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
  `/api/feedback`, `/api/testlog`, push vapid/unsubscribe. e2e suites mint
  their own key — the e2e runbook has the rules.

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
  always the chapter heading alone. Verify any backend change by
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
  著, and guessing entries up front just moves the error. **Pauses are the
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
  ~137 MB voice pack is downloaded ONLY by the `/wasmtest` diagnostic
  (never by ▶ — cellular) into the `bw-wasmtts` cache both pages share;
  `packReady()` flips the reader to this engine, eviction falls back to
  STREAM, `localStorage bw_tts="stream"` forces the online engines. The
  cache sweep is a keep-set, not a name list, so it reclaims the whole
  piper/melo/fanchen era in one pass and never needs editing again.
  Binaries come from the `wasmtts-assets-v2` GitHub release via the
  allowlisted `/api/wasmtts/` proxy; `/wasmtest` imports the real engine
  rather than carrying its own copy, because a bench that drifts from what
  ships measures the wrong thing. **ort is pinned to
  `1.26.0-dev.20260416-b7804b056c` on purpose** — a dev build, but the one
  the phone verification was performed on, and its wasm differs from stable
  1.27.0's by 537 KB. Moving it means re-verifying on device and re-cutting
  the release asset (whose filename carries the version, so a forgotten
  re-cut 404s loudly), not a routine bump. Note `env.versions.common`
  reports *onnxruntime-common*, not the web package, so the drift guard
  checks the wasm's byte length instead.
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
- **testlog is the phone's console.** An iPhone has no console and a push
  lands with no page alive, so `/api/testlog` is unauthenticated by design,
  size-capped, self-pruned to the newest 500 rows — a permanent tenant. The
  on-device diagnostic pages (`/vhtest`, `/pgtest`, `/scrolltest`,
  `/pagedtest`, linked from /admin) write their readouts there; read them
  with `curl '<origin>/api/testlog?page=…&limit=5'`.
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
- **Deploy & ops.** The custom domain is added in the Cloudflare dashboard
  only — the deploy token has no zone permissions, so putting the domain in
  `wrangler.jsonc` `routes` breaks `deploy.sh`. `deploy.sh` captures
  `wrangler whoami` output and prints it only on failure: it names the
  account's email, and a public repo's Actions logs are world-readable.
  README screenshots are staged on an isolated `wrangler dev --persist-to`
  scratch instance with public-domain books from 維基文庫, captured over
  CDP at 390×844 @2× — never against the live shelf.

## Backlog

- Multi-lingual beyond the UI chrome: per-book `lang` in the manifest; TTS
  voice and chunker per language (ENDERS/PAUSES/CHARS_PER_SEC are CJK
  today); font stack and break rules per language; offer 直排 only for CJK
  books; chapter-title detection beyond 第…回／章.
- R2 `_tts/` eviction (lifecycle rule or admin sweep) if storage grows.
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
