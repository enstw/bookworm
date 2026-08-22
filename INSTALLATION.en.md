# Bookworm install & operations manual

This manual is written for **the AI agent installing Bookworm for you**. Hand the whole file to the
agent in your terminal (Claude Code, Codex, …) and say "follow `INSTALLATION.en.md` and install
Bookworm into my account"; only the steps marked 🧑 need a human's hands, and every other step is a
command the agent can run and verify by itself. No agent? The same commands run fine by hand, in
order, with the same result.

Installing needs **no fork, no clone of this repo, no GitHub Actions, and no wrangler**. One
`bootstrap.mjs`, downloaded from the release page, stands the whole machine up: it fetches the latest
reader release from upstream, creates D1 and R2, deploys both Workers, sets the secrets, and mints the
first key. Once installed, the machine follows upstream **on its own** (see *Turning on automatic
updates*) — you never come back to run anything.

For the product story and feature overview, return to the [README](README.en.md). Read
[DESIGN.md](DESIGN.md) before changing code; installing does not need it.

## Who does what

🧑 **The human does exactly three things**, the first two in a browser:

1. Have a free [Cloudflare account](https://dash.cloudflare.com/) and open the R2 page once to activate
   it (first activation may ask for billing details; usage within the free allowance stays `$0`).
2. Create a Cloudflare API token (permission table in step 1), copy the Account ID, and hand both to
   the agent — or paste the token yourself into the line that runs `bootstrap.mjs`.
3. After install, open the **reader-key link** the agent prints on the phone and add it to the Home
   Screen.

Everything else — download `bootstrap.mjs`, create resources, deploy, verify, mint keys, publish — the
agent does with `node` and `curl`. Also have ready: a `.txt` book you have the right to store and use
(Bookworm ships no content), and a password manager for the `ADMIN_TOKEN`.

## Rules for the agent

- **Secrets travel by environment variable.** `bootstrap.mjs` reads its values from `CF_API_TOKEN`,
  `CF_ACCOUNT_ID` and friends; never write a secret into a file, a command-line argument, or any public
  log. The Cloudflare token is best pasted by the human onto the command's line (Install, step 2).
- **Verify every step.** Each step states its expected result; on a mismatch, stop there and consult
  Troubleshooting instead of retrying until it passes.
- **No fork, no clone, no Actions.** Installing needs only one downloaded file. Cloning is for changing
  code or running tests — see Local development.

## Preflight

```sh
node --version        # Node 20+ (bootstrap uses the built-in fetch/crypto; nothing to install)
curl --version && openssl version
```

## Install

### 1. 🧑 Create a Cloudflare API token and Account ID

Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**. The built-in "Edit
Cloudflare Workers" template omits R2 and D1, so add these permissions:

| Scope | Permission | Level |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

Set **Account Resources** to your account. This is a **one-time**, broad token: delete it once the
install finishes. It is a different token from the narrow one the updater gets later (see *Turning on
automatic updates*). Also copy the **Account ID** — it is in the right-hand column of **Workers &
Pages**.

### 2. Download and run the bootstrap

```sh
curl -fsSL https://github.com/enstw/bookworm/releases/latest/download/bootstrap.mjs -o bootstrap.mjs

CF_API_TOKEN='paste the token from step 1' \
CF_ACCOUNT_ID='paste the Account ID from step 1' \
UPSTREAM_URL='https://github.com/enstw/bookworm/releases/latest/download/' \
VAPID_SUBJECT='mailto:you@example.com' \
node bootstrap.mjs
```

`bootstrap.mjs` is a self-contained file (the schema and the updater are baked in at release time; only
the 12 MB reader release is fetched from `UPSTREAM_URL` at run time). It creates the D1 database
`bookworm` and R2 bucket `bookworm-books`, applies `schema.sql`, deploys the reader Worker `bookworm`
with all of `public/`, enables the workers.dev subdomain, deploys the cron-only updater
`bookworm-updater` (**deliberately with no `CF_API_TOKEN`, so it will not auto-update yet** — see
*Turning on automatic updates*), sets `ADMIN_TOKEN` and the VAPID keys, and mints the first
owner reader key. From a laptop the whole thing takes about 30 seconds.

On success, stdout prints the three things to keep:

```
instance is up.
  reader:       https://bookworm.<your-subdomain>.workers.dev
  admin:        https://bookworm.<your-subdomain>.workers.dev/admin
  owner key:    https://bookworm.<your-subdomain>.workers.dev/?key=<32 hex>   (open on your phone, add to home screen)
  ADMIN_TOKEN:  <48 hex>   (save to a password manager now — it is not shown again)
```

🧑 Save `ADMIN_TOKEN` to a password manager immediately — it is printed exactly once. Keep the URL for
the steps below:

```sh
URL='https://bookworm.<your-subdomain>.workers.dev'   # use the URL actually printed
```

> **VAPID_SUBJECT** is optional: omit it and a default is used, new-book push still works (it is the
> contact email the push service sees, not something readers see). To supply your own `ADMIN_TOKEN` or
> VAPID keys, put `ADMIN_TOKEN=…` / `VAPID_PRIVATE_JWK=…` in the environment before running; otherwise
> they are generated.

### 3. Verify

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/books"          # expect 401
curl -s -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/books"   # expect {"books":[]}
```

The keyless 401 is correct: content lives behind a reader key. Opening `$URL` in a browser shows the
"needs a key" door — the same thing.

### 4. The first reader key

`bootstrap` already minted a key marked **owner** — the `owner key` link printed above. 🧑 AirDrop or
message it to the reading device and open it: the device is now logged in and lands on the shelf, no
retyping later; the app also offers "Add to Home Screen" once, installing as a full-screen PWA.

To mint a second key (another device, or another reader):

```sh
curl -s -X POST "$URL/api/admin/readers" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"label":"my iPad"}'
# expect {"ok":true,"key":"<32 hex>","user":"<auto-generated reader id>","label":"my iPad"}
```

- One reader (same `user` id) can hold several keys; progress and settings sync across devices by id.
  Mint the second device's key with the same id: `-d '{"user":"<id>","label":"iPad"}'`.
- The owner key (`is_owner`) has one extra role: only it receives the **owner-only** pushes — "an
  update is waiting for you", "an install failed and was rolled back", "the updater has gone silent"
  (ordinary new-book notifications go to every subscriber). Under `/admin` → Reader keys you can mark
  other keys as owner too.
- Lose a device, revoke that key; the others are unaffected: revoke in `/admin`, or
  `curl -X DELETE "$URL/api/admin/readers/<key>" -H "authorization: Bearer $ADMIN_TOKEN"`.
- Offline reading is on by default: open a book and nearby chapters plus the app shell stay on the
  device; tap a book's ⇣ on the shelf to store it whole, tap again to drop that book's offline copy.

### 5. The first book

Publishing needs no redeploy; pick one of two routes:

**A. Browser upload (🧑, most private, no tools)** — open `$URL/admin`, paste `ADMIN_TOKEN`, choose a
`.txt` or `.zip`, confirm the detected title, slug and chapters, and upload. Unzipping, charset
conversion (UTF-8 / GBK / Big5 / Shift_JIS), OpenCC `cn→tw`, and chapter splitting all happen in the
browser; if chapter detection fails you can supply a regex (e.g. `^第.+章`). Re-uploading the same slug
overwrites in place and keeps reading progress.

**B. Local CLI (agent; needs a clone plus [pnpm](https://pnpm.io/installation) 11 and Node 22)** — for
bulk uploads or a reusable script:

```sh
gh repo clone enstw/bookworm bookworm && cd bookworm && pnpm install
pnpm run split -- ~/books/mybook.txt --title "Title" --slug mybook
pnpm run publish-book -- out/mybook --url "$URL" --token "$ADMIN_TOKEN"
```

Common split flags: `--charset gbk|big5|shift_jis` (output is always UTF-8), `--s2t` (OpenCC `cn→tw`
across body, titles and filenames), `--pattern '^第.+章'`. With fewer than three title matches it
splits by size; oversized single chapters continue at line boundaries; a folder already split into
`NN_title.txt` can be the input as-is.

Install is complete: the shelf is at `$URL`, admin at `$URL/admin`. This machine is now independent of
this repo — updates included, see the next section.

## Turning on automatic updates

The installed updater `bookworm-updater` is cron-only and **not yet armed**: every 15 minutes it checks
upstream for a new release and writes what it finds to the **Updates** panel in `/admin`, but with no
token that can rewrite the reader Worker it does not actually install anything. To turn on automatic
updates, 🧑 give it a **narrow** token:

1. Create another Cloudflare API token, this time with a single permission:

   | Scope | Permission | Level |
   | --- | --- | --- |
   | Account | Workers Scripts | Edit |

   This token can only rewrite this account's Workers — not R2, D1 or account settings — far narrower
   than the install token. It is the updater's **only** secret (it is not even given `ADMIN_TOKEN`; see
   R4 in [DESIGN.md](DESIGN.md)).

2. Set it and the Account ID as two secrets on the updater, over the Cloudflare API (no clone needed;
   `$ARM` is that narrow token — the broad install token also works):

   ```sh
   ACCT='paste the Account ID'
   ARM='paste the narrow token'
   for pair in "CF_API_TOKEN:$ARM" "CF_ACCOUNT_ID:$ACCT"; do
     curl -s -X PUT \
       "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/bookworm-updater/secrets" \
       -H "authorization: Bearer $ARM" -H "content-type: application/json" \
       -d "{\"name\":\"${pair%%:*}\",\"text\":\"${pair#*:}\",\"type\":\"secret_text\"}" >/dev/null
   done
   ```

   Or in the dashboard: **Workers & Pages → bookworm-updater → Settings → Variables and Secrets →** add
   `CF_API_TOKEN` (Secret, the narrow token) and `CF_ACCOUNT_ID` (Secret, the Account ID). Then **check
   the Deployments tab: the active version must be the newest one.** Every secret you add creates a new
   version, and it does not always become active — it has happened that the active version was the one
   holding only `CF_API_TOKEN`, so the updater was never armed and the panel just said "last install:
   never". If so, promote the newest version to 100%.

3. In the **Updates** panel at `$URL/admin`, pick a policy: **Automatic (after N days)**, **Notify me
   only**, or **Pinned (stay put)**. The default is automatic with a 2-day soak — upstream runs a day
   ahead as the canary, and your machine waits for a release to prove out before taking it. The panel
   also shows the running version, upstream latest, and the last check and install.

From then on the machine follows upstream on its own: check → decide by policy → download and verify →
install → health-check, rolling back to the previous version automatically if the new one fails. This
is the **only** path that can rewrite the reader, with no human in the middle. To turn automatic
updates off, set the panel to "Pinned", or delete `CF_API_TOKEN` in the dashboard.

### Updating the updater itself (rare)

Occasionally a release requires a newer updater than the one you run (the panel names the version it
needs). Re-download the latest `bootstrap.mjs` and run it with `BW_MODE=updater` to replace **only** the
updater, leaving everything else alone (the reader, D1, R2, every secret, and the armed state are all
kept):

```sh
curl -fsSL https://github.com/enstw/bookworm/releases/latest/download/bootstrap.mjs -o bootstrap.mjs
CF_API_TOKEN='broad token' CF_ACCOUNT_ID='Account ID' \
UPSTREAM_URL='https://github.com/enstw/bookworm/releases/latest/download/' \
BW_MODE=updater node bootstrap.mjs
```

On its next check the updated updater installs the release it had refused.

## Optional setup

### Custom domain

🧑 In Cloudflare, go to **Workers → bookworm → Settings → Domains & Routes → Add** — just add the domain
in the dashboard. Reader-key cookies and offline caches are bound to the origin; after a domain change,
re-mint keys for the same reader ids (`-d '{"user":"<id>"}'`) and open the new links on each device;
server-side progress follows the id and is not lost.

### New-book push

Web Push is already configured at install (`bootstrap` generated the VAPID keys). Readers subscribe from
the shelf footer; the **Test** button beside it exercises the whole path through device, browser and
push service. Under `/admin` → Reader keys, **Owner notification test** verifies the owner-only channel
on its own. iPhone exposes `PushManager` only to a Home-Screen PWA, not an ordinary Safari tab. To
rotate the VAPID key (which invalidates existing subscriptions — devices re-subscribe), replace the
`VAPID_PRIVATE_JWK` secret on `bookworm` in the dashboard. Push send/receive outcomes are logged:
`curl -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/testlog?page=push&limit=5"` reads them back
(writing needs no credential; reading does).

