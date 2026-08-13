// Full in-page E2E of /admin: auth → file → analyze (s2t auto) → upload,
// then the enriched-zip contract (the agent upload path): meta.json + cover
// ride the same form, the cover is transcoded to JPEG in the page, a
// plain-.txt republish leaves both enrichments alone, and the reader-facing
// shelf wears the author on the 書衣's 題簽.
// Drives a headless Chromium via CDP with awaitPromise so async flows finish.
//
// Prereqs: `pnpm run dev` running, ADMIN_TOKEN=test-token-123 in .dev.vars
// (or pass ADMIN_TOKEN=...). Runs under node ≥22 (native fetch/WebSocket).
//
//   node scripts/test-admin-e2e.mjs
const PORT = 9337;
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const ORIGIN = process.env.BOOKWORM_URL ?? "http://localhost:8787";
const URL_ = ORIGIN + "/admin";
import { launch } from "./cdp-client.mjs";
import { zipSync, strToU8 } from "../public/vendor/fflate.js";

// The enriched-book.zip fixture, built the way an agent would: nested under
// a folder (agents zip directories — basename matching must cope), the cover
// deliberately PNG (the page must transcode it to the canonical JPEG), and
// meta.json carrying one key outside the contract (must be dropped).
const COVER_PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0));
const ENRICHED_META = {
  title: "豐收之書", author: "測試作者",
  synopsis: "一本用來驗收 enriched 上傳的書。", junk: "must-be-dropped",
};
const ENRICHED_BODY = [
  "第一章 起風", "　　風起於青萍之末。",
  "第二章 落雨", "　　雨落在瓦上。",
  "第三章 收成", "　　倉裡有了新穀。"].join("\n") + "\n";
const ZIP_B64 = Buffer.from(zipSync({
  "enriched/book.txt": strToU8(ENRICHED_BODY),
  "enriched/meta.json": strToU8(JSON.stringify(ENRICHED_META)),
  "enriched/cover.png": COVER_PNG,
})).toString("base64");

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

// --- the enriched-zip contract, same form, three acts ---

// act 1: upload the agent's payload. meta.json names the book (the form's
// leftover title from the previous cycle must NOT win — nothing was typed
// for THIS file), the PNG becomes a blob: thumbnail, and the page says why
// the charset/簡繁 knobs stepped back.
const enriched = await evalJs(`(async () => {
  const $ = (id) => document.getElementById(id);
  const steps = {};
  const wait = async (fn, n = 100) => {
    for (let i = 0; i < n && !fn(); i++) await new Promise(r => setTimeout(r, 100));
    return fn();
  };
  const bytes = Uint8Array.from(atob("${ZIP_B64}"), c => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "enriched-book.zip", { type: "application/zip" }));
  $("file").files = dt.files;
  $("file").dispatchEvent(new Event("change"));
  $("analyze").click();
  await wait(() => $("summary").textContent);
  steps.title = $("title").value;
  steps.enrichedNote = $("log").textContent.includes("meta.json") ? "ok" : "MISSING enriched note";
  steps.author = $("metaAuthor").hidden ? "MISSING author line" : $("metaAuthor").textContent;
  await wait(() => !$("coverThumb").hidden, 50);
  steps.cover = !$("coverThumb").hidden && $("coverThumb").src.startsWith("blob:")
    ? "ok" : "MISSING cover thumb";
  $("upload").click();
  await wait(() => /[✓✗]/.test($("log").textContent), 200);
  steps.uploadLog = $("log").textContent;
  return steps;
})()`);
out.enriched = { ...enriched, title: enriched.title === "豐收之書" ? "ok" : `FAIL title=${enriched.title}` };

// act 2 (server side): the bucket holds the contract and nothing more —
// meta filtered to known keys, the cover transcoded to a real JPEG under the
// canonical name, the text split into its three chapters — and the shelf
// row itself carries the author (registerBook read the sidecar at publish)
const authH = { authorization: `Bearer ${TOKEN}` };
const books = async () =>
  (await (await fetch(`${ORIGIN}/api/books`, { cache: "no-store", headers: authH })).json()).books ?? [];
const eb = (await books()).find((b) => b.title === "豐收之書");
let man1 = null;
if (eb) {
  const mRes = await fetch(`${ORIGIN}/books/${eb.id}/meta.json`, { headers: authH });
  const meta = mRes.ok ? await mRes.json() : null;
  const cRes = await fetch(`${ORIGIN}/books/${eb.id}/cover.jpg`, { headers: authH });
  const cBytes = cRes.ok ? new Uint8Array(await cRes.arrayBuffer()) : new Uint8Array(2);
  man1 = await (await fetch(`${ORIGIN}/books/${eb.id}/manifest.json`, { headers: authH })).json();
  out.enrichedServerState =
    meta?.author === "測試作者" && meta.synopsis && !("junk" in meta)
    && (mRes.headers.get("content-type") ?? "").includes("application/json")
    && cRes.headers.get("content-type") === "image/jpeg"
    && cBytes[0] === 0xff && cBytes[1] === 0xd8
    && man1?.chapters?.length === 3
    && eb.author === "測試作者"
      ? "ok (meta filtered to the contract, cover a real JPEG, 3 chapters, author on the row)"
      : `FAIL meta=${JSON.stringify(meta)} cover=${cRes.status}/${cRes.headers.get("content-type")} `
        + `magic=${cBytes[0]},${cBytes[1]} chapters=${man1?.chapters?.length} rowAuthor=${eb.author}`;
} else {
  out.enrichedServerState = "FAIL 豐收之書 not on the shelf";
}

