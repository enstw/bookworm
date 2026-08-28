// Bookworm TTS audiobook player: both playback engines, the player bar,
// and MediaSession. app.js preloads this module at reader init and wires
// the reader internals in via init(deps); everything else stays private.
//
// The worker synthesizes ~280-char chunks on demand (/api/tts/...) and the
// shared chunker in tts-core.mjs keeps both sides' offsets identical. While
// audio plays it owns the reading position: playback time maps to a char
// offset, feeding the same savePos/sync path as scrolling.
//
// Two playback engines behind the same player bar:
//
// - STREAM (Safari/iOS 17.1+): iOS refuses play() while the screen is
//   locked — an element that `ended` cannot be followed by another one, or
//   even by a src swap on the same element (iOS 15+), so a chunked playlist
//   dies a minute after locking. Apple's supported path is
//   ManagedMediaSource: ONE audio element playing ONE continuous mp3
//   timeline that we keep appending chunk files to. No chunk or chapter
//   boundary ever reaches the media element, nothing needs play() while
//   locked, and the system keeps the page alive to buffer ahead.
// - CHAIN (everything else): the double-buffered element swap. Chrome and
//   Firefox happily chain play() from the `ended` handler in background.
// - WASM (offline, wasm-tts.mjs): wasmtts's Matcha zh-en in a worker — no
//   network after the one-time voice pack download. The reader's DEFAULT when
//   the pack is in the cache (downloaded by /wasmtest or the pill, never
//   silently — ▶ must not quietly pull ~140 MB over cellular). localStorage
//   bw_tts picks the default engine, "offline" (default) or "online"; the
//   other one is the fallback (see ttsPref). Playback is wasmtts's own
//   continuous-stream-player on the reader's one blessed element: the same
//   single-timeline MediaSource discipline as STREAM, with the lock-screen
//   rules this app found on its phone and handed upstream (watchdog, the
//   5-minute chain death, Media Session) — see the WASM section below.

import * as ttsCore from "/tts-core.mjs";
import * as wasmTts from "/wasm-tts.mjs";
import { createContinuousStreamPlayer } from "/vendor/wasmtts/continuous-stream-player.mjs";

const MMS = globalThis.ManagedMediaSource;
export const useStream = !!MMS?.isTypeSupported?.("audio/mpeg");
let wasmOn = false;
let packOk = false; // the voice pack is complete in the cache (pickEngine)
const useWasm = () => wasmOn;
// 預設語音引擎 (owner, 2026-08-28): "offline" (the default) or "online"; the
// other one is the fallback. Per-device, like 每頁行數 — the pack is on THIS
// device and so is the signal. The old force-online debug flag "stream"
// reads as "online" so a phone that set it keeps its choice.
export function ttsPref() {
  let v = null;
  try { v = localStorage.getItem("bw_tts"); } catch { /* private mode */ }
  return v === "online" || v === "stream" ? "online" : "offline";
}
// Re-run whenever the pack may have changed (module load, pill re-download,
// session close) — but never under a live session: useWasm() is consulted
// throughout playback, and an engine that swaps mid-stream strands the
// timeline the other one owns. closePlayer re-picks, so a pack downloaded
// while listening takes effect at the next ▶. The fallbacks that DO swap
// under a session (engine failure, the network going away) each end the
// timeline they leave before opening the other — see wasmSynthLoop and
// feedStream.
function pickEngine() {
  return wasmTts.packReady().then((r) => {
    packOk = !!r;
    if (player.on) return;
    wasmOn = packOk && ttsPref() === "offline";
    console.log(`bookworm tts engine: ${wasmOn ? "wasm (offline matcha)" : useStream ? "stream (ManagedMediaSource)" : "chain"}`);
    wasmPrime();
  });
}
pickEngine();

// reader internals, injected once by app.js
let $, el, state, fetchChapter, openChapter, savePos, flush, updateProgress,
  followScroll, pageStartOffset, highlightSentence, lastUserScroll;

export function init(deps) {
  if ($) return; // both load paths in app.js may race; first wins
  ({ $, el, state, fetchChapter, openChapter, savePos, flush,
    updateProgress, followScroll, pageStartOffset, highlightSentence,
    lastUserScroll } = deps);
  // a page turn moves where ▶ would start (the page on screen): re-prime
  // once the reader settles — a no-op when the page still starts in the
  // primed sentence, one sentence of worker time otherwise
  let primeTimer = 0;
  document.addEventListener("scroll", () => {
    clearTimeout(primeTimer);
    primeTimer = setTimeout(wasmPrime, 1500);
  }, { capture: true, passive: true });
}

export const player = {
  on: false,       // listening session active (bar visible)
  playing: false,
  chapIdx: -1,
  chunks: [],
  chunkIdx: -1,
  audio: null,     // element playing the current chunk
  standby: null,   // element preloading the next chunk (double buffer)
  nextUrl: null,   // what standby holds; null = nothing usable preloaded
  status: "",      // "" | "loading" | "error"
  seekOff: null,   // chain engine: land the first chunk at this char offset
};

// A reading that starts mid-chunk opens on the sentence HOLDING the
// requested char, so narration begins a few seconds before it. Until the
// spoken offset crosses the request, that pre-roll must not turn the page
// back or drag the bookmark backward; one-shot, cleared on arrival and on
// any explicit ⏮/⏭.
let startFloor = -1;

function ttsUrl(file, idx) {
  const v = state.manifest?.generatedAt ?? "0";
  return `/api/tts/${encodeURIComponent(state.id)}/${encodeURIComponent(file)}/${idx}?v=${encodeURIComponent(v)}`;
}

let packNoticed = false; // the voice-pack pill, at most once per session

// A reading that lands on an online engine says why, once, with the fix one
// tap away — the voice pack is a reader feature, not diagnostic-page lore
// (owner, 2026-08-15). Two flavors of one pill: a device that HAD the pack
// and lost it to a model bump (packReady turns false on a phone that did
// nothing wrong) gets 「需要更新」, because a silent fallback reads as the
// app losing a feature it used to have; a device that never held the pack
// gets the plain offer, because the only other way it would ever learn the
// offline voice exists is finding /wasmtest by hand.
//
// The tap downloads in place (the same downloadPack /wasmtest runs) instead
// of leaving the book, and the button names the megabytes, so the cellular
// guarantee — no silent ~145 MB — still holds. Narration keeps playing on
// the online engine meanwhile; the offline one takes over at the next ▶
// (closePlayer re-picks).
function noticePack() {
  if (packNoticed || useWasm()) return;
  (async () => {
    const stale = await wasmTts.packStale();
    const missing = await wasmTts.packMissingBytes();
    // a complete pack here means pickEngine has not caught up yet — not news
    if (packNoticed || !missing) return;
    packNoticed = true;
    const goKey = stale ? "player.packGo" : "player.packGet";
    const label = el("span", { class: "jumpnote-text" },
      t(stale ? "player.packStale" : "player.packOffer"));
    const go = el("button", { class: "linklike", id: "packGoBtn", onclick: download },
      t(goKey, Math.round(missing / 1048576)));
    const note = el("div", { class: "jumpnote" }, label, go,
      el("button", { class: "iconbtn", title: t("ui.close"), onclick: () => note.remove() }, "✕"));
    document.body.append(note);
    async function download() {
      go.disabled = true;
      try {
        await wasmTts.downloadPack(({ gotBytes, totalBytes }) => {
          go.textContent = t("player.packBusy", Math.round((gotBytes / totalBytes) * 100));
        });
        label.textContent = t("player.packDone");
        go.remove();
        pickEngine(); // no-op while listening; closePlayer runs it again
      } catch {
        // half a pack is fine: a retry skips what already landed
        label.textContent = t("player.packFail");
        go.textContent = t(goKey, Math.round(await wasmTts.packMissingBytes() / 1048576));
        go.disabled = false;
      }
    }
  })();
}

