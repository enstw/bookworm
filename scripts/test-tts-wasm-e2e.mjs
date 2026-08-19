// Browser e2e for the offline TTS engine — the first coverage it has ever had.
// The unit test (test-wasm-frontend.mjs) proves the text path; this proves the
// half that only exists in a browser: two ort sessions in a worker, the Cache
// API pack, and — the actual integration risk — whether the mp3 the worker
// emits appends to a sequence-mode SourceBuffer and plays. Everything between
// speakChunk() and audible sound is code no unit test can reach.
//
// NOT in the default `pnpm test` chain: it needs ~130 MB of model weights, so
// it runs on demand. It serves them from MATCHA_MODEL_DIR rather than the
// GitHub release, which keeps it runnable before a release is cut and keeps CI
// off the network — the release proxy itself is a one-line allowlist in
// src/worker.js, covered by reading it. Fetch the weights from the pinned
// upstream (node_modules/wasmtts/platform/upstreams.yaml) into a private
// cache — the fetch block lives in .claude/skills/e2e/SKILL.md. Never point
// this at a live wasmtts checkout: that working folder mutates and vanishes
// under experiments.
//
//   MATCHA_MODEL_DIR=~/.cache/bookworm-matcha \
//     node scripts/test-tts-wasm-e2e.mjs
//
// Chromium has no ManagedMediaSource, so the page aliases plain MediaSource the
// way test-tts-stream-e2e.mjs does — the same trick, for the same reason: it is
// the phone's exact append path, minus the entitlement rules only iOS enforces.

import { createServer } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { launch } from "./cdp-client.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = process.env.MATCHA_MODEL_DIR;
const PORT = 9355;

if (!MODELS) {
  console.error("MATCHA_MODEL_DIR is unset — run `node scripts/fetch-matcha-weights.mjs`\n" +
    "  and point it at the directory that fills (default ~/.cache/bookworm-matcha)");
  process.exit(2);
}

// The release names the worker allowlists, mapped to where the weights sit
// locally — every name on both sides derived from the wasmtts pin
// (matcha-assets.json for the pack, the ort package for the runtime), the
// same derivation vendor.mjs bakes into pack-manifest.mjs / ort-manifest.mjs.
// A model bump upstream therefore moves this suite by itself, and a consumer
// that missed the rename is exactly the failure it should catch.
const wasmttsDir = realpathSync(join(root, "node_modules", "wasmtts"));
const pack = JSON.parse(readFileSync(join(wasmttsDir, "platform/matcha-assets.json"), "utf8"));
const ortDir = join(wasmttsDir, "..", "onnxruntime-web");
const ortVersion = JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")).version;
const RELEASE = {
  [pack.acoustic.packName]: join(MODELS, "matcha-icefall-zh-en", pack.acoustic.file),
  [pack.vocos.packName]: join(MODELS, basename(new URL(pack.vocos.url).pathname)),
  [pack.matcha.files["lexicon.txt"].packName]: join(MODELS, "matcha-icefall-zh-en/lexicon.txt"),
  [pack.matcha.files["tokens.txt"].packName]: join(MODELS, "matcha-icefall-zh-en/tokens.txt"),
  [`ort-${ortVersion}-wasm-simd-threaded.wasm`]: join(ortDir, "dist/ort-wasm-simd-threaded.wasm"),
};
for (const [name, file] of Object.entries(RELEASE))
  if (!existsSync(file)) { console.error(`missing ${name}: ${file}`); process.exit(2); }

// sherpa's zh rule tables, under the names the release gives them. Optional on
// purpose: without MATCHA_FST_DIR they 404 and the run asserts the other half
// of the contract — that a pack cut before the tables existed still speaks, on
// the JS number rules. With it set, the run asserts the chain loaded.
const FSTS = process.env.MATCHA_FST_DIR;
if (FSTS) Object.assign(RELEASE, Object.fromEntries(
  Object.entries(pack.matcha.files).filter(([f]) => f.endsWith(".fst"))
    .map(([f, meta]) => [meta.packName, join(FSTS, f)])));

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8", ".css": "text/css", ".wasm": "application/wasm", ".txt": "text/plain", ".onnx": "application/octet-stream", ".json": "application/json" };

