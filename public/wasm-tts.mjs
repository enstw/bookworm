// Offline TTS engine: Matcha zh-en (matcha-icefall-zh-en) under
// onnxruntime-web, ONE wasm thread, no WebGPU. It replaced piper 華言, which
// scored 60 to Matcha's 90 in a blind listening test at roughly the same CPU
// cost; the piper engine, its espeak phonemizer and the melo-era TW lexicon
// survive at `git show <the commit before this one>:public/wasm-tts.mjs`.
// player.mjs owns playback; this module owns synthesis: assets → lexicon
// lookup → Worker inference → one sentence per unit.
//
// Two models, not one. The acoustic model emits a mel spectrogram and Vocos
// turns it into magnitude + phase, which matcha-synthesis.js inverse-FFTs into
// audio — so both sessions must be live at once, and dropping the raw ONNX
// buffers the moment the sessions exist is load-bearing on a phone, not an
// optimisation.
//
// 簡繁直輸: traditional and simplified text both go straight into the lexicon,
// with no OpenCC anywhere. That is a decision with a known cost — see the
// header of matcha-frontend.js — and corrections arrive as override entries
// backed by listening tests, not as a conversion layer.
//
// The big binaries ride the same "bw-wasmtts" Cache API bucket as /wasmtest
// (same /api/wasmtts/ keys), so a phone that ran the diagnostic already holds
// the pack — packReady() is what flips the reader to this engine. The pack is
// only ever downloaded by /wasmtest, never here: a tap on ▶ must not quietly
// pull 138 MB over cellular.
//
// Pure text helpers live up top with no browser APIs so node tests can
// import them (see scripts/test-wasm-frontend.mjs).

// Relative, unlike player.mjs's absolute "/tts-core.mjs": this module is also
// imported straight off disk by scripts/test-wasm-frontend.mjs, where a
// root-absolute specifier would point at the filesystem root. "./" resolves to
// /tts-core.mjs in the browser and public/tts-core.mjs in node.
import { ENDERS, CLOSERS } from "./tts-core.mjs";

export const RATE = 16000; // the model's own rate; lame encodes at it directly

// ---- segmentation ---------------------------------------------------------
// One sentence, one unit. piper needed a clause-level split because espeak ate
// the commas and the pauses had to be spliced back in downstream; Matcha reads
// ，。！？ as real tokens and pauses on them by itself, so the only reason left
// to cut text up is latency and offset resolution.
//
// Spans, not strings: frac0/frac1 are the unit's share of the prompt, and
// deriving them from indices keeps them exact instead of reconstructing them
// from lengths that normalisation has already changed.
const SEG_MAX = 72; // longer than this and the wait for first audio shows
const SEG_TARGET = 60;
const SEG_PAUSES = "，、：,;";

export function segments(prompt) {
  const out = [];
  let s = 0;
  for (let i = 0; i < prompt.length; i++) {
    if (!ENDERS.includes(prompt[i])) continue;
    let e = i + 1;
    while (e < prompt.length && CLOSERS.includes(prompt[e])) e++;
    push(s, e);
    s = e;
    i = e - 1;
  }
  if (s < prompt.length) push(s, prompt.length);
  return out;

  // A "sentence" with no terminal mark for hundreds of chars is common in
  // dialogue-heavy prose; sub-split it at secondary pauses the way
  // chunkChapter's subSplit does, hard-cutting only as a last resort.
  function push(a, b) {
    if (!prompt.slice(a, b).trim()) return; // whitespace-only: nothing to say
    if (b - a <= SEG_MAX) return void out.push({ text: prompt.slice(a, b), start: a, end: b });
    let cut = a;
    for (let i = a; i < b; i++) {
      if ((SEG_PAUSES.includes(prompt[i]) && i + 1 - cut >= SEG_TARGET) || i + 1 - cut >= SEG_MAX) {
        out.push({ text: prompt.slice(cut, i + 1), start: cut, end: i + 1 });
        cut = i + 1;
      }
    }
    if (cut < b) out.push({ text: prompt.slice(cut, b), start: cut, end: b });
  }
}

// Float32 PCM → 16-bit mono WAV (what <audio> can play from a blob URL)
export function mkWav(f32, rate) {
  const n = f32.length, v = new DataView(new ArrayBuffer(44 + n * 2));
  v.setUint32(0, 0x46464952, true); v.setUint32(4, 36 + n * 2, true);
  v.setUint32(8, 0x45564157, true); v.setUint32(12, 0x20746d66, true);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  v.setUint32(36, 0x61746164, true); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767 | 0, true);
  return new Blob([v.buffer], { type: "audio/wav" });
}

