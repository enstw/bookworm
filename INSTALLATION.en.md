# Bookworm installation & operations

This guide covers deployment, book publishing, routine maintenance, local development, and troubleshooting.
For the product story and feature overview, return to the [README](README.en.md).

The easiest route is to **fork this repository and let GitHub Actions deploy it into your own Cloudflare
account**. It takes about fifteen minutes, requires no local development tools, and works the same from
Windows, macOS, or Linux.

## Before you begin

- A free [Cloudflare account](https://dash.cloudflare.com/). If you have never used R2, open its dashboard
  once to activate it. Cloudflare may request billing details; usage within the free allowance remains `$0`.
- A GitHub account.
- A `.txt` book that you have the right to store and use. Bookworm ships no content.
- A password manager for the `ADMIN_TOKEN` you will create below.

## Deploy with GitHub Actions

### 1. Fork the project and enable Actions

Click **Fork** in the top-right corner of the GitHub page. In your fork, open **Actions** and click
“I understand my workflows, go ahead and enable them.” GitHub disables workflows inherited by a fork until
you explicitly enable them.

### 2. Create a Cloudflare API token

Open **My Profile → API Tokens → Create Token → Create Custom Token** in Cloudflare. The built-in “Edit
Cloudflare Workers” template does not include R2 and D1, so grant these exact permissions:

| Scope | Permission | Level |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

Under **Account Resources**, include your Cloudflare account. The two Read permissions are used only by
the pre-deployment `wrangler whoami` check.

Also copy your **Account ID** from the sidebar under **Workers & Pages**.

### 3. Add three GitHub secrets

In your fork, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The Cloudflare token from the previous step |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `ADMIN_TOKEN` | A random admin key of at least 32 characters |

If a terminal is available, `openssl rand -hex 24` makes a suitable `ADMIN_TOKEN`. Save it in your password
manager before pasting it into GitHub: repository secrets are write-only and cannot be displayed again.

### 4. Run the first deployment

Open **Actions → deploy → Run workflow**. The workflow will:

1. Verify the Cloudflare token.
1. Create the `bookworm` D1 database and write its ID to `wrangler.jsonc`.
1. Create the `bookworm-books` R2 bucket.
1. Apply `schema.sql`.
1. Prepare browser dependencies and stamp the build number.
1. Deploy the Worker.
1. install `ADMIN_TOKEN` as a Worker secret.
1. Probe the live `/api/books` endpoint.

The run summary will show your URL, similar to:

```text
https://bookworm.<your-subdomain>.workers.dev
```

Opening it shows a locked door asking for a key — that is expected: mint your first reader key on `/admin`
first (see “Reader keys” below). Future pushes to `main` deploy automatically;
Markdown-only changes are skipped. Use **Sync fork** on GitHub to pull upstream updates.

## Publish the first book

### Upload in the browser

Visit:

```text
https://<your-server>/admin
```

Paste `ADMIN_TOKEN`, choose a `.txt` or `.zip`, inspect the detected title, slug, and chapters, then upload.
The key is kept in that browser's `localStorage`, so it only needs to be entered once.

Decompression, charset conversion, Simplified-to-Traditional conversion, and chapter splitting all run
inside the browser:

- Input encodings include UTF-8, GBK, Big5, and Shift_JIS.
- S→T uses OpenCC `cn→tw`, converting Taiwan vocabulary as well as glyphs.
- If headings are missed, provide a regex such as `^第.+章`.
- Uploading the same slug again replaces the book in place and keeps existing reading positions.

Browser upload is the best default and avoids placing book and chapter titles in a public Actions log.

### Publish with GitHub Actions

For a large source or a remote download URL, use **Actions → publish book → Run workflow**. It accepts:

- a `.txt`, or a `.zip` containing one or more `.txt` files;
- optional title, slug, charset, S→T conversion, and chapter-heading regex; and
- a `dry_run` option that only splits and reports the result.

First add these under **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `BOOKWORM_URL` | Your Bookworm base URL |
| Optional secret | `BOOK_SOURCE_URL` | Default source-book URL |
| Optional secret | `BOOK_SOURCE_HEADER` | Authentication header required by the source |

> Inputs and logs in a public repository are visible to everyone, including book and chapter names. Use a
> private fork or browser upload for copyrighted or sensitive material.

### Publish from the local CLI

After setting up the [development environment](#local-development), split and upload a book with:

```sh
pnpm run split -- ~/books/mybook.txt --title "Book title" --slug mybook
pnpm run publish-book -- out/mybook \
  --url https://<your-server> --token "$ADMIN_TOKEN"
```

Generated chapters land under `out/<slug>/`, which is gitignored. Useful splitter options:

- `--charset gbk`, `big5`, or `shift_jis`: select the source encoding; output is always UTF-8.
- `--pattern '^第.+章'`: override the chapter-heading expression.
- `--s2t`: run OpenCC `cn→tw` over body text, titles, and filenames.
- A directory of existing `NN_chapter-title.txt` files can be used directly as input.

If fewer than three headings match, the splitter falls back to size-based parts. Oversized chapters are
split again at line boundaries.

## Reader keys: before the first book opens

Reading requires a **reader key**. After deploying, open `/admin` and mint the first one under
“Reader keys”:

1. Leave the reader id empty (one is minted) or type a short id of your own.
2. Put the device's name in the note (“my iPhone”) so it can be revoked by name later.
3. Press **Mint a key** — the sign-in link is copied automatically, shaped `https://<your-server>/?key=…`.

AirDrop or message that link to the reading device and open it there; the device is signed in for good.
One key per device; one reader id can hold several keys, and positions and settings sync through the id.
Lose a device — revoke its key on `/admin`; every other device is untouched.

A book URL has the form `https://<your-server>/<book-slug>` (legacy `/<book-slug>/<reader-code>` links
still open; the trailing code is ignored now).

Choose “Add to Home Screen” on the phone to install the full-screen PWA. Whichever page you install from,
the app opens at the shelf (the manifest's `start_url`) — the shelf remembers every book's progress, and one
tap resumes where you left off. The app also offers the install steps once, right after a device enrolls.
Offline reading is on by default: opening a book keeps its nearby chapters and the app shell on the device.
Tap ⇣ on a book's card on the shelf to stock it in advance, and tap it again to drop it.

## Access model and security

Book content, positions, settings and narration all sit behind the reader key: a request without a live key
answers 401. The key is kept on the device as a server-set cookie (one year, self-repairing) and dies with
revocation; chapters already cached on a device survive it — revocation fences the server, not the phone.

Still open by design: the app shell (the code is public anyway), `/api/feedback` (the improvement-notes
queue, keyless by design) and `/api/testlog` (device diagnostics). Publishing and administration remain
protected by `ADMIN_TOKEN`, independent of reader keys.

## Optional configuration

### Custom domain

In Cloudflare, open **Workers → bookworm → Settings → Domains & Routes → Add**.

If the deployment token has no zone permissions, add the domain only in the dashboard. Do not add `routes`
to `wrangler.jsonc`, or the next deployment will fail.

Reader codes and offline caches are origin-bound. After changing domains, use **change** on every device to
re-enter the previous reader code; the server-side positions remain attached to that code.

### New-book Push notifications

Web Push is optional. Generate a VAPID key locally:

```sh
pnpm exec node scripts/gen-vapid.mjs
```

Add the output as GitHub repository secrets:

| Secret | Value |
| --- | --- |
| `VAPID_PRIVATE_JWK` | The private JWK printed by the command |
| `VAPID_SUBJECT` | Your contact, such as `mailto:you@example.com` |

Run the deploy workflow again. Readers can then subscribe in the library footer and use the adjacent test
button to check the complete device/browser/push-service path.

On iPhone, `PushManager` is available only to an installed home-screen PWA, not an ordinary Safari tab.
Rotating the VAPID key invalidates existing subscriptions, so readers must subscribe again.

The red dot on the app icon is not a side effect of showing a notification — the app has to ask, through
the Badging API. The service worker calls `setAppBadge()` when a push lands, counting whatever the system
still has in the tray, and opening the app (or tapping the notification) clears it. Same requirements:
installed to the Home Screen, notifications allowed. Whether it worked goes into the push log, readable
with `/api/testlog?page=push`.

### Narration

Narration is enabled by default and requires no API key. The Worker speaks Microsoft's undocumented Edge
TTS protocol with `zh-TW-HsiaoChenNeural`; generated MP3 chunks are cached under `_tts/` in R2.

The endpoint has no stability guarantee. If narration stops working in the future, check for protocol changes
first. Audio cache entries do not currently expire, so inspect `_tts/` if R2 use grows unexpectedly.

## Routine maintenance

### Update Bookworm

Click **Sync fork** on GitHub. Once the changes reach `main`, deployment runs automatically. Books and reading
positions survive application deployments.

### Force-refresh stale phone UI

The library footer has a **refresh** control beside the build ID. It discards the app-shell cache and service
worker, then reloads while keeping downloaded offline chapters.

### Retitle, change a slug, or delete a book

Open `/admin` (the library footer's **manage** link points at it) and enter `ADMIN_TOKEN`. Once the key
checks out, the top of the page lists every book on the shelf, each with:

- **edit:** the title and the slug in one form. A title change rewrites metadata only, leaving chapters and
  the audio cache alone. A slug change only changes the URL: every book actually lives under a permanent
  book id (its R2 key prefix) and the slug is just a name pointing at it, so re-slugging is one request —
  no files move, the audio cache survives, reading positions are untouched, and the old slug keeps
  resolving, so existing bookmarks still work.
- **delete:** chapters, cached audio, and every reader's position, after you type the slug to confirm. There
  is no undo.

### Check and repair

Halfway down `/admin` are two buttons and two phases: **Health check** looks, **Repair** acts — think
`brew doctor` and `brew doctor --fix` kept apart. The rule is one sentence: **if the shelf does not know
about it, nothing can read it** — no point rescuing it, delete and upload again.

**Health check** only reads, all the way down. It is safe to press at any time, and it assumes no repair
has run: the files in R2 are the truth, and the index is one of the things being checked against them,
never a premise. So when it says nothing is wrong, nothing is — a silence you can trust is the whole
reason it exists. (It used to run only after an index rebuild, which meant a finding could mean "the
index is behind" rather than "this is broken" — so it could not be run on its own, and its silence was
worth nothing.)

**Repair** is the only button on this page that writes, and it only ever acts on what the check just
found. It rebuilds the index, then deletes what nothing can reach, then runs the same check again as
proof. That order has a reason: the rebuild is the one step that puts something back rather than taking
it away, and it is the complete fix for two of the findings.

**Rebuilding the index** has no button of its own, because it writes: it is step one of a repair and
nothing else needs it. The shelf is an index built from each book's `manifest.json`, so if the index and
the bucket ever disagree (or once, when upgrading to book ids), Repair is what handles it. The one thing
it reports is a **slug collision** — that only shows itself when the row is written, and it is the only
problem the health check cannot see. It reports under the book list at the top of the page, because what
it has to say is about the shelf.

There is a window between checking and repairing — somebody may publish a book in it. So every request
that deletes something re-checks what it is acting on: the premise it was sent with ("this book's files
are gone", "this book is missing chapters", "this book's manifest will not parse") is verified against R2
server-side, and a mismatch gets a 409 instead of a sweep on the strength of a stale scan.

What gets deleted:

| Finding | What it means |
|---|---|
| Files with no manifest | Chapter files under a book id with no `manifest.json` — an upload or move that stopped early |
| Audio cache for a book that is gone | `_tts/<book-id>/` outliving its book — usually the biggest one |
| Slug pointing at a missing book | A URL that resolves to nothing |
| Bookmarks for a missing book | Reading positions nobody can open |
| Loose object at the bucket root | Something that belongs to no book |
| Files the manifest does not name | Objects under a book id its manifest never mentions — leftovers from an earlier split |
| Incomplete book | The manifest names chapter files R2 does not have, or has at the wrong size — the whole book goes; upload it again |
| The manifest will not parse | `manifest.json` is there and is not valid JSON — as unreadable as having none |

The incomplete-book check is the only chapter-level one. A shelf entry's chapter count and character
total come from that book's `manifest.json` — the uploader's claim, not a measurement — so this compares
the claim against what the bucket actually holds (and, for books whose manifest records byte sizes,
against the sizes too). A book missing chapters is deleted whole: a reader hitting a wall halfway is
worse than the book not being there, and there is nothing to salvage — upload it again. (Note that
deleting takes that book's reading positions with it, and a fresh upload gets a new book id.) It is also
the only check that counts chapters for books the shelf has never heard of — which are exactly the books
nobody has ever counted.

A manifest that will not parse is as unreachable as having none: every route into a book goes through the
index, the index is built from that file, and if it cannot be read there is no route at all. It can only
be found by the pass that actually reads the manifest — the book sweep only HEADs it, and a HEAD cannot
tell a book from a broken one.

The two that delete a whole book (**incomplete book**, **the manifest will not parse**) stop and ask
first. Everything else was already unreachable, so nobody loses what they could not open — but a book is
different: it is on the shelf, it half works, and sweeping it takes every reader's place in it. So Repair
lists the books it is about to take and waits for one press. Cancel and nothing at all happens.

Reported but not touched: **missing from the shelf index** and **indexed, but the files are gone**, both
of which the rebuild in step one already fixes with no separate action, and **prefix outside the id
alphabet**, which the server cannot address at all — handle that one in the Cloudflare R2 dashboard.

Repair checks again afterwards to confirm. Because the check is complete, whatever comes back that time
is what the repair failed to clear — not something it uncovered — so a leftover is a bug and can be
reported as one. Not a routine job: worth a check after an interrupted upload or delete, or a move.

## Local development

Use [pnpm](https://pnpm.io/installation) 11 with its managed Node.js 22-or-newer environment. The local
workflow is pnpm-only; npm, npx, yarn, and corepack are unnecessary.

```sh
git clone https://github.com/<you>/bookworm.git
cd bookworm
pnpm install

cp .deploy.env.example .deploy.env
# Fill CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and ADMIN_TOKEN
./scripts/deploy.sh
```

`.deploy.env` is gitignored and must never be committed. `deploy.sh` creates or finds D1, creates R2, applies
the schema, deploys the Worker, and installs secrets. It also writes your D1 `database_id` to `wrangler.jsonc`;
commit that change to your fork.

To run the Cloudflare steps manually:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create bookworm
# Copy the returned ID into wrangler.jsonc
pnpm exec wrangler r2 bucket create bookworm-books
pnpm run db:init
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm run deploy
```

Start a local development server with:

```sh
cp .dev.vars.example .dev.vars
pnpm run db:init:local
pnpm run dev
```

The default URL is <http://localhost:8787>.

### Tests

```sh
pnpm test
```

The full suite covers Push crypto and APIs, shelf administration, vertical layout, background behavior,
TTS streaming, and offline use. Individual commands include:

```sh
pnpm run test:push
pnpm run test:tts
pnpm run test:vertical
pnpm run test:bg
pnpm run test:admin
pnpm run test:shelf
pnpm run test:offline
```

End-to-end tests require Chromium; TTS streaming also requires `ffmpeg` on `PATH`.

## Troubleshooting

### Actions is empty or a workflow will not run

GitHub disables inherited workflows in a fork. Open Actions and click “I understand my workflows, go ahead
and enable them.”

### `wrangler d1 create` fails, or R2 is not enabled

Open the R2 page in Cloudflare and activate it once, then rerun the workflow. Initial activation may request
billing details without changing the free allowance.

### First deployment asks for a `workers.dev` subdomain

A new Cloudflare account must choose one. Complete that step under **Workers & Pages → Add**, then deploy again.

### Token verification fails immediately

Confirm that the token has both `Account Settings · Read` and `User Details · Read`, with the correct account
included under Account Resources. Successful runs intentionally suppress `wrangler whoami` output so a public
Actions log does not reveal the Cloudflare email address.

### The first post-deployment probe returns 404

The Worker may still be propagating. Wait a few seconds and reopen the URL from the run summary.

### CI fails at `pnpm install --frozen-lockfile`

If your pnpm configuration has `minimumReleaseAge`, a newly released dependency can remain temporarily
unavailable. Rebuild and commit the lockfile later, or wait for that window to pass.

### Splitting produces one enormous chapter

The source headings did not match the built-in patterns. Pass a matching regex with `--pattern`, or split the
source into `NN_chapter-title.txt` files and feed the directory to the splitter.

### One device jumps to an unexpected place

Bookworm uses last-read-wins. If the same reader code was used later on another device, its newer timestamp
wins. When a synchronized position differs by at least two chapters from the last local position, the reader
offers **return to previous position** to restore and resynchronize it.

## Known limitations

- Only plain text is accepted directly. EPUB, PDF, and comics need a converter that emits Bookworm chapters
  and a manifest.
- Each `(book, reader)` stores one position; there is no furthest-read marker, annotation, highlight, or search.
- The interface is bilingual, but narration, typography, splitting, and line-breaking remain Chinese-first.
- Edge TTS uses an undocumented protocol and cannot be guaranteed forever.
- Reader codes are not strong authentication and suit only a small trusted group.

For the lower-level data contracts see [REQUIREMENTS.md](REQUIREMENTS.md); the standing design
decisions, including the conclusions of the on-device investigations, are in [DESIGN.md](DESIGN.md).