export function togglePlayer() {
  if (player.on) return closePlayer();
  // a NEW reading opens at the top of the page on screen — the tracked
  // state.off is paragraph-grained and sticky (a straddling paragraph keeps
  // its start), so it routinely points a page or more behind the eye
  startPlayer(pageStartOffset() ?? state.off);
}

// The engine button: a tap flips the default and, under a live session,
// reopens the reading on the other engine at the voice's own position —
// inside the same tap, so the element blessing below still counts as a
// gesture. Ending the session first is what keeps the mid-stream rule.
function toggleTtsPref() {
  const next = ttsPref() === "online" ? "offline" : "online";
  try { localStorage.setItem("bw_tts", next); } catch { /* private mode: this session only */ }
  wlog(`預設引擎 → ${next}`);
  if (!player.on) return;
  const off = state.off;
  closePlayer();
  // the synchronous re-pick; closePlayer's async one lands on the same
  // answer and stands down because the session is already on again
  wasmOn = packOk && next === "offline";
  startPlayer(off);
}

// open a session at `off` inside the current tap
function startPlayer(off) {
  player.on = true;
  $("#audioBtn")?.classList.add("active");
  // 線上為預設、離線為備援: with no network at ▶ the fallback starts at once
  // instead of a stream that can only fail
  if (!wasmOn && packOk && !navigator.onLine) { wasmOn = true; wlog("▶ 無網路 → 離線引擎"); }
  noticePack();
  // bless the element(s) inside this tap: iOS only lets an element play()
  // outside a gesture (chunk swaps happen on `ended`) after it has played
  // within one — a beat of silence counts
  if (useWasm() || useStream) {
    ensureStreamEl();
    unlockAudio(stream.el);
  } else {
    ensureAudio();
    unlockAudio(player.audio);
    unlockAudio(player.standby);
  }
  buildPlayerBar();
  playFrom(state.idx, off);
}

// called by openChapter: navigating while listening moves the narration too
// (chapter auto-advance restarts playback itself, so only manual jumps land
// here — advance paths set chapIdx before opening the chapter)
export function chapterOpened(i, offset) {
  if (player.on && player.playing && i !== player.chapIdx) playFrom(i, offset);
  else if (!player.on) wasmPrime();
}

// called on visibilitychange→visible: show the chapter the narration
// crossed into while the screen was off
export function visibleCatchup() {
  if ((stream.pendingOpen || wasm.pendingOpen) && player.on) {
    stream.pendingOpen = false;
    wasm.pendingOpen = false;
    openChapter(state.idx, state.off);
  }
  // the 5-minute chain death (a play() the lock screen left pending forever)
  // is the upstream player's to recover from now: it re-kicks on the
  // foreground flip unless the reader paused on purpose (autoResumeOnVisible)
}

const SILENCE = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

function unlockAudio(a) {
  a.src = SILENCE;
  a.play().catch(() => { /* the unlock itself may be interrupted; fine */ });
}

function ensureAudio() {
  if (player.audio) return;
  player.audio = makeAudio();
  player.standby = makeAudio();
}

// The two elements swap roles as chunks advance and share these handlers;
// events from whichever is standby are ignored, except a failed preload,
// which drops the preload so playChunk falls back to a fresh load.
function makeAudio() {
  const a = new Audio();
  a.preload = "auto";
  const msn = ("mediaSession" in navigator) ? navigator.mediaSession : null;
  const active = (fn) => () => { if (a === player.audio) fn(); };
  a.addEventListener("playing", active(() => {
    player.playing = true; player.status = "";
    if (msn) msn.playbackState = "playing";
    updatePlayerBar();
  }));
  a.addEventListener("pause", active(() => {
    player.playing = false;
    if (msn) msn.playbackState = "paused";
    updatePlayerBar();
  }));
  a.addEventListener("waiting", active(() => { player.status = "loading"; updatePlayerBar(); }));
  // chain engine: a reading started mid-chunk seeks into the first chunk
  // once its duration is known — the same proportional chars↔time map
  // onAudioTime reads positions with
  a.addEventListener("loadedmetadata", active(() => {
    // the unlock silence also loads — it must not consume the seek
    if (a.currentSrc.startsWith("data:")) return;
    if (player.seekOff == null) return;
    const c = player.chunks[player.chunkIdx];
    const off = player.seekOff;
    player.seekOff = null;
    if (c && off > c.start && Number.isFinite(a.duration) && a.duration > 0)
      a.currentTime = Math.min(1, (off - c.start) / c.chars) * a.duration;
  }));
  a.addEventListener("timeupdate", active(onAudioTime));
  // the unlock silence also ends — it must not advance the narration
  a.addEventListener("ended", active(() => {
    if (a.currentSrc.startsWith("data:")) return;
    advanceChunk(1);
  }));
  a.addEventListener("error", () => {
    if (a === player.audio) { player.playing = false; player.status = "error"; updatePlayerBar(); }
    else player.nextUrl = null;
  });
  return a;
}

// Start (or restart) playback of chapter ci at char offset off. Synchronous
// when the chapter text is already loaded, so the audio.play() inside stays
// within the user's tap gesture (iOS requirement).
function playFrom(ci, off) {
  if (useWasm()) return wasmPlayFrom(ci, off);
  if (useStream) return streamPlayFrom(ci, off);
  const ch = state.manifest.chapters[ci];
  if (!ch) return closePlayer();
  const text = state.cache.get(ch.file);
  if (text !== undefined) {
    player.chapIdx = ci;
    player.chunks = ttsCore.chunkChapter(text);
    startFloor = off;
    player.seekOff = off; // land inside the chunk, not at its start
    playChunk(ttsCore.chunkIndexFor(player.chunks, off));
    return;
  }
  player.status = "loading";
  updatePlayerBar();
  fetchChapter(ci)
    .then(() => { if (player.on) playFrom(ci, off); })
    .catch(() => { player.status = "error"; updatePlayerBar(); });
}

