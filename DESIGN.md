# Bookworm

A private Chinese-first reader: one Cloudflare Worker (`src/worker.js`), a
vanilla-JS PWA in `public/`, chapters in R2, reading positions in D1.

The v1 contract lives in `REQUIREMENTS.md`. The git log is the engineering
history — commit bodies carry the prose. The standing decisions below are the
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
  reconcile carries a 4 s abort — a dying cellular link hangs fetches, and
  reading must not wait on a bookmark the device already holds. The legacy
  `/<book>/<uid>` route is deleted, not shimmed. An online not-found forgets
  `bw_last_book`; an offline not-found forgets nothing.
- **TTS (2026-07-15 onward).** Two engines in `player.mjs`: STREAM
  (`ManagedMediaSource`, one continuous mp3 timeline — no chunk boundary
  ever needs `play()` while the screen is locked) where supported, CHAIN
  (double-buffered element swap) elsewhere; `globalThis.bwPlayer` says
  which. The backend speaks Microsoft Edge read-aloud (protocol gotchas
  commented in `src/edge-tts.js`); real Mandarin rate ≈ 4.5 chars/s; TTS
  chunk 0 is always the chapter heading alone. Verify any backend change by
  Whisper-transcribing a sample — duration checks cannot hear garbage,
  which is how the MeloTTS breakage was confirmed. Rejected alternatives,
  kept for the day edge-tts dies: Web Speech API (iOS pauses it on lock),
  Azure/OpenAI TTS (~$200/novel), MeloTTS (broke upstream; voices
  zh-TW-HsiaoChen/YunJhe were the shortlist).
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
