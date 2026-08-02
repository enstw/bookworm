// Offline TTS engine: piper 華言 (zh_CN-huayan-medium) under onnxruntime-web,
// single-threaded. Melo fp32 hit ×1.7 realtime with 4 wasm threads but cooked
// the phone (user 08-03) — huayan medium keeps realtime on ONE thread, so the
// threads knob (bw_tts_threads) and the threaded ort build went with it; the
// vetted melo TW-lexicon work survives at `git show 1bc494f:public/wasm-tts.mjs`.
// player.mjs owns playback; this module owns synthesis: assets → espeak
// phonemize (piper_phonemize wasm, main thread — milliseconds per chunk) →
// clause items → Worker inference → sentence-sized units with page-spliced
// pauses. espeak's "cmn" voice reads traditional text directly — no OpenCC.
//
// The big binaries ride the same "bw-wasmtts" Cache API bucket as /wasmtest
// (same /api/wasmtts/ keys), so a phone that ran the medium diagnostic
// already holds the pack — packReady() is what flips the reader to this
// engine. The pack is only ever downloaded by /wasmtest, never here: a tap
// on ▶ must not quietly pull 60 MB over cellular.
//
// Pure text helpers live up top with no browser APIs so node tests can
// import them (see scripts/test-wasm-frontend.mjs).

// ---- frontend: clause split + espeak id remap -----------------------------
// espeak erases commas (they reach the model as plain spaces, and training
// saw the same pipeline, so the model never learned a pause symbol). Split at
// clause punctuation, phonemize each clause as its own entry, splice real
// silence downstream. Orphan punctuation (a clause that trimmed to nothing)
// folds into the previous clause's mark.
const CLAUSE_RE = /([。！？；：，、!?;:,])/;
export function clauses(text) {
  const parts = text.split(CLAUSE_RE);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const t = parts[i].trim();
    const punct = parts[i + 1] ?? "";
    if (t) out.push({ text: t, punct });
    else if (out.length && punct) out[out.length - 1].punct = punct;
  }
  return out;
}

// The CLI's built-in id table is NEWER than the model's phoneme_id_map, so
// ids are rebuilt through the model's own map: keep the structural 0/1/2
// (pad/BOS/EOS — they only exist in the id stream), re-map the rest by
// walking ids and phoneme strings in lockstep. Symbols the model lacks are
// dropped and counted (medium keeps espeak's tone digits).
export function remapIds(map, ids, phonemes) {
  const out = [];
  let p = 0, miss = 0;
  for (const id of ids) {
    if (id <= 2) { out.push(id); continue; }
    const hit = map[phonemes[p++]];
    if (hit) out.push(hit[0]);
    else miss++;
  }
  return { ids: out, miss };
}

// ---- pause ownership (values validated by ear on-device) ------------------
export const PAUSE_MS = { "。": 450, "！": 450, "？": 450, "；": 320, "：": 260, "，": 200, "、": 160, ".": 450, "!": 450, "?": 450, ";": 320, ":": 260, ",": 200 };
export const UNIT_ENDERS = "。！？.!?";
export const UNIT_MAX_S = 12;