function playChunk(k) {
  const c = player.chunks[k];
  if (!c) return advanceChapter(1);
  player.chunkIdx = k;
  const file = state.manifest.chapters[player.chapIdx].file;
  const url = ttsUrl(file, k);
  // with the screen off, everything must happen on the one element that is
  // already playing: iOS refuses play() on a different element (and kills
  // the session) in the background — a src swap on the same element is the
  // only chain with a chance there
  const hidden = document.visibilityState === "hidden";
  if (!hidden && player.nextUrl === url) {
    // the standby element already fetched and decoded this chunk — swap it
    // in and playback starts with no gap
    const a = player.standby;
    player.standby = player.audio;
    player.standby.pause();
    player.audio = a;
  } else {
    player.audio.src = url;
  }
  player.nextUrl = null;
  player.status = player.audio.readyState >= 3 ? "" : "loading";
  player.audio.play().catch(() => {
    player.status = "error";
    updatePlayerBar();
    retryOnVisible();
  });
  // preload the next chunk into the standby element — synthesis takes
  // seconds on an R2 miss, and this doubles as the only warm-up request
  if (player.chunks[k + 1] && !hidden) {
    player.nextUrl = ttsUrl(file, k + 1);
    player.standby.src = player.nextUrl;
  }
  updatePlayerBar();
  setMediaSession();
}

// a play() the OS refused while the screen was off gets one retry when the
// page becomes visible again, so unlocking the phone resumes the narration
function retryOnVisible() {
  const retry = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", retry);
    if (player.on && !player.playing && player.status === "error") {
      if (useWasm()) wasmReplay();
      else playChunk(Math.max(0, player.chunkIdx));
    }
  };
  document.addEventListener("visibilitychange", retry);
}

function advanceChunk(d) {
  startFloor = -1;      // an explicit skip owns the page from here
  player.seekOff = null;
  if (useWasm()) return wasmSkip(d);
  if (useStream) return streamAdvanceChunk(d);
  const k = player.chunkIdx + d;
  if (k >= 0 && k < player.chunks.length) playChunk(k);
  else advanceChapter(d < 0 ? -1 : 1);
}

function advanceChapter(d) {
  const ci = player.chapIdx + d;
  if (ci < 0 || ci >= state.manifest.chapters.length) return closePlayer();
  const text = state.cache.get(state.manifest.chapters[ci].file);
  if (text !== undefined) {
    // the next chapter's text is prefetched in the common case — stay
    // synchronous inside the `ended` event: iOS refuses playback started
    // from an async continuation while the screen is off
    player.chapIdx = ci;
    player.chunks = ttsCore.chunkChapter(text);
    playChunk(0);
    openChapter(ci, 0).then(() => flush());
    return;
  }
  openChapter(ci, 0).then(() => { flush(); if (player.on) playFrom(ci, 0); });
}

function playerPlayPause() {
  if (useWasm()) {
    // pause() is the one user pause the upstream player knows; a system
    // pause (lock screen) is "suspended" and auto-resumes on return
    if (player.playing) { wasm.player?.pause(); flush(); return; }
    if (player.status === "error") return wasmPlayFrom(state.idx, state.off);
    wasm.player?.resume().catch(() => { player.status = "error"; updatePlayerBar(); });
    return;
  }
  const a = useStream ? stream.el : player.audio;
  if (player.playing) {
    a?.pause();
    flush();
    return;
  }
  if (player.status === "error") {
    return useStream ? streamPlayFrom(state.idx, state.off) : playChunk(Math.max(0, player.chunkIdx));
  }
  if (useStream || (player.chapIdx === state.idx && player.chunkIdx >= 0))
    a?.play().catch(() => { player.status = "error"; updatePlayerBar(); });
  else playFrom(state.idx, pageStartOffset() ?? state.off); // navigated while paused: read the page on screen
}

export function closePlayer() {
  if (useWasm() && wasm.player) wlog("關閉");
  player.on = false;
  player.playing = false;
  player.chapIdx = -1;
  player.chunkIdx = -1;
  player.chunks = [];
  player.nextUrl = null;
  player.seekOff = null;
  startFloor = -1; // ✕ ends the session; the next 🔊 is a fresh reading
  for (const a of [player.audio, player.standby])
    if (a) { a.pause(); a.removeAttribute("src"); }
  streamTeardown();
  wasmStop();
  highlightSentence(null); // pause keeps the mark; ✕ clears it
  $("#playerbar")?.remove();
  $("#audioBtn")?.classList.remove("active");
  flush();
  pickEngine(); // a pack the pill downloaded mid-session takes effect now
}

// ---------- STREAM engine (ManagedMediaSource, Safari/iOS 17.1+) ----------
//
// One SourceBuffer("audio/mpeg", sequence mode); chunk mp3s are fetched and
// appended so playback is a single continuous timeline across chunk AND
// chapter boundaries. segs maps timeline spans back to (chapter, chunk,
// char range) for position sync. Playback behind currentTime is trimmed;
// a seek out of the buffered range rebuilds the stream at the target chunk.

export const stream = {
  el: null,          // the single audio element
  ms: null, sb: null,
  segs: [],          // appended spans: {ci, k, start, chars, t0, t1}
  pendingSeg: null,  // seg of the append currently in flight
  chunksBy: new Map(), // ci -> chunkChapter(text)
  feedCi: -1, feedK: 0, // next chunk to append
  fetching: false,
  pendingOpen: false, // chapter crossed while hidden; DOM catches up on show
  gen: 0,            // rebuild generation — stale async work checks this
  seekOff: -1,       // one-shot: land the playhead at this char offset once
                     // the first chunk's timeline span is known
};

const bufferedEnd = (sb) => (sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0);

function ensureStreamEl() {
  if (stream.el) return;
  const a = new Audio();
  a.preload = "auto";
  // ManagedMediaSource only engages with remote playback disabled — giving
  // up AirPlay for narration that survives the lock screen
  a.disableRemotePlayback = true;
  const msn = ("mediaSession" in navigator) ? navigator.mediaSession : null;
  a.addEventListener("playing", () => {
    player.playing = true; player.status = "";
    if (msn) msn.playbackState = "playing";
    slog("播放");
    updatePlayerBar();
  });
  a.addEventListener("pause", () => {
    player.playing = false;
    if (msn) msn.playbackState = "paused";
    slog("暫停");
    updatePlayerBar();
  });
  // 待料 = the timeline ran dry; 停滯 = the element gave up waiting for it
  a.addEventListener("waiting", () => { player.status = "loading"; slog("待料"); updatePlayerBar(); });
  a.addEventListener("stalled", () => slog("停滯"));
  a.addEventListener("timeupdate", onStreamTime);
  // the unlock silence (data: URI) also ends — only a real stream ending
  // means the whole book finished
  a.addEventListener("ended", () => { if (!a.currentSrc.startsWith("data:")) closePlayer(); });
  a.addEventListener("error", () => { player.playing = false; player.status = "error"; updatePlayerBar(); });
  // WebKit engages ManagedMediaSource on elements in the document (audio
  // without [controls] renders nothing, so this has no layout effect)
  document.body.append(a);
  stream.el = a;
}