// ---- pronunciation overrides ----------------------------------------------
// Grown one line at a time from listening tests, never designed up front.
// Keys are the literal text as it appears in a book — there is no conversion
// step — and a single-char key is shadowed wherever a longer lexicon match
// wins, so prefer whole words. Every entry that lands here gets a case in the
// MATCHA_MODEL_DIR-gated block of scripts/test-wasm-frontend.mjs.
export const OVERRIDES = {
  // Absent from the lexicon in both spellings, so per-char fallback says
  // la1 ji1 — the mainland reading. Confirmed by ear in the wasmtts iPhone run.
  "垃圾": "le4 se4",
};

// ---- assets ---------------------------------------------------------------
const CACHE = "bw-wasmtts"; // shared with /wasmtest — one download, two pages

// The pack /wasmtest downloads. ort's wasm is 12.9 MB and belongs in the gate:
// unlike the piper era's small glue files, losing it means a 13 MB cellular
// re-download, not a rounding error. Sizes are what the progress bar counts.
const MODEL_FILES = [
  { name: "matcha-acoustic-steps3.onnx", bytes: 75717082, label: "聲學模型" },
  { name: "matcha-vocos-16khz-univ.onnx", bytes: 53882848, label: "聲碼器" },
  { name: "matcha-lexicon.txt", bytes: 1400278, label: "詞典" },
  { name: "matcha-tokens.txt", bytes: 21146, label: "音素表" },
  { name: "ort-1.27.0-wasm-simd-threaded.wasm", bytes: 13479978, label: "推論引擎" },
];

// sherpa's zh text-normalization tables, in the order they are applied — the
// order is load-bearing and matches sherpa's own config. matcha-fst.js runs
// them; see its header for what they are and why we can without sherpa.
const RULE_FILES = [
  { name: "phone-zh.fst", bytes: 88630, label: "號碼規則" },
  { name: "date-zh.fst", bytes: 59154, label: "日期規則" },
  { name: "number-zh.fst", bytes: 64482, label: "數字規則" },
];

export const PACK_FILES = [...MODEL_FILES, ...RULE_FILES];

// The ort build this engine was verified against, byte-for-byte. The release
// filename carries the version, so a bump that forgets to re-cut the release
// 404s instead of drifting; this catches the other direction — a re-cut release
// under the same name — and says so, rather than failing inside instantiation.
const ORT_WASM_BYTES = 13479978;

// Gates on MODEL_FILES, not PACK_FILES: the rule tables are part of the pack
// /wasmtest downloads, but they are not what makes the engine able to speak.
// Gating on them would have taken a phone holding a complete pre-table pack off
// the offline engine until it visited /wasmtest again — and it does not need to,
// because ensureEngine fetches them softly and caches them, so a device that is
// online picks them up on its next init by itself.
export async function packReady() {
  try {
    const cache = await caches.open(CACHE);
    for (const f of MODEL_FILES)
      if (!(await cache.match("/api/wasmtts/" + f.name))) return false;
    return true;
  } catch { return false; } // private mode: no cache, no pack
}

async function cachedBuf(url) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* private mode */ }
  let res = await cache?.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    if (cache) await cache.put(url, res.clone());
  }
  return res.arrayBuffer();
}

