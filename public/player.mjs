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
// - WASM (offline, wasm-tts.mjs): in-browser Matcha zh-en — no network after
//   the one-time voice pack download. Selected automatically when the pack is
//   in the cache (downloaded by /wasmtest, never by the reader — ▶ must
//   not quietly pull 137 MB over cellular); localStorage bw_tts="stream"
//   forces the online engines back. Playback rides the SAME MediaSource
//   discipline as STREAM: the synth worker encodes each unit to mp3 and
//   the units are appended to one continuous timeline. The chain-swap
//   variant died on the phone after ~5 min locked — a play() at a unit
//   boundary just never settled (no resolve, no reject): iOS quietly
//   withdraws the new-element entitlement, exactly the lesson the STREAM
//   engine encodes. Blob-WAV chain remains only for browsers with no MSE.

import * as ttsCore from "/tts-core.mjs";
import * as wasmTts from "/wasm-tts.mjs";

const MMS = globalThis.ManagedMediaSource;
export const useStream = !!MMS?.isTypeSupported?.("audio/mpeg");
// the wasm engine can ride plain MediaSource too (desktop Chrome — which
// also makes the phone's exact playback path testable headless)
const LocalMS = MMS ?? globalThis.MediaSource;
const wasmStreamOk = !!LocalMS?.isTypeSupported?.("audio/mpeg");
let wasmOn = false;
const useWasm = () => wasmOn;
wasmTts.packReady().then((r) => {
  wasmOn = r && localStorage.getItem("bw_tts") !== "stream";
  console.log(`bookworm tts engine: ${wasmOn ? "wasm (offline matcha)" : useStream ? "stream (ManagedMediaSource)" : "chain"}`);
});

// reader internals, injected once by app.js
let $, el, state, fetchChapter, openChapter, savePos, flush, updateProgress,
  followScroll, lastUserScroll;

export function init(deps) {
  if ($) return; // both load paths in app.js may race; first wins
  ({ $, el, state, fetchChapter, openChapter, savePos, flush,
    updateProgress, followScroll, lastUserScroll } = deps);
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
};

function ttsUrl(file, idx) {
  const v = state.manifest?.generatedAt ?? "0";
  return `/api/tts/${encodeURIComponent(state.id)}/${encodeURIComponent(file)}/${idx}?v=${encodeURIComponent(v)}`;
}

export function togglePlayer() {
  if (player.on) return closePlayer();
  player.on = true;
  $("#audioBtn")?.classList.add("active");
  // bless the element(s) inside this tap: iOS only lets an element play()
  // outside a gesture (chunk swaps happen on `ended`) after it has played
  // within one — a beat of silence counts
  if (useWasm() ? wasmStreamOk : useStream) {
    ensureStreamEl();
    unlockAudio(stream.el);
  } else {
    ensureAudio();
    unlockAudio(player.audio);
    unlockAudio(player.standby);
  }
  buildPlayerBar();
  playFrom(state.idx, state.off);
}

// called by openChapter: navigating while listening moves the narration too
// (chapter auto-advance restarts playback itself, so only manual jumps land
// here — advance paths set chapIdx before opening the chapter)
export function chapterOpened(i, offset) {
  if (player.on && player.playing && i !== player.chapIdx) playFrom(i, offset);
}

