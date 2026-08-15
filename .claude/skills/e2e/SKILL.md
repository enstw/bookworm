---
name: e2e
description: Project runbook for Bookworm's e2e suites — which suites need the dev server, the two-stage offline runbook, and bookworm-specific conventions. Use when running tests, when a suite fails mysteriously, or when writing a new e2e test. The general method (CDP client, suite taxonomy, authoring rules) lives in the account-level browser-e2e skill.
user-invocable: true
---

# Bookworm e2e suites

Only what is bookworm-specific lives here. The method — the CDP client API,
suite taxonomy, verdict contract, service-worker testing rationale — is the
account-level `browser-e2e` skill (from the skill-jz collection); the
scripts in `scripts/` are the source of truth.

## Preconditions

- A Chromium: `scripts/find-browser.mjs` resolves `BROWSER_BIN` → the
  browser-cdp skill's provisioned wrapper → installed Brave/Chrome/chromium →
  playwright's headless shell. It and `scripts/cdp-client.mjs` are verbatim
  copies of the browser-cdp skill's templates — refresh them by re-copying,
  never by editing in place.
- Server-backed suites need `pnpm run dev` and `ADMIN_TOKEN=<value from
  .dev.vars>`. If 8787 was busy, wrangler silently took 8788 — export
  `BOOKWORM_URL=http://localhost:8788` to follow it.
- Fresh checkout: `pnpm run db:init:local` first, or every table read 500s.

## Suite matrix

| suite | command | needs |
| --- | --- | --- |
| slug, worker-pool, push-crypto | `pnpm run test:slug` etc. | nothing (pure node) |
| vertical, bg, testlog | `pnpm run test:vertical` / `test:bg` / `test:testlog` | Chromium only (own static server) |
| auth, sync, admin, shelf-admin, push-api | `pnpm run test:auth` etc. | dev server + ADMIN_TOKEN |
| tts-stream | `pnpm run test:tts-stream` | Chromium + `ffmpeg` on PATH (own static server) |
| **everything above** | `ADMIN_TOKEN=… pnpm test` | dev server + Chromium |
| **everything above, one command** | `ADMIN_TOKEN=… node scripts/run-ci-tests.mjs` | Chromium (spawns its own server if 8787 is silent; per-suite logs in `test-artifacts/`) |
| offline | see runbook below | dev server, then NO server |
| tts-wasm | `MATCHA_MODEL_DIR=… pnpm run test:tts-wasm` | Chromium + ~130 MB of model weights (own static server) |

`tts-wasm` stays out of the `pnpm test` chain because it needs the voice-pack
weights on disk. It serves them itself from `MATCHA_MODEL_DIR` (the directory
holding `matcha-icefall-zh-en/` and `vocos-16khz-univ.onnx`) instead of the
GitHub release, so it runs before a release is cut and never touches the
network. Its profile is deliberately persistent — the Cache API pack survives
between runs, so only the first one pays to load 130 MB. Run it after any
change to `wasm-tts.mjs`, the worker allowlist, or the ort pin: it is the only
thing that exercises two ort sessions, the mp3 encode and the SourceBuffer
append together.

### Fetching the weights (tts-wasm, and the gated halves of wasm-frontend / matcha-fst)

