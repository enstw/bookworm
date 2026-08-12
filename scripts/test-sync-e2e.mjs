// E2E for the background bookmark pull — the reader's answer to "another
// device moved on while this one sat open".
//
// The boot reconcile (resolvePosition) runs once per page load, and an
// installed PWA is reopened, not reloaded: a device that opened offline, or
// opened before the phone read ahead, used to hold that first answer for as
// long as the app stayed alive. checkRemotePosition re-runs the reconcile on
// the foreground flip and on the network's return, and offers the jump as a
// pill instead of moving the page.
//
// The suite drives both halves the way the app sees them: the "other device"
// is a plain POST /api/position with the same reader key (positions belong to
// the key's user, so that IS a second device as far as the row is concerned),
// and the foreground flip is a visibilitychange dispatched on a page that
// really is visible — the branch the handler takes when a phone comes back.
//
// It also pins the listener-registration contract: initReader re-enters on a
// repaired 401, and the window must still carry ONE set of reader listeners.
//
// Prereqs: `pnpm run dev` running, ADMIN_TOKEN in .dev.vars.
//
//   node scripts/test-sync-e2e.mjs

import { rmSync } from "node:fs";
import { launch } from "./cdp-client.mjs";

const PORT = 9344;
const PROFILE = "/tmp/bookworm-sync-e2e-profile";
const BASE = process.env.BOOKWORM_URL ?? "http://localhost:8787";
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const SLUG = "sync-e2e";
const USER = "e2e-sync";
const CHAPTERS = 8;
const auth = { authorization: `Bearer ${TOKEN}` };
const title = (i) => `第${i + 1}章 同步`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(PROFILE, { recursive: true, force: true }); // fresh browser state

// --- publish a synthetic book through the admin API ---
const put = async (name, body, type) => {
  const res = await fetch(`${BASE}/api/admin/objects/${SLUG}/${encodeURIComponent(name)}`, {
    method: "PUT", headers: { ...auth, "content-type": type }, body,
  });
  if (!res.ok) throw new Error(`PUT ${name}: HTTP ${res.status}`);
};
const entries = [];
for (let i = 0; i < CHAPTERS; i++) {
  const file = `${String(i).padStart(4, "0")}_${title(i).replace(/\s+/g, "-")}.txt`;
  const body = `${title(i)}\n　　這是第 ${i + 1} 章的內容。`.padEnd(400, "水") + "\n";
  await put(file, body, "text/plain; charset=utf-8");
  entries.push({ title: title(i), file, chars: body.length });
}
await put("manifest.json", JSON.stringify({
  slug: SLUG, title: "同步測試", charset: "utf-8",
  totalChars: entries.reduce((a, c) => a + c.chars, 0),
  chapters: entries,
  generatedAt: new Date().toISOString(),
}), "application/json");

const rres = await fetch(`${BASE}/api/admin/readers`, {
  method: "POST", headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ user: USER, label: "sync-e2e" }),
});
const KEY = (await rres.json().catch(() => ({}))).key ?? "";
if (!KEY) throw new Error(`minting a reader key failed: HTTP ${rres.status}`);

const otherDevice = (chapter, offset) =>
  fetch(`${BASE}/api/position`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-reader-key": KEY },
    body: JSON.stringify({ book: SLUG, chapter, offset, updatedAt: Date.now() }),
  });
const rowNow = async () => (await (await fetch(
  `${BASE}/api/position?book=${SLUG}`, { headers: { "x-reader-key": KEY } })).json()).position;
// the row is also how we know this device's own push has landed — a check
// that runs while state.dirty is still set returns early by design, so every
// assertion below waits for the queue to be empty before poking the page
const waitRow = async (chapter, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const row = await rowNow();
    if (row?.chapter === chapter) return row;
    await sleep(250);
  }
  return await rowNow();
};

await otherDevice(0, 0); // an earlier run's row must not decide this one

// --- browser ---
const { evalJs, send, close, sessionId } = await launch({ port: PORT, profile: PROFILE });
const nav = async (url) => {
  await send("Page.navigate", { url }, sessionId);
  await sleep(1500);
};
const waitFor = async (expr, pred, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const v = await evalJs(expr);
    if (pred(v)) return v;
    await sleep(250);
  }
  return await evalJs(expr);
};
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  await fetch(`${BASE}/api/admin/readers/${encodeURIComponent(KEY)}`, { method: "DELETE", headers: auth });
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};
const foreground = async () => {
  await evalJs(`document.dispatchEvent(new Event("visibilitychange"))`);
  await sleep(800); // the check is a network round trip
};
const pillText = `document.querySelector(".syncnote .jumpnote-text")?.textContent ?? ""`;
const pillCount = `document.querySelectorAll(".syncnote").length`;
const chapterShown = `document.getElementById("ctitle")?.textContent ?? ""`;

