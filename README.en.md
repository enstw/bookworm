![Bookworm: a green dragon guarding a book in its private library](.github/banner.png)

# Bookworm

**Turn the Chinese novels you already have into a reading app that finally feels made for them.**

True vertical type · Simplified-to-Traditional · cross-device resume · lock-screen narration · offline · self-hosted with no monthly bill

<sub>[繁體中文](README.md) · English · [Installation & operations](INSTALLATION.en.md)</sub>

Most reading apps begin by asking which store sold you the book. Bookworm begins with a better question:
**how do you want to read it?**

Give it a `.txt`. Bookworm handles legacy encodings such as GBK and Big5, converts Simplified Chinese
into Taiwan Traditional, finds the chapter headings, and publishes the result at your own URL. Open the
same link on a phone, tablet, or laptop and resume at the same character. When your eyes need a rest,
tap once and narration picks up from the sentence in front of you.

It is not another bookstore, and it does not want custody of your library. It is a private Chinese
reading server for you and a few people you trust.

> **The entire service is one Cloudflare Worker.** No always-on home server, App Store, or subscription.
> Within Cloudflare's free allowances, a personal shelf costs `$0` to run.

<p align="center">
  <img src=".github/screenshots/reader.png" width="200" alt="Bookworm's full-page vertical reader, flowing right to left">
  <img src=".github/screenshots/toc.png" width="200" alt="Bookworm chapter drawer">
  <img src=".github/screenshots/library.png" width="200" alt="Bookworm private shelf and reading progress">
  <img src=".github/screenshots/horizontal.png" width="200" alt="Bookworm horizontal reading mode">
</p>

<p align="center"><sub>
Full-page vertical reading · table of contents · private shelf · horizontal mode<br>
The pictured books are public-domain Chinese classics sourced from Wikisource.
</sub></p>

## What Bookworm does differently

### Chinese is the starting point, not an afterthought

Bookworm's vertical mode is not horizontal text rotated ninety degrees. Line pitch, font size, and page
width sit on an integer-pixel grid, so a page boundary always lands between two columns. Pages turn from
right to left without clipping half a line or accumulating Safari's fractional-pixel drift.

Changing type size changes the number of lines on a page and returns you to the sentence you were reading.
Rotate the screen or switch to horizontal mode and your place remains intact. The bundled ENS Font is based
on LXGW WenKai TC; punctuation, rhythm, and fourteen paper colors are tuned for long Chinese sessions.

### Simplified sources become natural Taiwan Traditional

Bookworm runs OpenCC `cn→tw` before it splits the book. That changes vocabulary as well as glyphs:
`软件` becomes `軟體`, and `信息` becomes `訊息`. Body text, title, chapter headings, filenames,
and URL slug are converted together, so a shelf never ends up half Simplified and half Traditional.

Already have a Traditional copy? Auto-detect or skip conversion. UTF-8, GBK, Big5, and Shift_JIS inputs
are all accepted.

### Your place is a character, not a page number

A page cannot mean the same thing on a six-inch phone and a 27-inch display. Bookworm stores a chapter
and character offset instead. Change devices, type size, or writing direction and you still land on the
same sentence. It syncs periodically while you read, flushes once more when the tab closes, and catches up
after an offline session.

There is no account to register. The owner mints a reader key per device on `/admin`; open the key link on
a device once and it is signed in — positions and settings sync through the reader id the key maps to.

### When your eyes stop, the story does not

Tap 🔊 and the text in front of you becomes an audiobook. Bookworm chunks the chapter, synthesizes speech
at the edge, caches the MP3s, advances into the next chapter, and keeps narration, visible text, and the
bookmark on the same timeline.

On Safari and iOS, chunks are appended to one continuous audio stream, so narration keeps playing behind
the lock screen and responds to system media controls. It is not a separate audio edition—it takes over
from the sentence you were reading.

### One URL is a shelf and an app

Opening a book keeps its nearby chapters on the device by itself, so a plane changes nothing; progress syncs
when the connection returns. To stock a book before you leave, tap ⇣ on its card on the shelf.
“Add to Home Screen” installs the frameless standalone PWA — whichever page you install from, it opens at
the shelf, and one tap resumes any book where you left it. Web Push can announce new books to installed
devices.

### Your books, your account, your infrastructure

Chapters live in your Cloudflare R2 bucket, positions in your D1 database, and code in your Worker. There
is no third-party reading account or proprietary content format, and your original `.txt` remains yours.
`/admin` is the control panel: retitle, change a URL slug, or delete chapters, audio cache, and
reading positions together.

