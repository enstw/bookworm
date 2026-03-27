# Bookworm 書蟲

A lightweight Chinese e-reader that runs entirely in the browser. No server required.

## Features

- **Vertical text layout** — traditional right-to-left Chinese typesetting
- **Simplified → Traditional** Chinese conversion (powered by OpenCC-js)
- **Read zipped books directly** — no need to unzip; supports GB18030/GBK encoded text files
- **Smart chapter detection** — automatically detects chapter headings (第X章/回/卷, 楔子, 序, etc.) and builds a table of contents on the fly
- **AI text-to-speech** — listen to book content using OpenAI-compatible TTS APIs
- **Custom fonts** — drop font files into `fonts/` and select them in settings
- **URL bookmarks** — share your reading position across browsers via URL
- **Themes** — light, dark, and sepia reading modes
- **Zero backend** — static files only, hosted on GitHub Pages

## Usage

1. Drop a zipped `.txt` book file into the `books/` folder
2. Add an entry to `books/index.json`
3. Open the app and select your book
4. Read!

### Custom Fonts

Place `.ttf`, `.otf`, `.woff`, or `.woff2` files in `fonts/` and register them in `fonts/index.json`:

```json
[{ "name": "我的字體", "file": "MyFont.woff2" }]
```

### AI TTS Setup

Open Settings and enter your OpenAI-compatible TTS API endpoint and key. The app sends requests to `POST <endpoint>` with the standard OpenAI TTS payload format.

## Development

```bash
npm install
npm run build     # compile TypeScript → app.js
npm run watch     # rebuild on changes
npm run dev       # start local dev server on :8000
```

## Tech Stack

| Component | Solution |
|-----------|----------|
| Language | TypeScript (compiled via esbuild) |
| Unzip | [fflate](https://github.com/101arrowz/fflate) (CDN) |
| Text encoding | `TextDecoder('gb18030')` (browser built-in) |
| SC → TC | [OpenCC-js](https://github.com/nk2028/opencc-js) (CDN) |
| TTS | OpenAI-compatible AI TTS API |
| Vertical layout | CSS `writing-mode: vertical-rl` |
| Custom fonts | `fonts/` folder + FontFace API |
| Hosting | GitHub Pages |

## License

MIT