const out = {};
await nav(`${BASE}/?key=${encodeURIComponent(KEY)}`);
out.enrolled = await evalJs(`localStorage.getItem("bw_uid")`) === USER
  ? "ok" : "FAIL: the key link did not enroll";

await nav(`${BASE}/${SLUG}`);
out.opened = await waitFor(`document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0) > 0
  ? "ok" : "FAIL: the reader never rendered";
out.openedAt = await evalJs(chapterShown) === title(0)
  ? "ok" : `FAIL: opened at ${await evalJs(chapterShown)}`;

// 1. nothing moved anywhere: a foreground flip must stay silent
await foreground();
out.quiet = await evalJs(pillText) === "" ? "ok" : `FAIL: unprompted pill "${await evalJs(pillText)}"`;

// 2. the other device reads on to chapter 6. The flip offers the jump — and
//    the page does NOT move on its own; text must not move under a reader.
await otherDevice(5, 0);
await foreground();
const offered = await evalJs(pillText);
out.offered = offered.includes(title(5)) ? "ok" : `FAIL: pill said "${offered}"`;
out.offeredPhrasing = /另一台裝置|Another device/.test(offered) ? "ok" : `FAIL: pill said "${offered}"`;
out.didNotMove = await evalJs(chapterShown) === title(0)
  ? "ok" : "FAIL: the page moved without being asked";

// 3. asked once: the same remote row must not re-raise on every flip
await foreground();
const pills = await evalJs(pillCount);
out.notRepeated = pills === 1 ? "ok" : `FAIL: ${pills} pills for one remote position`;

// 4. tapping it lands there, and this device's arrival is what the row holds
//    afterwards — following a bookmark is this device reading, not an echo.
//    (Guarded: with no pill on screen the rest of the run has nothing to say,
//    and a report that names the missing step beats a stack trace that leaks
//    the browser and the minted key.)
const tapped = await evalJs(`(() => {
  const btn = document.querySelector(".syncnote .linklike");
  if (!btn) return false;
  btn.click();
  return true;
})()`);
if (!tapped) {
  out.jumped = "FAIL: no pill to tap — the rest of the run is moot";
  await finish(out);
}
out.jumped = await waitFor(chapterShown, (s) => s === title(5)) === title(5)
  ? "ok" : `FAIL: landed on ${await evalJs(chapterShown)}`;
out.pillCleared = await evalJs(pillCount) === 0 ? "ok" : "FAIL: the pill outlived the jump";
out.pushedBack = (await waitRow(5))?.chapter === 5 ? "ok" : "FAIL: the jump never reached the row";

// 5. same chapter is not worth a pill — two devices a few paragraphs apart
//    settle themselves, and naming the chapter the reader is in says nothing
await otherDevice(5, 200);
await foreground();
out.sameChapterQuiet = await evalJs(pillCount) === 0
  ? "ok" : "FAIL: pill for a same-chapter difference";

// 6. backwards is still a move: the check is driven by the timestamp, not by
//    the direction. A phone that jumped back to chapter 2 is news too.
await otherDevice(1, 0);
await foreground();
const back = await evalJs(pillText);
out.backwardsOffered = back.includes(title(1)) ? "ok" : `FAIL: pill said "${back}"`;

// 7. the listener contract. Clearing the cookie AND the book cache makes the
//    manifest 401 with nothing local to fall back on, which is the path
//    reauth repairs by re-entering initReader.
await evalJs(`caches.keys().then((ks) =>
  Promise.all(ks.filter((k) => k.startsWith("bw-book")).map((k) => caches.delete(k))))`);
await send("Network.enable", {}, sessionId);
await send("Network.clearBrowserCookies", {}, sessionId);
await nav(`${BASE}/${SLUG}`);
out.reentered = await waitFor(`document.querySelectorAll("#content p[data-off]").length`, (n) => n > 0) > 0
  ? "ok" : "FAIL: the repaired 401 never rendered the book";
// Counted per registration SITE, not per event type: two owners for one type
// is normal and correct (app.js and player.mjs both flush on pagehide), while
// the same source line appearing twice is exactly and only the bug.
const { result } = await send("Runtime.evaluate", { expression: "window" }, sessionId);
const { listeners } = await send("DOMDebugger.getEventListeners", { objectId: result.objectId }, sessionId);
const counted = {};
for (const l of listeners) {
  const site = `${l.type}@${l.scriptId}:${l.lineNumber}:${l.columnNumber}`;
  counted[site] = (counted[site] ?? 0) + 1;
}
const doubled = Object.entries(counted).filter(([, n]) => n > 1);
out.listenersOnce = doubled.length === 0
  ? `ok (${listeners.length} on window, all distinct)`
  : `FAIL: ${doubled.map(([s, n]) => `${s}×${n}`).join(", ")}`;

await finish(out);