There is no NAS to nurse. Once deployed, Bookworm has no daemon, container, or operating system to maintain.
Cloudflare's current free plan includes [100,000 Worker requests per day](https://developers.cloudflare.com/workers/platform/limits/),
[10 GB-month of R2 storage](https://developers.cloudflare.com/r2/pricing/), and
[5 GB total D1 storage](https://developers.cloudflare.com/d1/platform/pricing/)—ample room for a typical
personal shelf.

## Where it sits among other reading apps

This is not a feature-count contest. Each product has a different center of gravity. Bookworm sits between
storefront readers and full self-hosted library managers, focusing on one job: reading **your own long-form
Chinese plain text** exceptionally well.

| | **Bookworm** | **Kobo / Apple Books** | **Readwise Reader** | **Calibre-Web / Kavita** |
| --- | --- | --- | --- | --- |
| Best for | Your own long Chinese `.txt` novels | Buying and reading store ebooks | Articles, PDFs, EPUBs, annotations, and knowledge workflows | Managing a large, multi-format self-hosted library |
| Chinese vertical type | Core design: full-page grid and right-to-left turns | Depends on title, format, and platform | Not a product focus | Not a product focus |
| Import preparation | Legacy encodings, S→T conversion, heading detection, chapter splitting | Platform-dependent sideload formats | Imports EPUB, PDF, and many document sources | The broadest format, metadata, and conversion support |
| Cross-device position | Your URL; character-precise | Platform account and cloud | Readwise account and cloud | Your server and user configuration |
| Narration | Starts at visible text, crosses chapters, continuous lock-screen playback | Kobo Web Reader offers it for selected books | Multilingual AI voices with a subscription | Depends on reader or external tooling |
| Hosting and data | Cloudflare runs the infrastructure in your account | Platform cloud | Readwise cloud | You operate a host or container |
| Ongoing cost | Usually `$0` at personal scale | Free app; books sold separately | Paid subscription | Free software; you provide hosting, storage, and maintenance |

The comparison is based on the products' public descriptions:
[Kobo Apps](https://www.kobo.com/tw/zh/p/apps),
[Apple Books sync](https://support.apple.com/en-au/guide/iphone/iphb886e1752/ios),
[Readwise Reader](https://readwise.io/read/),
[Calibre-Web](https://github.com/janeczku/calibre-web), and
[Kavita](https://www.kavitareader.com/). Features and prices can change.

## Is it for you?

Bookworm is likely the missing piece if you:

- keep web novels, classics, or other long works as `.txt`, often in Simplified Chinese or a legacy encoding;
- care about real vertical composition and complete pages on a phone or tablet;
- want to read on the commute, listen while walking, and resume the same sentence at home;
- share a private shelf with a few trusted friends or relatives without creating accounts for everyone; or
- want control of your data without keeping a computer on around the clock.

Bookworm is **not currently for** readers who need:

- direct EPUB, PDF, comic, or DRM-store support;
- highlights, annotations, full-text search, dictionaries, or a knowledge-management workflow;
- public hosting, or granular per-user/per-book authorization (a reader key decides *whether* you can read, not *which* books); or
- multilingual voices—the narrator is currently fixed to Taiwan Mandarin.

Those are deliberate boundaries. Bookworm is not trying to become the universal warehouse for every kind
of book; it is trying to become the most comfortable doorway into a long Chinese one.

## From one `.txt` to your private app

Publishing a book does not redeploy the application. Open `/admin` (the library footer's "manage" link
points at it), choose a `.txt` or `.zip`, inspect the detected chapters, and upload. Decompression, charset
conversion, S→T conversion, and splitting all happen in the browser—even on a phone. The same page lists
every book on the shelf and edits it in place: retitle, re-slug, or delete. Each book is stored under a
permanent book id, so a new slug only changes the URL—nothing moves, reading positions stay put, and the
old URL still resolves. GitHub Actions and a CLI are available for huge files and batch work.

Deployment takes about fifteen minutes: fork the project, add three secrets, and run one GitHub Action.
Permissions, publishing, custom domains, Push, local development, maintenance, and troubleshooting now live
in the **[Installation & operations guide](INSTALLATION.en.md)**.

## Technical outline

- **Cloudflare Worker:** routing, APIs, TTS, and the static front end.
- **R2:** plain-text chapters, manifests, and synthesized audio chunks.
- **D1:** reading positions, synchronized settings, and Push subscriptions.
- **Vanilla JavaScript PWA:** no front-end framework, bundler, or mandatory build step.
- **Key identity model:** reader keys minted on `/admin` map to reader ids; `/<book-slug>` opens that book at this device's position.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the data contracts and v1 design,
and [DESIGN.md](DESIGN.md) for the standing engineering decisions.

## Access and security boundary

Book content, positions, and narration sit behind the reader key: requests without one answer 401. Keys are
minted and revoked on `/admin`, one per device; revocation fences the server — chapters a device already
cached offline are unaffected. `robots.txt` and `noindex` additionally keep ordinary search engines away.

Publishing and shelf administration always require `ADMIN_TOKEN`. Only upload material you have the right
to store and share.

## License

The application is released under the [MIT License](LICENSE): fork it, change it, and ship it.

The bundled [ENS Font](public/fonts/LICENSE.md) is distributed under the SIL Open Font License 1.1. Follow
its font license and reserved-name terms when modifying or redistributing it.

---

**Ready to put the next long read back in your own hands?**

[Install Bookworm →](INSTALLATION.en.md)