// called on visibilitychange→visible: show the chapter the narration
// crossed into while the screen was off
export function visibleCatchup() {
  if ((stream.pendingOpen || wasm.pendingOpen) && player.on) {
    stream.pendingOpen = false;
    wasm.pendingOpen = false;
    openChapter(state.idx, state.off);
  }
  // a play() the lock screen left PENDING forever (neither resolved nor
  // rejected — the 5-minute chain death) re-arms nothing; kick playback
  // when the user comes back, unless they paused on purpose
  if (useWasm() && player.on && !player.playing && !wasm.userPaused
    && (stream.local || wasm.queue.length)) {
    wlog("visible 恢復踢");
    wasmReplay();
  }
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
    // a pause that is not the unit finishing = someone (iOS?) stopped us
    if (useWasm() && !a.ended && a.currentSrc.startsWith("blob:"))
      wlog(`句${wasm.nextPlay} 暫停 @${a.currentTime.toFixed(1)}/${(a.duration || 0).toFixed(1)}s vis=${document.visibilityState}`);
    player.playing = false;
    if (msn) msn.playbackState = "paused";
    updatePlayerBar();
  }));
  a.addEventListener("waiting", active(() => { player.status = "loading"; updatePlayerBar(); }));
  a.addEventListener("timeupdate", active(onAudioTime));
  // the unlock silence also ends — it must not advance the narration
  a.addEventListener("ended", active(() => {
    if (a.currentSrc.startsWith("data:")) return;
    if (useWasm()) {
      wlog(`句${wasm.nextPlay} 播畢 vis=${document.visibilityState}`);
      wasm.active = false;
      wasm.wake?.(); // synthesis may be sleeping on backpressure — refill now
      wasmTrim();
      wasmPump();
      return;
    }
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
  const a = (useWasm() ? wasmStreamOk : useStream) ? stream.el : player.audio;
  if (player.playing) {
    if (useWasm()) { wasm.userPaused = true; wlog("使用者暫停"); }
    a?.pause();
    flush();
    return;
  }
  wasm.userPaused = false;
  if (player.status === "error") {
    if (useWasm()) return wasmReplay();
    return useStream ? streamPlayFrom(state.idx, state.off) : playChunk(Math.max(0, player.chunkIdx));
  }
  if (useWasm() || useStream || (player.chapIdx === state.idx && player.chunkIdx >= 0))
    a?.play().catch(() => { player.status = "error"; updatePlayerBar(); });
  else playFrom(state.idx, state.off);
}

export function closePlayer() {
  if (useWasm() && wasm.queue.length) wlog("關閉");
  player.on = false;
  player.playing = false;
  player.chapIdx = -1;
  player.chunkIdx = -1;
  player.chunks = [];
  player.nextUrl = null;
  for (const a of [player.audio, player.standby])
    if (a) { a.pause(); a.removeAttribute("src"); }
  streamTeardown();
  wasmTeardown();
  $("#playerbar")?.remove();
  $("#audioBtn")?.classList.remove("active");
  flush();
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
  local: false,      // fed by the wasm engine's mp3 units, not /api/tts
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
    updatePlayerBar();
  });
  a.addEventListener("pause", () => {
    player.playing = false;
    if (msn) msn.playbackState = "paused";
    updatePlayerBar();
  });
  a.addEventListener("waiting", () => { player.status = "loading"; updatePlayerBar(); });
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
  stream.local = false;
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
  streamStart(ci, ttsCore.chunkIndexFor(chunks, off));
}

// (re)build the MediaSource and start playing at chunk k of chapter ci
function streamStart(ci, k) {
  const gen = ++stream.gen;
  stream.local = false;
  ensureStreamEl();
  stream.sb = null;
  stream.segs = [];
  stream.pendingSeg = null;
  stream.fetching = false;
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
  ms.addEventListener("startstreaming", () => feedStream(gen));
  stream.el.src = url;
  player.status = "loading";
  stream.el.play().catch(() => { player.status = "error"; updatePlayerBar(); });
  updatePlayerBar();
  setMediaSession();
}

// append the next chunk when the buffer runs low; kicked by sourceopen,
// updateend, startstreaming, and timeupdate
async function feedStream(gen) {
  if (stream.local) return wasmFeedLocal(gen);
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
  } catch {
    if (gen !== stream.gen) return;
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

  const chapterCrossed = seg.ci !== player.chapIdx;
  if (chapterCrossed) {
    player.chapIdx = seg.ci;
    // local-feed segs carry their chapter's chunk list (chunksBy is net-only)
    player.chunks = stream.chunksBy.get(seg.ci) ?? seg.chunks ?? player.chunks;
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
      savePos();
      return;
    }
    stream.pendingOpen = false;
    openChapter(seg.ci, off).then(() => flush());
    return;
  }
  if (off === state.off) return;
  state.off = off;
  updateProgress();
  savePos();
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

// ---------- WASM engine (offline matcha, wasm-tts.mjs) ----------
//
// Synthesis streams sentence-sized WAV units into `queue`; playback chains
// them through the same two chain elements with strict alternation (the
// exact pattern the /wasmtest lock-screen rounds validated). Each unit maps
// to a char span of its chunk, so position sync is FINER than chunk
// granularity. Synthesis runs ~90 s ahead and pauses (backpressure inside
// speakChunk's onUnit await); played units are dropped promptly so an
// hours-long session cannot pile up blobs.

export const wasm = {
  gen: 0,
  queue: [],         // {buf|url, secs, ci, k, start, chars, chunks}
  nextPlay: 0,       // queue index of the next unit to append/play
  active: false,     // chain mode: a unit is in the audio element right now
  synthDone: false,  // book finished synthesizing; drain then closePlayer
  cur: null,         // chain mode: unit currently playing (position mapping)
  pendingOpen: false, // chapter crossed while hidden; DOM catches up on show
  wake: null,        // resolver that un-sleeps backpressured synthesis NOW
  userPaused: false, // deliberate ⏸ — the visible-recovery kick must not undo it
};

