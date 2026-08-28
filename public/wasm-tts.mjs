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
// The pack: the models, tokens, rule tables and the compiled lexicon live on
// the wasmtts-assets GitHub release under their content-versioned packNames,
// proxied same-origin by /api/wasmtts/ (src/worker.js) and cached by the
// synth worker in its own "bw-wasmtts" Cache API bucket, swept by keep-set on
// every download. ort's 13 MB wasm is the one file ort loads by URL itself,
// so it lives in a second bucket ("bw-wasmtts-rt") that sw.js serves
// cache-first and the worker never sweeps. A phone that ran the old engine
// holds ort's wasm under the old bucket: migrateRuntime moves it over before
// the worker's first sweep can reclaim it, so nobody re-downloads 13 MB over
// cellular for a bookkeeping change.

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
const CACHE = "bw-wasmtts";       // the synth worker's pack bucket (cacheName)
const RT_CACHE = "bw-wasmtts-rt"; // sw.js parks ort's wasm here (runtimeFetch)
export const ENGINE_BASE = "/vendor/wasmtts/"; // the tarball's files, on the sw shell
export const PACK_BASE = "/api/wasmtts/";      // the assets release, proxied same-origin

const runtimeFile = (pkg, file) => ASSETS.runtime[pkg].files[file];
export const ORT_WASM = runtimeFile("onnxruntime-web", "dist/ort-wasm-simd-threaded.wasm");

// Everything the worker needs, as URLs: engine scripts and the runtime's JS
// from the shell, the pack from the release proxy, ort's wasm from the proxy
// too (its own bucket, above). Derived from the pin's manifest — no file name
// is written here, so a pin that moves a model or a runtime moves this.
export function workerConfig() {
  const cfg = workerConfigFromAssets({
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
  // the compiled lexicon's packName carries its content hash, so its bytes
  // can never change under the URL: cache-first, like the models — the
  // upstream default (network-first) is for a host that serves it unversioned
  cfg.assets.lexicon.networkFirst = false;
  return cfg;
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

// ort's wasm used to live in the pack bucket (the old engine preloaded it);
// the worker's keep-set sweep would reclaim it there. Move it once.
let migrated = null;
function migrateRuntime() {
  return migrated ??= (async () => {
    const [pack, rt] = await Promise.all([openCache(CACHE), openCache(RT_CACHE)]);
    if (!pack || !rt) return;
    const url = packUrl(ORT_WASM.packName);
    if (await rt.match(url)) return;
    const old = await pack.match(url);
    if (old) await rt.put(url, old);
  })().catch(() => {});
}

export async function packStatus() {
  await migrateRuntime();
  const [pack, rt] = await Promise.all([openCache(CACHE), openCache(RT_CACHE)]);
  const files = [];
  let cachedBytes = 0, missingBytes = 0;
  for (const f of PACK_FILES) {
    const bucket = f.name === ORT_WASM.packName ? rt : pack;
    const cached = !!(await bucket?.match(packUrl(f.name)));
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
  for (const name of [CACHE, RT_CACHE]) {
    try { any = (await caches.delete(name)) || any; } catch { /* private mode */ }
  }
  return any;
}

// ort's wasm into its bucket (sw.js does the same on the way through, so this
// is the no-service-worker path and the "count it as downloaded" step); stale
// ort versions leave with it, the way the worker sweeps the pack bucket.
async function ensureRuntimeWasm() {
  const rt = await openCache(RT_CACHE);
  const url = packUrl(ORT_WASM.packName);
  if (rt) {
    for (const req of await rt.keys()) if (req.url !== url) await rt.delete(req);
    if (await rt.match(url)) return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ORT_WASM.packName} HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== ORT_WASM.bytes)
    throw new Error(`ort wasm is ${buf.byteLength} B, the pin says ${ORT_WASM.bytes} — the release and the pin disagree; re-sync the release`);
  if (rt) await rt.put(url, new Response(buf, { headers: { "content-type": "application/wasm" } }));
}

// ---- the producer: one worker, kept across sessions -----------------------
// The models take seconds to load and ~124 MiB to hold; a producer that dies
// with the listening session would pay that on every ▶. So one producer, made
// on first use, its worker kept warm; a worker that crashes is forgotten so
// the next ▶ builds a fresh one. `more` is the reader's hook for the next
// chapter's sentences (set per session by player.mjs); events fan out to
// whoever subscribed (the pill's progress, the player's fallback).
const listeners = new Set();
export function onEngineEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let moreHook = null;
export function setMore(fn) { moreHook = fn; }

let producer = null;
export function ensureProducer() {
  if (producer) return producer;
  const p = createMatchaProducer({
    workerUrl: ENGINE_BASE + "matcha-worker.js",
    config: workerConfig(),
    more: (ctx) => (moreHook ? moreHook(ctx) : null),
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
// engine) nothing here touches the network but the runtime check.
export function ensureEngine() {
  return engine ??= (async () => {
    navigator.storage?.persist?.().catch(() => {});
    const p = ensureProducer();
    await Promise.all([p.download(), ensureRuntimeWasm()]);
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

// The whole pack, into the worker's bucket (and ort's wasm into its own) —
// /wasmtest and the reader's pack pill both call this, so either path primes
// the other. onProgress({label, gotBytes, totalBytes}) rides the worker's
// download-progress events (cached files count as arrived). Every caller sits
// behind an explicit tap that names the size: ▶ itself must never quietly pull
// ~140 MB over cellular.
export async function downloadPack(onProgress) {
  const p = ensureProducer();
  const totalBytes = PACK_FILES.reduce((s, f) => s + f.bytes, 0);
  const packTotal = totalBytes - ORT_WASM.bytes;
  const off = onEngineEvent((e) => {
    if (e.type !== "download-progress") return;
    onProgress?.({ label: e.asset, gotBytes: Math.min(packTotal, e.loaded), totalBytes });
  });
  try {
    await p.download();
    onProgress?.({ label: "推論引擎", gotBytes: packTotal, totalBytes });
    await ensureRuntimeWasm();
    onProgress?.({ label: "推論引擎", gotBytes: totalBytes, totalBytes });
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
