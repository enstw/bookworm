# Enrich a book for Bookworm — agent runbook

You are an AI agent (any vendor — a Claude project, a Codex project, or a
plain chat with file support) holding a raw book file the owner attached.
Your job: produce an enriched zip for the owner to download, **named after
the book** — `劍來.zip`, not `enriched-book.zip`. The filename is part of
the contract: the owner's admin page pre-fills the book's title and URL
slug from it the moment the file is picked, before the zip is even opened.
They will upload it themselves on their Bookworm admin page — you never
need credentials, an API token, or network access to their site. The human
carries the payload; that is the design, not a limitation.

## What the zip must contain

Files at the zip root or inside a single folder (both work):

| file | required | what it is |
|---|---|---|
| `book.txt` | yes | the complete body text, UTF-8 |
| `meta.json` | yes | title / author / synopsis you researched |
| `cover.jpg` or `.png` or `.webp` | no | one cover image |

Nothing else. Extra files are ignored.

## book.txt — byte-faithful. This rule outranks every other.

The body text must be the original, byte for byte. **Never** retype,
regenerate, summarize, "clean up", fix typos in, or otherwise let a language
model produce any part of the body. A model that "helpfully" rewrites one
paragraph has destroyed the book.

- Source already UTF-8 → copy the file unchanged.
- Source in Big5 / GBK / GB18030 → transcode with a real tool only:
  `iconv -f GBK -t UTF-8 in.txt > book.txt` (pick the charset by trying
  candidates and choosing the one with no U+FFFD replacement characters).
- Do **not** convert 簡→繁. The upload page does that conversion itself,
  with the owner watching the preview.
- Source is a zip holding several `.txt` → the largest one is the book.
- Verify before packing: output line count and CJK character count must
  match the input (transcodes preserve both); read the first and last
  paragraphs and confirm they match the source.

## meta.json — researched, not guessed

```json
{
  "title": "書名",
  "author": "作者",
  "synopsis": "二到四句、不劇透的簡介。",
  "source": "https://example.org/where-you-verified-this"
}
```

- Caps: title 100 chars, author 100, synopsis 2000, source 500. Keys
  outside these four are dropped by the uploader — don't invent any.
- Identify the book from its own text (title page, chapter headers), then
  verify title and author against the web. `source` is where you verified.
- For Chinese books, write title / author / synopsis in 繁體中文 — the
  shelf is Traditional-first, and metadata is not run through the 簡→繁
  converter (only the body is).
- Not sure about a field? Leave it out rather than guess. A wrong author
  printed on the cover is worse than a blank one.
- Plain UTF-8 JSON, no BOM, no comments.

## The cover — flat front-cover art, or absent

Find the actual front cover of this book (any edition) as **flat artwork
in portrait orientation**: the image printed on the book's front, filling
the whole frame. The shelf crops covers into a 4:5 portrait tile, so the
wrong kind of image gets mangled there.

- **No product photos.** A bookstore's 3D shot — visible spine, white
  padding around the book, a 書腰 marketing band, promo stickers — is a
  photo *of* the book, not the cover. If the page you cite as `source`
  offers a plain frontcover image (Google Books and most bookstores do),
  prefer that exact image over anything from a shop listing.
- Any of jpg / png / webp is fine; the uploader transcodes to its
  canonical JPEG (1200 px long edge), so resolution beyond that is wasted.
- If no genuine flat cover can be found, **omit the file** — the shelf
  dresses cover-less books in a cloth binding with the title on a 題簽,
  which looks deliberate, not broken. Never generate a cover silently;
  that is the owner's call.
- **A generated cover, when the owner asks for one, is a designed cover,
  not an illustration.** The shelf shows the image alone — a cover image
  paints over the 題簽 — so the 書名 (and author) must be typeset on the
  artwork itself, in clean 繁體. Garbled AI glyphs are worse than the
  cloth fallback: if your image tool cannot set CJK type cleanly,
  generate textless artwork and typeset the title over it with a real
  tool (ImageMagick, canvas). Print-grade and 4:5 portrait, long edge
  ≥ 1200 px (the uploader downscales to 1200, so more is wasted), drawn
  from the book's actual mood and imagery — no watermarks, no mock-3D,
  no 書腰. Say in the hand-back that the cover is generated.

## Hand-back

1. Self-check: the zip is named after the book and lists `book.txt` +
   `meta.json` (+ one cover); `meta.json` parses; `book.txt` counts match
   the source; the cover, if present, is flat portrait front-cover art.
2. Save `<書名>.zip` where the owner can download it from this
   conversation / project.
3. Tell the owner what you identified (title, author) and anything you
   were unsure of, so they can eyeball it before uploading.