export function trimTail(f32, rate) {
  let end = f32.length;
  while (end > 0 && Math.abs(f32[end - 1]) < 0.004) end--;
  return f32.subarray(0, Math.min(f32.length, end + Math.floor(rate * 0.08)));
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

// ---- assets ---------------------------------------------------------------
const CACHE = "bw-wasmtts"; // shared with /wasmtest — one download, two pages
const MODEL_FILES = ["zh_CN-huayan-medium.onnx", "zh_CN-huayan-medium.onnx.json", "piper_phonemize.data"];

// pack = the model files /wasmtest downloads; the small ort/phonemizer pieces
// fetch on demand (and cache) because they are cheap even on cellular
export async function packReady() {
  try {
    const cache = await caches.open(CACHE);
    for (const f of MODEL_FILES)
      if (!(await cache.match("/api/wasmtts/" + f))) return false;
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
// session.run blocks JS for a second-plus per unit — in a Worker that never
// touches the main thread's chain-swap `ended` handlers. The ort UMD and
// wasm arrive as buffers (blob importScripts), so the worker works offline
// and never re-downloads.
const WORKER_SRC = `
let session, rt, scales; // rt, not ort: the UMD script declares the global "ort" itself
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      importScripts(URL.createObjectURL(new Blob([m.ortJs], { type: "text/javascript" })));
      importScripts(URL.createObjectURL(new Blob([m.lameJs], { type: "text/javascript" })));
      rt = self.ort;
      const wasmURL = URL.createObjectURL(new Blob([m.wasm], { type: "application/wasm" }));
      rt.env.wasm.wasmPaths = { "ort-wasm-simd.wasm": wasmURL };
      rt.env.wasm.numThreads = 1;
      scales = Float32Array.from(m.scales);
      session = await rt.InferenceSession.create(new Uint8Array(m.model));
      postMessage({ type: "ready" });
    } else if (m.type === "synth") {
      const t = performance.now();
      const out = await session.run({
        input: new rt.Tensor("int64", m.ids, [1, m.ids.length]),
        input_lengths: new rt.Tensor("int64", [m.ids.length]),
        scales: new rt.Tensor("float32", scales),
      });
      const pcm = new Float32Array((out.output ?? out.y).data);
      postMessage({ type: "pcm", k: m.k, pcm, ms: performance.now() - t }, [pcm.buffer]);
    } else if (m.type === "mp3") {
      // one self-contained mp3 stream per unit; frames concatenate cleanly
      // in a sequence-mode SourceBuffer
      const f = m.pcm, n = f.length;
      const i16 = new Int16Array(n);
      for (let i = 0; i < n; i++) i16[i] = Math.max(-1, Math.min(1, f[i])) * 32767 | 0;
      const enc = new self.lamejs.Mp3Encoder(1, m.rate, 96);
      const parts = [];
      for (let o = 0; o < n; o += 1152) parts.push(enc.encodeBuffer(i16.subarray(o, Math.min(n, o + 1152))));
      parts.push(enc.flush());
      let len = 0;
      for (const p of parts) len += p.length;
      const buf = new Uint8Array(len);
      let o = 0;
      for (const p of parts) { buf.set(p, o); o += p.length; }
      postMessage({ type: "mp3", k: m.k, buf: buf.buffer }, [buf.buffer]);
    }
  } catch (err) {
    postMessage({ type: "err", k: m.k, msg: String(err?.message ?? err) });
  }
};`;

export let RATE = 22050; // reassigned from the voice config at init

// what init actually decided — the player's flight recorder reads this
export const engineInfo = { threads: 0 };

let engine = null; // singleton promise — model stays loaded across sessions

// → { speakChunk } — throws when init fails (player falls back to stream)
export function ensureEngine() {
  return engine ??= (async () => {
    navigator.storage?.persist?.().catch(() => {});
    const [model, cfgBuf, phData, phJs, phWasm, wasm, ortJs, lameJs] = await Promise.all([
      cachedBuf("/api/wasmtts/zh_CN-huayan-medium.onnx"),
      cachedBuf("/api/wasmtts/zh_CN-huayan-medium.onnx.json"),
      cachedBuf("/api/wasmtts/piper_phonemize.data"),
      cachedBuf("/vendor/wasmtts/piper_phonemize.js"),
      cachedBuf("/vendor/wasmtts/piper_phonemize.wasm"),
      cachedBuf("/api/wasmtts/ort-wasm-simd.wasm"),
      cachedBuf("/vendor/wasmtts/ort-umd.min.js"),
      cachedBuf("/vendor/wasmtts/lame.min.js"),
    ]);
    const config = JSON.parse(new TextDecoder().decode(cfgBuf));
    RATE = config.audio?.sample_rate ?? RATE;
    const scales = [
      config.inference?.noise_scale ?? 0.667,
      config.inference?.length_scale ?? 1,
      config.inference?.noise_w ?? 0.8,
    ];
    // classic script, no module export — load once from cache via blob URL so
    // it works offline like everything else
    if (!globalThis.createPiperPhonemize) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = URL.createObjectURL(new Blob([phJs], { type: "text/javascript" }));
        s.onload = res;
        s.onerror = () => rej(new Error("piper_phonemize.js load failed"));
        document.head.append(s);
      });
    }
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
    const synth = (item) => call({ type: "synth", ids: item.ids });
    const encodeMp3 = (pcm) => call({ type: "mp3", pcm, rate: RATE }, [pcm.buffer]);
    const up = await new Promise((r) => {
      pending.set(undefined, r);
      worker.postMessage({ type: "init", model, wasm, ortJs, lameJs, scales }, [model, wasm, ortJs, lameJs]);
    });
    if (up === null) { worker.terminate(); throw new Error("wasm-tts init failed"); }
    engineInfo.threads = 1;
    console.log(`wasm-tts ready: huayan-medium ${RATE}Hz, 1 thread`);
    // the melo era left ~170 MB in this cache; reclaim it so iOS quota
    // pressure doesn't evict the pack we actually use (/wasmtest re-downloads
    // on demand if a diagnostic wants melo back)
    caches.open(CACHE).then(async (c) => {
      for (const f of ["melo-zh_en.onnx", "melo-lexicon.txt", "melo-tokens.txt", "ort-wasm-simd-threaded.wasm"])
        if (await c.delete("/api/wasmtts/" + f)) console.log("wasm-tts: evicted stale " + f);
    }).catch(() => {});

    // One prompt → clause items. A fresh emscripten module per call — the
    // CLI's main() is not reentrant; instantiation is milliseconds and the
    // wasm/data buffers are reused. Each item carries `len`, the count of
    // source code points it covers, so playback can map audio back to char
    // offsets; a phoneme-line/clause count mismatch degrades to even weights.
    async function piperItems(prompt) {
      const cls = clauses(prompt);
      if (!cls.length) return [];
      cls[cls.length - 1].flush = true;
      const lines = [], errs = [];
      const mod = await createPiperPhonemize({
        print: (l) => { try { lines.push(JSON.parse(l)); } catch { errs.push(l); } },
        printErr: (l) => errs.push(l),
        locateFile: (f) => "/vendor/wasmtts/" + f,
        wasmBinary: phWasm,
        getPreloadedPackage: () => phData,
      });
      try {
        mod.callMain(["-l", "cmn", "--input", JSON.stringify(cls.map((c) => ({ text: c.text }))), "--espeak_data", "/espeak-ng-data"]);
      } catch (e) {
        if (!lines.length) throw e;
      }
      let miss = 0;
      const idLines = lines.map((j) => {
        const r = remapIds(config.phoneme_id_map, j.phoneme_ids, j.phonemes);
        miss += r.miss;
        return r.ids;
      });
      if (errs.length) console.warn(`piper phonemize stderr ${errs.length}:`, String(errs[0]).slice(0, 120));
      if (miss) console.warn(`piper phonemize: ${miss} symbol(s) not in the model map`);
      if (idLines.length !== cls.length) {
        console.warn(`phoneme lines ${idLines.length} ≠ clauses ${cls.length} — pauses/offsets degrade to fixed`);
        return idLines.map((ids, i) => ({ ids, punct: "。", len: 1, flush: i === idLines.length - 1 }));
      }
      return idLines.map((ids, i) => ({
        ids,
        punct: cls[i].punct,
        len: [...cls[i].text].length + [...cls[i].punct].length,
        flush: !!cls[i].flush,
      }));
    }

    // Synthesize one chunk's prompt text as a stream of sentence-sized
    // units. onUnit({blob|buf, secs, frac0, frac1}) — fracs are the unit's
    // span over the prompt (proportional char mapping, like the other
    // engines); await its return value for backpressure, return false to
    // abort. mp3=true yields mp3 frames (unit.buf) for the MediaSource
    // path instead of a WAV blob — iOS only keeps lock-screen audio on one
    // continuous timeline, and MSE does not eat WAV.
    async function speakChunk(prompt, onUnit, mp3 = false) {
      const items = await piperItems(prompt);
      const total = items.reduce((s, it) => s + it.len, 0) || 1;
      let acc = [], accLen = 0, accMs = 0, accSrc = 0, srcDone = 0;
      const emit = async () => {
        if (!acc.length) return true;
        const pcm = new Float32Array(accLen);
        let o = 0;
        for (const p of acc) { pcm.set(p, o); o += p.length; }
        const unit = {
          secs: pcm.length / RATE,
          ms: accMs, // compute time — the flight recorder's ×N
          frac0: srcDone / total,
          frac1: (srcDone + accSrc) / total,
        };
        acc = []; accLen = 0; accMs = 0;
        srcDone += accSrc; accSrc = 0;
        if (mp3) {
          const r = await encodeMp3(pcm); // transfers pcm away
          if (!r) return true; // encode failure drops the unit, not the book
          unit.buf = r.buf;
        } else unit.blob = mkWav(pcm, RATE);
        return (await onUnit(unit)) !== false;
      };
      for (const item of items) {
        const r = await synth(item);
        if (!r) continue; // one bad clause must not kill the readout
        const pcm = trimTail(r.pcm, RATE);
        const gap = new Float32Array(Math.floor(RATE * (PAUSE_MS[item.punct] ?? (item.punct ? 300 : 80)) / 1000));
        acc.push(pcm, gap);
        accLen += pcm.length + gap.length;
        accMs += r.ms;
        accSrc += item.len;
        if ((UNIT_ENDERS.includes(item.punct) || item.flush || accLen / RATE >= UNIT_MAX_S) && !(await emit()))
          return false;
      }
      return emit();
    }
    return { speakChunk };
  })().catch((e) => { engine = null; throw e; });
}