function streamTeardown() {
  stream.gen++;
  if (stream.el) { stream.el.pause(); stream.el.removeAttribute("src"); stream.el.load(); }
  stream.ms = null;
  stream.sb = null;
  stream.segs = [];
  stream.pendingSeg = null;
  stream.chunksBy.clear();
  stream.fetching = false;
  stream.pendingOpen = false;
  stream.seekOff = -1;
}

function streamPlayFrom(ci, off) {
  const ch = state.manifest.chapters[ci];
  if (!ch) return closePlayer();
  const text = state.cache.get(ch.file);
  if (text === undefined) {
    player.status = "loading";
    updatePlayerBar();
    fetchChapter(ci)
      .then(() => { if (player.on) streamPlayFrom(ci, off); })
      .catch(() => { player.status = "error"; updatePlayerBar(); });
    return;
  }
  const chunks = ttsCore.chunkChapter(text);
  stream.chunksBy.set(ci, chunks);
  player.chapIdx = ci;
  player.chunks = chunks;
  const k = ttsCore.chunkIndexFor(chunks, off);
  startFloor = off;
  wlog(`start ci${ci} k${k} off${off} 線上串流`);
  hbStart();
  streamStart(ci, k, off);
}

// (re)build the MediaSource and start playing at chunk k of chapter ci;
// off > the chunk's start seeks into it once its timeline span is known
function streamStart(ci, k, off = -1) {
  const gen = ++stream.gen;
  ensureStreamEl();
  stream.sb = null;
  stream.segs = [];
  stream.pendingSeg = null;
  stream.fetching = false;
  stream.seekOff = off;
  stream.feedCi = ci;
  stream.feedK = k;
  player.chunkIdx = k;
  const ms = new MMS();
  stream.ms = ms;
  const url = URL.createObjectURL(ms);
  ms.addEventListener("sourceopen", () => {
    URL.revokeObjectURL(url);
    if (gen !== stream.gen) return;
    const sb = ms.addSourceBuffer("audio/mpeg");
    sb.mode = "sequence";
    sb.addEventListener("updateend", () => onStreamUpdateEnd(gen));
    stream.sb = sb;
    feedStream(gen);
  });
  // the managed source tells us when it wants data (incl. from lock screen)
  ms.addEventListener("startstreaming", () => { slog("要料"); feedStream(gen); });
  ms.addEventListener("endstreaming", () => slog("停料"));
  stream.el.src = url;
  player.status = "loading";
  stream.el.play().catch(() => { player.status = "error"; updatePlayerBar(); });
  updatePlayerBar();
  setMediaSession();
}

// append the next chunk when the buffer runs low; kicked by sourceopen,
// updateend, startstreaming, and timeupdate
async function feedStream(gen) {
  const { sb, ms, el } = stream;
  if (gen !== stream.gen || !sb || sb.updating || stream.fetching) return;
  trimStream();
  if (sb.updating) return; // trim in progress; updateend re-kicks
  const ahead = bufferedEnd(sb) - el.currentTime;
  if (ahead > 150 || (ms.streaming === false && ahead > 45)) return;
  const next = nextFeedChunk(gen);
  if (next === "pending") return; // chapter text loading; re-kicked on arrival
  if (next === null) {
    // book finished: close the stream so `ended` can fire
    if (ms.readyState === "open") { try { ms.endOfStream(); } catch { /* mid-update */ } }
    return;
  }
  stream.fetching = true;
  try {
    const file = state.manifest.chapters[next.ci].file;
    const res = await fetch(ttsUrl(file, next.k));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (gen !== stream.gen) return;
    stream.pendingSeg = { ci: next.ci, k: next.k, start: next.chunk.start, chars: next.chunk.chars };
    stream.sb.appendBuffer(buf);
    stream.feedCi = next.ci;
    stream.feedK = next.k + 1;
  } catch (e) {
    if (gen !== stream.gen) return;
    // 線上為預設、離線為備援: the network is gone — a fetch that got no answer
    // (TypeError), not a bad one (HTTP) — and the pack is here: hand the
    // reading over while the buffer still has something in it, rather than
    // retrying every 4 s into silence. wasmPlayFrom ends this timeline and
    // opens the offline one on the same element
    if (packOk && player.on && (!navigator.onLine || e instanceof TypeError)
        && bufferedEnd(stream.sb) - stream.el.currentTime < 30) {
      wlog(`線上斷 ${e?.message ?? e} → 離線引擎`);
      wasmOn = true;
      wasmPlayFrom(state.idx, state.off);
      flashStatus(t("player.fellBack", t("player.engOffline")));
      return;
    }
    // synthesis hiccup: only alarm the user if we're about to run dry
    if (bufferedEnd(stream.sb) - stream.el.currentTime < 10) {
      player.status = "error";
      updatePlayerBar();
    }
    setTimeout(() => feedStream(gen), 4000);
  } finally {
    // never clear a NEWER generation's flag: a rebuild mid-fetch starts its
    // own fetch, and this stale one must not unlock a concurrent append
    if (gen === stream.gen) stream.fetching = false;
  }
}

// next chunk to append, rolling into the following chapter (fetching its
// text on demand) — {ci, k, chunk}, "pending" while text loads, null at end
function nextFeedChunk(gen) {
  let ci = stream.feedCi, k = stream.feedK;
  let chunks = stream.chunksBy.get(ci);
  if (!chunks) return "pending";
  if (k >= chunks.length) {
    ci += 1;
    k = 0;
    if (ci >= state.manifest.chapters.length) return null;
    chunks = stream.chunksBy.get(ci);
    if (!chunks) {
      fetchChapter(ci)
        .then((text) => {
          if (gen !== stream.gen) return;
          stream.chunksBy.set(ci, ttsCore.chunkChapter(text));
          for (const old of stream.chunksBy.keys()) if (old < ci - 1) stream.chunksBy.delete(old);
          feedStream(gen);
        })
        .catch(() => setTimeout(() => { if (gen === stream.gen) feedStream(gen); }, 4000));
      return "pending";
    }
  }
  return { ci, k, chunk: chunks[k] };
}

function onStreamUpdateEnd(gen) {
  if (gen !== stream.gen || !stream.sb) return;
  const seg = stream.pendingSeg;
  if (seg) {
    stream.pendingSeg = null;
    const t1 = bufferedEnd(stream.sb);
    const t0 = stream.segs.length ? stream.segs[stream.segs.length - 1].t1 : 0;
    stream.segs.push({ ...seg, t0, t1 });
    // a reading started mid-chunk: land the playhead inside the first
    // appended chunk with the same proportional map onStreamTime reads by
    if (stream.seekOff >= 0) {
      const off = stream.seekOff;
      stream.seekOff = -1;
      if (off > seg.start && seg.chars > 0)
        stream.el.currentTime = t0 + Math.min(1, (off - seg.start) / seg.chars) * (t1 - t0);
    }
  }
  feedStream(gen);
}

