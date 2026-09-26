// End-to-end proof of online books (DESIGN.md → Online books): a website's
// book registered from a chapter URL, its chapters fetched by the worker the
// first time a reader asks and never again, the health check treating the
// unfetched ones as normal, the index refreshed — by the /admin button and by
// the background look a manifest read triggers — the duplicate refused, and
// the delete sweeping it all.
//
// The site is a stub this file runs: pages in the exact shape novels.com.tw
// serves (encrypted the way its own script decrypts them), so the worker's
// adapter matches the real hostname and fetches the stub. That needs a
// worker of its own, booted with `--var ONLINE_TEST_ORIGIN:<stub>` — this
// suite never attaches to a running dev server, BOOKWORM_URL or not.
//
//   node scripts/test-online-book-e2e.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fetch } from "./retry-fetch.mjs";

const DEV_PORT = 8794;
const STUB_PORT = 8992;
const BASE = `http://localhost:${DEV_PORT}`;
const STUB = `http://localhost:${STUB_PORT}`;
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const SITE = "https://www.novels.com.tw";
const BOOK_PATH = "/novels/nostub0001/";
const INDEX_URL = `${SITE}${BOOK_PATH}`;
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the site ---

const KEY = new TextEncoder().encode("WZc0cbzgY3lhz3X6");
async function encrypt(text) {
  const key = await crypto.subtle.importKey("raw", KEY, { name: "AES-CBC" }, false, ["encrypt"]);
  const bytes = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) }, key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...bytes)).replace(/\//g, "\\/");
}
const site = {
  chapters: [
    { id: 1001, title: "第1 章 開始", pages: [
      `<p> "\r</p><p> 【第1\r</p><p> 章\r</p><p> 開始】\r</p><p> ------------------------------------------\r</p><p> 第一段。\r</p><p> 第二段的前半，</p>`,
      `<p>後半。\r</p><p> 第三段 &amp; 實體。\r</p><p> 第四段。\r</p><p> "\r</p>`,
    ] },
    { id: 1002, title: "第2 章 中段", pages: [`<p> 第二章只有一頁。\r</p>`] },
    { id: 1003, title: "第3 章 末段", pages: [`<p> 第三章也只有一頁。\r</p>`] },
  ],
  hits: new Map(),
};
const EXPECT_CH1 = "第1章　開始\n第一段。\n第二段的前半，後半。\n第三段 & 實體。\n第四段。\n";
const indexHtml = () => `<!doctype html><html><head><meta charset="UTF-8">
<meta property="og:novel:book_name" content="線上測試書"><meta property="og:novel:author" content="作者甲">
<title>「線上測試書」分頁版</title></head><body><img src="${SITE}/ftimg/1/1/1s.jpg"><h1>線上測試書</h1>
<div class="intro"><p><p> 一句簡介\\n</p></p></div>
<div class="chapters"><ul>${site.chapters.map((c) =>
  `<li><a href="${BOOK_PATH}${c.id}.html" title="${c.title}"> ${c.title} </a></li>`).join("")}</ul></div></body></html>`;
const stub = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  site.hits.set(path, (site.hits.get(path) ?? 0) + 1);
  const send = (code, body, type = "text/html; charset=utf-8") => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (path === BOOK_PATH) return send(200, indexHtml());
  if (path === "/ftimg/1/1/1s.jpg") return send(200, "not really a jpeg", "image/jpeg");
  const m = path.match(new RegExp(`^${BOOK_PATH}(\\d+)(?:_(\\d+))?\\.html$`));
  const ch = m && site.chapters.find((c) => c.id === Number(m[1]));
  if (!ch) return send(404, "no");
  const n = Math.min(ch.pages.length, Number(m[2] ?? 1)); // past the last page: the last page again, like the site
  const h1 = ch.pages.length > 1 ? `${ch.title}（${n} / ${ch.pages.length}）` : ch.title;
  send(200, `<html><h1 class="style_h1">${h1}</h1><div id="chapter-content"><script>
window.encryptedContent = "${await encrypt(ch.pages[n - 1])}";
</script>請前往www.novels.com.tw網站繼續全文閱讀</div></html>`);
});
await new Promise((r) => stub.listen(STUB_PORT, r));