// ---- flight recorder ----------------------------------------------------
// Background/lock behaviour only exists on the phone and the phone has no
// console: while the wasm engine drives, mirror the /wasmtest timeline into
// /api/testlog (page=player) — unit synth ×N, play()/播畢 with visibility,
// queue depth heartbeat. A log that stops mid-line with no error is itself
// the diagnosis (iOS killed or suspended the page). Read back with
// /api/testlog?page=player.
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

let wasmHb = 0;
function wasmHbStart() {
  if (wasmHb) return;
  wasmHb = setInterval(() => {
    if (!player.on || !useWasm()) { clearInterval(wasmHb); wasmHb = 0; return; }
    const played = stream.local
      ? (player.playing && stream.el ? `@${stream.el.currentTime.toFixed(0)}s` : "無")
      : (player.playing && wasm.cur ? `句${wasm.nextPlay} ${player.audio?.currentTime.toFixed(0)}s/${wasm.cur.secs.toFixed(0)}s` : "無");
    const buffered = stream.local && stream.sb && stream.el
      ? `緩${Math.max(0, bufferedEnd(stream.sb) - stream.el.currentTime).toFixed(0)}s ` : "";
    wlog(`♥ vis=${document.visibilityState} 播=${played} ${buffered}佇${wasm.queue.length - wasm.nextPlay}(${Math.round(wasmQueuedSecs())}s) ${wasm.synthDone ? "合成畢" : "合成中"}`);
  }, 10000);
}

function wasmTeardown() {
  wasm.gen++;
  wasm.wake?.();
  wasm.wake = null;
  for (const u of wasm.queue) if (u.url) URL.revokeObjectURL(u.url);
  wasm.queue = [];
  wasm.nextPlay = 0;
  wasm.active = false;
  wasm.synthDone = false;
  wasm.cur = null;
  wasm.pendingOpen = false;
  wasm.userPaused = false;
}

function wasmPlayFrom(ci, off) {
  wasmTeardown();
  const gen = wasm.gen;
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
  player.status = "loading"; // first audio lands when unit 1 is synthesized
  updatePlayerBar();
  setMediaSession();
  wlog(`start ci${ci} k${player.chunkIdx} off${off} ${wasmStreamOk ? "mms" : "chain"}`);
  wasmHbStart();
  if (wasmStreamOk) wasmStreamStart();
  wasmSynthLoop(gen, ci, chunks, player.chunkIdx);
}

// one continuous mp3 timeline for the wasm units — the STREAM engine's
// machinery (element, seg map, trim, position sync) with a local feed
function wasmStreamStart() {
  const gen = ++stream.gen;
  stream.local = true;
  ensureStreamEl();
  stream.sb = null;
  stream.segs = [];
  stream.pendingSeg = null;
  stream.fetching = false;
  const ms = new LocalMS();
  stream.ms = ms;
  const url = URL.createObjectURL(ms);
  ms.addEventListener("sourceopen", () => {
    URL.revokeObjectURL(url);
    if (gen !== stream.gen) return;
    const sb = ms.addSourceBuffer("audio/mpeg");
    sb.mode = "sequence";
    sb.addEventListener("updateend", () => onStreamUpdateEnd(gen));
    stream.sb = sb;
    wasmFeedLocal(gen);
  });
  ms.addEventListener("startstreaming", () => wasmFeedLocal(gen)); // MMS only
  stream.el.src = url;
  stream.el.play().then(
    () => wlog(`stream play() ok vis=${document.visibilityState}`),
    (e) => { wlog(`stream play() 拒 ${e?.name} vis=${document.visibilityState}`); player.status = "error"; updatePlayerBar(); },
  );
}

// append the next synthesized unit; kicked by sourceopen, updateend,
// startstreaming, timeupdate (via feedStream redirect) and each new unit
function wasmFeedLocal(gen) {
  const { sb } = stream;
  if (gen !== stream.gen || !sb || sb.updating) return;
  trimStream();
  if (sb.updating) return; // trim in progress; updateend re-kicks
  const u = wasm.queue[wasm.nextPlay];
  if (!u) {
    if (wasm.synthDone && !stream.pendingSeg && stream.ms?.readyState === "open") {
      try { stream.ms.endOfStream(); } catch { /* mid-update */ }
    }
    return;
  }
  wasm.nextPlay++;
  stream.pendingSeg = { ci: u.ci, k: u.k, start: u.start, chars: u.chars, chunks: u.chunks };
  try {
    sb.appendBuffer(u.buf);
  } catch (e) {
    // quota or state hiccup: retry this unit on the next kick
    wlog(`append 錯 ${e?.name} vis=${document.visibilityState}`);
    stream.pendingSeg = null;
    wasm.nextPlay--;
    return;
  }
  wlog(`句${wasm.nextPlay} append 音${u.secs.toFixed(1)}s vis=${document.visibilityState}`);
  wasmTrim();
  wasm.wake?.(); // one unit left the queue — synthesis may resume
}