// keep ~30 s of already-heard audio, drop the rest so hours of listening
// can't hit the SourceBuffer quota (times don't shift on remove)
function trimStream() {
  const { sb, el } = stream;
  if (!sb || sb.updating || !sb.buffered.length) return;
  const start = sb.buffered.start(0);
  const cut = el.currentTime - 30;
  if (cut - start < 60) return; // trim in ~minute steps, not every pass
  try { sb.remove(start, cut); } catch { /* next pass */ }
  stream.segs = stream.segs.filter((s) => s.t1 > cut);
}

function onStreamTime() {
  if (!player.on) return;
  feedStream(stream.gen);
  if (!player.playing || !stream.segs.length) return;
  const now = stream.el.currentTime;
  const seg = stream.segs.find((s) => now >= s.t0 && now < s.t1) ?? stream.segs[stream.segs.length - 1];
  const frac = Math.min(1, Math.max(0, (now - seg.t0) / (seg.t1 - seg.t0 || 1)));
  const off = Math.min(seg.start + Math.floor(frac * seg.chars), seg.start + seg.chars - 1);

  // pre-roll: the snapped-back sentence before the requested start — hold
  // the page and the bookmark until narration reaches the request
  if (startFloor >= 0) {
    if (off < startFloor) return;
    startFloor = -1;
  }

  const chapterCrossed = seg.ci !== player.chapIdx;
  if (chapterCrossed) {
    player.chapIdx = seg.ci;
    player.chunks = stream.chunksBy.get(seg.ci) ?? player.chunks;
  }
  if (player.chunkIdx !== seg.k) { player.chunkIdx = seg.k; updatePlayerBar(); }
  if (chapterCrossed) setMediaSession();

  if (seg.ci !== state.idx) {
    if (document.visibilityState === "hidden") {
      // screen off: keep position sync truthful without touching the DOM;
      // the visible chapter catches up on the next visibilitychange
      state.idx = seg.ci;
      state.off = off;
      stream.pendingOpen = true;
      savePos("player");
      return;
    }
    stream.pendingOpen = false;
    openChapter(seg.ci, off).then(() => flush());
    return;
  }
  if (off === state.off) return;
  state.off = off;
  updateProgress();
  savePos("player");
  markSpoken(off);
  if (Date.now() - lastUserScroll() > 5000) followScroll(off);
}

// ⏮/⏭: seek within the buffered timeline when the target chunk is still
// there, rebuild the stream at that chunk otherwise
function streamAdvanceChunk(d) {
  const k = player.chunkIdx + d;
  if (k >= 0 && k < player.chunks.length) {
    const seg = stream.segs.find((s) => s.ci === player.chapIdx && s.k === k);
    if (seg && stream.el) {
      stream.el.currentTime = seg.t0 + 0.01;
      stream.el.play().catch(() => { /* already playing or blocked; bar shows state */ });
      return;
    }
    player.chunks = stream.chunksBy.get(player.chapIdx) ?? player.chunks;
    return streamStart(player.chapIdx, k);
  }
  const ci = player.chapIdx + (d < 0 ? -1 : 1);
  if (ci < 0 || ci >= state.manifest.chapters.length) return closePlayer();
  streamPlayFrom(ci, 0);
}

// ---------- WASM engine (offline matcha — wasmtts's producer + player) ----------
//
// The offline reading rides wasmtts's own transport: matcha-producer.mjs
// turns chapter text into sentence-sized mp3 units, each tagged with the raw
// char span it speaks and the chapter it came from; continuous-stream-player
// appends them to ONE MediaSource timeline on the reader's one blessed
// element and keeps the lock-screen rules — the heartbeat watchdog (nudge,
// then rebuild at the current unit), the 5-minute chain death (only pause()
// is a user pause; a system pause is "suspended" and auto-resumes on
// return), Media Session — that were found on this app's phone and moved
// upstream so they are tested there (the ledger: DESIGN.md → TTS). What
// stays here is the reader's side of the contract: chapter text → sentence
// spans (ttsPrompt on each prompt, offsets kept raw), the next chapter when
// one runs out (`more`) and a chapter again when the player rebuilds in one
// the producer has left (`restore`), the timeline position → (chapter,
// char) → bookmark, highlight and page-follow, ⏮/⏭ at chunk grain, and the
// engine fallbacks.

export const wasm = {
  gen: 0,             // session generation — stale async work checks this
  player: null,       // the upstream player, made once on the reader's element
  pendingOpen: false, // chapter crossed while hidden; DOM catches up on show
  lastStatus: "",     // the upstream status last mirrored into the bar
  primed: null,       // {ci, sentence}: the unit synthesized ahead of ▶ (wasmPrime)
};

