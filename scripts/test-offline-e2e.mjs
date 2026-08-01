// E2E for the offline chapter cache (-5/+50 window + service worker).
//
// Two stages, so "offline" is real (server actually down), not emulated —
// DevTools network emulation does not reliably apply to service workers:
//
//   pnpm run dev &                            # with ADMIN_TOKEN=test-token-123
//   node scripts/test-offline-e2e.mjs prime   # upload the book, verify the
//                                             # default-on window, the ⇣ in
//                                             # the reader and on the shelf,
//                                             # and eviction
//   <stop the dev server>
//   node scripts/test-offline-e2e.mjs offline # same browser profile, no
//                                             # server: reader must still work
//
// Runs under node ≥22 (native fetch/WebSocket).

import { rmSync } from "node:fs";
import { launch } from "./cdp-client.mjs";

const STAGE = process.argv[2];
if (!["prime", "offline"].includes(STAGE)) {
  console.error("usage: node scripts/test-offline-e2e.mjs <prime|offline>");
  process.exit(1);
}
const PORT = 9338;
const PROFILE = "/tmp/bookworm-offline-e2e-profile";
const BASE = process.env.BOOKWORM_URL ?? "http://localhost:8787";
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const SLUG = "offline-e2e";
const CHAPTERS = 100;

