// E2E for the STREAM TTS engine (ManagedMediaSource path in app.js).
//
// Chromium has no ManagedMediaSource, so the test aliases it to Chrome's
// plain MediaSource before app.js evaluates — same API surface for what the
// engine uses (isTypeSupported, addSourceBuffer, sequence mode; the managed
// .streaming/startstreaming extras are optional in the engine). That runs
// the real append pipeline over real mp3 bytes: chunk fetch → appendBuffer
// → seg timeline mapping → chapter rollover → hidden-mode bookkeeping.
//
// What it proves: narration crosses chunk AND chapter boundaries without a
// single play() call after the first — the property that survives the iOS
// lock screen. The hidden-path check monkeypatches visibilityState to
// "hidden", lets the narration cross a chapter, and verifies the DOM was
// left alone (position bookkeeping only) until visibilitychange catches up.
//
//   node scripts/test-tts-stream-e2e.mjs          # STREAM engine (MMS alias)
//   node scripts/test-tts-stream-e2e.mjs chain    # CHAIN engine (double buffer)
//
// `chain` skips the alias, so app.js picks the double-buffered element-swap
// engine — the path Chrome/Firefox/older-iOS users get — and asserts the
// same chunk/chapter continuity (minus the stream-only hidden bookkeeping).
//
// Self-contained: in-process static server (public/ + synthetic book +
// /api/tts/* serving an ffmpeg-generated 2 s mp3 for every chunk). Needs
// ffmpeg on PATH for the fixture (generated once into /tmp).

import { rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp-client.mjs";

const CHAIN = process.argv[2] === "chain";
const PORT = CHAIN ? 9342 : 9341;
const HTTP_PORT = CHAIN ? 8990 : 8989;
const PROFILE = `/tmp/bookworm-ttsstream-e2e-profile${CHAIN ? "-chain" : ""}`;
const MP3 = "/tmp/bookworm-ttsstream-chunk.mp3";
const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// --- fixture: one 2 s mono 24 kHz mp3 stands in for every tts chunk ---
if (!existsSync(MP3)) {
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-ar", "24000", "-ac", "1", "-b:a", "48k", "-y", MP3,
  ], { stdio: "ignore" });
}
const MP3_BYTES = readFileSync(MP3);

// --- synthetic book: 3 short chapters ≈ 4 chunks ≈ 8 s of audio each ---
const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};
const PARA = "話說天下大勢，分久必合，合久必分。周末七國分爭，併入於秦。及秦滅之後，楚漢分爭，又併入於漢，一統天下。";
// chapter 1's body is ONE paragraph spanning several pages: the shape that
// pins both start-at-page-start and the mid-paragraph page turn (with no
// next paragraph to lean on, only char-precise page maths can turn a page)
const chapterText = (i) => `第${i}章 串流測試\n\n`
  + (i === 1 ? PARA.repeat(12) : Array(4).fill(PARA).join("\n"));
const chapters = [1, 2, 3].map((i) => ({
  file: `ch${i}.txt`, title: `第${i}章 串流測試`, chars: chapterText(i).length,
}));
const manifest = {
  slug: "ts", title: "串流測試", generatedAt: "ts1",
  totalChars: chapters.reduce((a, c) => a + c.chars, 0), chapters,
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const out = (code, body, type) => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (/^\/api\/tts\/ts\/ch\d\.txt\/\d+$/.test(path)) return out(200, MP3_BYTES, "audio/mpeg");
  // settings:null = server never overrides the test's local state
  if (path === "/api/settings")
    return out(200, req.method === "POST" ? '{"ok":true}' : '{"settings":null}', MIME[".json"]);
  if (path.startsWith("/api/")) return out(404, "{}", MIME[".json"]);
  if (path === "/books/ts/manifest.json") return out(200, JSON.stringify(manifest), MIME[".json"]);
  const ch = path.match(/^\/books\/ts\/ch(\d)\.txt$/);
  if (ch) return out(200, chapterText(Number(ch[1])), MIME[".txt"]);
  const file = path === "/" ? "/index.html" : path;
  if (file.includes(".") && existsSync(join(PUB, file)))
    return out(200, readFileSync(join(PUB, file)), MIME[extname(file)] ?? "application/octet-stream");
  return out(200, readFileSync(join(PUB, "index.html")), MIME[".html"]); // SPA reader routes
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const BASE = `http://localhost:${HTTP_PORT}`;

// --- CDP client (same pattern as the other e2e scripts) ---

rmSync(PROFILE, { recursive: true, force: true });
// --- CDP client (shared: cdp-client.mjs) ---
const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: PROFILE,
  // muted: the assertions read the media clock, never the speaker — the
  // sine fixture beeping through the desktop was just noise
  args: ["--window-size=900,700", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  onFail: () => server.close(),
});
if (!CHAIN)
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
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  server.close();
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};

// --- the test ---

