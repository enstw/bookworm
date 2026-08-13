// E2E for the paper-color selector (背景顏色) and the build stamp: topbar 🎨
// cycle button, per-color CSS variable overrides, dark theme winning over a
// picked paper color, persistence across reloads, the library inheriting the
// color, and the "build …" footer line.
//
// Self-contained — serves public/ plus a synthetic book from an in-process
// static server (no wrangler, no worker APIs involved):
//
//   node scripts/test-bg-e2e.mjs
//
// Runs under node ≥22. Browser discovery is shared — see find-browser.mjs
// (BROWSER_BIN, desktop Chrome/Brave, or playwright's headless shell).
// Screenshots land in /tmp/bookworm-bg-*.png.

import { rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp-client.mjs";

const PORT = 9340;
const HTTP_PORT = 8989;
const PROFILE = "/tmp/bookworm-bg-e2e-profile";
const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// --- synthetic book + static server (public/ with SPA fallback) ---

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};
const PARA = "話說天下大勢，分久必合，合久必分。";
const chapterText = (i) => `第${i}回 測試章節\n\n` + Array(40).fill(PARA).join("\n\n");
const chapters = [1].map((i) => ({
  file: `ch${i}.txt`, title: `第${i}回 測試章節`, chars: chapterText(i).length,
}));
const manifest = { slug: "vt", title: "背景測試", generatedAt: "bg1",
  totalChars: chapters.reduce((a, c) => a + c.chars, 0), chapters };

const settingsPosts = []; // bodies the client pushed to /api/settings
// This page ships BUILD "dev", so "dev…" is the entry the walk must stop at:
// everything above it is news, everything from it down is already running here.
let releasesBody = JSON.stringify({
  releases: [
    { build: "ffffffffffff", date: "2026-08-12", notes: ["離線後連上網會自己補書籤", "wrangler 4.120.0 → 4.121.0"] },
    { build: "eeeeeeeeeeee", date: "2026-08-11", notes: ["另一個改進"] },
    { build: "dev000000000", date: "2026-08-10", notes: ["ALREADY-RUNNING"] },
    { build: "cccccccccccc", date: "2026-08-09", notes: ["OLDER-STILL"] },
  ],
});
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const out = (code, body, type) => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (path === "/api/books") return out(200, '{"books":[]}', MIME[".json"]);
  // a build the page (BUILD "dev") has never heard of → the update note
  if (path === "/api/version") return out(200, '{"build":"e2e-vNEXT"}', MIME[".json"]);
  // the reader-facing release notes the deploy ships alongside the build.
  // Mutable so the same run can also assert the shape of a release that had
  // nothing to say — the case that must NOT grow a 有什麼新的 button.
  if (path === "/releases.json") return out(200, releasesBody, MIME[".json"]);
  // settings:null = server never overrides the test's local state; POSTs are
  // captured so the push path can be asserted
  if (path === "/api/settings") {
    if (req.method !== "POST") return out(200, '{"settings":null}', MIME[".json"]);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { settingsPosts.push(JSON.parse(raw)); } catch { /* ignore */ }
      out(200, '{"ok":true}', MIME[".json"]);
    });
    return;
  }
  if (path.startsWith("/api/")) return out(404, "{}", MIME[".json"]);
  if (path === "/books/vt/manifest.json") return out(200, JSON.stringify(manifest), MIME[".json"]);
  const ch = path.match(/^\/books\/vt\/ch(\d)\.txt$/);
  if (ch) return out(200, chapterText(Number(ch[1])), MIME[".txt"]);
  const file = path === "/" ? "/index.html" : path;
  if (file.includes(".") && existsSync(join(PUB, file)))
    return out(200, readFileSync(join(PUB, file)), MIME[extname(file)] ?? "application/octet-stream");
  return out(200, readFileSync(join(PUB, "index.html")), MIME[".html"]); // SPA reader routes
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const BASE = `http://localhost:${HTTP_PORT}`;

// --- CDP client (same pattern as test-vertical-e2e.mjs) ---

rmSync(PROFILE, { recursive: true, force: true });
// --- CDP client (shared: cdp-client.mjs) ---
const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: PROFILE, args: ["--window-size=900,700"],
  onFail: () => server.close(),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = async (url) => { await send("Page.navigate", { url }, sessionId); await sleep(1200); };
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(`/tmp/bookworm-bg-${name}.png`, Buffer.from(data, "base64"));
};
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  server.close();
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};