// ---- flight recorder ----------------------------------------------------
// Background/lock behaviour only exists on the phone and the phone has no
// console: while a listening session runs, mirror the /wasmtest timeline into
// /api/testlog (page=player) — unit synth ×N, play()/播畢 with visibility,
// media-element transitions, queue depth heartbeat. A log that stops mid-line
// with no error is itself the diagnosis (iOS killed or suspended the page).
// Read back with /api/testlog?page=player.
//
// Both stream engines record, not just the wasm one: they share the element
// and the MediaSource discipline, so "the online engine did the same thing" is
// what separates a platform rule from an engine bug — and there is no other
// way to find that out from an iPhone.
const wlog = (() => {
  let buf = [], timer = 0, t0 = 0, device = "";
  try { device = localStorage.getItem("bw_uid") ?? ""; } catch { /* private mode */ }
  const flush = () => {
    timer = 0;
    if (!buf.length) return;
    const body = JSON.stringify({ page: "player", device, data: buf.join("\n") });
    buf = [];
    try {
      if (!navigator.sendBeacon?.("/api/testlog", new Blob([body], { type: "application/json" })))
        fetch("/api/testlog", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
    } catch { /* offline is fine */ }
  };
  document.addEventListener("visibilitychange", () => {
    if (!t0) return; // never used — stay silent
    line("vis=" + document.visibilityState);
    if (document.visibilityState === "hidden") { clearTimeout(timer); flush(); }
  });
  addEventListener("pagehide", () => { if (t0) { clearTimeout(timer); flush(); } });
  function line(s) {
    if (!t0) t0 = performance.now();
    buf.push(((performance.now() - t0) / 1000).toFixed(1) + "s " + s);
    if (!timer) timer = setTimeout(flush, 1500);
  }
  return line;
})();

// One line of media-element truth, for exactly the lock-screen/background
// question: of "iOS paused us", "the timeline ran dry" and "the page was
// frozen", which actually happened. The third has no event to listen for — it
// shows as a GAP in the recorder's own clock — which is why the dull lines earn
// their place as much as the alarming ones. 段 is the buffered range count: a
// timeline the media stack purged under us looks different from one we simply
// stopped feeding.
function slog(what) {
  if (!player.on) return; // teardown pauses the element; that is not news
  const a = stream.el;
  const ahead = stream.sb && a ? Math.max(0, bufferedEnd(stream.sb) - a.currentTime) : 0;
  wlog(`${what} @${(a?.currentTime ?? 0).toFixed(0)}s 緩${ahead.toFixed(0)}s 段${stream.sb?.buffered.length ?? 0}`
    + ` vis=${document.visibilityState}`
    + (stream.ms && "streaming" in stream.ms ? ` 串${stream.ms.streaming}` : ""));
}

// The ONLINE timeline's watchdog. The offline engine's heartbeat, nudge and
// rebuild live in wasmtts's player now (the rule below was the finding it
// was built from) — hbStart stands down under it, or the log would beat twice.
let hb = 0, hbCt = -1, hbStuck = 0;
function hbStart() {
  if (hb || useWasm()) return;
  hbCt = -1;
  hbStuck = 0;
  hb = setInterval(() => {
    if (!player.on || useWasm()) { clearInterval(hb); hb = 0; return; }
    const onStream = !!stream.ms;
    const played = onStream && player.playing && stream.el ? `@${stream.el.currentTime.toFixed(0)}s` : "無";
    const buffered = onStream && stream.sb && stream.el
      ? `緩${Math.max(0, bufferedEnd(stream.sb) - stream.el.currentTime).toFixed(0)}s ` : "";
    wlog(`♥ vis=${document.visibilityState} 播=${played} ${buffered}`);

    // Stall watchdog. Measured on device (2026-08-08, iOS 18.7): a lock-screen
    // pause/resume cycle can leave the element claiming "playing" with
    // currentTime frozen and 90 s buffered — for minutes, surviving further
    // pause/play cycles and visibility changes. Ran-dry is not this (it has no
    // buffer ahead, and 待料 already names it); pause is not this. Two beats
    // stuck = ~20 s: nudge the pipeline with a micro-seek first, rebuild the
    // stream at the narration position if the nudge moved nothing.
    const ct = onStream && stream.el ? stream.el.currentTime : -1;
    const ahead = onStream && stream.sb ? bufferedEnd(stream.sb) - ct : 0;
    if (player.playing && ct >= 0 && !stream.el.paused && Math.abs(ct - hbCt) < 0.05 && ahead > 2) {
      if (++hbStuck === 1) {
        wlog(`卡死 @${ct.toFixed(1)}s 緩${ahead.toFixed(0)}s — 推一下`);
        stream.el.currentTime = ct + 0.01;
        stream.el.play().catch(() => { /* bar shows state */ });
      } else {
        wlog(`卡死未解 — 重建 ci${state.idx} off${state.off}`);
        hbStuck = 0;
        streamPlayFrom(state.idx, state.off);
      }
    } else hbStuck = 0;
    hbCt = ct;
  }, 10000);
}

// A chapter's sentences for the producer: upstream's walk on the RAW text,
// so meta.start/end are the reader's own offsets (the ones p[data-off] and
// the highlight use); each sentence's prompt is cleaned by ttsPrompt the way
// the online engines' chunks are (layout whitespace → 「，」 between Han).
function chapterSegments(ci, text) {
  return wasmTts.sentenceSpans(text)
    .map((s) => ({ text: ttsCore.ttsPrompt(s.text), start: s.start, end: s.end, tag: ci }));
}

function wasmStop() {
  wasm.gen++;
  wasm.player?.stop();
  wasm.pendingOpen = false;
  wasm.lastStatus = "";
  wasm.primed = null;
}

// The sentence ▶ would start on (the page on screen — togglePlayer's
// offset, not the sticky bookmark), synthesized before the tap (upstream
// prime): on a warm engine the first sound then lands with the tap instead
// of ~0.6 s after it. Runs when the reader lands on a chapter or turns a
// page with the offline engine picked and no session open; nothing on a
// cold engine (see engineWarm) and nothing without the chapter text. A ▶
// elsewhere just voids it.
async function wasmPrime() {
  if (!wasmOn || player.on || !wasmTts.engineWarm() || !state?.manifest) return;
  const ci = state.idx, off = pageStartOffset?.() ?? state.off;
  const text = state.cache.get(state.manifest.chapters[ci]?.file);
  if (text === undefined) return;
  const p = wasmTts.ensureProducer();
  if (wasm.primed?.ci === ci && p.tag === ci && wasmTts.chunkIndexFor(p.segments, off) === wasm.primed.sentence) return;
  p.setSegments(chapterSegments(ci, text), { tag: ci });
  const sentence = wasmTts.chunkIndexFor(p.segments, off);
  wasm.primed = { ci, sentence };
  try {
    const m = await p.prime({ offset: off });
    if (m && wasm.primed?.ci === ci) wlog(`預熱 ci${ci} 句${sentence} ${Math.round(m.phases?.totalMs ?? 0)}ms`);
  } catch (e) {
    if (wasm.primed?.ci === ci) wasm.primed = null;
    wlog(`預熱失敗 ${e?.message ?? e}`);
  }
}

// Start (or restart) the offline reading of chapter ci at char offset off.
// Synchronous when the chapter text is loaded, so the player's one play()
// stays inside the user's tap; the engine comes up alongside (from the cache
// — packReady is what put the reader here) and audio lands when the first
// unit is appended.
function wasmPlayFrom(ci, off) {
  const gen = ++wasm.gen;
  wasm.player?.stop();
  streamTeardown(); // an online timeline on the same element, if one is open
  wasm.pendingOpen = false;
  wasm.lastStatus = "";
  const ch = state.manifest.chapters[ci];
  if (!ch) return closePlayer();
  const text = state.cache.get(ch.file);
  if (text === undefined) {
    player.status = "loading";
    updatePlayerBar();
    fetchChapter(ci)
      .then(() => { if (player.on && gen === wasm.gen) wasmPlayFrom(ci, off); })
      .catch(() => { player.status = "error"; updatePlayerBar(); });
    return;
  }
  const chunks = ttsCore.chunkChapter(text);
  player.chapIdx = ci;
  player.chunks = chunks;
  player.chunkIdx = ttsCore.chunkIndexFor(chunks, off);
  startFloor = off;
  player.status = "loading"; // first audio lands when unit 1 is synthesized
  updatePlayerBar();
  setMediaSession();
  wlog(`start ci${ci} k${player.chunkIdx} off${off} wasmtts`);

  const p = wasmTts.ensureProducer();
  // the primed unit stands when ▶ lands in its sentence — setSegments/seekTo
  // would void it; otherwise only the sentence holding the request, not the
  // chunk from its start
  const primed = wasm.primed?.ci === ci && p.tag === ci && wasmTts.chunkIndexFor(p.segments, off) === wasm.primed.sentence;
  if (!primed) {
    p.setSegments(chapterSegments(ci, text), { tag: ci });
    p.seekTo(off);
  }
  wlog(primed ? "預熱單位直接上" : "無預熱");
  wasm.primed = null;
  // the next chapter when this one's sentences run out — fetched on demand;
  // null at the book's end, which ends the timeline (`ended` closes the player)
  const segmentsOf = async (ci) => {
    if (!player.on || gen !== wasm.gen || ci < 0 || ci >= state.manifest.chapters.length) return null;
    const t = state.cache.get(state.manifest.chapters[ci].file) ?? await fetchChapter(ci);
    return gen === wasm.gen ? { segments: chapterSegments(ci, t), tag: ci } : null;
  };
  wasmTts.setMore(({ tag }) => segmentsOf(tag + 1));
  // a chapter the producer has already left, when the player must rebuild
  // its timeline there: ⏮ back across a boundary, or the watchdog striking
  // inside the 90 s the producer runs ahead of the voice
  wasmTts.setRestore((tag) => segmentsOf(tag));
  ensureStreamEl();
  wasm.player ??= createContinuousStreamPlayer({
    audio: stream.el,
    producer: p,
    // play/pause the player installs itself; ⏮/⏭ are this reader's (chunk grain)
    mediaSession: { handlers: { previoustrack: () => advanceChunk(-1), nexttrack: () => advanceChunk(1) } },
    onUpdate: onWasmUpdate,
    onSegment: onWasmSegment,
    onStall: (e) => wlog(`看門狗 ${e.phase} @${Math.round(e.playhead ?? 0)}s`),
    onLog: ({ code, message, detail }) =>
      wlog(`[${code}] ${message}${detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`),
  });
  wasm.player.start().catch((e) => {
    if (gen !== wasm.gen) return;
    wlog(`stream play() 拒 ${e?.name} vis=${document.visibilityState}`);
    player.status = "error";
    updatePlayerBar();
  });
  wasmTts.ensureEngine().then(() => {
    const i = wasmTts.engineInfo;
    if (gen === wasm.gen) wlog(`引擎 ${i.tag} ${i.threads}緒 詞典${i.lexiconSize} 規則表${i.rules} 規則${i.contextualRules}`);
  }).catch((e) => wasmFallback(gen, `引擎失敗 ${e?.message ?? e}`));
}

// The online engine takes over: end this timeline first, then open the
// other one at the voice's position. Only an engine that cannot come up (or
// a worker that died) gets here — a sentence the engine cannot read is
// skipped by the producer and its span folded into the next unit.
function wasmFallback(gen, why) {
  if (gen !== wasm.gen || !player.on || !navigator.onLine) return;
  console.warn("wasm-tts unavailable, falling back:", why);
  wlog(`${why} → 回線上引擎`);
  wasmStop();
  wasmOn = false;
  playFrom(state.idx, state.off);
  flashStatus(t("player.fellBack", t("player.engOnline")));
}
wasmTts.onEngineEvent((e) => {
  if (e.type === "error" && e.action === "worker" && useWasm()) wasmFallback(wasm.gen, `worker ${e.message}`);
});

// upstream's status → the bar; the playhead → the reader's position. Fires on
// every timeupdate and feed; the snapshot says whether it is even ours. The
// producer running dry is `snap.drained`, not a status: `playing` holds
// until the element itself ends (the whole book is synthesized up to 90 s
// before the voice gets there), and the reader's `ended` listener on the
// element is what closes the session.
function onWasmUpdate(snap) {
  if (!useWasm() || !player.on || !snap.active) return;
  const playing = snap.status === "playing";
  const status = snap.status === "opening" || snap.status === "buffering" ? "loading"
    : snap.status === "error" ? "error" : "";
  const shown = `${snap.status}/${playing}`;
  if (shown !== wasm.lastStatus) {
    wasm.lastStatus = shown;
    player.playing = playing;
    player.status = status;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    updatePlayerBar();
  }
  if (!playing || !snap.currentSegment) return;
  const seg = snap.currentSegment;
  const m = seg.meta;
  if (!m || m.start === undefined) return;
  // proportional inside the unit — a sentence is a few seconds, so this is
  // finer than the online engines' chunk map
  const frac = Math.min(1, Math.max(0, (snap.currentTime - seg.start) / (seg.end - seg.start || 1)));
  const off = Math.min(m.start + Math.floor(frac * (m.end - m.start)), Math.max(m.start, m.end - 1));
  wasmPosition(m.tag, off);
}

// each new unit under the voice: the chunk label follows (⏮/⏭ move on chunks)
function onWasmSegment(seg) {
  const m = seg?.meta;
  if (!useWasm() || !player.on || m?.tag !== player.chapIdx) return;
  const k = ttsCore.chunkIndexFor(player.chunks, m.start);
  if (k !== player.chunkIdx) { player.chunkIdx = k; updatePlayerBar(); }
}

// The narration's position → the reader: the pre-roll floor, a chapter
// crossing (hidden: bookkeeping only; visible: open the chapter), then the
// bookmark, the highlight and the page-follow — the online timeline's
// discipline (onStreamTime), on upstream's units.
function wasmPosition(ci, off) {
  if (startFloor >= 0) {
    if (ci === player.chapIdx && off < startFloor) return;
    startFloor = -1;
  }
  if (ci !== player.chapIdx) {
    player.chapIdx = ci;
    const text = state.cache.get(state.manifest.chapters[ci]?.file);
    player.chunks = text !== undefined ? ttsCore.chunkChapter(text) : [];
    player.chunkIdx = ttsCore.chunkIndexFor(player.chunks, off);
    setMediaSession();
    updatePlayerBar();
  }
  if (ci !== state.idx) {
    if (document.visibilityState === "hidden") {
      // screen off: keep position sync truthful without touching the DOM;
      // the visible chapter catches up on the next visibilitychange
      state.idx = ci;
      state.off = off;
      wasm.pendingOpen = true;
      savePos("player");
      return;
    }
    wasm.pendingOpen = false;
    openChapter(ci, off).then(() => flush());
    return;
  }
  if (off === state.off) return;
  state.off = off;
  updateProgress();
  savePos("player");
  markSpoken(off);
  if (Date.now() - lastUserScroll() > 5000) followScroll(off);
}

// resume/retry — ▶ in error state and the chain engine's visible retry
function wasmReplay() {
  wasm.player?.resume().catch(() => { /* bar shows state */ });
}

// ⏮/⏭ at chunk grain, like the online engines: the target chunk's first
// sentence. On the timeline (upstream segments(): every unit still in the
// buffer, the previous chapter's included) → the player seeks, or rebuilds
// at that (chapter, sentence) when the audio is gone — asking the producer
// to restore the chapter if `more` has moved it on; not on the timeline
// (ahead of the synthesis, or a chapter never played) → start there.
function wasmSkip(d) {
  const k = player.chunkIdx + d;
  let ci = player.chapIdx, target;
  if (k >= 0 && k < player.chunks.length) target = player.chunks[k].start;
  else {
    ci += d < 0 ? -1 : 1;
    if (ci < 0 || ci >= state.manifest.chapters.length) return closePlayer();
    target = 0;
  }
  const segs = wasm.player?.segments() ?? [];
  const seg = segs.find((s) => s.meta?.tag === ci && s.meta.start <= target && target < s.meta.end)
    ?? segs.find((s) => s.meta?.tag === ci && s.meta.start >= target);
  if (seg) {
    startFloor = -1;
    wasm.player.seekToSegment(seg.index).catch(() => wasmPlayFrom(ci, target));
    return;
  }
  wasmPlayFrom(ci, target);
}

// ---------- player bar / MediaSession ----------

function buildPlayerBar() {
  $("#playerbar")?.remove();
  document.body.append(
    el("div", { id: "playerbar", class: "playerbar" },
      el("button", { class: "iconbtn", id: "ppBtn", title: t("player.playPause"), onclick: playerPlayPause }, "⏸"),
      // ids, not titles, are what the e2e suites click (titles follow the UI language)
      el("button", { class: "iconbtn", id: "backBtn", title: t("player.back"), onclick: () => advanceChunk(-1) }, "⏮"),
      el("button", { class: "iconbtn", id: "fwdBtn", title: t("player.forward"), onclick: () => advanceChunk(1) }, "⏭"),
      el("button", { class: "iconbtn", id: "reportBtn", title: t("player.report"), onclick: reportHere }, "🚩"),
      el("button", { class: "iconbtn engbtn", id: "engBtn", onclick: toggleTtsPref }, ""),
      el("div", { class: "player-status", id: "playerStatus" }, ""),
      el("button", { class: "iconbtn", title: t("player.stop"), onclick: closePlayer }, "✕")),
  );
  updatePlayerBar();
}

// 🚩 — "this bit sounded wrong", one tap, mid-listening (owner request,
// 2026-08-15). Files book/chapter/offset/engine AND the sentence under the
// voice right now — the same walk markSpoken paints, so the ticket names
// exactly the marked span — to /api/testlog page=report. Once the session
// moves on that sentence is unrecoverable, which is the whole point of the
// button. testlog and not the 改進建議 queue because the reader page holds
// the bw_tlog cookie; the admin Bearer never leaves /admin. A plain fetch,
// not wlog: the tap deserves an ack, and the flight recorder's batching
// would eat both the ack and (on the online engines) the line itself.
async function reportHere() {
  const c = player.chunks[ttsCore.chunkIndexFor(player.chunks, state.off)];
  let sentence = "";
  if (c) {
    const i = Math.max(0, Math.min(state.off - c.start, c.chars - 1));
    sentence = c.text
      .slice(ttsCore.sentenceStartFor(c.text, i), ttsCore.sentenceEndFor(c.text, i))
      .trim().slice(0, 160);
  }
  const engine = useWasm() ? "wasm" : stream.ms ? "stream" : "chain";
  const title = state.manifest?.chapters?.[player.chapIdx]?.title ?? "";
  let device = "";
  try { device = localStorage.getItem("bw_uid") ?? ""; } catch { /* private mode */ }
  const data = `🚩 ${state.manifest?.title ?? state.id} ch${player.chapIdx}`
    + `${title ? `〈${title}〉` : ""} off${state.off} 引擎=${engine} 句=「${sentence}」`;
  try {
    const res = await fetch("/api/testlog", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "report", device, data }),
    });
    flashStatus(res.ok ? t("player.reported") : t("player.reportFail"));
  } catch {
    flashStatus(t("player.reportFail"));
  }
}