### Text-to-speech

Read-aloud is on by default and needs no API key. The Worker uses Microsoft Edge's undocumented TTS
protocol, voice fixed to `zh-TW-HsiaoChenNeural`; played MP3 segments cache in R2 under `_tts/`. That
endpoint carries no stability promise — if TTS suddenly fails, first check whether the protocol changed;
the voice cache does not evict itself, so check `_tts/` if R2 usage climbs oddly.

## Day-to-day operations

### Updating Bookworm

Nothing to do: an armed updater (see *Turning on automatic updates*) follows upstream on its own and
installs by the `/admin` policy. Books and reading positions survive updates. To install a version you
can already see right now, use **Install now** on the panel. A machine whose updater is not armed stays
on its current version until you arm it.

### Forcing a stale UI to update on a phone

Beside the build number in the shelf footer is **Refresh**: it clears the app-shell cache and service
worker and reloads; already-downloaded offline chapters are kept.

### Rename a book, change a slug, delete a book

Open `$URL/admin` (the **Admin** link in the shelf footer points there). The top half lists every book:
renaming touches only the catalogue; changing a slug only swaps the URL — each book lives under a
permanent book id (its R2 key prefix) and the slug is just a name pointing at it, so files do not move,
the voice cache is not dropped, progress does not move, and the old slug still resolves; deleting clears
chapters, voice cache and every reader's progress together, needs the slug typed to confirm, and cannot
be undone.