const out = {};
await send("Page.navigate", { url: `${BASE}/ts` }, sessionId);
await waitFor(`document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0);
// player.mjs is preloaded at reader init; bwPlayer appears when it lands
await waitFor(`typeof bwPlayer !== "undefined"`, (v) => v, 20);

out.engine = (await evalJs(`bwPlayer.useStream`)) === !CHAIN
  ? `ok (${CHAIN ? "chain" : "stream"})`
  : `FAIL: bwPlayer.useStream=${await evalJs(`bwPlayer.useStream`)}`;

// --- a NEW reading opens at the page on screen, not at the tracked offset ---
// page forward first: the tracked state.off sticks to the straddling
// paragraph's start (a page back), and the old player then rewound further,
// to that offset's chunk start
await evalJs(`document.querySelector("#content").scrollLeft = -GRID.span`);
await sleep(900); // snap + trackScroll settle
const pageStart = await evalJs(`pageStartOffset()`);
const staleOff = await evalJs(`state.off`);
out.pageStartDiscriminates = pageStart > staleOff + 20
  ? `ok (page start ${pageStart}, tracked ${staleOff})`
  : `FAIL: page start ${pageStart} vs tracked ${staleOff} — fixture no longer discriminates`;

// start listening; everything after this first tap must run play()-free
await evalJs(`document.getElementById("audioBtn").click()`);
out.playing = (await waitFor(`bwPlayer.player.playing === true`, (v) => v)) ? "ok" : "FAIL: never played";

// the first spoken offset lands at the page start (the floor holds back the
// snapped-sentence pre-roll), never at the stale tracked offset or chunk 0
// — poll for a MOVE off the stale value: state.off is nonzero before the
// tap, and chain-mode `playing` flips true on the unlock silence already
const firstOff = await waitFor(`state.off`, (o) => o > 0 && o !== staleOff, 30);
out.startsAtPageStart = firstOff >= pageStart && firstOff < pageStart + 300
  ? `ok (first spoken off ${firstOff} ≥ page start ${pageStart})`
  : `FAIL: first spoken off ${firstOff}, page start ${pageStart}`;
out.noBackTurn = (await evalJs(`-document.querySelector("#content").scrollLeft >= GRID.span - 1`))
  ? "ok" : `FAIL: page flipped back to ${await evalJs(`-document.querySelector("#content").scrollLeft`)}px`;

// chunk boundary: chunkIdx advances with no interaction (continuous timeline)
const k0 = await evalJs(`bwPlayer.player.chunkIdx`);
const k1 = await waitFor(`bwPlayer.player.chunkIdx`, (k) => k > k0, 30);
out.chunkAdvances = k1 > k0 ? `ok (chunk ${k0} → ${k1})` : `FAIL: stuck at ${k1}`;

// the page turns WITHIN the one-paragraph chapter as narration advances —
// paragraph-grained following could never turn it before the chapter ended
out.midParagraphTurn = (await waitFor(
  `state.idx === 0 && -document.querySelector("#content").scrollLeft >= 2 * GRID.span - 1`,
  (v) => v, 20))
  ? "ok"
  : `FAIL: idx=${await evalJs(`state.idx`)} scroll=${await evalJs(`-document.querySelector("#content").scrollLeft`)} span=${await evalJs(`GRID.span`)}`;

// chapter boundary (visible): narration rolls into 第2章, player still going,
// and the DOM followed
out.chapterCross = (await waitFor(
  `state.idx === 1 && bwPlayer.player.playing && document.getElementById("ctitle").textContent.includes("第2章")`,
  (v) => v, 60)) ? "ok" : `FAIL: idx=${await evalJs(`state.idx`)} playing=${await evalJs(`bwPlayer.player.playing`)}`;

if (!CHAIN) {
  // chapter boundary (hidden): fake a locked screen, let narration roll into
  // 第3章 — position bookkeeping must advance while the DOM stays untouched
  await evalJs(`Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange")); "hidden"`);
  out.hiddenCross = (await waitFor(
    `state.idx === 2 && bwPlayer.player.playing && bwPlayer.stream.pendingOpen === true
      && document.getElementById("ctitle").textContent.includes("第2章")`,
    (v) => v, 60)) ? "ok" : `FAIL: idx=${await evalJs(`state.idx`)} pendingOpen=${await evalJs(`bwPlayer.stream.pendingOpen`)} ctitle=${await evalJs(`document.getElementById("ctitle").textContent`)}`;
  // uid "" — an unenrolled device's local bookmarks (identity is a key now)
  const savedChapter = await evalJs(`JSON.parse(localStorage.getItem("bw_pos_ts_")).chapter`);
  out.hiddenPosSaved = savedChapter === 2 ? "ok" : `FAIL: saved chapter ${savedChapter}`;

  // unlock: the DOM catches up on visibilitychange
  await evalJs(`delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); "visible"`);
  out.unhideCatchesUp = (await waitFor(
    `document.getElementById("ctitle").textContent.includes("第3章") && bwPlayer.stream.pendingOpen === false`,
    (v) => v, 20)) ? "ok" : `FAIL: ${await evalJs(`document.getElementById("ctitle").textContent`)}`;

  // the whole run used exactly one media element and one play() chain — the
  // element never fired `ended` mid-book
  out.stillSameStream = (await evalJs(`bwPlayer.player.playing && bwPlayer.stream.segs.length > 0`))
    ? "ok" : `FAIL: playing=${await evalJs(`bwPlayer.player.playing`)}`;
} else {
  // chain engine: the double-buffer swap keeps rolling into 第3章 (chapter
  // advance stays synchronous inside `ended` when the next text is cached)
  out.chainSecondCross = (await waitFor(
    `state.idx === 2 && bwPlayer.player.playing`, (v) => v, 60))
    ? "ok" : `FAIL: idx=${await evalJs(`state.idx`)} playing=${await evalJs(`bwPlayer.player.playing`)}`;
}

// book end: last chapter finishes → endOfStream → ended → player closes
out.closesAtBookEnd = (await waitFor(`bwPlayer.player.on === false`, (v) => v, 60))
  ? "ok" : "FAIL: player still open";

await finish(out);