const PAGE = `<!doctype html><meta charset="utf-8"><title>wasm tts e2e</title><script type="module">
import * as tts from "/wasm-tts.mjs";
import { chunkChapter, ttsPrompt } from "/tts-core.mjs";

// the reader's own append discipline: ONE element, ONE MediaSource, sequence
// mode, remote playback off (without which iOS never fires sourceopen)
async function timeline() {
  const el = new Audio();
  el.disableRemotePlayback = true;
  const ms = new MediaSource();
  el.src = URL.createObjectURL(ms);
  const sb = await new Promise((res) => {
    ms.addEventListener("sourceopen", () => {
      const b = ms.addSourceBuffer("audio/mpeg");
      b.mode = "sequence";
      res(b);
    }, { once: true });
  });
  return { el, ms, sb,
    append: (buf) => new Promise((res, rej) => {
      sb.addEventListener("updateend", res, { once: true });
      sb.addEventListener("error", rej, { once: true });
      sb.appendBuffer(buf);
    }) };
}

window.go = async (chapter) => {
  const o = { packBefore: await tts.packReady() };
  const t = performance.now();
  const eng = await tts.ensureEngine();
  o.initMs = performance.now() - t;
  o.packAfter = await tts.packReady();
  o.threads = tts.engineInfo.threads;
  o.rules = tts.engineInfo.rules;

  const tl = await timeline();
  o.sourceopen = !!tl.sb;

  const chunks = chunkChapter(chapter);
  o.units = [];
  o.appendErrors = 0;
  for (const [ci, c] of chunks.entries()) {
    const ok = await eng.speakChunk(ttsPrompt(c.text), async (u) => {
      try { await tl.append(u.buf); } catch (e) { o.appendErrors++; }
      o.units.push({ ci, secs: u.secs, ms: u.ms, bytes: u.buf.byteLength,
        frac0: u.frac0, frac1: u.frac1,
        start: c.start + Math.round(u.frac0 * c.chars),
        buffered: tl.sb.buffered.length ? tl.sb.buffered.end(tl.sb.buffered.length - 1) : 0 });
      return true;
    }, true);
    if (!ok) { o.aborted = ci; break; }
  }

  // the timeline must be one continuous range, or playback gaps at every unit
  o.ranges = tl.sb.buffered.length;
  o.bufferedEnd = tl.sb.buffered.length ? tl.sb.buffered.end(tl.sb.buffered.length - 1) : 0;

  // and it must actually play
  await tl.el.play().then(() => { o.played = true; }, (e) => { o.played = e.name; });
  await new Promise((r) => setTimeout(r, 700));
  o.currentTime = tl.el.currentTime;
  tl.el.pause();

  // aborting mid-chunk must stop synthesis, not just ignore the units
  let seen = 0;
  o.abortReturn = await eng.speakChunk(ttsPrompt(chunks[1].text), () => { seen++; return false; }, true);
  o.unitsBeforeAbort = seen;
  return o;
};
</script>`;

const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const serve = (file) => {
    try {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": statSync(file).size });
      res.end(readFileSync(file));
    } catch {
      // the path stays in this process's log: echoing it back reflects the
      // request into the page, which is a real shape even on a throwaway
      // localhost fixture (CodeQL js/reflected-xss)
      console.error("missing " + file);
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("missing");
    }
  };
  if (url === "/" || url === "/e2e.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (url.startsWith("/api/wasmtts/")) {
    const f = RELEASE[url.slice("/api/wasmtts/".length)];
    if (!f) { res.writeHead(404); return res.end("not allowlisted"); }
    return serve(f);
  }
  const p = normalize(join(root, "public", url));
  if (!p.startsWith(join(root, "public"))) { res.writeHead(403); return res.end(); }
  serve(p);
});
await new Promise((r) => server.listen(PORT, r));

