// Offline TTS engine: wasmtts's Matcha zh-en, driven through wasmtts's own
// synth worker and producer (public/vendor/wasmtts/, from the pinned release
// tarball — see scripts/wasmtts-pin.mjs). This module is the thin layer
// between the engine and this app: the worker config (which same-origin URL
// serves what), the voice-pack rules the app keeps for itself (never download
// ~140 MB behind a tap that did not name the megabytes), the local
// pronunciation staging layer, and one singleton producer that outlives
// listening sessions so the models load once. Playback is player.mjs's, on
// wasmtts's continuous-stream-player.
//
// What moved upstream, and why nothing here re-implements it: the text
// frontend, the compiled lexicon (簡繁 mirror baked in — 銀行 reads yín háng
// without a supplement file), the taiwan profile's contextual rules, the
// kaldifst number tables, the worker's cache-first pack download with a
// 1 s network cap, the sentence walk (ENDERS/CLOSERS — re-exported below so
// the reader's highlight and the engine's units can never disagree), and
// the single-timeline MediaSource transport with its lock-screen rules.
// Every one of those started as a bookworm phone finding and was handed to
// wasmtts so it is tested there; the migration ledger is DESIGN.md → TTS.
//
// ONE wasm thread, no WebGPU — the engine runs on the worker's default
// (numThreads 1, proxy false), which needs no COOP/COEP, and the app has
// none. The raw ONNX buffers are dropped inside the worker the moment the
// sessions exist (upstream's own rule; ~124 MiB on a phone).
//
// The pack: the models, tokens, rule tables, the compiled lexicon AND ort's
// 13 MB wasm live on the wasmtts-assets GitHub release under their
// content-versioned packNames, proxied same-origin by /api/wasmtts/
// (src/worker.js) and cached by the synth worker in its own "bw-wasmtts"
// Cache API bucket, swept by keep-set on every download. ort's wasm rides
// the same pipeline since wasmtts v2.4.0 (the worker injects it as
// ort.env.wasm.wasmBinary, so ort never fetches by URL): one bucket, one
// status() answer, one sweep. Phones that ran v2.3.0 hold that file in the
// old second bucket; adoptRuntime moves it over once so the change costs no
// cellular bytes.

// Relative, unlike player.mjs's absolute "/...": this module is also imported
// straight off disk by scripts/test-wasm-frontend.mjs, where a root-absolute
// specifier would point at the filesystem root. "./" resolves to /vendor/...
// in the browser and public/vendor/... in node (vendor must have run first;
// every test entry point runs it).
import { ASSETS, PACK_NAMES, WASMTTS_TAG } from "./vendor/wasmtts/pack-manifest.mjs";
import {
  CLOSERS, ENDERS, chunkIndexFor, createMatchaProducer, sentenceEndFor, sentenceSpans, sentenceStartFor,
  workerConfigFromAssets,
} from "./vendor/wasmtts/matcha-producer.mjs";

export { ASSETS, PACK_NAMES, WASMTTS_TAG, CLOSERS, ENDERS, chunkIndexFor, sentenceEndFor, sentenceSpans, sentenceStartFor };

export const RATE = 16000; // the model's own rate; lame encodes at it directly

// ---- pronunciation overrides ----------------------------------------------
// Local staging only. The reviewed reading layer is upstream's (the compiled
// lexicon plus the runtime profile); an entry lands HERE when a listening test
// on this app catches a reading upstream does not cover yet, wins over the
// lexicon and the profile until upstream absorbs it, and then leaves (垃圾 →
// le4 se4 made exactly that trip). Keys are the literal text as it appears in
// a book — whole words, longest match — values a phone list; the engine
// refuses an entry whose phones are not in tokens.txt at create time rather
// than dropping a glyph at synthesis. Every entry that lands here gets a case
// in the MATCHA_MODEL_DIR-gated block of scripts/test-wasm-frontend.mjs.
export const OVERRIDES = {};

// ---- the config: which URL serves what ------------------------------------
const CACHE = "bw-wasmtts";          // the synth worker's pack bucket (cacheName)
const LEGACY_RT = "bw-wasmtts-rt";   // v2.3.0's ort-wasm bucket — adopted, then deleted
export const ENGINE_BASE = "/vendor/wasmtts/"; // the tarball's files, on the sw shell
export const PACK_BASE = "/api/wasmtts/";      // the assets release, proxied same-origin

const runtimeFile = (pkg, file) => ASSETS.runtime[pkg].files[file];
export const ORT_WASM = runtimeFile("onnxruntime-web", "dist/ort-wasm-simd-threaded.wasm");