### Health check and repair

The middle of `/admin` is two buttons: **Health check** reads without writing, is safe any time, and
when it says fine it is fine — the R2 files are the truth, the shelf index just one of the things being
checked. **Repair** is the only writing button on the page and touches only what the check just found:
it first rebuilds the shelf index (the one step that puts things back; index/file mismatches or slug
collisions are resolved or surfaced here), then deletes what nobody can reach, then reruns the same
check as proof. The rule in one line: **if it is not on the shelf, nobody can reach it** — do not
rescue it, delete and re-upload. Every deleting request carries its own premise, re-verified against R2,
answering 409 on a mismatch — so a new upload between check and repair is not deleted by a stale scan.
The two whole-book findings (**incomplete book**, **broken catalogue file**) are listed and wait for one
confirmation before acting — deleting a whole book clears everyone's progress in it, and re-uploading
gets a new book id.

| Finding | Meaning |
|---|---|
| Files without a catalogue | Chapter files under a book id but no `manifest.json` — an interrupted upload or move |
| Voice cache for a gone book | `_tts/<id>/` for a book long deleted — usually the biggest consumer |
| Slug points at a missing book | The URL resolves but the book is gone |
| Progress for a missing book | Reading progress for a book nobody can open |
| Junk at the bucket root | Objects belonging to no book |
| Extra files not in the catalogue | Old files left after a re-split |
| Incomplete book | A catalogued chapter file is missing or the wrong size in R2 — delete and re-upload |
| Broken catalogue file | `manifest.json` is not valid JSON — as unreadable as absent |