// --- the worker ---

const auth = { authorization: `Bearer ${TOKEN}` };
const jsonOf = async (res) => [res.status, await res.json().catch(() => ({}))];
const admin = (path, init = {}) => fetch(`${BASE}${path}`, {
  ...init, headers: { "content-type": "application/json", ...auth, ...(init.headers ?? {}) },
});
let RKEY = {};
const manifestOf = async (id) => {
  const res = await fetch(`${BASE}/books/${id}/manifest.json`, { headers: RKEY, cache: "no-store" });
  return res.ok ? await res.json() : null;
};
const shelf = async (headers = auth) =>
  (await (await fetch(`${BASE}/api/books`, { headers })).json()).books ?? [];
async function delBook(id) {
  let last = {};
  for (let rounds = 0; rounds < 50; rounds++) {
    const res = await admin(`/api/admin/books/${id}${rounds ? "?sweep=1" : ""}`, { method: "DELETE" });
    last = await res.json().catch(() => ({}));
    if (!res.ok || last.done) return { status: res.status, ...last };
  }
  return { status: 0 };
}
// 健康檢查 the way /admin drives it: a page per call, each handing the next
// its phase, cursor and the findings so far
async function auditAll() {
  let body = {};
  for (let i = 0; i < 200; i++) {
    const [, r] = await jsonOf(await admin("/api/admin/audit", { method: "POST", body: JSON.stringify(body) }));
    if (r.done) return r;
    body = { phase: r.phase, cursor: r.cursor, offset: r.offset, findings: r.findings, dropped: r.dropped };
  }
  throw new Error("audit never finished");
}

// a local D1 from before the column: the same guarded ALTER deploy.sh runs
try {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "bookworm", "--local", "--command",
    "ALTER TABLE books ADD COLUMN source TEXT NOT NULL DEFAULT ''"], { stdio: "ignore" });
} catch { /* already there */ }

const dev = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(DEV_PORT),
  "--var", `ONLINE_TEST_ORIGIN:${STUB}`], { stdio: "ignore", env: { ...process.env, CI: "true" } });
const finish = (code) => { dev.kill(); stub.close(); process.exit(code); };
const deadline = Date.now() + 60000;
while (true) {
  try { if ((await fetch(`${BASE}/api/books`, { headers: auth })).ok) break; } catch { /* booting */ }
  if (Date.now() > deadline) { console.error("worker never came up"); finish(1); }
  await sleep(500);
}