// audio synthesized but not yet heard: un-appended units, plus (local
// stream mode) whatever sits in the SourceBuffer ahead of the playhead
function wasmQueuedSecs() {
  let s = wasm.queue.slice(wasm.nextPlay).reduce((a, u) => a + u.secs, 0);
  if (stream.local && stream.sb && stream.el)
    s += Math.max(0, bufferedEnd(stream.sb) - stream.el.currentTime);
  return s;
}

async function wasmSynthLoop(gen, ci, chunks, k) {
  let eng;
  try {
    eng = await wasmTts.ensureEngine();
    wlog(`引擎 ${wasmTts.engineInfo.threads}緒`);
  } catch (e) {
    // pack half-evicted or init failure: this device cannot run the engine
    // now — fall back to the online engines for the rest of the session
    console.warn("wasm-tts unavailable, falling back:", e);
    wlog(`引擎失敗 ${e?.message ?? e} → 回線上引擎`);
    wasmOn = false;
    if (player.on && gen === wasm.gen) playFrom(state.idx, state.off);
    return;
  }
  try {
    while (gen === wasm.gen && player.on) {
      if (k >= chunks.length) { // roll into the next chapter's text
        ci += 1;
        if (ci >= state.manifest.chapters.length) break;
        const text = state.cache.get(state.manifest.chapters[ci].file)
          ?? await fetchChapter(ci);
        if (gen !== wasm.gen) return;
        chunks = ttsCore.chunkChapter(text);
        k = 0;
        continue;
      }
      const c = chunks[k];
      const ok = await eng.speakChunk(ttsCore.ttsPrompt(c.text), async (u) => {
        if (gen !== wasm.gen) return false;
        wasm.queue.push({
          ...(stream.local ? { buf: u.buf } : { url: URL.createObjectURL(u.blob) }),
          secs: u.secs, ci, k, chunks,
          start: c.start + Math.round(u.frac0 * c.chars),
          chars: Math.max(1, Math.round((u.frac1 - u.frac0) * c.chars)),
        });
        wlog(`句${wasm.queue.length} 合成${(u.ms / 1000).toFixed(1)}s → 音${u.secs.toFixed(1)}s ×${(u.secs * 1000 / (u.ms || 1)).toFixed(1)} vis=${document.visibilityState}`);
        wasmPump();
        // ≲90 s synthesized ahead. Sleep on a timer AND a wake handle: iOS
        // throttles background timers, but `ended` pings wake directly, so
        // refill stays event-driven no matter what the clock does.
        let slept = false;
        while (gen === wasm.gen && wasmQueuedSecs() > 90) {
          slept = true;
          await new Promise((r) => { wasm.wake = r; setTimeout(r, 1000); });
          wasm.wake = null;
        }
        if (slept && gen === wasm.gen) wlog(`合成續 佇${Math.round(wasmQueuedSecs())}s vis=${document.visibilityState}`);
        return gen === wasm.gen;
      }, stream.local);
      if (!ok || gen !== wasm.gen) return;
      k += 1;
    }
    if (gen === wasm.gen) { wasm.synthDone = true; wlog("全書合成畢"); wasmPump(); }
  } catch (e) {
    if (gen !== wasm.gen) return;
    console.warn("wasm-tts synth:", e);
    wlog(`合成錯誤 ${e?.message ?? e}`);
    player.status = "error";
    updatePlayerBar();
  }
}

function wasmPump() {
  if (stream.local) return wasmFeedLocal(stream.gen);
  if (wasm.active || !player.on) return;
  const u = wasm.queue[wasm.nextPlay];
  if (!u) {
    if (wasm.synthDone && wasm.queue.length && wasm.nextPlay >= wasm.queue.length)
      closePlayer(); // whole book spoken and drained
    return;
  }
  // strict element alternation — the pattern the lock-screen rounds proved
  const a = player.standby;
  player.standby = player.audio;
  player.standby.pause();
  player.audio = a;
  wasm.cur = u;
  wasm.nextPlay++;
  wasm.active = true;
  a.src = u.url;
  const n = wasm.nextPlay;
  a.play().then(
    () => { wlog(`句${n} play() ok 音${u.secs.toFixed(1)}s vis=${document.visibilityState}`); player.status = ""; updatePlayerBar(); },
    (e) => { wlog(`句${n} play() 拒 ${e?.name} vis=${document.visibilityState}`); player.status = "error"; updatePlayerBar(); retryOnVisible(); },
  );
  wasmPosition(u);
  updatePlayerBar();
}