// Everything the worker needs, as URLs: engine scripts and the runtime's JS
// from the shell, the pack from the release proxy — ort's wasm included:
// a `wasm` path that ends in its packName is what makes upstream list it as
// a pack asset (assets.ortWasm) instead of leaving ort to fetch it by URL.
// Derived from the pin's manifest — no file name is written here, so a pin
// that moves a model or a runtime moves this. The compiled lexicon is
// cache-first for the same reason upstream makes it so: its packName is its
// content hash.
export function workerConfig() {
  return workerConfigFromAssets({
    assets: ASSETS,
    engineBaseUrl: ENGINE_BASE,
    assetBaseUrl: PACK_BASE,
    runtimeBaseUrl: ENGINE_BASE,
    overrides: {
      ortWasmPaths: {
        mjs: ENGINE_BASE + runtimeFile("onnxruntime-web", "dist/ort-wasm-simd-threaded.mjs").packName,
        wasm: PACK_BASE + ORT_WASM.packName,
      },
    },
    cacheName: CACHE,
    pronunciationOverrides: OVERRIDES,
    networkTimeoutMs: 1000, // NET_MS: a dying link hangs, it does not fail
    ort: { numThreads: 1 },
  });
}

// The pack as the pill and /wasmtest count it: every release-served file,
// labelled. Sizes are what a progress line or a percentage needs.
const fstLabels = { "phone-zh.fst": "號碼規則", "date-zh.fst": "日期規則", "number-zh.fst": "數字規則" };
export const PACK_FILES = [
  { name: ASSETS.acoustic.packName, bytes: ASSETS.acoustic.bytes, label: "聲學模型" },
  { name: ASSETS.vocos.packName, bytes: ASSETS.vocos.bytes, label: "聲碼器" },
  { name: ASSETS.lexicon.packName, bytes: ASSETS.lexicon.bytes, label: "詞典" },
  { name: ASSETS.matcha.files["tokens.txt"].packName, bytes: ASSETS.matcha.files["tokens.txt"].bytes, label: "音素表" },
  ...Object.entries(ASSETS.matcha.files).filter(([f]) => f.endsWith(".fst"))
    .map(([f, m]) => ({ name: m.packName, bytes: m.bytes, label: fstLabels[f] ?? "規則表" })),
  { name: ORT_WASM.packName, bytes: ORT_WASM.bytes, label: "推論引擎" },
];

// ---- pack status, answered from the Cache API without a worker ------------
// The worker can answer status() too, but it costs a Worker plus importScripts
// of ort and the engine just to ask — and the reader asks at every open to
// pick an engine. The keys are the worker's own (absolute URLs of the config's
// asset URLs), so both answers agree.
const packUrl = (name) => new URL(PACK_BASE + name, location.origin).href;
async function openCache(name) {
  try { return await caches.open(name); } catch { return null; } // private mode: no cache
}

// v2.3.0 parked ort's wasm in a bucket of its own (sw.js served it
// cache-first; the worker did not know the file). Now the worker owns it
// under the same key in the pack bucket: move the phone's copy over once
// and drop the old bucket, so the bookkeeping change costs no 13 MB
// download. Deletable once every phone has opened the app on v2.4.0+.
let adopted = null;
function adoptRuntime() {
  return adopted ??= (async () => {
    if (!("caches" in self) || !(await caches.has(LEGACY_RT))) return;
    const [pack, rt] = await Promise.all([openCache(CACHE), openCache(LEGACY_RT)]);
    if (pack && rt) {
      const url = packUrl(ORT_WASM.packName);
      const old = await rt.match(url);
      if (old && !(await pack.match(url))) await pack.put(url, old);
    }
    await caches.delete(LEGACY_RT);
  })().catch(() => {});
}

export async function packStatus() {
  await adoptRuntime();
  const pack = await openCache(CACHE);
  const files = [];
  let cachedBytes = 0, missingBytes = 0;
  for (const f of PACK_FILES) {
    const cached = !!(await pack?.match(packUrl(f.name)));
    files.push({ ...f, cached });
    if (cached) cachedBytes += f.bytes;
    else missingBytes += f.bytes;
  }
  return { files, cachedBytes, missingBytes, complete: missingBytes === 0 };
}

// what flips the reader to this engine: the whole pack, including the rule
// tables — the worker's download step wants every asset before it inits
export const packReady = async () => (await packStatus()).complete;

// Not ready, but not empty either: a device that HAD the offline voice and
// lost it to a pack change (a model or lexicon bump renames a file, so the
// pack goes incomplete on a phone that did nothing wrong) or a half-finished
// download. The caller can tell that reader why the offline voice went
// missing — a fresh device stays quiet, because it never had anything to lose.
export async function packStale() {
  const s = await packStatus();
  return !s.complete && s.cachedBytes > 0;
}

// What tapping the pill's 重新下載 would actually pull over the network — a
// stale pack usually keeps most of its files, so this is how the button can
// be honest about the bytes before it is tapped.
export const packMissingBytes = async () => (await packStatus()).missingBytes;

// /wasmtest's 清除快取 button; here because the module owns the bucket names.
export async function clearPack() {
  let any = false;
  for (const name of [CACHE, LEGACY_RT]) {
    try { any = (await caches.delete(name)) || any; } catch { /* private mode */ }
  }
  return any;
}