Not for routine use; worth a check after an interrupted upload, a half-finished delete, or a move. If
the post-repair recheck still finds things, that is a bug — report it as one.

## Access model and security

Book content, reading progress and TTS all live behind a reader key: no valid key, 401 everywhere. The
server records the key as a cookie on the device (one year, self-healing); revoking it takes effect at
once, but offline chapters already on the device are unaffected — revocation blocks the server, not what
is already on the phone. The only things left open are the app shell (its code is public anyway) and
`/api/feedback`. `/api/testlog` needs a credential both ways: reading needs a reader key (those rows
quote book content), writing needs the `bw_tlog` cookie `/admin` issues. Admin and upload endpoints are
guarded by `ADMIN_TOKEN`, independent of reader keys.

The update path is the updater's alone: the reader Worker holds no Cloudflare token, and the `/admin`
Updates panel reads only from the local database and never contacts upstream. The token that arms the
updater can rewrite the reader, making it this machine's most sensitive secret — it should carry only
Workers Scripts · Edit and live only on the updater. Reader ids are not strong authentication; they suit
a small, trusted group.

## Local development

Installing does not need this section; changing code or running tests does. It needs pnpm 11 and the
Node.js 22+ it manages; the local flow is pnpm throughout — no npm, npx, yarn or corepack.