// keep a few played units for ⏮, revoke everything older
function wasmTrim() {
  while (wasm.nextPlay > 3) {
    URL.revokeObjectURL(wasm.queue.shift().url);
    wasm.nextPlay--;
  }
}

// resume/retry playback — the visible-again retry and ▶ in error state
function wasmReplay() {
  if (stream.local) {
    stream.el?.play().catch(() => { /* bar shows state */ });
    return;
  }
  wasm.nextPlay = Math.max(0, wasm.nextPlay - 1);
  wasm.active = false;
  wasmPump();
}

// ⏮/⏭. Local-stream mode moves at CHUNK grain like the net stream engine:
// seek within the buffered timeline when the target chunk is still there,
// restart synthesis at that chunk otherwise. Chain mode moves over units.
function wasmSkip(d) {
  if (stream.local) {
    const k = player.chunkIdx + d;
    const seg = stream.segs.find((s) => s.ci === player.chapIdx && s.k === k);
    if (seg && stream.el) {
      stream.el.currentTime = seg.t0 + 0.01;
      stream.el.play().catch(() => { /* already playing or blocked */ });
      return;
    }
    const c = player.chunks[k];
    if (c) return wasmPlayFrom(player.chapIdx, c.start);
    const ci = player.chapIdx + (d < 0 ? -1 : 1);
    if (ci < 0 || ci >= state.manifest.chapters.length) return closePlayer();
    return wasmPlayFrom(ci, 0);
  }
  const t = Math.max(0, wasm.nextPlay - 1 + d);
  if (t < wasm.queue.length) {
    player.audio.pause();
    wasm.nextPlay = t;
    wasm.active = false;
    wasmPump();
    return;
  }
  const u = wasm.cur;
  if (!u) return;
  const c = u.chunks[u.k + 1];
  if (c) wasmPlayFrom(u.ci, c.start);
  else if (u.ci + 1 < state.manifest.chapters.length) wasmPlayFrom(u.ci + 1, 0);
  else closePlayer();
}

// keep the reader following the narration as units start (chapter cross,
// chunk label) — mirrors the stream engine's hidden-tab discipline
function wasmPosition(u) {
  player.chunkIdx = u.k;
  if (u.ci !== player.chapIdx) {
    player.chapIdx = u.ci;
    player.chunks = u.chunks;
    setMediaSession();
  }
  if (u.ci !== state.idx) {
    if (document.visibilityState === "hidden") {
      state.idx = u.ci;
      state.off = u.start;
      wasm.pendingOpen = true;
      savePos();
      return;
    }
    wasm.pendingOpen = false;
    openChapter(u.ci, u.start).then(() => flush());
  }
}

// ---------- player bar / MediaSession ----------

function buildPlayerBar() {
  $("#playerbar")?.remove();
  document.body.append(
    el("div", { id: "playerbar", class: "playerbar" },
      el("button", { class: "iconbtn", id: "ppBtn", title: t("player.playPause"), onclick: playerPlayPause }, "⏸"),
      el("button", { class: "iconbtn", title: t("player.back"), onclick: () => advanceChunk(-1) }, "⏮"),
      el("button", { class: "iconbtn", title: t("player.forward"), onclick: () => advanceChunk(1) }, "⏭"),
      el("div", { class: "player-status", id: "playerStatus" }, ""),
      el("button", { class: "iconbtn", title: t("player.stop"), onclick: closePlayer }, "✕")),
  );
  updatePlayerBar();
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
}

function onAudioTime() {
  if (!player.playing || player.chapIdx !== state.idx) return;
  // wasm units carry their own char span — finer than a chunk, same shape
  const c = useWasm() ? wasm.cur : player.chunks[player.chunkIdx];
  if (!c) return;
  // proportional to the real clip length when known (exact at chunk edges);
  // the measured chars/sec constant is only the pre-metadata fallback
  const dur = player.audio.duration;
  const spoken = Number.isFinite(dur) && dur > 0
    ? (player.audio.currentTime / dur) * c.chars
    : player.audio.currentTime * ttsCore.CHARS_PER_SEC;
  const off = Math.min(c.start + Math.floor(spoken), c.start + c.chars - 1);
  if (off === state.off) return;
  state.off = off;
  updateProgress();
  savePos();
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
globalThis.bwPlayer = { player, stream, wasm, useStream, useWasm };