let key = "";
try {
  {
    const [st, r] = await jsonOf(await admin("/api/admin/readers", {
      method: "POST", body: JSON.stringify({ user: "onlinee2e", label: "online-book-e2e" }) }));
    if (!r.key) throw new Error(`minting a reader key failed: HTTP ${st}`);
    key = r.key;
    RKEY = { "x-reader-key": key };
  }
  // clean slate: the stub's book from an earlier run
  for (const b of await shelf()) if (b.source === INDEX_URL) await delBook(b.id);

  // 1. only a supported site, and only its book/chapter pages
  const [uStatus, uBody] = await jsonOf(await admin("/api/admin/online", {
    method: "POST", body: JSON.stringify({ url: "https://example.com/novels/x/" }) }));
  const [pStatus] = await jsonOf(await admin("/api/admin/online", {
    method: "POST", body: JSON.stringify({ url: `${SITE}/author/x/` }) }));
  out.unsupportedRefused = uStatus === 400 && /novels\.com\.tw/.test(uBody.error ?? "") && pStatus === 400
    ? "ok (400, names the supported site)" : `FAIL: ${uStatus} ${JSON.stringify(uBody)} ${pStatus}`;

  // 2. a chapter URL registers the whole book: index read once, chapters
  //    listed with estimates, nothing fetched yet
  const [aStatus, added] = await jsonOf(await admin("/api/admin/online", {
    method: "POST", body: JSON.stringify({ url: `${INDEX_URL}1001.html` }) }));
  const ID = added.id;
  const listed = (await shelf()).find((b) => b.id === ID);
  const readerSees = (await shelf(RKEY)).find((b) => b.id === ID);
  out.register =
    aStatus === 200 && added.chapters === 3 && added.title === "線上測試書" && /^[a-z0-9-]+$/.test(added.slug) &&
    listed?.source === INDEX_URL && listed.chapters === 3 && listed.totalChars === 9000 &&
    listed.author === "作者甲" && readerSees?.source === INDEX_URL &&
    site.hits.get(BOOK_PATH) === 1 && ![...site.hits.keys()].some((p) => p.endsWith(".html"))
      ? `ok (${added.slug}: 3 chapters listed, none fetched)`
      : `FAIL: ${aStatus} ${JSON.stringify(added)} ${JSON.stringify(listed)} hits=${JSON.stringify([...site.hits])}`;
  const m0 = await manifestOf(ID);
  out.manifestShape =
    m0?.source?.site === "novels.com.tw" && m0.source.url === INDEX_URL && m0.chapters.length === 3 &&
    m0.chapters[0].src === `${INDEX_URL}1001.html` && m0.chapters[0].chars === 3000 &&
    m0.chapters[0].bytes === undefined && m0.chapters[0].file.startsWith("0000_") && m0.totalChars === 9000
      ? "ok (src per chapter, estimates, no bytes)" : `FAIL: ${JSON.stringify(m0)}`;

  // 3. the first read fetches every page of the chapter; the second reads R2
  const chUrl = `${BASE}/books/${ID}/${encodeURIComponent(m0.chapters[0].file)}?v=${encodeURIComponent(m0.generatedAt)}`;
  const r1 = await fetch(chUrl, { headers: RKEY });
  const t1 = await r1.text();
  const hitsAfterFirst = [site.hits.get(`${BOOK_PATH}1001.html`), site.hits.get(`${BOOK_PATH}1001_2.html`)];
  const r2 = await fetch(chUrl, { headers: RKEY, cache: "no-store" });
  const t2 = await r2.text();
  const hitsAfterSecond = [site.hits.get(`${BOOK_PATH}1001.html`), site.hits.get(`${BOOK_PATH}1001_2.html`)];
  out.chapterOnDemand = r1.status === 200 && t1 === EXPECT_CH1 &&
    hitsAfterFirst.join() === "1,1" && !site.hits.has(`${BOOK_PATH}1001_3.html`)
    ? "ok (two pages fetched, joined at the seam, dressing dropped)"
    : `FAIL: ${r1.status} ${JSON.stringify(t1)} hits=${hitsAfterFirst}`;
  out.chapterCached = r2.status === 200 && t2 === EXPECT_CH1 && hitsAfterSecond.join() === "1,1"
    ? "ok (second read never touched the site)" : `FAIL: ${r2.status} hits=${hitsAfterSecond}`;
  out.chapterGated = (await fetch(chUrl)).status === 401 ? "ok" : "FAIL: chapter answered without a key";

  // 4. the health check: two chapters nobody has opened are not damage
  const audit = await auditAll();
  const mine = (audit.findings ?? []).filter((f) => f.id === ID);
  out.auditClean = mine.length === 0 ? "ok (no incomplete-book for the unfetched chapters)" : `FAIL: ${JSON.stringify(mine)}`;

  // 5. what the site had to give besides text: the sidecar and the 書衣
  const meta = await (await fetch(`${BASE}/books/${ID}/meta.json`, { headers: RKEY })).json().catch(() => null);
  let cover = 0;
  for (let i = 0; i < 20 && cover !== 200; i++) {
    cover = (await fetch(`${BASE}/books/${ID}/cover.jpg`, { method: "HEAD", headers: RKEY, cache: "no-store" })).status;
    if (cover !== 200) await sleep(250);
  }
  out.sidecarAndCover = meta?.author === "作者甲" && meta.synopsis === "一句簡介" && meta.source === INDEX_URL && cover === 200
    ? "ok" : `FAIL: meta=${JSON.stringify(meta)} cover=${cover}`;

  // 6. the site grows; 更新目錄 appends the new chapter and replaces the
  //    fetched chapter's estimate with its real count
  site.chapters.push({ id: 1004, title: "第4 章 新增", pages: [`<p> 新的一章。\r</p>`] });
  const [fStatus, refreshed] = await jsonOf(await admin(`/api/admin/books/${ID}/refresh`, { method: "POST" }));
  const m1 = await manifestOf(ID);
  const realBytes = new TextEncoder().encode(EXPECT_CH1).length;
  out.refresh =
    fStatus === 200 && refreshed.added === 1 && refreshed.chapters === 4 &&
    m1.chapters.length === 4 && m1.chapters[3].src === `${INDEX_URL}1004.html` && m1.chapters[3].file.startsWith("0003_") &&
    m1.chapters[0].chars === EXPECT_CH1.length && m1.chapters[0].bytes === realBytes &&
    m1.chapters[1].chars === 3000 && m1.totalChars === EXPECT_CH1.length + 9000 &&
    (await shelf()).find((b) => b.id === ID)?.chapters === 4
      ? "ok (1 appended, real count reconciled, index row updated)"
      : `FAIL: ${fStatus} ${JSON.stringify(refreshed)} ${JSON.stringify(m1?.chapters)} total=${m1?.totalChars}`;
  const [f2Status, again] = await jsonOf(await admin(`/api/admin/books/${ID}/refresh`, { method: "POST" }));
  out.refreshIdempotent = f2Status === 200 && again.added === 0 && again.chapters === 4
    ? "ok" : `FAIL: ${f2Status} ${JSON.stringify(again)}`;

  // 7. the same book twice is refused, naming the one on the shelf
  const [dStatus, dup] = await jsonOf(await admin("/api/admin/online", {
    method: "POST", body: JSON.stringify({ url: `${INDEX_URL}1002.html` }) }));
  out.duplicateRefused = dStatus === 409 && dup.id === ID && dup.slug === added.slug
    ? "ok (409 with the existing slug)" : `FAIL: ${dStatus} ${JSON.stringify(dup)}`;

  // 8. a stale index is re-read in the background when a reader opens the
  //    book: the response is the stored copy, the next open has the new chapter
  site.chapters.push({ id: 1005, title: "第5 章 又新增", pages: [`<p> 再一章。\r</p>`] });
  m1.source.checkedAt = 0;
  await fetch(`${BASE}/api/admin/objects/${ID}/manifest.json`, {
    method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(m1, null, 2) + "\n" });
  const stale = await manifestOf(ID);
  let grown = null;
  for (let i = 0; i < 40 && grown?.chapters?.length !== 5; i++) { await sleep(250); grown = await manifestOf(ID); }
  out.backgroundRefresh = stale?.chapters?.length === 4 && grown?.chapters?.length === 5 &&
    grown.source.checkedAt > 0 && (await shelf()).find((b) => b.id === ID)?.chapters === 5
    ? "ok (served the stored copy, refreshed behind it)"
    : `FAIL: stale=${stale?.chapters?.length} grown=${grown?.chapters?.length}`;

  // 9. a non-online book has no index to refresh
  const [nStatus, nBody] = await jsonOf(await admin(`/api/admin/books/b0nosuch1/refresh`, { method: "POST" }));
  out.refreshNeedsOnline = nStatus === 404 && nBody.ok === false ? "ok" : `FAIL: ${nStatus} ${JSON.stringify(nBody)}`;

  // 10. gone means gone: files, index row, and the source lookup
  const del = await delBook(ID);
  const [rdStatus, readd] = await jsonOf(await admin("/api/admin/online", {
    method: "POST", body: JSON.stringify({ url: INDEX_URL }) }));
  out.deleteThenReadd = del.done && (await manifestOf(ID)) === null && rdStatus === 200 && readd.id !== ID
    ? "ok" : `FAIL: ${JSON.stringify(del)} readd=${rdStatus}`;
  if (readd.id) await delBook(readd.id);
} catch (err) {
  out.crashed = `FAIL: ${err?.stack ?? err}`;
} finally {
  if (key) await admin(`/api/admin/readers/${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
}

console.log(JSON.stringify(out, null, 2));
finish(JSON.stringify(out).includes("FAIL") ? 1 : 0);