// --- stage prime: publish a synthetic book through the admin API ---
let KEY = "";
if (STAGE === "prime") {
  rmSync(PROFILE, { recursive: true, force: true }); // fresh browser state
  const put = async (name, body, type) => {
    const res = await fetch(`${BASE}/api/admin/objects/${SLUG}/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": type },
      body,
    });
    if (!res.ok) throw new Error(`PUT ${name}: HTTP ${res.status}`);
  };
  const entries = [];
  for (let i = 0; i < CHAPTERS; i++) {
    const title = `第${i + 1}章 測試`;
    const body = `${title}\n　　這是第 ${i + 1} 章的內容。`.padEnd(120, "水") + "\n";
    const file = `${String(i).padStart(4, "0")}_${title.replace(/\s+/g, "-")}.txt`;
    await put(file, body, "text/plain; charset=utf-8");
    entries.push({ title, file, chars: body.length });
  }
  await put("manifest.json", JSON.stringify({
    slug: SLUG, title: "離線測試", charset: "utf-8",
    totalChars: entries.reduce((a, c) => a + c.chars, 0),
    chapters: entries,
    generatedAt: new Date().toISOString(), // exercises the ?v= chapter URLs
  }), "application/json");
  // Reading is behind the gate now: mint this run a key bound to the same
  // reader id the suite has always used, so the pinned position below and
  // the browser's window-centring agree on whose bookmark it is. The
  // browser profile enrolls with it before opening the book (the cookie it
  // earns is also what the offline stage reads with).
  const rres = await fetch(`${BASE}/api/admin/readers`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ user: "e2e-tester", label: "offline-e2e" }),
  });
  KEY = (await rres.json().catch(() => ({}))).key ?? "";
  if (!KEY) throw new Error(`minting a reader key failed: HTTP ${rres.status}`);
  // An earlier run leaves this reader's position in the local D1, and both the
  // reader and the shelf's ⇣ centre their window on it — so without pinning it
  // back to chapter 0, every count below shifts depending on whether this test
  // has been run before.
  await fetch(`${BASE}/api/position`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-reader-key": KEY },
    body: JSON.stringify({ book: SLUG, chapter: 0, offset: 0 }),
  });
  console.log(`published ${CHAPTERS}-chapter test book "${SLUG}"`);
}

// --- CDP client (shared: cdp-client.mjs) ---
const { evalJs, send, close, sessionId } = await launch({ port: PORT, profile: PROFILE });
const nav = async (url) => {
  await send("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
};
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  const bad = JSON.stringify(out).includes("FAIL");
  process.exit(bad ? 1 : 0);
};

const cachedCount = `(async () => {
  const keys = await (await caches.open("bw-book-${SLUG}")).keys();
  return keys.filter((r) => new URL(r.url).pathname.endsWith(".txt")).length;
})()`;
const waitFor = async (expr, pred, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr);
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return await evalJs(expr);
};

if (STAGE === "prime") {
  const out = {};
  // enroll this profile: the /?key= swallow earns the cookie every later
  // request (and the whole offline stage's profile) rides on
  await nav(`${BASE}/?key=${encodeURIComponent(KEY)}`);
  out.enrolled = await evalJs(`localStorage.getItem("bw_uid")`) === "e2e-tester"
    ? "ok" : "FAIL: key link did not enroll";
  await nav(`${BASE}/${SLUG}`);
  await evalJs(`navigator.serviceWorker.ready.then(() => "sw-ready")`);
  out.rendered = await waitFor(
    `document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0) > 0 ? "ok" : "FAIL";

  // the safety net is on by default — nothing toggled yet. At chapter 0 the
  // implicit window is [0, 5] → 6 chapters.
  out.implicitWindow = await waitFor(cachedCount, (n) => n === 6);
  if (out.implicitWindow !== 6) out.implicitWindow = `FAIL: ${out.implicitWindow}`;

  // first ⇣ tap arms the full window: [0, 50] → 51
  await evalJs(`document.getElementById("offlineBtn").click()`);
  out.armed = await waitFor(cachedCount, (n) => n === 51);
  if (out.armed !== 51) out.armed = `FAIL: ${out.armed}`;

  // second tap turns off, and off drops the whole book
  await evalJs(`document.getElementById("offlineBtn").click()`);
  const gone = await waitFor(`caches.has("bw-book-${SLUG}")`, (v) => v === false);
  out.toggledOff = gone === false ? "ok" : "FAIL: cache survived the toggle";
  out.offFlag = await evalJs(`localStorage.getItem("bw_offline_${SLUG}")`) === "0"
    ? "ok" : "FAIL: off was not recorded";

  // the shelf re-arms it: ⇣ on the book card downloads the window without the
  // book ever being opened in this tab (bare "/" resumes the book now, so
  // the shelf lives at ?shelf)
  await nav(`${BASE}/?shelf`);
  const btnSel = `document.querySelector('.book-row[data-slug="${SLUG}"] .shelf-offline')`;
  out.shelfBtn = await waitFor(`!!${btnSel}`, (v) => v === true) ? "ok" : "FAIL: no ⇣ on the card";
  await evalJs(`${btnSel}.click()`);
  // centred on wherever the server says this reader is, so only the floor is
  // fixed: a window is at least OFFLINE_AHEAD + 1 chapters
  out.shelfSaved = await waitFor(cachedCount, (n) => n >= 51);
  if (!(out.shelfSaved >= 51)) out.shelfSaved = `FAIL: ${out.shelfSaved}`;
  out.shelfFlag = await evalJs(`localStorage.getItem("bw_offline_${SLUG}")`) === "1"
    ? "ok" : "FAIL: the shelf did not turn the cache back on";

  // back in the reader: jump to chapter 21 (idx 20) → window [15, 70] → 56
  // chapters, 0000 evicted. This is also the state stage "offline" reads.
  await nav(`${BASE}/${SLUG}`);
  await waitFor(`document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0);
  await evalJs(`openChapter(20, 0)`);
  out.windowAtCh21 = await waitFor(cachedCount, (n) => n === 56);
  if (out.windowAtCh21 !== 56) out.windowAtCh21 = `FAIL: ${out.windowAtCh21}`;
  const evicted = await evalJs(`(async () => {
    const c = await caches.open("bw-book-${SLUG}");
    const hitOld = await c.match(bookUrl("0000_第1章-測試.txt"));
    const hitNew = await c.match(bookUrl("0015_第16章-測試.txt"));
    return { old: !!hitOld, new: !!hitNew };
  })()`);
  out.eviction = !evicted.old && evicted.new ? "ok" : `FAIL: ${JSON.stringify(evicted)}`;
  await finish(out);
}

if (STAGE === "offline") {
  const out = {};
  await nav(`${BASE}/${SLUG}`);
  // server is down: the SW must serve the shell, manifest, and chapters
  out.title = await evalJs(`document.title`);
  out.rendered = await waitFor(
    `document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0) > 0 ? "ok" : "FAIL";
  out.chapterTitle = await evalJs(`document.getElementById("ctitle")?.textContent`);
  // the headline contract: an installed phone reopens at "/", and with no
  // server at all that must land INSIDE the book at the local bookmark —
  // not on the shelf, not on a spinner
  await nav(`${BASE}/`);
  const resumeCount = await waitFor(
    `document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0);
  const resumeTitle = await evalJs(`document.getElementById("ctitle")?.textContent`);
  out.rootResumes = resumeCount > 0 && /第\d+章 測試/.test(resumeTitle ?? "")
    ? `ok (resumed at ${resumeTitle})` : `FAIL: count=${resumeCount} title=${resumeTitle}`;
  // navigate within the cached window [15, 70]
  await evalJs(`openChapter(25, 0)`);
  out.midWindow = await waitFor(
    `document.getElementById("ctitle")?.textContent`, (t) => t === "第26章 測試");
  if (out.midWindow !== "第26章 測試") out.midWindow = `FAIL: ${out.midWindow}`;
  await evalJs(`openChapter(70, 0)`);
  out.windowEdge = await waitFor(
    `document.getElementById("ctitle")?.textContent`, (t) => t === "第71章 測試");
  if (out.windowEdge !== "第71章 測試") out.windowEdge = `FAIL: ${out.windowEdge}`;
  // chapter 91 (idx 90) was never in any window nor ever fetched — must fail
  // gracefully with the retry UI, not crash
  await evalJs(`openChapter(90, 0)`);
  // the message comes out in whatever the interface language is, and that is
  // 中文 unless this device has switched — so accept either wording
  const failed = /載入失敗|Failed to load/;
  const failText = await waitFor(
    `document.getElementById("content").textContent`, (t) => failed.test(t));
  out.outsideWindow = failed.test(failText) ? "graceful retry UI" : `FAIL: ${failText}`;
  // the explicit shelf address still answers offline: the stale list from
  // localStorage, not a dead loading screen
  await nav(`${BASE}/?shelf`);
  const shelfRow = await waitFor(
    `!!document.querySelector('.book-row[data-slug="${SLUG}"]')`, (v) => v === true);
  out.shelfOffline = shelfRow === true ? "ok (stale list rendered)" : "FAIL: no book row";
  await finish(out);
}
