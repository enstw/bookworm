# Bookworm install & operations manual

This manual is written for **the AI agent installing Bookworm for you**. Hand the whole file to the
agent in your terminal (Claude Code, Codex, …) and say "follow `INSTALLATION.md` and install Bookworm
into my accounts"; only the steps marked 🧑 need a human's hands, and every other step is a command the
agent can run and verify by itself. No agent? The same commands run fine by hand, in order, with the
same result.

For the product story and feature overview, return to the [README](README.en.md). Read
[DESIGN.md](DESIGN.md) before changing code; installing does not need it.

## Who does what

🧑 **The human does exactly three things**, all in a browser:

1. Have a free [Cloudflare account](https://dash.cloudflare.com/) and open the R2 page once to activate
   it (first activation may ask for billing details; usage within the free allowance stays `$0`).
2. Create a Cloudflare API token (permission table in step 2), copy the Account ID, and hand both to
   the agent — or run the two token-pasting commands yourself.
3. After deployment, open the reader-key link on the phone and add the app to the Home Screen.

Everything else — fork, secrets, deployment, verification, key minting, publishing — the agent does
with `gh` and `curl`. Also have ready: a `.txt` book you have the right to store and use (Bookworm
ships no content), and a password manager for the `ADMIN_TOKEN`.

## Rules for the agent

- **Secrets travel by stdin only.** `gh secret set` reads stdin; never write a secret into a file, a
  command-line argument, a commit, or a public log. The Cloudflare token is best pasted by the human
  (step 3).
- **Verify every step.** Each step states its expected result; on a mismatch, stop there and consult
  Troubleshooting instead of retrying until it passes.
- **Deploy through GitHub Actions, always.** No local wrangler is needed; once installed, pushing to
  `main` is deploying. (The no-Actions alternative is `deploy.sh` under Local development.)

## Preflight

```sh
gh auth status        # logged in to GitHub, scopes include repo and workflow
git --version && curl --version && openssl version
```

Local pnpm and Node are needed only for path B of "The first book" and for Local development.

## Install

### 1. Fork and enable workflows

```sh
gh repo fork enstw/bookworm --clone=false
FORK="$(gh api user -q .login)/bookworm"
gh workflow enable deploy.yml --repo "$FORK"
```

GitHub disables workflows inherited by a fork; `gh workflow enable` is the CLI equivalent of the
"I understand my workflows, go ahead and enable them" button. Enable `publish-book.yml` and
`push-test.yml` later, when they are used.

### 2. 🧑 Create a Cloudflare API token

In Cloudflare: **My Profile → API Tokens → Create Token → Create Custom Token**. The built-in "Edit
Cloudflare Workers" template does not include R2 and D1, so grant exactly:

| Scope | Permission | Level |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

Under **Account Resources**, include your account. The two Read permissions exist only for the
pre-deployment `wrangler whoami` check. Also copy the **Account ID** from the sidebar under
**Workers & Pages**.

### 3. Add the three secrets

The two Cloudflare values are pasted by 🧑 directly into the terminal (`gh secret set` reads stdin:
paste, press Enter, then Ctrl-D), so they never pass through the conversation with the agent:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo "$FORK"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$FORK"
```

`ADMIN_TOKEN` is Bookworm's own administration key; the agent mints it:

```sh
ADMIN_TOKEN="$(openssl rand -hex 24)"
echo "$ADMIN_TOKEN"   # 🧑 store it in the password manager first — GitHub secrets are write-only
printf '%s' "$ADMIN_TOKEN" | gh secret set ADMIN_TOKEN --repo "$FORK"
```

### 4. Deploy

```sh
gh workflow run deploy --repo "$FORK"
RUN="$(gh run list --repo "$FORK" --workflow deploy --limit 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$RUN" --repo "$FORK" --exit-status
```

(The run takes a second or two to appear; retry `gh run list` if it comes back empty.) The workflow
verifies the token, creates the `bookworm` D1 database and the `bookworm-books` R2 bucket, applies
`schema.sql`, deploys the Worker, installs the secrets, and finally probes `/api/books` with the
`ADMIN_TOKEN`. The whole run takes two to three minutes.

Then pull the URL out of the log:

```sh
URL="$(gh run view "$RUN" --repo "$FORK" --log | grep -m1 -oE 'https://[a-z0-9.-]+\.workers\.dev')"
echo "$URL"
```

Expect something like `https://bookworm.<your-subdomain>.workers.dev`. From here on, every push to
`main` deploys automatically; Markdown-only pushes are skipped. Pulling upstream updates is under
Routine maintenance.

### 5. Verify

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/books"          # expect 401
curl -s -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/books"   # expect {"books":[]}
```

The keyless 401 is correct: content sits behind the reader key. Opening `$URL` in a browser shows a
locked door asking for a key — same thing.

### 6. The first reader key

Reading requires a **reader key**, one per device. The agent mints it directly:

```sh
curl -s -X POST "$URL/api/admin/readers" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"label":"my iPhone"}'
# expect {"ok":true,"key":"<32 hex chars>","user":"<minted reader id>","label":"my iPhone"}
```

The sign-in link is `$URL/?key=<key>`. 🧑 AirDrop or message the link to the reading device and open
it there — the device is signed in for good and lands on the shelf; the app also offers the
"Add to Home Screen" steps once, installing the full-screen PWA.

- One reader (one `user` id) can hold several keys; positions and settings sync through the id. Mint
  the second device's key with the same id: `-d '{"user":"<id>","label":"iPad"}'`.
- Lose a device — revoke its key and every other device is untouched: on `/admin`, or
  `curl -X DELETE "$URL/api/admin/readers/<key>" -H "authorization: Bearer $ADMIN_TOKEN"`.
- Offline reading is on by default: opening a book keeps its nearby chapters and the app shell on the
  device; tap ⇣ on a book's shelf card to stock the whole book, tap again to drop it.

### 7. The first book

Publishing never redeploys. Three paths; pick one:

**A. Browser upload (🧑, most private, no tools)** — open `$URL/admin`, paste `ADMIN_TOKEN`, choose a
`.txt` or `.zip`, inspect the detected title, slug and chapters, upload. Decompression, charset
conversion (UTF-8/GBK/Big5/Shift_JIS), OpenCC `cn→tw` conversion and chapter splitting all run inside
the browser; if headings are missed, provide a regex such as `^第.+章`. Re-uploading the same slug
replaces the book in place and keeps reading positions.

**B. Local CLI (agent; needs [pnpm](https://pnpm.io/installation) 11 and Node 22)** —

```sh
gh repo clone "$FORK" bookworm && cd bookworm && pnpm install
pnpm run split -- ~/books/mybook.txt --title "Book title" --slug mybook
pnpm run publish-book -- out/mybook --url "$URL" --token "$ADMIN_TOKEN"
```

Useful splitter options: `--charset gbk|big5|shift_jis` (output is always UTF-8), `--s2t` (OpenCC
`cn→tw` over body, titles and filenames), `--pattern '^第.+章'`. Fewer than three heading matches falls
back to size-based parts, and oversized chapters split again at line boundaries; a directory of
existing `NN_title.txt` files works as input directly. The generated `out/` is gitignored.

**C. GitHub Actions (no local tools; public logs)** — for a large file that only exists at a URL:

```sh
printf '%s' "$URL" | gh secret set BOOKWORM_URL --repo "$FORK"
gh workflow enable publish-book.yml --repo "$FORK"
gh workflow run "publish book" --repo "$FORK" \
  -f source_url="https://example.com/book.txt" -f s2t=true -f dry_run=true
