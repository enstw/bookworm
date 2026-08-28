// Reader-level e2e for the OFFLINE engine: the whole path a phone takes when
// ▶ lands on wasmtts — app.js picks the engine from the cached pack,
// player.mjs hands chapter sentences to wasmtts's producer, wasmtts's
// continuous-stream-player appends units to the one blessed element, and the
// units' char spans come back as the reader's position: bookmark, highlight,
// chunk label, the next chapter through `more`, ⏮/⏭ at chunk grain, and the
// player closing when the book ends. test-tts-wasm-e2e.mjs proves the engine;
// this proves the reader's side of the contract (DESIGN.md → TTS).
//
// NOT in the default `pnpm test` chain: it needs the ~130 MB pack, served
// like the engine suite does — weights from MATCHA_MODEL_DIR, the compiled
// lexicon and ort's wasm from where the pin put them. Chromium has no
// ManagedMediaSource, so plain MediaSource is aliased in, the same trick the
// stream suite uses for the same reason.
//
//   MATCHA_MODEL_DIR=~/.cache/bookworm-matcha \
//     node scripts/test-tts-offline-e2e.mjs

import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { launch } from "./cdp-client.mjs";
import { engineDir, packEntries, readAssets, root } from "./wasmtts-pin.mjs";

const MODELS = process.env.MATCHA_MODEL_DIR;
if (!MODELS) {
  console.error("MATCHA_MODEL_DIR is unset — run `node scripts/fetch-matcha-weights.mjs`");
  process.exit(2);
}
const PORT = 9357;
const HTTP_PORT = 8991;
const PUB = join(root, "public");
// persistent on purpose: the Cache API pack survives, so only the first run
// pays for reading 130 MB off disk into the browser
const PROFILE = "/tmp/bookworm-offline-e2e-profile";

const engine = engineDir();
const RELEASE = Object.fromEntries(packEntries(readAssets(engine), engine).map((e) => [
  e.name,
  e.local ?? (e.name.startsWith("matcha-vocos") ? join(MODELS, e.file) : join(MODELS, "matcha-icefall-zh-en", e.file)),
]));
for (const [name, file] of Object.entries(RELEASE))
  if (!existsSync(file)) { console.error(`missing ${name}: ${file}`); process.exit(2); }

// --- synthetic book: three short chapters, ~12 s of speech each, so the
// narration crosses two chapter boundaries and ends inside a test budget ---
const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".onnx": "application/octet-stream",
};
const PARA = "他看著窗外，銀行的招牌顯得格外明亮。她覺得乾淨的街道很舒服，會計說話的聲音一個字一個字地傳過來。";
const chapterText = (i) => `第${i}章 離線測試\n\n　　${PARA}\n　　「你來了。」她說。這是第${i}章的最後一句。`;
const chapters = [1, 2, 3].map((i) => ({
  file: `ch${i}.txt`, title: `第${i}章 離線測試`, chars: chapterText(i).length,
}));
const manifest = {
  slug: "ol", title: "離線測試", generatedAt: "ol1",
  totalChars: chapters.reduce((a, c) => a + c.chars, 0), chapters,
};

const recorder = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const out = (code, body, type) => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (path.startsWith("/api/wasmtts/")) {
    const f = RELEASE[path.slice("/api/wasmtts/".length)];
    if (!f) return out(404, "not allowlisted", "text/plain");
    return out(200, readFileSync(f), MIME[extname(f)] ?? "application/octet-stream");
  }
  if (path === "/api/settings")
    return out(200, req.method === "POST" ? '{"ok":true}' : '{"settings":null}', MIME[".json"]);
  if (path === "/api/position") return out(200, req.method === "POST" ? '{"ok":true}' : "{}", MIME[".json"]);
  // the flight recorder's lines: what happened, when a check fails
  if (path === "/api/testlog") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => { try { recorder.push(JSON.parse(raw).data); } catch { /* ignore */ } out(200, '{"ok":true}', MIME[".json"]); });
    return;
  }
  if (path.startsWith("/api/")) return out(404, "{}", MIME[".json"]);
  if (path === "/books/ol/manifest.json") return out(200, JSON.stringify(manifest), MIME[".json"]);
  const ch = path.match(/^\/books\/ol\/ch(\d)\.txt$/);
  if (ch) return out(200, chapterText(Number(ch[1])), MIME[".txt"]);
  const file = path === "/" ? "/index.html" : path;
  if (file.includes(".") && existsSync(join(PUB, file)))
    return out(200, readFileSync(join(PUB, file)), MIME[extname(file)] ?? "application/octet-stream");
  return out(200, readFileSync(join(PUB, "index.html")), MIME[".html"]); // SPA reader routes
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const BASE = `http://localhost:${HTTP_PORT}`;

const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: PROFILE,
  args: ["--window-size=900,700", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  onFail: () => server.close(),
});
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "window.ManagedMediaSource = window.MediaSource;",
}, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, pred, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr);
    if (pred(v)) return v;
    await sleep(500);
  }
  return await evalJs(expr);
};
const out = {};
const finish = async () => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  server.close();
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};