// ---- the producer: one worker, kept across sessions -----------------------
// The models take seconds to load and ~124 MiB to hold; a producer that dies
// with the listening session would pay that on every ▶. So one producer, made
// on first use, its worker kept warm; a worker that crashes is forgotten so
// the next ▶ builds a fresh one. `more` and `restore` are the reader's hooks
// (set per session by player.mjs): the next chapter's sentences when this
// one runs out, and a chapter's sentences again when the player must
// rebuild the timeline in a chapter the producer has already left (⏮ across
// a boundary, the watchdog inside the 90 s after one). Events fan out to
// whoever subscribed (the pill's progress, the player's fallback).
const listeners = new Set();
export function onEngineEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let moreHook = null, restoreHook = null;
export function setMore(fn) { moreHook = fn; }
export function setRestore(fn) { restoreHook = fn; }

let producer = null;
export function ensureProducer() {
  if (producer) return producer;
  const p = createMatchaProducer({
    workerUrl: ENGINE_BASE + "matcha-worker.js",
    config: workerConfig(),
    more: (ctx) => (moreHook ? moreHook(ctx) : null),
    restore: (tag) => (restoreHook ? restoreHook(tag) : null),
    allowUnknown: true, // one unknown glyph must never stop a book
    onEvent: (e) => {
      if (e.type === "error" && e.action === "worker") {
        // the Worker itself failed to start or died: nothing on it can be
        // reused — forget it, and the engine promise with it
        if (producer === p) { producer = null; engine = null; }
      }
      for (const l of listeners) {
        try { l(e); } catch { /* a listener must not break the engine */ }
      }
    },
  });
  p.ready.catch(() => {});
  producer = p;
  return p;
}

// what init actually decided — the player's flight recorder and /wasmtest read this
export const engineInfo = { tag: WASMTTS_TAG, threads: 0, rules: 0, lexiconSize: 0, contextualRules: 0, localOverrides: 0 };

let engine = null; // singleton promise — models stay loaded across sessions

// → { producer, speakChunk } — throws when init fails (the player falls back
// to the online engine). Reads the pack from the worker's cache and inits;
// with the pack complete (packReady, which is what put the reader on this
// engine) nothing here touches the network but the two network-first files'
// 1 s probe.
export function ensureEngine() {
  return engine ??= (async () => {
    navigator.storage?.persist?.().catch(() => {});
    await adoptRuntime();
    const p = ensureProducer();
    await p.download();
    const init = await p.initialize();
    engineInfo.threads = init.runtime?.threads ?? 1;
    engineInfo.rules = init.frontend?.ruleFsts?.length ?? 0;
    engineInfo.lexiconSize = init.frontend?.lexiconSize ?? 0;
    engineInfo.contextualRules = init.frontend?.contextualRules?.length ?? 0;
    engineInfo.localOverrides = init.frontend?.localOverrides?.length ?? 0;
    console.log(`wasm-tts ready: wasmtts ${WASMTTS_TAG}, matcha zh-en ${RATE}Hz, ${engineInfo.threads} thread, ${engineInfo.lexiconSize} lexicon entries, ${engineInfo.rules} rule tables, ${engineInfo.contextualRules} contextual rules, ${engineInfo.localOverrides} local overrides, init ${Math.round(init.wallMs)}ms`);
    return { producer: p, speakChunk };
  })().catch((e) => { engine = null; throw e; });
}

// The whole pack, into the worker's bucket — /wasmtest and the reader's pack
// pill both call this, so either path primes the other.
// onProgress({label, gotBytes, totalBytes}) rides the worker's
// download-progress events (cached files count as arrived; the total is the
// worker's own, which includes the profile it also fetches). Every caller
// sits behind an explicit tap that names the size: ▶ itself must never
// quietly pull ~140 MB over cellular.
export async function downloadPack(onProgress) {
  await adoptRuntime();
  const p = ensureProducer();
  const off = onEngineEvent((e) => {
    if (e.type !== "download-progress") return;
    onProgress?.({ label: e.asset, gotBytes: e.loaded, totalBytes: e.total });
  });
  try {
    await p.download();
  } finally {
    off();
  }
}

// Synthesize one prompt as a stream of sentence-sized mp3 units — /wasmtest's
// chain playback and the e2e suite drive the engine this way; the reader's
// player goes through the producer's next() instead. onUnit({buf|blob, secs,
// ms, frac0, frac1}) — fracs are the unit's span over the prompt; await its
// return value for backpressure, return false to abort. One unreadable
// sentence must not kill the readout: its span joins the next unit so the
// char mapping stays continuous (the producer does the same for the player).
async function speakChunk(prompt, onUnit, mp3 = true) {
  const p = ensureProducer();
  const total = prompt.length || 1;
  let held = null;
  for (const s of sentenceSpans(prompt)) {
    let r = null;
    try { r = await p.synthesize(s.text); } catch { r = null; }
    if (!r || r.empty) { held ??= s.start; continue; }
    const unit = {
      secs: r.meta.audioSeconds,
      ms: r.meta.phases?.totalMs ?? 0, // compute time — the flight recorder's ×N
      frac0: (held ?? s.start) / total,
      frac1: s.end / total,
    };
    held = null;
    if (mp3) unit.buf = r.buffer;
    else unit.blob = new Blob([r.buffer], { type: "audio/mpeg" });
    if ((await onUnit(unit)) === false) return false;
  }
  return true;
}

// Float32 PCM → 16-bit mono WAV — /wasmtest's 50 ms primer silence
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
