# BookBug — Implementation Plan

## Status: Project setup complete, implementation not started

## Completed
- [x] GitHub repo created (`enstw/bookbug`)
- [x] CLAUDE.md and README.md written
- [x] GitHub description set
- [x] First book added (`books/540286_tw.zip` — 《劍來》, GB18030 encoded, zipped)
- [x] Confirmed decoding pipeline: ZIP → fflate → TextDecoder('gb18030') → OpenCC-js SC→TC

## Implementation Plan

### Phase 1: Core Reader
- [ ] Create `index.html` — single page app shell
- [ ] Create `style.css` — vertical layout (`writing-mode: vertical-rl`), page/column-based pagination, e-reader styling
- [ ] Create `app.js` — main application logic
- [ ] Load fflate via CDN — unzip `.zip` books client-side
- [ ] Decode text with `TextDecoder('gb18030')`
- [ ] Integrate OpenCC-js via CDN — convert SC → TC on the fly
- [ ] Render book content in vertical columns with page navigation (prev/next)

### Phase 2: Navigation & Bookmarks
- [ ] Parse book into chapters (detect chapter headings like `第X章`)
- [ ] Chapter list / table of contents sidebar
- [ ] URL hash bookmarks (`#book=540286_tw&ch=3&pos=42`)
- [ ] Keyboard navigation (arrow keys, Page Up/Down)

### Phase 3: Text-to-Speech
- [ ] Web Speech API integration (`speechSynthesis`)
- [ ] Play/pause/stop controls
- [ ] Highlight current sentence being read
- [ ] Auto-advance pages during TTS playback

### Phase 4: Book Management
- [ ] Book selector UI (list all `.zip` files in `books/`)
- [ ] Remember last-read book and position
- [ ] Support adding book list via a `books/index.json` manifest (since GitHub Pages can't list directories)

### Phase 5: Polish
- [ ] Font size adjustment
- [ ] Light/dark theme
- [ ] Mobile responsive layout
- [ ] Loading indicator during unzip/conversion

## Key Libraries (all via CDN, no build step)
- **fflate** — `https://cdn.jsdelivr.net/npm/fflate` (~13KB)
- **OpenCC-js** — `https://cdn.jsdelivr.net/npm/opencc-js` (~200KB)

## Design Notes
- No backend, no build tools — everything is static files
- Books stay zipped to save bandwidth and simplify adding new books
- `books/index.json` needed because GitHub Pages doesn't support directory listing
- URL hash is the only state persistence mechanism — no cookies, no localStorage needed for bookmarks