// Park a transient message where the chunk counter sits; the next real
// repaint (or the timer) takes the bar back.
let statusFlash = 0;
function flashStatus(msg) {
  const s = $("#playerStatus");
  if (!s) return;
  s.textContent = msg;
  clearTimeout(statusFlash);
  statusFlash = setTimeout(updatePlayerBar, 2500);
}

function updatePlayerBar() {
  if (!$("#playerbar")) return;
  $("#ppBtn").textContent = player.playing ? "⏸" : "▶";
  let label = "";
  if (player.status === "loading") label = t("player.generating");
  else if (player.status === "error") label = t("player.error");
  else if (player.chunks.length && player.chunkIdx >= 0)
    label = t("player.chunk", player.chunkIdx + 1, player.chunks.length);
  $("#playerStatus").textContent = label;
  // the engine button names the engine RUNNING; the title names the default.
  // They differ exactly when a fallback is in effect (.fallback, accent)
  const eb = $("#engBtn");
  if (eb) {
    const active = useWasm() ? "offline" : "online";
    const name = (e) => t(e === "offline" ? "player.engOffline" : "player.engOnline");
    eb.textContent = name(active);
    eb.dataset.engine = active;
    eb.title = t("player.engine", name(ttsPref()));
    eb.classList.toggle("fallback", active !== ttsPref());
  }
}

