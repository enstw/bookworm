// Full in-page E2E of /admin: auth → file → analyze (s2t auto) → upload.
// Drives a headless Chromium via CDP with awaitPromise so async flows finish.
//
// Prereqs: `pnpm run dev` running, ADMIN_TOKEN=test-token-123 in .dev.vars
// (or pass ADMIN_TOKEN=...). Runs under node ≥22 (native fetch/WebSocket).
//
//   node scripts/test-admin-e2e.mjs
const PORT = 9337;
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const URL_ = (process.env.BOOKWORM_URL ?? "http://localhost:8787") + "/admin";
import { launch } from "./cdp-client.mjs";

// --- CDP client (shared: cdp-client.mjs) ---
const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: "/tmp/bookworm-e2e-profile",
});
const nav = () =>
  new Promise(async (res) => {
    await send("Page.navigate", { url: URL_ }, sessionId);
    setTimeout(res, 1500);
  });

await nav();
await evalJs(`localStorage.setItem("bookworm:admin-token", ${JSON.stringify(TOKEN)})`);
await nav(); // initAuth runs with the stored token

const out = await evalJs(`(async () => {
  const $ = (id) => document.getElementById(id);
  const steps = {};
  // wait for initAuth to unhide the picker
  for (let i = 0; i < 50 && $("pick").hidden; i++) await new Promise(r => setTimeout(r, 100));
  steps.authGate = !$("pick").hidden ? "unlocked" : "STILL LOCKED";

  // synthetic simplified book, injected as if picked from the Files app
  const txt = ["书名页",
    "第一章 惊蛰开门", "　　龙抬头，头发很乱。这是简体测试。",
    "第二章 万里无云", "　　书剑恩仇，对错难分。",
    "第三章 龙门客栈", "　　几个人坐在门槛上。"].join("\\n");
  const dt = new DataTransfer();
  dt.items.add(new File([txt], "测试书.txt", { type: "text/plain" }));
  $("file").files = dt.files;
  $("file").dispatchEvent(new Event("change"));
  steps.autoFill = { title: $("title").value, slug: $("slug").value };

  $("analyze").click();
  for (let i = 0; i < 100 && !$("summary").textContent; i++) await new Promise(r => setTimeout(r, 200));
  steps.summary = $("summary").textContent;
  steps.converted = { title: $("title").value, slug: $("slug").value };
  steps.preview = [...$("chapterPreview").children].map(li => li.textContent);

  $("upload").click();
  for (let i = 0; i < 100 && !$("log").textContent.includes("✓") && !$("log").textContent.includes("✗"); i++)
    await new Promise(r => setTimeout(r, 200));
  steps.uploadLog = $("log").textContent;
  return steps;
})()`);

// The same page manages what it uploaded: reload so the book list picks up
// the book just published, then retitle + re-slug it in one save and delete
// it. No prompt() anywhere on this page, so it drives from CDP directly.
await nav();

const manage = await evalJs(`(async () => {
  const steps = {};
  const wait = async (fn, n = 100) => {
    for (let i = 0; i < n && !fn(); i++) await new Promise(r => setTimeout(r, 100));
    return fn();
  };
  await wait(() => document.querySelectorAll(".book").length);
  const rowFor = (slug) =>
    [...document.querySelectorAll(".book")].find(r => r.querySelector("code")?.textContent === slug);

  // "测试书" → 繁 "測試書" → pinyin initials "css" (the house slug rule)
  const row = rowFor("css");
  steps.rowFound = row ? "ok" : "MISSING ROW for css";
  if (!row) return steps;

  // 修改: both fields at once — a retitle and a re-slug are one save
  row.querySelector(".book-head button").click();
  const [title, slug] = row.querySelectorAll(".panel input");
  title.value = "改過的測試書";
  slug.value = "cs9";
  row.querySelector(".panel .btn.primary").click();
  await wait(() => row.querySelector(".msg.ok") || row.querySelector(".msg.err"));
  steps.save = row.querySelector(".msg")?.textContent ?? "(no message)";
  await wait(() => rowFor("cs9"));
  const moved = rowFor("cs9");
  steps.listRefreshed = moved
    ? moved.querySelector(".name").textContent
    : "LIST DID NOT REFRESH";
  if (!moved) return steps;

  // 刪除: the wrong slug must refuse before the right one goes through
  const [, delBtn] = moved.querySelectorAll(".book-head button");
  delBtn.click();
  const panel = moved.querySelectorAll(".panel")[1];
  const typed = panel.querySelector("input");
  typed.value = "wrong";
  panel.querySelector(".btn.danger").click();
  await new Promise(r => setTimeout(r, 300));
  steps.deleteGuard = moved.querySelector(".msg")?.textContent ?? "(no message)";
  typed.value = "cs9";
  panel.querySelector(".btn.danger").click();
  await wait(() => document.getElementById("booksMsg").textContent, 200);
  steps.deleted = document.getElementById("booksMsg").textContent;
  steps.rowGone = rowFor("cs9") ? "STILL LISTED" : "ok";
  return steps;
})()`);

// the Bearer, not a bare fetch: the shelf list sits behind the reader gate
const shelf = (await (await fetch(`${process.env.BOOKWORM_URL ?? "http://localhost:8787"}/api/books`,
  { cache: "no-store", headers: { authorization: `Bearer ${TOKEN}` } })).json()).books ?? [];
out.manage = manage;
out.manageServerState = shelf.some((b) => b.slug === "cs9" || b.slug === "css")
  ? "FAIL book still on the shelf: " + JSON.stringify(shelf.map((b) => b.slug))
  : "ok (gone from /api/books too)";

console.log(JSON.stringify(out, null, 2));
await close();
process.exit(JSON.stringify(out).match(/FAIL|MISSING|DID NOT|STILL/) ? 1 : 0);