// --- the test ---

const out = {};
const bodyBg = () => evalJs(`getComputedStyle(document.body).backgroundColor`);
const dataBg = () => evalJs(`document.documentElement.dataset.bg ?? ""`);
const clickBg = () => evalJs(`document.getElementById("bgBtn").click()`);

// the settings push below needs an identity: an unenrolled device (uid "")
// deliberately keeps settings local, so seed what adoptKey would have stored
await nav(`${BASE}/?shelf`);
await evalJs(`localStorage.setItem("bw_uid", "e2e")`);
await nav(`${BASE}/vt`);
out.rendered = (await evalJs(`document.querySelectorAll("#content p[data-off]").length`)) > 0
  ? "ok" : "FAIL: no paragraphs";
out.btnExists = (await evalJs(`!!document.getElementById("bgBtn")`)) ? "ok" : "FAIL";

// the stub advertises build "e2e-vNEXT": the update note must appear (in
// whatever the interface language is), dismiss on ✕, and stay away
const noteText = await evalJs(`document.querySelector(".updatenote")?.textContent ?? ""`);
out.updateNote = /新版本|new version/i.test(noteText) && noteText.includes("e2e-vNEXT")
  ? "ok (note names the build)" : `FAIL: ${JSON.stringify(noteText)}`;
// 有什麼新的: the notes ship with the build, and the walk stops at the one
// this shell is already running — a reader is never told about their own
// version, nor about anything older than it.
const whatsNew = `document.getElementById("whatsNewBtn")`;
out.whatsNewOffered = (await evalJs(`!!${whatsNew}`)) ? "ok" : "FAIL: no 有什麼新的 button";
out.whatsNewLabel = /有什麼新的|What's new/.test(await evalJs(`${whatsNew}.textContent`))
  ? "ok" : `FAIL: ${await evalJs(`${whatsNew}.textContent`)}`;
out.notesStartHidden = (await evalJs(`document.querySelector(".notelist")?.hidden`)) === true
  ? "ok" : "FAIL: the list was open before it was asked for";
await evalJs(`${whatsNew}.click()`);
const shown = await evalJs(`[...document.querySelectorAll(".notelist li")].map((li) => li.textContent)`);
out.notesShown = JSON.stringify(shown) === JSON.stringify(
  ["離線後連上網會自己補書籤", "wrangler 4.120.0 → 4.121.0", "另一個改進"])
  ? "ok (both newer releases, in order)" : `FAIL: ${JSON.stringify(shown)}`;
out.stopsAtOwnBuild = shown.some((s) => s.includes("ALREADY-RUNNING") || s.includes("OLDER-STILL"))
  ? "FAIL: notes from this build or older reached the reader" : "ok";
out.notesToggleBack = await (async () => {
  await evalJs(`${whatsNew}.click()`);
  return (await evalJs(`document.querySelector(".notelist")?.hidden`)) === true ? "ok" : "FAIL: would not close";
})();

await evalJs(`document.querySelector(".updatenote .iconbtn").click()`);
out.updateDismiss = (await evalJs(`!!document.querySelector(".updatenote")`))
  ? "FAIL: note survived ✕" : "ok";

// a release that said nothing to readers: the pill still announces the build,
// but there must be nothing to expand — an empty "有什麼新的" is worse than none
releasesBody = JSON.stringify({ releases: [] });
await nav(`${BASE}/vt`);
await sleep(500);
out.quietReleaseStillNotes = (await evalJs(`!!document.querySelector(".updatenote")`))
  ? "ok" : "FAIL: the build announcement itself went missing";
out.quietReleaseNoButton = (await evalJs(`!!${whatsNew}`))
  ? "FAIL: offered 有什麼新的 with nothing behind it" : "ok";
await evalJs(`document.querySelector(".updatenote .iconbtn")?.click()`);
// factory default is 金褐 (an explicitly stored choice would win)
out.defaultTitle = (await evalJs(`document.getElementById("bgBtn").title`)) === "背景顏色：金褐"
  ? "ok" : "FAIL: " + (await evalJs(`document.getElementById("bgBtn").title`));
out.defaultBg = (await bodyBg()) === "rgb(224, 203, 151)" ? "ok" : `FAIL: ${await bodyBg()}`;