**Never point `MATCHA_MODEL_DIR`/`MATCHA_FST_DIR` at a live wasmtts
checkout** — that is the owner's working folder; its contents mutate and
vanish mid-experiment (a batch died exactly this way, 2026-08-15). The
assets are pinned through the wasmtts dependency (`matcha-assets.json`, the
pack's canonical definition); fetch a SHA-256-verified private copy once —
re-runs skip files that still verify, and a model bump upstream changes what
this fetches with no edit here:

```sh
node scripts/fetch-matcha-weights.mjs   # fills ~/.cache/bookworm-matcha
```

Then:

- `MATCHA_MODEL_DIR=~/.cache/bookworm-matcha pnpm run test:tts-wasm`
  (add `MATCHA_FST_DIR=~/.cache/bookworm-matcha/matcha-icefall-zh-en` to
  assert the rule tables loaded; without it the run asserts the JS-rules
  fallback half instead — that split is deliberate)
- `MATCHA_MODEL_DIR=~/.cache/bookworm-matcha/matcha-icefall-zh-en node scripts/test-wasm-frontend.mjs`
- `MATCHA_FST_DIR=~/.cache/bookworm-matcha/matcha-icefall-zh-en node scripts/test-matcha-fst.mjs`

## The reader gate (affects every server-backed suite)

Content routes (`/api/books`, `/books/*`, TTS, positions, settings, push
subscribe/test) 401 without a credential. The rules a suite lives by:

- Mint an identity through the route /admin uses: `POST /api/admin/readers
  {user, label}` with the admin Bearer → `{key}`; send it as an
  `x-reader-key` header on content fetches, and revoke it
  (`DELETE /api/admin/readers/<key>`) on the way out.
- Positions and settings belong to the KEY's user — asserted `user` params
  and body fields are ignored, so mint the key bound to the user the suite
  asserts about.
- The admin Bearer passes the gate for book content but has NO reader
  identity: positions/settings answer it 401.
- A browser profile enrolls by navigating `/?key=…` once — the app swallows
  the key and earns the cookie; `test-auth-e2e.mjs` is the reference.
- Still open (never send a key): `/api/feedback`, `/api/push/vapid`,
  `/api/push/unsubscribe`, the shell. Reading the testlog is gated — send the
  admin Bearer, as `test-push-api-e2e.mjs` does.
- Writing the testlog needs the `bw_tlog` cookie, and the admin Bearer does
  NOT substitute for it: `POST /api/admin/session` with the Bearer, then send
  the `set-cookie` value back (`test-auth-e2e.mjs` is the reference). A header
  would be the wrong shape to test — sendBeacon and the service worker, the
  writers this endpoint exists for, cannot send one.
- In-process suites (vertical, bg, tts-stream) stub their own `/api` and
  never see the gate.

## The offline runbook (test:offline)

Two invocations, same browser profile — the offline stage needs the server
genuinely dead (`browser-e2e` explains why emulation cannot substitute):

1. `ADMIN_TOKEN=… node scripts/test-offline-e2e.mjs prime` — publishes the
   test book, mints a reader key for `e2e-tester` and enrolls the browser
   profile with it (the cookie is state the offline stage inherits), then
   verifies the implicit ±5 window, the ⇣ arm/disarm cycle in the reader and
   on the shelf, and eviction. Repeatable: it pins the reader's position
   back to chapter 0 itself.
2. **Stop the dev server — completely.** Killing the wrangler parent can
   leave `workerd` alive and answering; curl the port and
   `lsof -ti :8787 | xargs kill` stragglers until it is dead.
3. `node scripts/test-offline-e2e.mjs offline` — no server: the service
   worker must serve shell, manifest and chapters; outside the cached window
   must degrade to the retry UI, not crash.
4. Restart `pnpm run dev` for whatever runs next.

## Bookworm-specific conventions

- CDP ports are 934x, profiles `/tmp/bookworm-<suite>-e2e-profile`; the
  offline stage-2 deliberately keeps its profile (that IS the test).
- **A suite that throws leaves its browser alive**, because `close()` never
  runs — and the next run's `launch()` connects to that survivor on the same
  port, inheriting its localStorage. `rmSync(PROFILE)` does not help: the
  zombie already holds the profile open. The symptom is a suite failing on
  state that should be factory-default, with the wrong value *drifting
  between runs* (bg-e2e starting on 雪白, then 淡綠, then 紫紅). It is not the
  code under test. Check with
  `ps ax | grep remote-debugging-port=93` and kill the strays before
  believing any red run that follows a crashed one.
- The chrome is 中文 first: assert user-facing strings against both
  languages, e.g. `/載入失敗|Failed to load/`.
- 直排 suites run phone-shaped (`--window-size=430,900`) — a desktop-wide
  window puts the pager in a typographic regime readers never see.
- New suites join `package.json` as `test:<name>`; only single-command
  suites join the `pnpm test` chain (the offline two-stage stays manual).
- **An in-process static server must map `/admin` and `/vhtest` to
  `admin.html` and `vhtest.html`** the way Cloudflare's assets layer does
  (`if (!file.includes(".") && exists(file + ".html")) file += ".html"`).
  Miss it and the SPA fallback quietly returns the reader shell instead:
  the page under test never loads, and every assertion about it passes
  vacuously. `test:testlog` has the rule.
- A "second device" needs no second browser: positions belong to the KEY's
  user, so a `POST /api/position` from node with the same key is one, and
  `test:sync` is the reference. It also dispatches `visibilitychange` by hand
  — on a page that really is visible, which is the branch the handler takes
  when a phone comes back — rather than driving the browser's own lifecycle.
- Counting event listeners (`DOMDebugger.getEventListeners` on the window
  objectId) is per registration *site* — `type@scriptId:line:col`. Per type
  is wrong: app.js and player.mjs both own a `pagehide`, correctly.
