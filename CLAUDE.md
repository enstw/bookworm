# BookBug

## Project Overview
A zero-backend Chinese e-reader web app hosted on GitHub Pages. Reads zipped, non-unicode (GB18030) Chinese text files directly in the browser, converts Simplified Chinese to Traditional Chinese, and displays in vertical traditional layout.

## Tech Stack
- **Pure HTML/CSS/JS** — no build step, no framework
- **fflate** — client-side zip decompression (~13KB)
- **OpenCC-js** — Simplified → Traditional Chinese conversion (~200KB)
- **Web Speech API** — text-to-speech (browser built-in)
- **CSS `writing-mode: vertical-rl`** — vertical text layout

## Architecture
```
bookbug/
├── index.html          ← single page app
├── style.css           ← vertical layout, pagination
├── app.js              ← reader logic, TTS, SC→TC
├── books/
│   └── *.zip           ← zipped GB18030-encoded text files
└── CLAUDE.md
```

## Key Design Decisions
- Books are kept zipped — browser decompresses on the fly via fflate
- Text files are GB18030 encoded — decoded via built-in `TextDecoder('gb18030')`
- No backend — everything runs client-side, hosted on GitHub Pages
- Bookmarks are stored in URL hash (e.g. `#book=abc&ch=3&pos=42`) for cross-browser sharing
- Pipeline: ZIP → fflate unzip → TextDecoder('gb18030') → OpenCC-js SC→TC → render

## Commands
- No build step required. Open `index.html` or serve with any static file server.
- `python3 -m http.server 8000` — local dev server (needed for fetch to work with local files)

## Code Style
- Vanilla JS, no TypeScript
- Minimal dependencies — prefer browser APIs over libraries
- No build tools, no bundler
