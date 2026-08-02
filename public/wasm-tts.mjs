// Offline TTS engine: MeloTTS-zh fp32 under onnxruntime-web, in-browser.
// Graduated from the /wasmtest diagnostic after the on-device rounds proved
// every piece: native-accent frontend (no espeak), ×1.7 realtime with 4
// wasm threads on the phone, and blob-WAV chain playback surviving the
// lock screen. player.mjs owns playback; this module owns synthesis:
// assets → lexicon → clause items → Worker inference → sentence-sized WAV
// units with page-spliced pauses.
//
// The big binaries ride the same "bw-wasmtts" Cache API bucket as
// /wasmtest (same /api/wasmtts/ keys), so a phone that ran the diagnostic
// already holds the pack — packReady() is what flips the reader to this
// engine. The pack is only ever downloaded by /wasmtest, never here: a tap
// on ▶ must not quietly pull 180 MB over cellular.
//
// Pure text/PCM helpers live up top with no browser APIs so node tests can
// import them (see scripts/test-wasm-frontend.mjs).

// ---- frontend: sherpa's melo-tts-lexicon.cc, reimplemented ----------------
// lexicon.txt line: word phone… tone… (equal counts); tokens.txt: symbol id.
// Greedy longest match, per-char fallback, punctuation via token aliases.
export function parseMeloLexicon(tokTxt, lexTxt) {
  const tok = new Map();
  for (const line of tokTxt.split("\n")) {
    const p = line.split(/\s+/).filter(Boolean);
    if (p.length === 2) tok.set(p[0], +p[1]);
  }
  tok.set(" ", tok.get("_"));
  for (const [a, b] of [[",", "，"], [".", "。"], ["!", "！"], ["?", "？"]])
    if (tok.has(a)) tok.set(b, tok.get(a));
  tok.set("、", tok.get("，"));
  const lex = new Map();
  for (const line of lexTxt.split("\n")) {
    const p = line.split(/\s+/).filter(Boolean);
    if (p.length < 3) continue;
    const w = p[0].toLowerCase();
    if (lex.has(w)) continue;
    const n = (p.length - 1) >> 1;
    const ids = new Array(n), tones = new Array(n);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const id = tok.get(p[1 + i]);
      if (id === undefined) { ok = false; break; }
      ids[i] = id;
      tones[i] = +p[1 + n + i];
    }
    if (ok) lex.set(w, [ids, tones]);
  }
  lex.set("呣", lex.get("母"));
  lex.set("嗯", lex.get("恩"));
  return { tok, lex };
}

// ---- Taiwan readings overlay ---------------------------------------------
// The melo lexicon carries mainland readings; these lines (same format as
// lexicon.txt, every phone verified against melo-tokens.txt offline) are
// prepended so parseMeloLexicon's first-wins dedupe yields 台灣讀音 (MOE
// 一字多音審訂表) where the two standards differ: 垃圾 lèsè, 角色 jiǎosè,
// 頭髮 fǎ, 研究 jiù, 消息/休息 xí, 期 qí, 品質 zhí, 知識 shì, 攻擊 jí,
// 突 tú, 危/微 wéi, 企 qì, 血 xiě, 液 yì, 說服 shuì, 曝光 pù, 包括 guā,
// 亞 yǎ, 步驟 zòu, 誰 shéi… Single-char lines catch every per-char
// fallback; word lines exist only where the base lexicon has the whole
// word (a word hit would otherwise bypass the single-char override).
// Keys are simplified because matching runs after t2cn. localStorage
// bw_tts_tw="0" turns the overlay off.
export const TW_LEXICON = `期 q i 2 2
质 zh ir 2 2
识 sh ir 4 4
息 x i 2 2
击 j i 2 2
突 t u 2 2
危 w ei 2 2
微 w ei 2 2
企 q i 4 4
淆 y ao 2 2
俄 EE e 4 4
亚 y a 3 3
骤 z ou 4 4
携 x i 1 1
蜗 g ua 1 1
液 y i 4 4
血 x ie 3 3
谁 sh ei 2 2
究 j iu 4 4
括 g ua 1 1
垃圾 l e s e 4 4 4 4
头发 t ou f a 2 2 3 3
白发 b ai f a 2 2 3 3
长发 ch ang f a 2 2 3 3
角色 j iao s e 3 3 4 4
主角 zh u j iao 3 3 3 3
配角 p ei j iao 4 4 3 3
研究 y En j iu 2 2 4 4
追究 zh ui j iu 1 1 4 4
消息 x iao x i 1 1 2 2
休息 x iu x i 1 1 2 2
信息 x in x i 4 4 2 2
期待 q i d ai 2 2 4 4
时期 sh ir q i 2 2 2 2
星期 x ing q i 1 1 2 2
期间 q i j ian 2 2 1 1
预期 y v q i 4 4 2 2
期望 q i w ang 2 2 4 4
学期 x ve q i 2 2 2 2
日期 r ir q i 4 4 2 2
早期 z ao q i 3 3 2 2
长期 ch ang q i 2 2 2 2
近期 j in q i 4 4 2 2
质量 zh ir l iang 2 2 4 4
意识 y i sh ir 4 4 4 4
认识 r en sh ir 4 4 4 4
知识 zh ir sh ir 1 1 4 4
打击 d a j i 3 3 2 2
冲击 ch ong j i 1 1 2 2
冲突 ch ong t u 1 1 2 2
稍微 sh ao w ei 1 1 2 2
血液 x ie y i 3 3 4 4
鲜血 x ian x ie 1 1 3 3
说服 sh ui f u 4 4 2 2
曝光 p u g uang 4 4 1 1
包括 b ao g ua 1 1 1 1`;