// one click → 深褐 (the entry after 金褐), with the exact sampled color
await clickBg();
out.firstCycle =
  (await dataBg()) === "dark-brown" && (await bodyBg()) === "rgb(207, 186, 159)"
    ? "ok" : `FAIL: ${await dataBg()} ${await bodyBg()}`;
out.titleUpdates = (await evalJs(`document.getElementById("bgBtn").title`)) === "背景顏色：深褐"
  ? "ok" : "FAIL: " + (await evalJs(`document.getElementById("bgBtn").title`));
await shot("dark-brown");

// 12 more clicks visit every remaining color, pass 預設, and wrap around
const seen = [];
for (let i = 0; i < 12; i++) { await clickBg(); seen.push(await dataBg()); }
out.wrapsToDefault = seen[9] === "" && seen[10] === "light-brown" && new Set(seen).size === 12
  ? "ok" : `FAIL: ${JSON.stringify(seen)}`;

// pick 紫紅 (last color), check the exact sampled color
for (let i = 0; i < 11; i++) await clickBg();
out.magenta = (await dataBg()) === "magenta" && (await bodyBg()) === "rgb(250, 224, 253)"
  ? "ok" : `FAIL: ${await dataBg()} ${await bodyBg()}`;
await shot("magenta");

// the picked color reaches the server: the 2s-debounced settings push
// carries bg=magenta under the enrolled reader id
await sleep(2600);
const pushed = settingsPosts[settingsPosts.length - 1];
out.settingsPushed = pushed?.user === "e2e" && pushed?.settings?.bg === "magenta"
  && Number.isInteger(pushed?.settings?.fontSize) && typeof pushed?.settings?.vertical === "boolean"
  ? "ok" : `FAIL: ${JSON.stringify(pushed)}`;

// dark theme must win over a picked paper color
await evalJs(`localStorage.setItem("bw_theme", "dark"), location.reload()`);
await sleep(1200);
out.darkWins = (await bodyBg()) === "rgb(23, 24, 28)" ? "ok" : `FAIL: ${await bodyBg()}`;
await shot("dark-with-magenta");

// back to light: paper color persisted across reloads
await evalJs(`localStorage.setItem("bw_theme", "light"), location.reload()`);
await sleep(1200);
out.persistsReload = (await dataBg()) === "magenta" && (await bodyBg()) === "rgb(250, 224, 253)"
  ? "ok" : `FAIL: ${await dataBg()} ${await bodyBg()}`;
out.activeClass = (await evalJs(`document.getElementById("bgBtn").classList.contains("active")`))
  ? "ok" : "FAIL";

// library page gets the paper color too, and shows the build stamp with the
// force-refresh button next to it
// bare "/" resumes the open book now — ?shelf is the library's address
await nav(`${BASE}/?shelf`);
out.libraryBg = (await bodyBg()) === "rgb(250, 224, 253)" ? "ok" : `FAIL: ${await bodyBg()}`;
// zh-TW is the shipped default, so the stamp reads 版本 …; startsWith because
// the temporary diagnostics links follow it in the same paragraph
const buildLine = await evalJs(
  `[...document.querySelectorAll(".library p")].map((p) => p.textContent.trim().replace(/\\s+/g, " ")).find((t) => t.startsWith("版本 "))`);
out.buildStamp = buildLine?.startsWith("版本 dev · 重新整理") ? "ok" : `FAIL: ${buildLine}`; // git checkout is unstamped
out.refreshBtn = (await evalJs(`!!document.getElementById("refreshBtn")`))
  ? "ok" : "FAIL: no refresh button";
// the language switch flips the whole shell and is remembered per device
await evalJs(`document.getElementById("langBtn").click()`);
await sleep(300);
const enLine = await evalJs(
  `[...document.querySelectorAll(".library p")].map((p) => p.textContent.trim().replace(/\\s+/g, " ")).find((t) => t.startsWith("build "))`);
out.langSwitch = enLine?.startsWith("build dev · refresh")
  && (await evalJs(`document.documentElement.lang`)) === "en"
  ? "ok" : `FAIL: ${enLine} lang=${await evalJs(`document.documentElement.lang`)}`;
await evalJs(`document.getElementById("langBtn").click()`); // back to 中文
await sleep(300);
out.langSwitchBack = (await evalJs(`document.documentElement.lang`)) === "zh-Hant"
  ? "ok" : `FAIL: ${await evalJs(`document.documentElement.lang`)}`;

await finish(out);
