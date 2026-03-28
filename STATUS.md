# Bookworm — Status

## Status: Core implementation complete

## Completed
- [x] GitHub repo created
- [x] Project docs (AGENT.md, README.md, STATUS.md)
- [x] TypeScript project setup (esbuild, tsconfig)
- [x] Book added (`books/540286_tw.zip` — 《劍來》, GB18030 encoded, zipped)
- [x] `index.html` — single page app with all UI
- [x] `style.css` — vertical layout, themes (light/dark/sepia), responsive
- [x] Core reader (`src/app.ts`) — ZIP → fflate → TextDecoder → OpenCC → render
- [x] Chapter detector (`src/chapters.ts`) — auto-detects 第X章/回/卷, 楔子, 序, etc.
- [x] Custom fonts (`src/fonts.ts`) — loads from `fonts/` folder via FontFace API
- [x] AI TTS (`src/tts.ts`) — OpenAI-compatible TTS API integration
- [x] URL hash bookmarks + localStorage fallback
- [x] Keyboard and touch navigation
- [x] Settings panel (font, size, theme, TTS config)
- [x] Book selector UI with `books/index.json` manifest

## Future Enhancements
- [ ] Preload next TTS audio for gapless playback
- [ ] Drag-and-drop book upload
- [ ] Reading statistics / progress tracking
- [ ] Multiple bookmark slots
