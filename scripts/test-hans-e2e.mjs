// E2E for a Simplified online book read as Traditional (DESIGN.md → Online
// books): a manifest that says `script: "hans"` opens with its title, the
// chapter heading, every paragraph and the 目錄 converted on the phone —
// with every paragraph's offset unchanged, since cn→tw keeps lengths — and
// a book without the flag is shown exactly as served.
//
// Self-contained — serves public/ plus two synthetic books from an
// in-process static server (no wrangler, no worker APIs involved); the
// expected strings come from the same vendored OpenCC module the reader
// loads, so a dictionary update moves both sides at once:
//
//   node scripts/test-hans-e2e.mjs
//
// Runs under node ≥22. Browser discovery is shared — see find-browser.mjs
// (BROWSER_BIN, desktop Chrome/Brave, or playwright's headless shell).

import { rmSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp-client.mjs";

const PORT = 9346;
const HTTP_PORT = 8993;
const PROFILE = "/tmp/bookworm-hans-e2e-profile";
const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// --- two synthetic books: the same Simplified text, one flagged hans ---

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};
// phrases whose cn→tw is not one character at a time (头发→頭髮, 干净→乾淨,
// 后台→後臺) beside characters that never change: the offsets must survive both
const PARA = "头发干净，软件与后台。这是第二段：他们说“发动机”坏了，于是大家一起想办法。";
const HEAD = (i) => `第${i}章　开始${i}`;
const chapterText = (i) => `${HEAD(i)}\n` + Array(40).fill(PARA).join("\n") + "\n";
const chapters = (n) => [1, 2, 3].map((i) => ({
  file: `ch${i}.txt`, title: HEAD(i), chars: chapterText(i).length, src: `https://www.aiyanzx.com/x/${n}/c${i}.html`,
}));
const BOOKS = {
  b0hans001: { slug: "hs", title: "测试书", script: "hans" },
  b0plain01: { slug: "pl", title: "测试书" },
};
const manifests = Object.fromEntries(Object.entries(BOOKS).map(([id, b]) => [id, {
  id, slug: b.slug, title: b.title, generatedAt: "hs1",
  ...(b.script ? { script: b.script } : {}),
  totalChars: chapters(id).reduce((a, c) => a + c.chars, 0), chapters: chapters(id),
  source: { site: "aiyanzx.com", url: `https://www.aiyanzx.com/x/${id}/`, checkedAt: Date.now() },
}]));
const bySlug = (slug) => Object.entries(BOOKS).find(([, b]) => b.slug === slug)?.[0];

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const out = (code, body, type) => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (path === "/api/settings")
    return out(200, req.method === "POST" ? '{"ok":true}' : '{"settings":null}', MIME[".json"]);
  if (path === "/api/books")
    return out(200, JSON.stringify({ books: Object.entries(BOOKS).map(([id, b]) => ({
      id, slug: b.slug, title: b.title, chapters: 3, totalChars: manifests[id].totalChars, source: manifests[id].source.url,
    })) }), MIME[".json"]);
  const bm = path.match(/^\/api\/books\/([a-z]+)$/);
  if (bm && bySlug(bm[1])) {
    const id = bySlug(bm[1]);
    return out(200, JSON.stringify({ book: { id, slug: bm[1], title: BOOKS[id].title, chapters: 3, totalChars: manifests[id].totalChars } }), MIME[".json"]);
  }
  if (path.startsWith("/api/")) return out(404, "{}", MIME[".json"]);
  const mm = path.match(/^\/books\/(b0[a-z0-9]+)\/manifest\.json$/);
  if (mm && manifests[mm[1]]) return out(200, JSON.stringify(manifests[mm[1]]), MIME[".json"]);
  const ch = path.match(/^\/books\/(b0[a-z0-9]+)\/ch(\d)\.txt$/);
  if (ch && manifests[ch[1]]) return out(200, chapterText(Number(ch[2])), MIME[".txt"]);
  const file = path === "/" ? "/index.html" : path;
  if (file.includes(".") && existsSync(join(PUB, file)))
    return out(200, readFileSync(join(PUB, file)), MIME[extname(file)] ?? "application/octet-stream");
  return out(200, readFileSync(join(PUB, "index.html")), MIME[".html"]);
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const BASE = `http://localhost:${HTTP_PORT}`;