// A chapter shaped like a real one: heading line, traditional prose, a quoted
// line, numbers, and a run-on sentence that forces the length re-split.
const CHAPTER = [
  "第十二章　窗外的長街",
  "",
  "他看著窗外，銀行的招牌顯得格外明亮。她覺得乾淨的街道很舒服，會計說話的聲音一個字一個字地傳過來。",
  "「你來了。」她說。這是一袋垃圾，還有2026年8月7日14:30的約定，完成度25.5%。",
  "他一路走過長街，穿過市集，越過石橋，繞過廟口，聞著糖炒栗子的香氣，聽著小販的吆喝，看著孩童追逐嬉戲，想起許多年前的那個冬天，也是這樣的一個黃昏，母親牽著他的手走過同樣的路",
].join("\n");

const { evalJs, close } = await launch({
  port: 9356,
  // persistent on purpose: the Cache API pack survives, so only the first run
  // pays for reading 130 MB off disk into the browser
  profile: "/tmp/bookworm-wasm-e2e-profile",
  // muted: the checks read currentTime, not the speaker — matcha reading
  // the fixture chapter aloud on the desktop was just noise
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  onFail: () => server.close(),
});

const fail = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail.push(name);
};

try {
  await evalJs(`location.href = "http://127.0.0.1:${PORT}/e2e.html"`);
  await new Promise((r) => setTimeout(r, 800));
  const o = await evalJs(`window.go(${JSON.stringify(CHAPTER)})`);

  const audio = o.units.reduce((s, u) => s + u.secs, 0);
  const wall = o.units.reduce((s, u) => s + u.ms, 0);

  console.log(`\nwasm tts e2e — ${o.units.length} units, ${audio.toFixed(1)}s audio in ${(wall / 1000).toFixed(1)}s (×${(audio * 1000 / wall).toFixed(2)} realtime)\n`);

  check("pack fills the cache", o.packAfter === true, `packReady ${o.packBefore} → ${o.packAfter}`);
  // Only asserted when the tables were served this run: the profile is
  // persistent, so a warm cache answers even when MATCHA_FST_DIR is unset and
  // "engine falls back to the JS rules" is not reproducible from here. That
  // half is pinned in scripts/test-wasm-frontend.mjs instead.
  if (FSTS) check("rule tables loaded", o.rules === 3, `${o.rules}/3 tables`);
  else console.log(`  · rule tables: ${o.rules}/3 from cache (set MATCHA_FST_DIR to assert)`);
  check("engine reports one thread", o.threads === 1, `init ${(o.initMs / 1000).toFixed(1)}s`);
  check("sourceopen fires", o.sourceopen === true);
  check("every chunk synthesized", o.aborted === undefined);
  check("units produced", o.units.length >= 5, `${o.units.length} units`);
  check("no append errors", o.appendErrors === 0, `${o.appendErrors} errors`);
  check("timeline is one continuous range", o.ranges === 1, `${o.ranges} range(s), ${o.bufferedEnd.toFixed(1)}s buffered`);
  check("buffered audio matches synthesized", Math.abs(o.bufferedEnd - audio) < audio * 0.05,
    `${o.bufferedEnd.toFixed(1)}s buffered vs ${audio.toFixed(1)}s synthesized`);
  check("plays", o.played === true, `currentTime ${o.currentTime?.toFixed(2)}s`);
  check("playhead advances", o.currentTime > 0);
  check("onUnit=false aborts", o.abortReturn === false && o.unitsBeforeAbort === 1,
    `returned ${o.abortReturn} after ${o.unitsBeforeAbort} unit`);

  // char mapping: fracs ordered within a chunk, offsets non-decreasing overall
  const ordered = o.units.every((u, i) => u.frac1 > u.frac0 && (i === 0 || u.ci !== o.units[i - 1].ci || u.frac0 >= o.units[i - 1].frac1 - 1e-9));
  check("fracs ordered and non-overlapping", ordered);
  check("char offsets non-decreasing", o.units.every((u, i) => i === 0 || u.start >= o.units[i - 1].start));

  console.log(fail.length ? `\n✗ ${fail.length} failure(s): ${fail.join(", ")}\n` : "\n✓ all checks passed\n");
  if (fail.length) process.exitCode = 1;
} finally {
  await close();
  server.close();
}