```

`dry_run=true` only splits and lists the detected chapters in the run summary; rerun without it once
they look right. ⚠ Inputs and logs of a public repository are visible to everyone, book and chapter
titles included — use path A or a private fork for copyrighted or sensitive material.

The install is complete: the shelf is at `$URL`, administration at `$URL/admin`.

## Optional configuration

### Custom domain

🧑 In Cloudflare: **Workers → bookworm → Settings → Domains & Routes → Add**. Add the domain in the
dashboard only — do **not** put `routes` into `wrangler.jsonc`; the deploy token has no zone
permissions, so the next deployment would fail.

Reader-key cookies and offline caches are bound to the origin. After a domain change, re-mint keys
with the original reader ids (`-d '{"user":"<id>"}'`) and open the new links on each device; server-side
positions follow the id and survive.

### New-book Push notifications

Web Push is optional and needs a local clone with pnpm (see path B above):

```sh
pnpm exec node scripts/gen-vapid.mjs
gh secret set VAPID_PRIVATE_JWK --repo "$FORK"    # paste the printed private JWK
printf '%s' "mailto:you@example.com" | gh secret set VAPID_SUBJECT --repo "$FORK"
gh workflow run deploy --repo "$FORK"
```

Readers can then subscribe in the shelf footer; the adjacent **test** button checks the whole
device/browser/push-service path. For a full end-to-end rehearsal, the `push test` workflow publishes
a throwaway book to production (a real notification) and deletes it again:

```sh
gh workflow enable push-test.yml --repo "$FORK"
gh workflow run "push test" --repo "$FORK"
```

On iPhone, only an installed Home-Screen PWA gets `PushManager`; an ordinary Safari tab shows no
subscribe option. Rotating the VAPID key invalidates existing subscriptions. The red dot on the app
icon is the service worker calling `setAppBadge()` when a push lands, cleared on the next open;
whether it worked lands in the push log —
`curl -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/testlog?page=push&limit=5"` reads it back
(writing the log needs no credential; reading it does).