```sh
gh repo clone enstw/bookworm bookworm && cd bookworm && pnpm install
cp .dev.vars.example .dev.vars
pnpm run db:init:local
pnpm run dev            # http://localhost:8787
```

Tests (end-to-end needs Chromium; TTS streaming also needs `ffmpeg`):

```sh
pnpm test               # or test:push, test:tts, test:vertical, test:bg,
                        #    test:admin, test:shelf, test:offline individually
```

A clone can also run the install (equivalent to the downloaded `bootstrap.mjs`, only the payload is
rebuilt from the current tree):

```sh
CF_API_TOKEN=… CF_ACCOUNT_ID=… UPSTREAM_URL=…/releases/latest/download/ \
  node scripts/bootstrap-cli.mjs
```

Upstream's own instance (the release build, running as the canary) uses `scripts/deploy.sh`, the
repo-backed deploy path — different from an ordinary instance's bootstrap. An ordinary instance never
uses `deploy.sh` and never needs a clone.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `bootstrap.mjs` says R2 is not enabled (an R2 error other than 10004) | 🧑 Activate R2 once in the dashboard (may ask for billing; the free tier still costs $0), then re-run |
| `bootstrap.mjs` cannot read the manifest | `UPSTREAM_URL` must be a `…/releases/latest/download/` URL (trailing slash), and that repo must have a release |
| Token rejected immediately (403 / 10000) | The token needs the five permissions above, with Account Resources set to the right account |
| Deploy finished but `$URL` will not open | The workers.dev subdomain is still propagating — wait 10–60 s and retry; a brand-new account may first need a workers.dev subdomain chosen under **Workers & Pages → Add**, then re-run |
| A reader device jumps to the wrong position | Last reader wins; when the synced position is 2+ chapters from local, the screen offers **Back to last position**, one tap to restore |
| The `/admin` panel says the updater has not reported in a long time | The updater's cron stopped or its token expired; check the cron and secrets under **Workers & Pages → bookworm-updater** |
| Splitting yields one giant chapter | Pass a `--pattern` regex that matches the title lines, or pre-split into `NN_title.txt` and feed the folder to the splitter |

## Known limits

- Plain text only. EPUB, PDF and comics must first be converted to Bookworm's chapter + manifest format.
- One position per `(book, reader)`; no furthest-read mark, annotations, highlights or full-text search.
- The UI is bilingual, but the voice, fonts, chapter splitting and typography stay Chinese-first.
- Edge TTS uses an undocumented protocol and cannot be guaranteed to keep working.
- Reader ids are not strong authentication; they suit a small, trusted group.
- The first install needs one machine with Node to run one command; after that, updates are automatic
  and it is never needed again.

For the lower-level data contract see [REQUIREMENTS.md](REQUIREMENTS.md); for current design decisions
(including the conclusions of on-device investigation), see [DESIGN.md](DESIGN.md).