// ---- inference worker -----------------------------------------------------
// session.run blocks JS for hundreds of ms per sentence — in a Worker that
// never touches the main thread's playback handlers. Everything the worker
// needs arrives as a buffer and is importScripts'd from a blob URL, so it
// works offline and never re-downloads. The one exception is ort's loader
// glue: ort import()s it by URL, which a blob cannot satisfy in a classic
// worker, so it stays a same-origin asset and rides the service worker shell.
const WORKER_SRC = `
let rt, frontend, engine; // rt, not ort: the UMD script declares the global "ort" itself
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      const js = (buf) => URL.createObjectURL(new Blob([buf], { type: "text/javascript" }));
      importScripts(js(m.ortJs), js(m.lameJs), js(m.fstJs), js(m.frontendJs), js(m.synthesisJs));
      rt = self.ort;
      rt.env.wasm.numThreads = 1;
      rt.env.wasm.proxy = false;
      rt.env.wasm.wasmBinary = m.ortWasm;
      rt.env.wasm.wasmPaths = { mjs: m.glueUrl };
      // The rule tables read every ordinary number, date and phone number in the
      // book; the JS rules in matcha-frontend.js stay behind them as the reading
      // for a device that has the voice pack but not the tables. A table that
      // fails to parse is the same case as a missing one — say so and speak.
      let ruleNormalizer, rules = 0, rulesErr = "";
      if (m.ruleFsts) {
        try {
          ruleNormalizer = self.MatchaFst.createNormalizer(m.ruleFsts.map((b) => new Uint8Array(b)));
          rules = m.ruleFsts.length;
        } catch (err) {
          rulesErr = String(err.message ?? err); // reported with ready, not as an init failure
        }
      }
      frontend = self.MatchaFrontend.createFrontend({
        lexiconText: new TextDecoder().decode(m.lexicon),
        tokensText: new TextDecoder().decode(m.tokens),
        pronunciationOverrides: m.overrides,
        ruleNormalizer,
      });
      // noise 1 and length 1 are the defaults the phone was verified with, and
      // deliberately not sherpa's 0.667 noise. The silence is NOT left at its
      // ported default: scaleSilence is a pause CUTTER, not a pause generator —
      // it finds every stretch of quiet over 0.2 s and shortens it to that
      // fraction, and at sentence length the only silences that qualify are the
      // own 。 and ， pauses. Measured on one paragraph: at 0.2 a comma is
      // 55 ms and a full stop 147 ms; at 1 (the pass short-circuits, waveform
      // untouched) they are 280 ms and 740 ms. The phone heard the first as no
      // punctuation at all, which it effectively is.
      engine = self.MatchaSynthesis.createEngine({ ORT: rt, silenceScale: 1 });
      const info = await engine.init({
        acousticModel: new Uint8Array(m.acoustic),
        vocoderModel: new Uint8Array(m.vocoder),
      });
      postMessage({ type: "ready", initMs: info.wallMs, lexiconSize: frontend.lexiconSize, rules, rulesErr });
    } else if (m.type === "speak") {
      const t = performance.now();
      // one unknown glyph must never stop a book: drop it and count it
      const f = frontend.tokensFor(m.text, { allowUnknown: true });
      if (!f.ids.length) return postMessage({ type: "spoke", k: m.k, empty: true });
      const s = await engine.synthesize(f.ids, {});
      const w = s.waveform;
      // a numerical blow-up is silence or NaN, and both play as a dead unit the
      // reader cannot distinguish from a pause — refuse it here instead
      if (w.finiteSamples !== s.samples.length || w.peak === 0 || w.rms === 0)
        throw new Error("waveform not audible (peak " + w.peak + ", rms " + w.rms + ")");
      const ms = performance.now() - t;
      if (!m.mp3) {
        const pcm = s.samples;
        return postMessage({ type: "spoke", k: m.k, pcm, secs: s.audioSeconds, ms, unknown: f.unknown.length }, [pcm.buffer]);
      }
      // one self-contained mp3 stream per unit; frames concatenate cleanly
      // in a sequence-mode SourceBuffer
      const n = s.samples.length, i16 = new Int16Array(n);
      for (let i = 0; i < n; i++) i16[i] = Math.max(-1, Math.min(1, s.samples[i])) * 32767 | 0;
      const enc = new self.lamejs.Mp3Encoder(1, s.sampleRate, 96);
      const parts = [];
      for (let o = 0; o < n; o += 1152) parts.push(enc.encodeBuffer(i16.subarray(o, Math.min(n, o + 1152))));
      parts.push(enc.flush());
      let len = 0;
      for (const p of parts) len += p.length;
      const buf = new Uint8Array(len);
      let o = 0;
      for (const p of parts) { buf.set(p, o); o += p.length; }
      postMessage({ type: "spoke", k: m.k, buf: buf.buffer, secs: s.audioSeconds, ms, unknown: f.unknown.length }, [buf.buffer]);
    }
  } catch (err) {
    postMessage({ type: "err", k: m.k, msg: String(err?.message ?? err) });
  }
};`;

// what init actually decided — the player's flight recorder reads this
export const engineInfo = { threads: 0, rules: 0 };

let engine = null; // singleton promise — models stay loaded across sessions