### Narration

Narration is on by default and needs no API key. The Worker speaks Microsoft's undocumented Edge TTS
protocol with `zh-TW-HsiaoChenNeural`; generated MP3 chunks are cached under `_tts/` in R2. The
endpoint carries no stability promise — if narration suddenly stops, check for protocol changes first;
the audio cache never expires on its own, so inspect `_tts/` if R2 use grows unexpectedly.

## Routine maintenance

### Update Bookworm

```sh
gh repo sync "$FORK" --source enstw/bookworm
```

Once the sync reaches `main`, the deploy workflow runs by itself; books and reading positions survive
deployments.

### Force-refresh a stale phone UI

The shelf footer has a **refresh** control beside the build ID: it discards the app-shell cache and
service worker and reloads, keeping downloaded offline chapters.

### Retitle, re-slug, or delete a book

Open `$URL/admin` (the shelf footer's **manage** link points at it). The top of the page lists every
book on the shelf: a retitle rewrites metadata only; a re-slug only changes the URL — every book lives
under a permanent book id (its R2 key prefix) and the slug is just a name pointing at it, so nothing
moves, the audio cache survives, positions stay put, and the old slug keeps resolving; a delete takes
chapters, cached audio and every reader's position with it, asks you to type the slug to confirm, and
has no undo.

### Health check and repair

Halfway down `/admin` are two buttons. **Health check** only reads, is safe to press at any time, and
when it says nothing is wrong, nothing is — the files in R2 are the truth, and the shelf index is just
one of the things being checked. **Repair** is the only button on the page that writes, and it only
acts on what the check just found: it first rebuilds the shelf index (the one step that puts something
back; index/file disagreements and slug collisions are resolved or surfaced here), then deletes what
nothing can reach, then runs the same check again as proof. The rule is one sentence: **if the shelf
does not know about it, nothing can read it** — no rescuing, delete and upload again.

Every deleting request carries its own premise, re-verified server-side against R2, answering 409 on a
mismatch — a book published between check and repair cannot be swept on the strength of a stale scan.
The two findings that delete a whole book (**incomplete book**, **manifest will not parse**) list the
books first and wait for one confirming press — a whole-book sweep takes every reader's position with
it, and a fresh upload gets a new book id.

| Finding | What it means |
|---|---|
| Files with no manifest | Chapter files under a book id with no `manifest.json` — an interrupted upload or move |
| Audio cache for a gone book | `_tts/<book-id>/` outliving its book — usually the biggest one |
| Slug pointing at a missing book | A URL that resolves to nothing |
| Positions for a missing book | Reading positions nobody can open |
| Loose object at the bucket root | Something that belongs to no book |
| Files the manifest does not name | Leftovers from an earlier split |
| Incomplete book | The manifest names chapters R2 lacks or has at the wrong size — the whole book goes; upload again |
| Manifest will not parse | `manifest.json` is not valid JSON — as unreadable as having none |

Not a routine job: worth a check after an interrupted upload or delete, or a migration. If the
post-repair re-check still reports something, that is a bug — report it as one.

## Access model and security

Book content, positions and narration sit behind the reader key: without a live key, 401. The key is a
server-set cookie on the device (one year, self-repairing) and dies with revocation; chapters already
cached on the device survive it — revocation fences the server, not the phone. Open by design: the app
shell (the code is public anyway), `/api/feedback` and writes to `/api/testlog` — the log is written by
a service worker that can hold no credential, but reading it back needs one, since its rows quote the
book. Administration and publishing
stay behind `ADMIN_TOKEN`, independent of reader keys. Reader ids are not strong authentication and
suit only a small trusted group.

## Local development

Use pnpm 11 with its managed Node.js 22-or-newer environment; the local workflow is pnpm-only — no
npm, npx, yarn, or corepack.

```sh
gh repo clone "$FORK" bookworm && cd bookworm && pnpm install
cp .dev.vars.example .dev.vars
pnpm run db:init:local
pnpm run dev            # http://localhost:8787
```

Tests (end-to-end needs a Chromium; TTS streaming also needs `ffmpeg`):

```sh
pnpm test               # or test:push, test:tts, test:vertical, test:bg,
                        #    test:admin, test:shelf, test:offline individually
```

To skip GitHub Actions entirely, `deploy.sh` performs the identical deployment locally:

```sh
cp .deploy.env.example .deploy.env
# fill CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ADMIN_TOKEN
./scripts/deploy.sh
```

`.deploy.env` is gitignored; never commit it. `deploy.sh` writes your account's D1 `database_id` into
`wrangler.jsonc` — commit that change to your fork.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gh workflow run` answers 404 or "workflow disabled" | The fork's Actions are still off: `gh api -X PUT "repos/$FORK/actions/permissions" -F enabled=true`, then `gh workflow enable deploy.yml --repo "$FORK"` |
| Deploy fails at `d1 create`, or says R2 is not enabled | 🧑 open the R2 page in the Cloudflare dashboard once to activate it (may ask for billing details; the free allowance is unchanged), rerun the workflow |
| First deployment asks for a `workers.dev` subdomain | 🧑 a new account must choose one: **Workers & Pages → Add**, then rerun |
| Token verification fails immediately | The token needs both `Account Settings · Read` and `User Details · Read`, with the right account under Account Resources. Successful runs intentionally suppress `wrangler whoami` — a public log would leak the Cloudflare email |
| Deploy succeeded but the probe answers 404 | The Worker is still propagating; wait a few seconds and retry |
| CI fails at `pnpm install --frozen-lockfile` | With `minimumReleaseAge` in your pnpm config, a freshly released dependency is temporarily uninstallable; rebuild and commit the lockfile later, or wait out the window |
| Splitting produces one enormous chapter | Pass a heading-matching regex with `--pattern`, or pre-split into `NN_title.txt` files and feed the directory to the splitter |
| A device jumps to a wrong position | Last-read-wins; when the synced position is ≥ 2 chapters from the local one, the reader shows **return to previous position** for a one-tap restore |

## Known limitations

- Only plain text is accepted directly. EPUB, PDF and comics need a converter that emits Bookworm
  chapters and a manifest.
- Each `(book, reader)` stores one position; no furthest-read marker, annotation, highlight, or search.
- The interface is bilingual, but narration, typography, splitting and line-breaking remain
  Chinese-first.
- Edge TTS uses an undocumented protocol and cannot be guaranteed forever.
- Reader ids are not strong authentication and suit only a small trusted group.

For the lower-level data contracts see [REQUIREMENTS.md](REQUIREMENTS.md); the standing design
decisions, including the on-device investigations, are in [DESIGN.md](DESIGN.md).
