# Bookworm — Requirements

_The v1 spec. This repo implements v1; items marked **[v2]** are explicitly
deferred._

## Vision

A personal web ebook reader for a handful of trusted users. Opening
`https://<host>/<book>/<user-id>` on **any device** resumes the book exactly
where that user last left it. Zero running costs, no service that sleeps or
expires, and adding a book must not require redeploying the app.

## Scope assumptions

- ≤ 10 books, ≤ 5 users (design headroom is far larger, but this is the target).
- Books are plain-text files (novels), possibly 20 MB+ compressed / ~80 MB raw,
  possibly in legacy encodings (GBK, Big5, …).
- Users are trusted; no accounts, no registration, no PII beyond a reader id.
- Reference scale the pipeline is verified against: 劍來, 1,182 pre-split
  chapters / 12.9M chars, plus a 42-chapter sequel via directory mode.

## Functional requirements

**FR-1 · URL contract.** `/<book-slug>/<user-id>` opens that book for that
user at their saved position. `/` is a library page listing all books and
showing/generating/changing the device's reader id (6 random hex digits, kept
in localStorage). Invalid paths get a helpful error, not a blank page.

**FR-2 · Reader.** Continuous scroll within a chapter; top/bottom bars are
overlays hidden by default — tapping the middle ninth of the screen toggles
them, so the text otherwise gets the whole screen. Tap zones: bottom-left
quarter scrolls a screen forward, bottom-right quarter a screen back
(forward-on-the-left matches right-to-left 直排; same in 橫排); at a
chapter's edge the page turn crosses into the adjacent chapter — backward
lands on the previous chapter's end. Chapter nav
puts Next on the left and Prev on the right for the same reason; keyboard
arrows switch chapters too. Table-of-contents drawer; adjustable font size
(16–72 px, default 24) and theme (auto/light/dark), both remembered per
device; line spacing is ⅓ of the font size; progress indicator (chapter
n/total and % of book). CJK-friendly typography.
**[v2]** Page-flip pagination mode (Kindle-style) as an alternative to scroll —
the char-offset position model already supports it.

**FR-3 · Position tracking.** Position = `(chapter index, character offset
into the chapter file)` — independent of device, font size, and layout.
Saved to localStorage immediately on scroll/navigation; synced to the server
at most every ~10 s while reading, and flushed via `sendBeacon` on tab
hide/close. On open, the newer of local vs server position wins
(**last-read-wins**, single position per (book, user); no furthest-read
tracking). Offline reading keeps tracking locally and pushes when possible.

**FR-4 · Book pipeline.** `split-book.mjs` converts a book into per-chapter
UTF-8 files plus `manifest.json`. Input is either one big `.txt`, or a
directory of already-split `NN_<title>.txt` files (e.g. an unzipped archive —
ordered by numeric prefix, titles taken from filenames, one folder per book).
For single-txt input: Chapter headings are detected by
a line regex (Chinese `第…章/節/回/卷…`, `Chapter N`, 序章/楔子/番外 …,
overridable via `--pattern`); preface text before the first heading becomes
chapter 0; if fewer than 3 headings match, fall back to size-based parts.
Oversized chapters are sub-split at line boundaries (default 150k chars).
Input charset selectable (`--charset gbk|big5|…`); output is always UTF-8.

**FR-5 · Chapter filenames.** Each file encodes chapter number + sanitized
title: `NNNN_<title>.txt` (e.g. `0012_第十二章-雪夜.txt`) so the bucket is
human-manageable. `manifest.json` (ordered titles → files → char counts) is
the source of truth the reader navigates by; filename sanitization can never
break a URL or the reading order.

**FR-6 · Publishing without redeploy.** `publish-book.mjs` uploads a split
book to R2 through the worker's token-guarded admin endpoint
(`PUT/DELETE /api/admin/objects/<key>`, `Bearer ADMIN_TOKEN`), manifest last
so a half-uploaded book is never listed. Re-publishing overwrites in place.

**FR-7 · API.** `GET /api/books` (the shelf, from the D1 index),
`GET /api/books/<slug>` (slug → book id, including former slugs), `GET/POST
/api/position` (LWW upsert guarded by timestamp — a late write from another
device never clobbers a newer one), and behind `ADMIN_TOKEN`:
`PATCH/DELETE /api/admin/books/<id>` (retitle, re-slug, delete),
`POST /api/admin/audit` (the read-only health check), and
`POST /api/admin/reindex` + `POST /api/admin/cleanup` (the repair, which is
the only half that writes).

## Non-functional requirements

**NFR-1 · Cost & permanence.** $0: Cloudflare Workers free tier (static
assets + worker), R2 (10 GB), D1 (100k writes/day). No component sleeps,
expires, or needs a credit card.

**NFR-2 · Resume latency.** Opening a book at a saved position fetches only
`manifest.json` + one chapter file — first readable paint well under 1 s on
broadband regardless of total book size. Next chapter is prefetched while
reading; chapters are edge/browser-cached (1 h) and compressed (brotli/gzip)
on the wire automatically by Cloudflare.

**NFR-3 · Access model.** Reading requires a **reader key**: a bearer
secret minted on `/admin`, delivered to a device as a `/?key=…` link, and
mapped server-side to the reader id whose positions and settings that
device then uses. Content routes (`/api/books`, `/books/*`, TTS, positions,
settings) 401 without one; the app shell and `/api/feedback` stay open.
`/api/testlog` takes a credential in both directions: a reader key to read
(its rows quote the book) and an admin cookie to write. The key rides as a
server-set cookie (so `<audio>`, sendBeacon and the service worker
authenticate for free); revocation is deleting the
row on `/admin`. Ids asserted by clients are never trusted — the v1 model
(the 6-hex id in the URL as a capability token, resisting stumbling but not
enumeration) was accepted for a trusted circle and retired when the repo
went public. Cloudflare Access was considered and rejected: its redirect
auth breaks the installed-PWA offline machinery and cannot ship with a
self-hosted fork.

**NFR-4 · No lock-in of content.** Original `.txt` files are kept by the
owner (optionally archived in a GitHub release); everything in R2/D1 is
derived and reproducible from them via the scripts.

**NFR-5 · Simplicity.** No frontend framework, no build step, no server
framework. Vanilla JS ± 600 lines total.

## Data contracts

```
manifest.json   { id, slug, title, charset: "utf-8", totalChars,
                  chapters: [{ title, file, chars, bytes }, …], generatedAt }
D1 books        (id TEXT PK, slug TEXT, title TEXT, chapters INT,
                  total_chars INT, updated_at INT, indexed_at INT)
D1 book_slugs   (slug TEXT PK, book TEXT, created_at INT)
D1 positions    (book TEXT, user TEXT, chapter INT, char_off INT,
                  updated_at INT, PK (book, user))   -- book = the book ID
R2 layout       <id>/manifest.json, <id>/NNNN_<safe-title>.txt
```

The id is minted once and never changes; the slug is a label in the URL that
resolves through `book_slugs` (former slugs stay, so links keep working).
Manifests are the source of truth — the two D1 book tables are an index over
them, rebuildable with `POST /api/admin/reindex`. Books published before ids
existed have id = their original slug, which is what their prefix already was.

## Explicitly out of scope (v1)

- Page-flip pagination **[v2]**, PWA/offline install **[deferred, revisit]**
- EPUB/PDF input (txt only; EPUB could be added as a splitter that emits the
  same manifest + chapter files)
- Multi-position/furthest-read tracking, annotations, highlights, search
- Any account system or per-book permissions