const dump = () => evalJs(`JSON.stringify({ on: bwPlayer?.player.on, playing: bwPlayer?.player.playing, status: bwPlayer?.player.status, wasm: bwPlayer?.useWasm(), idx: state.idx, off: state.off, bar: !!document.getElementById("playerbar"), snap: bwPlayer?.wasm.player?.snapshot() })`).catch((e) => String(e));
async function main() {

// --- 1. the pack, primed the way the pill does it, then the reader picks the engine ---
await send("Page.navigate", { url: `${BASE}/ol` }, sessionId);
await waitFor(`document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0);
await evalJs(`localStorage.setItem("bw_tts", "offline")`);
const primed = await evalJs(`import("/wasm-tts.mjs").then(async (m) => {
  const before = await m.packReady();
  await m.downloadPack();
  return { before, after: await m.packReady(), missing: await m.packMissingBytes() };
})`);
out.packPrimed = primed?.after === true && primed.missing === 0
  ? `ok (packReady ${primed.before} → ${primed.after})` : `FAIL ${JSON.stringify(primed)}`;

// a reload: pickEngine runs at module load, and the pack is complete now
await send("Page.navigate", { url: `${BASE}/ol` }, sessionId);
await waitFor(`document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0);
await waitFor(`typeof bwPlayer !== "undefined"`, (v) => v, 20);
const engine0 = await waitFor(`bwPlayer.useWasm()`, (v) => v === true, 20);
out.enginePicked = engine0 === true ? "ok (offline pack complete → wasm engine)" : `FAIL useWasm=${engine0}`;

// --- 2. ▶: the session opens on wasmtts's player and audio starts ---
await evalJs(`document.getElementById("audioBtn").click()`);
const playing = await waitFor(`bwPlayer.player.on && bwPlayer.player.playing && bwPlayer.wasm.player?.snapshot().status`,
  (v) => v === "playing", 120);
out.plays = playing === "playing" ? "ok (upstream player status playing)" : `FAIL status=${playing}`;
out.engineButton = (await evalJs(`document.getElementById("engBtn")?.dataset.engine`)) === "offline"
  ? "ok" : `FAIL ${await evalJs(`document.getElementById("engBtn")?.outerHTML`)}`;

// --- 3. the units' char spans drive the reader: the bookmark moves forward
// inside chapter 1 and the spoken sentence is painted ---
const off0 = await evalJs(`state.off`);
// past the heading (chunk 0, rendered as <h2>: nothing to paint) and into
// the body, where the wash has a paragraph to map onto
const off1 = await waitFor(`state.idx === 0 ? state.off : -1`, (v) => v > 14, 60);
out.positionFollows = off1 > 14 ? `ok (off ${off0} → ${off1} in chapter 1)` : `FAIL off ${off0} → ${off1}`;
const hl = await evalJs(`(() => {
  const w = document.getElementById("ttsHl");
  if (!w) return null;
  return { start: +w.dataset.start, end: +w.dataset.end, rects: w.children.length };
})()`);
out.sentenceMarked = hl && hl.end > hl.start && hl.rects > 0
  ? `ok (${hl.start}–${hl.end}, ${hl.rects} rect(s))` : `FAIL ${JSON.stringify(hl)}`;

// --- 4. ⏭ at chunk grain moves the label forward without leaving the engine ---
const k0 = await evalJs(`bwPlayer.player.chunkIdx`);
await evalJs(`document.getElementById("fwdBtn").click()`);
const k1 = await waitFor(`bwPlayer.player.chunkIdx + ":" + state.idx`, (v) => v !== `${k0}:0`, 40);
out.skipForward = k1 !== `${k0}:0` && (await evalJs(`bwPlayer.useWasm() && bwPlayer.player.on`))
  ? `ok (chunk ${k0} → ${k1.split(":")[0]}, chapter ${Number(k1.split(":")[1]) + 1}, still offline)`
  : `FAIL ${k0} → ${k1}`;

// --- 5. the next chapter arrives through `more`: narration crosses into
// 第2章 with no new play(), and the DOM follows ---
const crossed = await waitFor(`state.idx >= 1 && document.getElementById("ctitle").textContent.includes("第2章") && bwPlayer.player.playing`,
  (v) => v, 160);
out.chapterCrossed = crossed ? "ok (第2章 opened by the narration, still playing)"
  : `FAIL idx=${await evalJs(`state.idx`)} title=${await evalJs(`document.getElementById("ctitle").textContent`)} status=${await evalJs(`bwPlayer.wasm.player?.snapshot().status`)}`;

// --- 6. ⏮ into a chapter the producer has left rebuilds there ---
await evalJs(`document.getElementById("backBtn").click()`);
await sleep(1500);
const back = await waitFor(`bwPlayer.player.playing && bwPlayer.player.on`, (v) => v, 60);
out.skipBack = back ? `ok (still playing after ⏮, chapter ${(await evalJs(`bwPlayer.player.chapIdx`)) + 1})` : "FAIL not playing after ⏮";

// --- 7. book end: producer returns null → timeline ends → the player closes ---
out.closesAtBookEnd = (await waitFor(`bwPlayer.player.on === false`, (v) => v, 400))
  ? "ok" : `FAIL still open: idx=${await evalJs(`state.idx`)} status=${await evalJs(`bwPlayer.wasm.player?.snapshot().status`)}`;
out.markCleared = (await evalJs(`document.getElementById("ttsHl") === null`)) ? "ok" : "FAIL overlay survived close";
}

try {
  await main();
} catch (e) {
  out.crashed = `FAIL ${e?.message ?? e}`;
  out.state = await dump();
  out.recorder = recorder.join("\n").split("\n").slice(-60);
}
await finish();