// what the phone must show: the vendored module's own answer
const OpenCC = await import("../public/vendor/opencc-cn2t.js");
const hant = OpenCC.Converter({ from: "cn", to: "tw" });
const WANT_PARA = hant(PARA);
const WANT_HEAD = hant(HEAD(1));
if (WANT_PARA === PARA || WANT_PARA.length !== PARA.length || !/頭髮乾淨/.test(WANT_PARA)) {
  console.log(JSON.stringify({ dictionary: `FAIL: cn→tw gave ${JSON.stringify(WANT_PARA)}` }));
  server.close();
  process.exit(1);
}

// --- the browser ---

rmSync(PROFILE, { recursive: true, force: true });
const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: PROFILE, args: ["--window-size=430,900"],
  onFail: () => server.close(),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = async (url) => {
  await send("Page.navigate", { url }, sessionId);
  // the hans book also loads the 1.1 MB dictionary before its first paint
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await evalJs(`!!document.querySelector("#content p[data-off]")`)) break;
  }
  await sleep(200);
};
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  server.close();
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};
const page = () => evalJs(`(() => {
  const ps = [...document.querySelectorAll("#content p[data-off]")];
  return {
    title: document.title,
    bar: document.querySelector("#ctitle")?.textContent ?? null,
    h2: document.querySelector("#content h2.chapter-head")?.textContent ?? null,
    first: ps[0]?.textContent ?? null,
    firstOff: ps[0]?.dataset.off ?? null,
    lastOff: ps[ps.length - 1]?.dataset.off ?? null,
    n: ps.length,
  };
})()`);

const out = {};

// 1. the hans book: everything the reader shows is Traditional, every
//    offset is the raw file's
await nav(`${BASE}/hs`);
const hs = await page();
const rawLastOff = chapterText(1).lastIndexOf(PARA);
out.hansConverted =
  hs.title === `${hant("测试书")} · Bookworm` && hs.bar === WANT_HEAD && hs.h2 === WANT_HEAD &&
  hs.first === WANT_PARA && hs.n === 40 &&
  hs.firstOff === String(HEAD(1).length + 1) && hs.lastOff === String(rawLastOff)
    ? `ok (title, heading, ${hs.n} paragraphs converted; offsets raw)` : `FAIL: ${JSON.stringify(hs)} want ${WANT_HEAD} / ${WANT_PARA}`;

// 2. the 目錄 and the next chapter come through the same converter
const toc = await evalJs(`(() => {
  document.getElementById("tocBtn").click();
  return [...document.querySelectorAll(".toc-item")].map((b) => b.textContent);
})()`);
await evalJs(`document.querySelectorAll(".toc-item")[2].click()`);
await sleep(600);
const ch3 = await page();
out.hansTocAndNext = toc.join("|") === [1, 2, 3].map((i) => hant(HEAD(i))).join("|") &&
  ch3.h2 === hant(HEAD(3)) && ch3.first === WANT_PARA
    ? "ok" : `FAIL: toc=${JSON.stringify(toc)} ch3=${JSON.stringify(ch3)}`;

// 3. the same text without the flag is shown as served: the flag, not a
//    guess about the text, decides
await nav(`${BASE}/pl`);
const pl = await page();
out.plainUntouched = pl.title === "测试书 · Bookworm" && pl.h2 === HEAD(1) && pl.first === PARA && pl.n === 40
  ? "ok" : `FAIL: ${JSON.stringify(pl)}`;

// 4. and back to the hans book in the same session: the bookmark resumes
//    chapter 3, still converted (the converter is per book, the module per
//    session)
await nav(`${BASE}/hs`);
const again = await page();
out.hansAgain = again.h2 === hant(HEAD(3)) && again.first === WANT_PARA
  ? "ok (resumed at chapter 3, converted)" : `FAIL: ${JSON.stringify(again)}`;

await finish(out);