// Paint the sentence containing the char the voice is on. Bounds come from
// the chunk's own text via the shared ENDERS/CLOSERS walk, so the mark and
// the audio can never disagree about where a sentence is. A force-split
// run-on sentence has no ender inside its chunk, so its whole chunk-sized
// piece marks — exactly the span being spoken.
function markSpoken(off) {
  const c = player.chunks[ttsCore.chunkIndexFor(player.chunks, off)];
  if (!c) return;
  const i = Math.max(0, Math.min(off - c.start, c.chars - 1));
  let a = ttsCore.sentenceStartFor(c.text, i);
  const b = ttsCore.sentenceEndFor(c.text, i);
  // a paragraph's first sentence begins right after the previous \n — on the
  // 段首 indent, which the rendered paragraph does not hold (data-off starts
  // at ink). Advance to ink so the wash maps onto the trimmed node; a span
  // that is ALL whitespace (the tick between lines) keeps the current mark.
  while (a < b && !c.text[a].trim()) a++;
  if (a >= b) return;
  highlightSentence(c.start + a, c.start + b);
}

function onAudioTime() {
  if (!player.playing || player.chapIdx !== state.idx) return;
  const c = player.chunks[player.chunkIdx];
  if (!c) return;
  // proportional to the real clip length when known (exact at chunk edges);
  // the measured chars/sec constant is only the pre-metadata fallback
  const dur = player.audio.duration;
  const spoken = Number.isFinite(dur) && dur > 0
    ? (player.audio.currentTime / dur) * c.chars
    : player.audio.currentTime * ttsCore.CHARS_PER_SEC;
  const off = Math.min(c.start + Math.floor(spoken), c.start + c.chars - 1);
  // pre-roll before the requested start: hold the page and the bookmark
  if (startFloor >= 0) {
    if (off < startFloor) return;
    startFloor = -1;
  }
  if (off === state.off) return;
  state.off = off;
  updateProgress();
  savePos("player");
  markSpoken(off);
  // follow the narration unless the user scrolled away recently
  if (Date.now() - lastUserScroll() > 5000) followScroll(off);
}

function setMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.metadata = new MediaMetadata({
    title: state.manifest.chapters[player.chapIdx]?.title ?? "",
    artist: state.manifest.title,
    album: "Bookworm",
  });
  ms.setActionHandler("play", playerPlayPause);
  ms.setActionHandler("pause", playerPlayPause);
  ms.setActionHandler("previoustrack", () => advanceChunk(-1));
  ms.setActionHandler("nexttrack", () => advanceChunk(1));
}

// debug handle: e2e assertions and the remote-inspector device pass
globalThis.bwPlayer = { player, stream, wasm, useStream, useWasm, ttsPref };