// → { speakChunk } — throws when init fails (player falls back to stream)
export function ensureEngine() {
  return engine ??= (async () => {
    navigator.storage?.persist?.().catch(() => {});
    const [acoustic, vocoder, lexicon, tokens, ortWasm, ortJs, lameJs, fstJs, frontendJs, synthesisJs, ...ruleFsts] =
      await Promise.all([
        ...MODEL_FILES.map((f) => cachedBuf("/api/wasmtts/" + f.name)),
        cachedBuf("/vendor/wasmtts/ort-wasm.min.js"),
        cachedBuf("/vendor/wasmtts/lame.min.js"),
        cachedBuf("/matcha-fst.js"),
        cachedBuf("/matcha-frontend.js"),
        cachedBuf("/matcha-synthesis.js"),
        // Soft, unlike everything above it: a device holding a pack cut before
        // the tables existed has all 138 MB of what it needs to speak, and must
        // not lose offline audio over 212 KB it has never heard of. Absent
        // tables leave prepareText on the JS number rules — what shipped before.
        ...RULE_FILES.map((f) => cachedBuf("/api/wasmtts/" + f.name).catch(() => null)),
      ]);
    if (ortWasm.byteLength !== ORT_WASM_BYTES)
      throw new Error(`ort wasm is ${ortWasm.byteLength} B, expected ${ORT_WASM_BYTES} — the release and package.json disagree; re-cut the release or re-verify on device`);

    const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })));
    const pending = new Map();
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "err") console.warn("wasm-tts worker:", m.msg);
      const r = pending.get(m.k);
      pending.delete(m.k);
      r?.(m.type === "err" ? null : m);
    };
    let seq = 0;
    const call = (msg, transfer) => new Promise((r) => {
      pending.set(++seq, r);
      worker.postMessage({ ...msg, k: seq }, transfer);
    });
    // all three or none: a half-applied chain is a reading nobody has verified
    const rules = ruleFsts.every(Boolean) ? ruleFsts : null;
    const up = await new Promise((r) => {
      pending.set(undefined, r);
      worker.postMessage(
        { type: "init", ortJs, lameJs, fstJs, frontendJs, synthesisJs, ortWasm, acoustic, vocoder, lexicon, tokens,
          ruleFsts: rules, overrides: OVERRIDES,
          glueUrl: new URL("/vendor/wasmtts/ort-wasm-simd-threaded.mjs", location.origin).href },
        [ortJs, lameJs, fstJs, frontendJs, synthesisJs, ortWasm, acoustic, vocoder, lexicon, tokens, ...(rules ?? [])],
      );
    });
    if (up === null) { worker.terminate(); throw new Error("wasm-tts init failed"); }
    engineInfo.threads = 1;
    engineInfo.rules = up.rules ?? 0;
    if (up.rulesErr) console.warn("wasm-tts: rule tables unusable, JS number rules only —", up.rulesErr);
    console.log(`wasm-tts ready: matcha zh-en ${RATE}Hz, 1 thread, ${up.lexiconSize} lexicon entries, ${up.rules ? `${up.rules} rule tables` : "JS number rules"}, init ${Math.round(up.initMs)}ms`);

    // Everything this engine does not use is dead weight in a cache iOS evicts
    // under pressure — and the piper/melo/fanchen era left several hundred MB
    // of it. Sweep by keep-set rather than by name so this never needs editing
    // again; /wasmtest re-downloads on demand if a diagnostic wants something.
    caches.open(CACHE).then(async (c) => {
      const keep = new Set([
        ...PACK_FILES.map((f) => "/api/wasmtts/" + f.name),
        // the small same-origin files cachedBuf also parks here — they were
        // being swept and re-fetched on every single init
        "/vendor/wasmtts/ort-wasm.min.js", "/vendor/wasmtts/lame.min.js",
        "/matcha-fst.js", "/matcha-frontend.js", "/matcha-synthesis.js",
      ]);
      for (const req of await c.keys()) {
        const p = new URL(req.url).pathname;
        if (!keep.has(p) && await c.delete(req)) console.log("wasm-tts: evicted stale " + p);
      }
    }).catch(() => {});

    // Synthesize one chunk's prompt text as a stream of sentence-sized units.
    // onUnit({blob|buf, secs, frac0, frac1}) — fracs are the unit's span over
    // the prompt (proportional char mapping, like the other engines); await
    // its return value for backpressure, return false to abort. mp3=true
    // yields mp3 frames (unit.buf) for the MediaSource path instead of a WAV
    // blob — iOS only keeps lock-screen audio on one continuous timeline, and
    // MSE does not eat WAV.
    async function speakChunk(prompt, onUnit, mp3 = false) {
      const segs = segments(prompt);
      const total = prompt.length || 1;
      let held = null; // start of a segment that produced nothing, folded forward
      for (const s of segs) {
        const r = await call({ type: "speak", text: s.text, mp3 });
        // one unreadable sentence must not kill the readout; its span joins
        // the next unit so the char mapping stays continuous
        if (!r || r.empty) { held ??= s.start; continue; }
        const unit = {
          secs: r.secs,
          ms: r.ms, // compute time — the flight recorder's ×N
          frac0: (held ?? s.start) / total,
          frac1: s.end / total,
        };
        held = null;
        if (mp3) unit.buf = r.buf;
        else unit.blob = mkWav(r.pcm, RATE);
        if ((await onUnit(unit)) === false) return false;
      }
      return true;
    }
    return { speakChunk };
  })().catch((e) => { engine = null; throw e; });
}