// act 3: a plain-.txt republish of the same title lands on the same id and
// leaves the enrichment alone — meta.json and cover.jpg belong to the book,
// not to the upload that happened to carry them
const replay = await evalJs(`(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = async (fn, n = 100) => {
    for (let i = 0; i < n && !fn(); i++) await new Promise(r => setTimeout(r, 100));
    return fn();
  };
  const txt = ["第一章 起風", "　　改版的內文。",
    "第二章 落雨", "　　也改了。", "第三章 收成", "　　都改了。"].join("\\n") + "\\n";
  const dt = new DataTransfer();
  dt.items.add(new File([txt], "豐收之書.txt", { type: "text/plain" }));
  $("file").files = dt.files;
  $("file").dispatchEvent(new Event("change"));
  $("analyze").click();
  await wait(() => $("summary").textContent);
  $("upload").click();
  await wait(() => /[✓✗]/.test($("log").textContent), 200);
  return { title: $("title").value, uploadLog: $("log").textContent };
})()`);
const eb2 = (await books()).find((b) => b.title === "豐收之書");
if (eb && eb2) {
  const meta2 = await (await fetch(`${ORIGIN}/books/${eb2.id}/meta.json`, { headers: authH })).json().catch(() => null);
  const cRes2 = await fetch(`${ORIGIN}/books/${eb2.id}/cover.jpg`, { headers: authH });
  const man2 = await (await fetch(`${ORIGIN}/books/${eb2.id}/manifest.json`, { headers: authH })).json();
  out.republishKeepsEnrichment =
    eb2.id === eb.id && meta2?.author === "測試作者" && cRes2.ok
    && man2.generatedAt !== man1?.generatedAt
    && eb2.author === "測試作者"
      ? "ok (same id, meta, cover and shelf-row author survive, manifest re-generated)"
      : `FAIL id=${eb.id}→${eb2.id} meta=${JSON.stringify(meta2)} cover=${cRes2.status} `
        + `regenerated=${man2.generatedAt !== man1?.generatedAt} rowAuthor=${eb2.author} log=${replay.uploadLog}`;
} else {
  out.republishKeepsEnrichment = `FAIL book lost: before=${!!eb} after=${!!eb2} log=${replay.uploadLog}`;
}

// act 4: the reader-facing shelf wears it — the 題簽 on the 書衣 carries the
// author under the title. Through a real reader key: "/" sits behind the
// reader gate, and the admin token in localStorage means nothing to it.
if (eb2) {
  const mint = await (await fetch(`${ORIGIN}/api/admin/readers`, {
    method: "POST", headers: { ...authH, "content-type": "application/json" },
    body: JSON.stringify({ user: "admin-e2e", label: "slip-check" }),
  })).json();
  // enrolling a never-enrolled profile lands on the install guide, not the
  // shelf (auth-e2e proves that path) — this act is about the 題簽, so mark
  // the guide seen before walking through the door. Same origin as /admin.
  // And drop the bw_books cache: with one, the shelf paints it and refreshes
  // through a CAPPED fetch that a busy CI server can outlast — the stale
  // paint (with or without an old copy of this fixture) must not be what
  // the assertion reads. No cache → the uncapped network paint, every run.
  await evalJs(`{ localStorage.setItem("bw_install_seen", "1");
                  localStorage.removeItem("bw_books"); }`);
  await send("Page.navigate",
    { url: `${ORIGIN}/?key=${encodeURIComponent(mint.key)}` }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
  const slip = await evalJs(`(async () => {
    // the shelf paints the bw_books cache first and repaints when /api/books
    // answers — wait for THIS book's row, not for the first paint
    for (let i = 0; i < 100; i++) {
      const row = [...document.querySelectorAll(".book-row")]
        .find(r => r.querySelector(".slip")?.textContent.includes("豐收之書"));
      if (row) return row.querySelector(".slip-author")?.textContent ?? "(no slip-author)";
      await new Promise(r => setTimeout(r, 100));
    }
    const api = await fetch("/api/books").then(async r => r.status + " " +
      JSON.stringify(((await r.json().catch(() => ({}))).books ?? []).map(b => b.title)), e => "ERR " + e.message);
    return "(no row) shelfHidden=" + document.getElementById("shelfScreen")?.hidden
      + " slips=" + JSON.stringify([...document.querySelectorAll(".book-row .slip")].map(s => s.textContent))
      + " api=" + api + " url=" + location.href.replace(/key=[^&]*/, "key=…");
  })()`);
  out.shelfSlip = slip === "測試作者"
    ? "ok (題簽 carries the author)" : `FAIL slip author=${slip}`;
  await fetch(`${ORIGIN}/api/admin/readers/${encodeURIComponent(mint.key)}`,
    { method: "DELETE", headers: authH });
} else {
  out.shelfSlip = "FAIL no enriched book to look for";
}

// sweep the fixture book back off the shelf (books DELETE pages like /admin)
if (eb2 ?? eb) {
  const id = (eb2 ?? eb).id;
  for (let round = 0; round < 50; round++) {
    const res = await fetch(`${ORIGIN}/api/admin/books/${encodeURIComponent(id)}${round ? "?sweep=1" : ""}`,
      { method: "DELETE", headers: authH });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.done) break;
  }
}
out.enrichedCleanup = (await books()).some((b) => b.title === "豐收之書")
  ? "FAIL fixture book still on the shelf" : "ok (gone)";

console.log(JSON.stringify(out, null, 2));
await close();
process.exit(JSON.stringify(out).match(/FAIL|MISSING|DID NOT|STILL/) ? 1 : 0);