export const addBlank = (x) => {
  const out = new Array(x.length * 2 + 1).fill(0);
  for (let i = 0; i < x.length; i++) out[i * 2 + 1] = x[i];
  return out;
};

// Clause items; the flushing punctuation KEEPS its token inside the clause
// (melo learned punctuation prosody — trimTail removes only the rendered
// silence after it). Each item carries `len`, the count of source code
// points it covers, so playback can map audio back to char offsets.
const FLUSH = "。！？，、；：.!?,;:";
export function lexItems(text, ld) {
  const units = [...text.toLowerCase()];
  const out = [];
  let ids = [], tones = [];
  let lastI = 0;
  const emit = (punct, i) => {
    if (ids.length)
      out.push({ ids: addBlank(ids), tones: addBlank(tones), punct, len: i - lastI, flush: false });
    ids = []; tones = [];
    lastI = i;
  };
  for (let i = 0; i < units.length;) {
    let step = 1;
    for (let L = Math.min(8, units.length - i); L >= 1; L--) {
      const w = units.slice(i, i + L).join("");
      const hit = ld.lex.get(w);
      if (hit) { ids.push(...hit[0]); tones.push(...hit[1]); step = L; break; }
      if (L === 1) {
        const t = ld.tok.get(w);
        if (t !== undefined) { ids.push(t); tones.push(0); }
      }
    }
    i += step;
    if (FLUSH.includes(units[i - 1])) emit(units[i - 1], i);
  }
  emit("", units.length);
  if (out.length) out[out.length - 1].flush = true;
  return out;
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
const MODEL_FILES = ["melo-zh_en.onnx", "melo-lexicon.txt", "melo-tokens.txt"];

// pack = the model files /wasmtest downloads; the small ort pieces fetch on
// demand (and cache) because they are cheap even on cellular
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
// and never re-downloads. Threads need crossOriginIsolated (COOP/COEP on
// the page — see public/_headers); the pthread workers are embedded blobs.
const WORKER_SRC = `
let session, rt; // rt, not ort: the UMD script declares the global "ort" itself
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      importScripts(URL.createObjectURL(new Blob([m.ortJs], { type: "text/javascript" })));
      rt = self.ort;
      const wasmURL = URL.createObjectURL(new Blob([m.wasm], { type: "application/wasm" }));
      rt.env.wasm.wasmPaths = { [m.threads > 1 ? "ort-wasm-simd-threaded.wasm" : "ort-wasm-simd.wasm"]: wasmURL };
      rt.env.wasm.numThreads = m.threads;
      session = await rt.InferenceSession.create(new Uint8Array(m.model));
      postMessage({ type: "ready" });
    } else if (m.type === "synth") {
      const t = performance.now();
      const out = await session.run({
        x: new rt.Tensor("int64", m.ids, [1, m.ids.length]),
        x_lengths: new rt.Tensor("int64", [m.ids.length]),
        tones: new rt.Tensor("int64", m.tones, [1, m.tones.length]),
        sid: new rt.Tensor("int64", [1]),
        noise_scale: new rt.Tensor("float32", [0.667]),
        length_scale: new rt.Tensor("float32", [1]),
        noise_scale_w: new rt.Tensor("float32", [0.8]),
      });
      const pcm = new Float32Array(out.y.data);
      postMessage({ type: "pcm", k: m.k, pcm, ms: performance.now() - t }, [pcm.buffer]);
    }
  } catch (err) {
    postMessage({ type: "err", k: m.k, msg: String(err?.message ?? err) });
  }
};`;

export const RATE = 44100; // melo's export; onnx metadata is unreadable from ort-web

// what init actually decided — the player's flight recorder reads this
export const engineInfo = { threads: 0, tw: true };

let engine = null; // singleton promise — model stays loaded across sessions

// → { speakChunk } — throws when init fails (player falls back to stream)
export function ensureEngine() {
  return engine ??= (async () => {
    navigator.storage?.persist?.().catch(() => {});
    // bw_tts_threads: battery-vs-speed A/B knob (melo needs ≥2 for realtime)
    const threads = crossOriginIsolated
      ? Math.max(1, Math.min(4, +localStorage.getItem("bw_tts_threads") || navigator.hardwareConcurrency || 1)) : 1;
    const [model, wasm, ortJs, tokTxt, lexTxt, OpenCC] = await Promise.all([
      cachedBuf("/api/wasmtts/melo-zh_en.onnx"),
      cachedBuf("/api/wasmtts/" + (threads > 1 ? "ort-wasm-simd-threaded.wasm" : "ort-wasm-simd.wasm")),
      cachedBuf("/vendor/wasmtts/ort-umd.min.js"),
      cachedBuf("/api/wasmtts/melo-tokens.txt"),
      cachedBuf("/api/wasmtts/melo-lexicon.txt"),
      import("/vendor/opencc-t2cn.js"),
    ]);
    const tw = localStorage.getItem("bw_tts_tw") !== "0";
    const lex = parseMeloLexicon(
      new TextDecoder().decode(tokTxt),
      (tw ? TW_LEXICON + "\n" : "") + new TextDecoder().decode(lexTxt));
    const t2cn = OpenCC.Converter({ from: "tw", to: "cn" });
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
    const synth = (item) => new Promise((r) => {
      pending.set(++seq, r);
      worker.postMessage({ type: "synth", k: seq, ids: item.ids, tones: item.tones });
    });
    const up = await new Promise((r) => {
      pending.set(undefined, r);
      worker.postMessage({ type: "init", model, wasm, ortJs, threads }, [model, wasm, ortJs]);
    });
    if (up === null) { worker.terminate(); throw new Error("wasm-tts init failed"); }
    engineInfo.threads = threads;
    engineInfo.tw = tw;
    console.log(`wasm-tts ready: melo fp32, ${threads} thread(s), tw readings ${tw ? "on" : "off"}`);

    // Synthesize one chunk's prompt text as a stream of sentence-sized WAV
    // units. onUnit({blob, secs, frac0, frac1}) — fracs are the unit's span
    // over the prompt (proportional char mapping, like the other engines);
    // await its return value for backpressure, return false to abort.
    async function speakChunk(prompt, onUnit) {
      const items = lexItems(t2cn(prompt), lex);
      const total = items.reduce((s, it) => s + it.len, 0) || 1;
      let acc = [], accLen = 0, accMs = 0, accSrc = 0, srcDone = 0;
      const emit = async () => {
        if (!acc.length) return true;
        const pcm = new Float32Array(accLen);
        let o = 0;
        for (const p of acc) { pcm.set(p, o); o += p.length; }
        const unit = {
          blob: mkWav(pcm, RATE),
          secs: pcm.length / RATE,
          ms: accMs, // compute time — the flight recorder's ×N
          frac0: srcDone / total,
          frac1: (srcDone + accSrc) / total,
        };
        acc = []; accLen = 0; accMs = 0;
        srcDone += accSrc; accSrc = 0;
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
