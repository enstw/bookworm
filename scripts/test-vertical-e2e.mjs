// E2E for vertical reading (直排): writing-mode toggle, horizontal document
// scroll, offset tracking/restore in both orientations, arrow-key flip, and
// the library staying horizontal while the toggle is on. Also covers the
// reading-surface chrome: bars hidden by default, middle-ninth tap toggling
// them, bottom-quarter tap paging, and the font/line-height defaults.
//
// Self-contained — serves public/ plus a synthetic book from an in-process
// static server (no wrangler, no worker APIs involved):
//
//   node scripts/test-vertical-e2e.mjs
//
// Runs under node ≥22. Browser discovery is shared — see find-browser.mjs
// (BROWSER_BIN, desktop Chrome/Brave, or playwright's headless shell).
// Screenshots land in /tmp/bookworm-vertical-*.png.

import { rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp-client.mjs";

const PORT = 9339;
const HTTP_PORT = 8988;
const PROFILE = "/tmp/bookworm-vertical-e2e-profile";
const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// --- synthetic book + static server (public/ with SPA fallback) ---

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};
const PARA = "話說天下大勢，分久必合，合久必分。周末七國分爭，併入於秦。及秦滅之後，楚、漢分爭，又併入於漢。漢朝自高祖斬白蛇而起義，一統天下，後來光武中興，傳至獻帝，遂分為三國。推其致亂之由，殆始於桓、靈二帝。";
const chapterText = (i) => `第${i}回 測試章節\n\n` + Array(60).fill(PARA).join("\n\n");
const chapters = [1, 2, 3].map((i) => ({
  file: `ch${i}.txt`, title: `第${i}回 測試章節`, chars: chapterText(i).length,
}));
// id ≠ slug on purpose: the reader must fetch chapters by the id it resolved,
// not by the slug in the address bar (they are only equal for books published
// before ids existed, which would hide a regression here)
const BOOK_ID = "b0vert01";
const manifest = {
  id: BOOK_ID, slug: "vt", title: "直排測試", generatedAt: "vt1",
  totalChars: chapters.reduce((a, c) => a + c.chars, 0), chapters,
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const out = (code, body, type) => { res.writeHead(code, { "content-type": type }); res.end(body); };
  // settings:null = server never overrides the test's local state
  if (path === "/api/settings")
    return out(200, req.method === "POST" ? '{"ok":true}' : '{"settings":null}', MIME[".json"]);
  if (path === "/api/books")
    return out(200, JSON.stringify({ books: [{
      id: BOOK_ID, slug: "vt", title: "直排測試", chapters: 3,
      totalChars: manifest.totalChars, progress: { chapter: 1, pct: 42.5 },
    }] }), MIME[".json"]);
  if (path === "/api/books/vt")
    return out(200, JSON.stringify({ book: {
      id: BOOK_ID, slug: "vt", title: "直排測試", chapters: 3,
      totalChars: manifest.totalChars,
    } }), MIME[".json"]);
  if (path.startsWith("/api/")) return out(404, "{}", MIME[".json"]);
  if (path === `/books/${BOOK_ID}/manifest.json`) return out(200, JSON.stringify(manifest), MIME[".json"]);
  const ch = path.match(new RegExp(`^/books/${BOOK_ID}/ch(\\d)\\.txt$`));
  if (ch) return out(200, chapterText(Number(ch[1])), MIME[".txt"]);
  const file = path === "/" ? "/index.html" : path;
  if (file.includes(".") && existsSync(join(PUB, file)))
    return out(200, readFileSync(join(PUB, file)), MIME[extname(file)] ?? "application/octet-stream");
  return out(200, readFileSync(join(PUB, "index.html")), MIME[".html"]); // SPA reader routes
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const BASE = `http://localhost:${HTTP_PORT}`;

// --- CDP client (shared: cdp-client.mjs) ---

rmSync(PROFILE, { recursive: true, force: true });
// phone-shaped: 直排 is built around a per-page column count, so a
// desktop-wide window would put the test in a typographic regime the
// reader never actually sees (11 columns across 900 px = 61 px glyphs)
const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: PROFILE, args: ["--window-size=430,900"],
  onFail: () => server.close(),
});
const nav = async (url) => {
  await send("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, 1200));
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(`/tmp/bookworm-vertical-${name}.png`, Buffer.from(data, "base64"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  server.close();
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};

// --- the test ---

const out = {};
// the writing mode lives on #content (the 直排 scroller); the root must stay
// horizontal-tb so its fixed overlays behave on iOS. Library has no #content.
const mode = () => evalJs(
  `getComputedStyle(document.querySelector("#content") ?? document.documentElement).writingMode`);
const contentScrollLeft = () => evalJs(`document.querySelector("#content").scrollLeft`);
// local bookmarks are keyed by book id, not by the slug in the URL
// the trailing "_": an unenrolled device has no reader identity, so its
// local bookmarks live under uid "" (identity comes only from a key now)
const savedOff = () => evalJs(`JSON.parse(localStorage.getItem("bw_pos_${BOOK_ID}_")).offset`);
const barsShown = () => evalJs(`getComputedStyle(document.querySelector(".topbar")).display !== "none"`);
// mouse tap at a viewport fraction — dispatched on the element under the
// point so it takes the same path (bubbling to the window handler) as a click
const tap = (fx, fy) => evalJs(`(() => {
  const x = innerWidth * ${fx}, y = innerHeight * ${fy};
  (document.elementFromPoint(x, y) ?? document.body)
    .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
})()`);
// real touch tap through the browser input pipeline (touchstart/touchend) —
// iOS Safari never synthesizes click for taps on plain text, so the reader
// must react to the touch events themselves
const touchTap = async (fx, fy) => {
  const { x, y } = await evalJs(`({ x: innerWidth * ${fx}, y: innerHeight * ${fy} })`);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }, sessionId);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
  await sleep(150); // > the momentum-brake window before any next tap
};
// absolute char position (data-off + caret offset) at the center of an edge
// column in 直排: "last" = leftmost fully-visible, "first" = rightmost
// (measured against the PAGE box, which in 直排 is narrower than the
// viewport — the page is centered in whatever the margins leave)
const edgeCol = (which) => evalJs(`(() => {
  const page = document.getElementById("content").getBoundingClientRect();
  let cand = null;
  for (const p of document.querySelectorAll("#content p[data-off]")) {
    const b = p.getBoundingClientRect();
    if (b.right < page.left || b.left > page.right) continue;
    const range = document.createRange();
    range.selectNodeContents(p);
    for (const r of range.getClientRects()) {
      if (!r.width || !r.height) continue;
      if (${JSON.stringify(which)} === "last"
        ? r.left >= page.left - 0.5 && (!cand || r.left < cand.r.left)
        : r.right <= page.right + 0.5 && (!cand || r.right > cand.r.right)) cand = { r, p };
    }
  }
  if (!cand) return null;
  const caret = document.caretRangeFromPoint(
    (cand.r.left + cand.r.right) / 2, (cand.r.top + cand.r.bottom) / 2);
  return Number(cand.p.dataset.off) + (caret ? caret.startOffset : 0);
})()`);

// characters in one column, sampled the same way edgeCol samples: the seam
// between two pages should be exactly this wide (page k's last column and
// page k+1's first column are adjacent columns of the same text)
const colChars = () => evalJs(`(() => {
  // a paragraph currently ON the page (caretRangeFromPoint only resolves
  // points inside the viewport) with at least two columns to compare
  const page = document.getElementById("content").getBoundingClientRect();
  let rects = [];
  for (const p of document.querySelectorAll("#content p[data-off]")) {
    const b = p.getBoundingClientRect();
    if (b.right < page.left || b.left > page.right) continue;
    const range = document.createRange();
    range.selectNodeContents(p);
    const rs = [...range.getClientRects()]
      .filter((r) => r.width && r.height &&
        r.left >= page.left - 0.5 && r.right <= page.right + 0.5)
      .sort((a, b) => b.left - a.left);
    if (rs.length >= 2) { rects = rs; break; }
  }
  if (rects.length < 2) return null;
  const at = (r) => {
    const c = document.caretRangeFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return c ? c.startOffset : null;
  };
  const a = at(rects[0]), b = at(rects[1]);
  return a === null || b === null ? null : Math.abs(b - a);
})()`);

await nav(`${BASE}/vt`);
out.rendered = (await evalJs(`document.querySelectorAll("#content p[data-off]").length`)) > 0
  ? "ok" : "FAIL: no paragraphs";
// identity belongs to the reader key (POST /api/auth) alone — merely opening
// a book must not invent one (savedOff above proves the local bookmarks of
// an unenrolled device live under uid "")
const claimedUid = await evalJs(`localStorage.getItem("bw_uid")`);
out.uidNotClaimed = claimedUid === null ? "ok" : `FAIL: claimed ${claimedUid}`;
// factory defaults: 直排, light theme, 金褐 paper (a stored choice wins)
out.defaultMode = (await mode()) === "vertical-rl" ? "ok" : `FAIL: ${await mode()}`;
const defaults = await evalJs(
  `document.documentElement.dataset.theme + "/" + document.documentElement.dataset.bg`);
out.defaultThemeBg = defaults === "light/gold-brown" ? "ok" : `FAIL: ${defaults}`;
// 直排 typography is derived from the factory 11 columns per page: pitch =
// floor(avail/11) (integer), 字級 = pitch × ¾, so 行距 stays 字號/3
const type = await evalJs(`(() => {
  const c = document.getElementById("content");
  const box = document.getElementById("pagebox");
  const bcs = getComputedStyle(box);
  const cs = getComputedStyle(c.querySelector("p[data-off]"));
  const avail = box.clientWidth - parseFloat(bcs.paddingLeft) - parseFloat(bcs.paddingRight);
  const pitch = Math.floor(avail / 11);
  return {
    lines: c.clientWidth / parseFloat(cs.lineHeight),
    pitch: parseFloat(cs.lineHeight), wantPitch: pitch,
    fs: parseFloat(cs.fontSize),
    stored: localStorage.getItem("bw_lines"),
  };
})()`);
out.typeDefaults =
  type.lines === 11 && type.pitch === type.wantPitch &&
  Math.abs(type.fs - type.pitch * 0.75) < 0.51 && type.stored === null
    ? `ok (11 行 × ${type.pitch}px, 字級 ${type.fs}, unset = factory)`
    : `FAIL: ${JSON.stringify(type)}`;
out.barsHiddenByDefault = (await barsShown()) ? "FAIL: bars visible" : "ok";
// the rest of the flow starts in 橫排 — toggle out of the 直排 default
await evalJs(`document.getElementById("vertBtn").click()`);
await sleep(400);
out.togglesToHorizontal = (await mode()) === "horizontal-tb" ? "ok" : `FAIL: ${await mode()}`;
await shot("horizontal");

// scroll down mid-chapter; trackScroll debounce is 400ms
await evalJs(`scrollTo(0, 1500)`);
await sleep(700);
const hOff = await savedOff();
out.horizontalTracking = hOff > 0 ? `ok (offset ${hOff})` : `FAIL: ${hOff}`;

// toggle 直排: same paragraph should land near the right (start) edge
await evalJs(`document.getElementById("vertBtn").click()`);
await sleep(400);
out.verticalMode = (await mode()) === "vertical-rl" ? "ok" : `FAIL: ${await mode()}`;
const geo = await evalJs(`((c) => ({
  overflowX: c.scrollWidth > c.clientWidth,
  overflowY: c.scrollHeight > c.clientHeight,
  docStill: scrollX === 0 && scrollY === 0,
}))(document.querySelector("#content"))`);
out.horizontalOverflowOnly =
  geo.overflowX && !geo.overflowY && geo.docStill ? "ok" : `FAIL: ${JSON.stringify(geo)}`;
// paged reading lands the PAGE that holds the offset, so the paragraph can
// sit anywhere on it — the invariant is that it is on the page in front of
// you, not that it starts at the reading edge
const landed = await evalJs(`(() => {
  const c = document.getElementById("content");
  const page = c.getBoundingClientRect();
  const ps = [...document.querySelectorAll("p[data-off]")];
  const t = ps.filter((p) => Number(p.dataset.off) <= ${hOff}).pop();
  const r = t.getBoundingClientRect();
  return { on: r.right > page.left + 1 && r.left < page.right - 1, r: r.right, page: page.right };
})()`);
out.positionKeptOnToggle = landed.on ? "ok" : `FAIL: ${JSON.stringify(landed)}`;
await shot("vertical");

// reading on = scrolling leftward: the tracked offset must advance.
// (long enough for the page snap to land AND the tracker to record the
// settled page — reading mid-flight makes the offset run-dependent)
await evalJs(`document.querySelector("#content").scrollBy(-1200, 0)`);
await sleep(1300);
const vOff = await savedOff();
out.verticalTracking = vOff > hOff ? `ok (${hOff} → ${vOff})` : `FAIL: ${hOff} → ${vOff}`;

// A± in 直排 means "one column fewer/more", so the text grows and the whole
// grid is re-derived — the reader must stay on the page holding the tracked
// offset. The bookmark itself may settle onto that page's FIRST paragraph
// (paged reading is page-granular), but it must never move forward past
// where we were, and the text we were reading must still be on screen.
const font0 = await evalJs(
  `parseFloat(getComputedStyle(document.querySelector("#content p[data-off]")).fontSize)`);
await evalJs(`document.getElementById("fontUpBtn").click()`);
await sleep(600);
const fontNow = await evalJs(
  `parseFloat(getComputedStyle(document.querySelector("#content p[data-off]")).fontSize)`);
const fontLanded = await evalJs(`(() => {
  const page = document.getElementById("content").getBoundingClientRect();
  const ps = [...document.querySelectorAll("p[data-off]")];
  const t = ps.filter((p) => Number(p.dataset.off) <= ${vOff}).pop();
  const r = t.getBoundingClientRect();
  return r.right <= page.right + 1 && r.right > page.left;
})()`);
const fontOff = await savedOff();
out.fontChangeKeepsPlace =
  fontNow > font0 && fontLanded && fontOff <= vOff
    ? `ok (${font0} → ${fontNow}px, off ${vOff} → ${fontOff})`
    : `FAIL: font=${font0}→${fontNow} landed=${fontLanded} off=${vOff}→${fontOff}`;
await evalJs(`document.getElementById("fontDownBtn").click()`);
await sleep(600); // back to the 24px default for the rest of the flow

// middle-ninth touch shows the bars, a second one hides them again
await touchTap(0.5, 0.5);
const shown = await barsShown();
await touchTap(0.5, 0.5);
out.centerTapTogglesBars = shown && !(await barsShown()) ? "ok" : `FAIL: shown=${shown}`;

// the paged grid: the page is an exact whole number of columns, the engine
// advances lines by exactly that pitch, and every block is a whole number
// of columns tall — the three facts that make "no line is ever sliced" a
// property of the layout rather than of the scroll distance
const grid = await evalJs(`(() => {
  const c = document.getElementById("content");
  const cs = getComputedStyle(c);
  const pitch = parseFloat(cs.lineHeight);
  // the engine's real line advance, read back from adjacent line rects
  const p = c.querySelector("p[data-off]:nth-of-type(3)");
  const range = document.createRange();
  range.selectNodeContents(p);
  const lefts = [...range.getClientRects()].filter((r) => r.width && r.height)
    .map((r) => r.left).sort((a, b) => b - a);
  const diffs = [];
  for (let i = 1; i < lefts.length; i++) {
    const d = lefts[i - 1] - lefts[i];
    if (d > 1) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  let offGrid = 0;
  for (const b of c.children) {
    const bcs = getComputedStyle(b);
    const outer = b.getBoundingClientRect().width +
      parseFloat(bcs.marginLeft) + parseFloat(bcs.marginRight);
    const rem = outer % pitch;
    if (Math.min(rem, pitch - rem) > 0.5) offGrid++;
  }
  return {
    pitch, width: c.clientWidth, fs: parseFloat(cs.fontSize),
    advance: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null,
    offGrid, cols: c.clientWidth / pitch,
  };
})()`);
out.pagedGrid =
  Number.isInteger(grid.pitch) && Math.abs(grid.cols - Math.round(grid.cols)) < 0.001 &&
  Math.abs(grid.advance - grid.pitch) <= 0.25 && grid.offGrid === 0 &&
  Math.abs(grid.fs - grid.pitch * 0.75) < 0.51
    ? `ok (${Math.round(grid.cols)} 行 × ${grid.pitch}px, 字級 ${grid.fs})`
    : `FAIL: ${JSON.stringify(grid)}`;

// bottom-left quarter pages forward (leftward in 直排), bottom-right back
const x0 = await contentScrollLeft();
const lastCol = await edgeCol("last");
await touchTap(0.2, 0.8);
await sleep(700); // native smooth animation — engine-defined duration
const x1 = await contentScrollLeft();
// fixed span−半行 step: the new page starts at or just before the old last
// fully-visible column (half-line overlap) — starting past it means text
// was skipped (which would also expose a doubled scroll or a re-fired tap)
const firstCol = await edgeCol("first");
const perCol = await colChars();
// 重疊 0: the new page opens on the column immediately AFTER the old page's
// last one — one column of text apart. Landing before it would repeat text,
// landing further than a couple of columns on would have skipped some.
out.pagingNoSkip =
  firstCol !== null && perCol && firstCol > lastCol && firstCol - lastCol <= perCol * 3
    ? `ok (${lastCol} → ${firstCol}, 一行 ${perCol} 字)`
    : `FAIL: last=${lastCol} first=${firstCol} perCol=${perCol}`;
await touchTap(0.8, 0.8);
await sleep(700);
const x2 = await contentScrollLeft();
out.tapPagingVertical =
  x1 < x0 && x2 > x1 ? `ok (${x0} → ${x1} → ${x2})` : `FAIL: ${x0} → ${x1} → ${x2}`;
// the constant step is direction-symmetric: next then prev must land back
// on the SAME spot (the measured variants drifted — user report 07-28)
out.pagingSymmetric = Math.abs(x2 - x0) <= 1
  ? `ok (${x0} → ${x2})` : `FAIL: ${x0} → ${x2}`;
// every landing is a page point (an exact multiple of the page width),
// so a column can never sit half-on/half-off the page edge
const onPagePoint = await evalJs(`(() => {
  const c = document.getElementById("content");
  const step = c.clientWidth;
  const k = Math.round(-c.scrollLeft / step);
  return { k, err: Math.abs(-c.scrollLeft - k * step) };
})()`);
out.landsOnPagePoint = onPagePoint.err <= 1
  ? `ok (page ${onPagePoint.k}, err ${onPagePoint.err.toFixed(1)})`
  : `FAIL: ${JSON.stringify(onPagePoint)}`;

// the iOS fixed-overlay guard: paging must scroll #content, never the doc
out.docNeverScrolls = (await evalJs(`scrollX === 0 && scrollY === 0`))
  ? "ok" : "FAIL: document scrolled";
await sleep(900); // let the snap and trackScroll settle before the reload
const preReload = await savedOff();

// reload: setting + position persist. Paged reading is page-granular, so
// the meaningful invariant is that reopening restores EXACTLY what was
// saved (comparing against an offset captured pages ago would only measure
// how coarse a page is)
await nav(`${BASE}/vt`);
await sleep(900);
out.persistsReload = (await mode()) === "vertical-rl" ? "ok" : `FAIL: ${await mode()}`;
const rOff = await savedOff();
out.positionAfterReload = rOff === preReload && rOff > hOff
  ? `ok (${rOff})` : `FAIL: ${preReload} → ${rOff}`;

// bookmark fixed point (restore→save→restore): reopening must land on the
// SAME point every time — zero drift in the saved offset and in the first
// visible column. On iOS the old scrollBy restore landed long, trackScroll
// saved the overshoot, and every open walked the bookmark forward.
const fp0 = { off: rOff, col: await edgeCol("first") };
const fpCycles = [];
for (let i = 0; i < 2; i++) {
  await nav(`${BASE}/vt`);
  await sleep(900); // restore + trackScroll debounce fully settled
  fpCycles.push({ off: await savedOff(), col: await edgeCol("first") });
}
out.bookmarkFixedPoint = fpCycles.every((c) => c.off === fp0.off && c.col === fp0.col)
  ? `ok (off ${fp0.off} col ${fp0.col} ×${fpCycles.length + 1})`
  : `FAIL: ${JSON.stringify([fp0, ...fpCycles])}`;

// Keyboard in 直排: the text flows leftward, so ←/→ page (← forward) and
// ↑/↓ change chapter. 橫排 swaps the pairs — asserted further down.
const key = async (k, wait = 700) => {
  await evalJs(`dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, cancelable: true }))`);
  await sleep(wait);
};
const chapTitle = () => evalJs(`document.getElementById("ctitle").textContent`);
// Math.abs, not unary minus: scrollLeft is 0 at a chapter's start and CDP
// cannot serialize -0, so `-scrollLeft` comes back undefined
const vDist = () => evalJs(`Math.abs(document.querySelector("#content").scrollLeft)`);

await key("ArrowDown");
out.arrowDownNextChapter = (await chapTitle()).includes("第2回") ? "ok" : `FAIL: ${await chapTitle()}`;
await key("ArrowUp");
out.arrowUpPrevChapter = (await chapTitle()).includes("第1回") ? "ok" : `FAIL: ${await chapTitle()}`;

// now parked at 第1回's start — space and ← both page forward, → pages back
const kd0 = await vDist();
await key(" ");
const kd1 = await vDist();
await key("ArrowLeft");
const kd2 = await vDist();
await key("ArrowRight");
await key("ArrowRight");
const kd3 = await vDist();
out.spacePagesForward = kd1 > kd0 && (await chapTitle()).includes("第1回")
  ? `ok (${kd0} → ${kd1})` : `FAIL: ${kd0} → ${kd1}`;
out.vArrowLeftPagesForward = kd2 > kd1 ? `ok (${kd1} → ${kd2})` : `FAIL: ${kd1} → ${kd2}`;
out.vArrowRightPagesBack = kd3 === kd0 ? `ok (${kd2} → ${kd3})` : `FAIL: ${kd2} → ${kd3}`;

// leave the reader at 第2回's beginning for the page-back test below
await key("ArrowDown");
const ct = await chapTitle();
out.arrowDownAgain = ct.includes("第2回") ? "ok" : `FAIL: ${ct}`;

// page-back at a chapter's beginning lands on the previous chapter's END
await touchTap(0.8, 0.8);
await sleep(700);
const backCt = await evalJs(`document.getElementById("ctitle").textContent`);
const atDocEnd = await evalJs(
  `((c) => c.scrollLeft <= c.clientWidth - c.scrollWidth + 2)(document.querySelector("#content"))`);
out.pageBackCrossesChapter =
  backCt.includes("第1回") && atDocEnd ? "ok" : `FAIL: ${backCt} end=${atDocEnd}`;

// …and that last page must RENDER as a page: the chapter ends mid-page, so
// this landing is clamped short of a page point — it still may not slice a
// column at either edge, and the chapter's final glyph must actually be on
// screen (paging back into a chapter you have not read must show its end)
const endPage = await evalJs(`(() => {
  const c = document.getElementById("content");
  const page = c.getBoundingClientRect();
  const pitch = parseFloat(getComputedStyle(c).lineHeight);
  const min = c.clientWidth - c.scrollWidth;
  const mod = ((min % pitch) + pitch) % pitch;
  let cut = 0;
  for (const b of c.children) {
    const bb = b.getBoundingClientRect();
    if (bb.right < page.left - pitch || bb.left > page.right + pitch) continue;
    const range = document.createRange();
    range.selectNodeContents(b);
    for (const r of range.getClientRects()) {
      if (!r.width || !r.height) continue;
      if ((r.left < page.left - 1 && r.right > page.left + 1) ||
          (r.left < page.right - 1 && r.right > page.right + 1)) cut++;
    }
  }
  const ps = [...c.querySelectorAll("p[data-off]")];
  const lastRect = ps[ps.length - 1].getBoundingClientRect();
  return {
    atMin: Math.abs(c.scrollLeft - min) <= 1,
    onGrid: Math.min(mod, pitch - mod) < 0.5,
    cut,
    endVisible: lastRect.left >= page.left - 1 && lastRect.left < page.right,
    gap: +(lastRect.left - page.left).toFixed(1),
  };
})()`);
out.chapterEndPageRenders =
  endPage.atMin && endPage.onGrid && endPage.cut === 0 && endPage.endVisible
    ? `ok (end column ${endPage.gap}px from the page edge)`
    : `FAIL: ${JSON.stringify(endPage)}`;

// Paging back OFF that clamped page. It does not sit on a page point, so
// the step must count UP to the page it overlaps: k = ceil(dist/step) − 1.
// Rounding instead would land a page too early and skip everything between.
// The two pages legitimately OVERLAP here (that is what "the text ended
// mid-page" means), so the invariant is no GAP, not contiguity.
const endFirst = await edgeCol("first");
const endGeom = await evalJs(`(() => {
  const c = document.getElementById("content");
  const step = c.clientWidth;
  return { step, want: Math.ceil((c.scrollWidth - step) / step) - 1 };
})()`);
await touchTap(0.8, 0.8);
await sleep(700);
const offEnd = await evalJs(`(() => {
  const c = document.getElementById("content");
  const step = c.clientWidth;
  const k = Math.round(-c.scrollLeft / step);
  return { k, err: Math.abs(-c.scrollLeft - k * step), left: c.scrollLeft };
})()`);
const offEndLast = await edgeCol("last");
out.pageBackOffChapterEnd =
  offEnd.err <= 1 && offEnd.k === endGeom.want && offEndLast >= endFirst - 2
    ? `ok (page ${offEnd.k}, reaches ${offEndLast} ≥ end page's ${endFirst})`
    : `FAIL: ${JSON.stringify(offEnd)} want=${endGeom.want} last=${offEndLast} first=${endFirst}`;
// forward again to restore the flow's expected position (chapter end)
await touchTap(0.2, 0.8);
await sleep(700);

// page-forward at a chapter's end crosses to the next chapter's beginning
await touchTap(0.2, 0.8);
await sleep(700);
const fwdCt = await evalJs(`document.getElementById("ctitle").textContent`);
const atDocStart = (await contentScrollLeft()) >= -2;
out.pageForwardCrossesChapter =
  fwdCt.includes("第2回") && atDocStart ? "ok" : `FAIL: ${fwdCt} start=${atDocStart}`;

// forward from a chapter's FIRST page: the chapter head is same-size bold
// now, so it occupies whole columns like any paragraph — the page grid must
// be undisturbed by it and the seam must stay exactly one column
const headLast = await edgeCol("last");
await touchTap(0.2, 0.8);
await sleep(700); // native smooth settle
const headFirst = await edgeCol("first");
const headPerCol = await colChars();
out.chapterHeadSeam =
  headFirst !== null && headPerCol &&
  headFirst > headLast && headFirst - headLast <= headPerCol * 3
    ? `ok (${headLast} → ${headFirst})`
    : `FAIL: last=${headLast} first=${headFirst} perCol=${headPerCol}`;

// free scrolling is demoted to page-or-nothing: a pan that stops mid-page
// settles onto the nearest page point by itself. (Last of the 直排 checks —
// it deliberately parks the reader mid-book.)
await evalJs(`(() => {
  const c = document.getElementById("content");
  c.scrollLeft = -Math.round(1.4 * c.clientWidth);
})()`);
await sleep(1400);
const snapped = await evalJs(`(() => {
  const c = document.getElementById("content");
  const step = c.clientWidth;
  const k = Math.round(-c.scrollLeft / step);
  return { k, err: Math.abs(-c.scrollLeft - k * step) };
})()`);
out.snapsToPage = snapped.err <= 1 && snapped.k === 1
  ? `ok (settled on page ${snapped.k})` : `FAIL: ${JSON.stringify(snapped)}`;

// ROTATION MUST NOT RESIZE THE TEXT (user 07-28). The pitch is calibrated
// once by 直排 in portrait; landscape simply fits MORE lines of that same
// size, and whatever the width cannot divide evenly becomes padding split
// between the two sides. Every page boundary still moves, so the reader
// must also re-anchor on the tracked offset.
const beforeRot = await savedOff();
const portraitGrid = await evalJs(`(() => {
  const c = document.getElementById("content");
  const cs = getComputedStyle(c);
  return { pitch: parseFloat(cs.lineHeight), fs: parseFloat(cs.fontSize), cols: c.clientWidth / parseFloat(cs.lineHeight) };
})()`);
await send("Emulation.setDeviceMetricsOverride",
  { width: 880, height: 520, deviceScaleFactor: 0, mobile: true }, sessionId);
await sleep(1000);
const rot = await evalJs(`(() => {
  const c = document.getElementById("content");
  const box = document.getElementById("pagebox");
  const bcs = getComputedStyle(box);
  const cs = getComputedStyle(c);
  const pitch = parseFloat(cs.lineHeight);
  const avail = box.clientWidth - parseFloat(bcs.paddingLeft) - parseFloat(bcs.paddingRight);
  const step = c.clientWidth;
  const k = Math.round(-c.scrollLeft / step);
  const t = [...document.querySelectorAll("p[data-off]")]
    .filter((p) => Number(p.dataset.off) <= ${beforeRot}).pop();
  const r = t.getBoundingClientRect();
  const page = c.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  return {
    pitch, fs: parseFloat(cs.fontSize), step, cols: step / pitch, avail,
    landscape: matchMedia("(orientation: landscape)").matches,
    err: Math.abs(-c.scrollLeft - k * step),
    onPage: r.right > page.left && r.left < page.right,
    // the undividable remainder, split evenly by the centering
    padL: +(page.left - boxRect.left).toFixed(1),
    padR: +(boxRect.right - page.right).toFixed(1),
    slack: avail - step,
  };
})()`);
out.rotationKeepsTextSize =
  rot.landscape && rot.pitch === portraitGrid.pitch && rot.fs === portraitGrid.fs &&
  rot.cols > portraitGrid.cols && Math.abs(rot.cols - Math.round(rot.cols)) < 0.001 &&
  rot.slack >= 0 && rot.slack < rot.pitch && Math.abs(rot.padL - rot.padR) <= 1 &&
  rot.err <= 1 && rot.onPage
    ? `ok (${portraitGrid.cols} → ${Math.round(rot.cols)} 行, 字級 ${rot.fs} unchanged, 兩邊 padding ${rot.padL}/${rot.padR})`
    : `FAIL: portrait=${JSON.stringify(portraitGrid)} landscape=${JSON.stringify(rot)}`;
await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
await sleep(800);

// toggle back
await evalJs(`document.getElementById("vertBtn").click()`);
await sleep(400);
out.togglesBack = (await mode()) === "horizontal-tb" ? "ok" : `FAIL: ${await mode()}`;

// in 橫排 the same bottom-left tap pages downward
const y0 = await evalJs(`scrollY`);
await tap(0.2, 0.8);
await sleep(600); // 橫排 turns ride the engine's smooth scroll now
const y1 = await evalJs(`scrollY`);
out.tapPagingHorizontal = y1 > y0 ? `ok (${y0} → ${y1})` : `FAIL: ${y0} → ${y1}`;

// 橫排 is paged too, but the DOCUMENT scrolls, so there is nothing to clip
// against: the grid is anchored to the reading band instead (#content's
// padding-top). The properties to prove are that a page is a whole number
// of lines, that a turn is exactly one page, and that after a landing a
// line boundary sits exactly at the band top — that is what keeps a line
// from being cut by the viewport edge.
const hGrid = await evalJs(`(() => {
  const c = document.getElementById("content");
  const cs = getComputedStyle(c);
  const pitch = parseFloat(cs.lineHeight);
  const band = parseFloat(cs.paddingTop);
  const avail = innerHeight - band - parseFloat(cs.paddingBottom);
  const p = [...c.querySelectorAll("p[data-off]")]
    .find((el) => el.getBoundingClientRect().height > pitch * 1.5);
  const range = document.createRange();
  range.selectNodeContents(p);
  const tops = [...range.getClientRects()].filter((r) => r.width && r.height)
    .map((r) => r.top).sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < tops.length; i++) {
    const d = tops[i] - tops[i - 1];
    if (d > 1) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  // where the first line of the chapter sits relative to the band, once the
  // current scroll is accounted for: a whole number of lines must fit above
  const first = c.querySelector("p[data-off]").getBoundingClientRect().top + scrollY - band;
  return {
    pitch, band, avail, fs: parseFloat(cs.fontSize),
    lines: avail / pitch,
    advance: diffs.length ? diffs[Math.floor(diffs.length / 2)] : null,
    step: ${y1} - ${y0},
    phase: Math.abs(((scrollY - first) % pitch + pitch) % pitch),
  };
})()`);
const near = (a, b, t = 0.5) => Math.abs(a - b) < t;
out.pagedGridHorizontal =
  Number.isInteger(hGrid.pitch) && near(hGrid.advance, hGrid.pitch, 0.25) &&
  near(hGrid.fs, hGrid.pitch * 0.75, 0.51) &&
  hGrid.step === Math.floor(hGrid.lines) * hGrid.pitch &&
  (near(hGrid.phase, 0) || near(hGrid.phase, hGrid.pitch))
    ? `ok (${Math.floor(hGrid.lines)} 行 × ${hGrid.pitch}px, 一頁 ${hGrid.step}px, 相位 ${hGrid.phase.toFixed(2)})`
    : `FAIL: ${JSON.stringify(hGrid)}`;

// …and switching writing mode must not resize the text either: 橫排 renders
// the SAME calibrated pitch, it just fits a different number of lines
const vertPitch = await evalJs(`(() => {
  document.getElementById("vertBtn").click();
  const cs = getComputedStyle(document.getElementById("content"));
  const g = { pitch: parseFloat(cs.lineHeight), fs: parseFloat(cs.fontSize) };
  document.getElementById("vertBtn").click(); // back to 橫排
  return g;
})()`);
await sleep(500);
out.modeSwitchKeepsTextSize =
  vertPitch.pitch === hGrid.pitch && vertPitch.fs === hGrid.fs
    ? `ok (${vertPitch.pitch}px pitch, 字級 ${vertPitch.fs} in both modes)`
    : `FAIL: 直排=${JSON.stringify(vertPitch)} 橫排 pitch=${hGrid.pitch} fs=${hGrid.fs}`;

// free scrolling settles onto a page in 橫排 as well
await evalJs(`scrollTo(0, Math.round(${y1} + 0.4 * (${y1} - ${y0})))`);
await sleep(1400);
const hSnap = await evalJs(`(() => {
  const step = ${y1} - ${y0};
  const k = Math.round(scrollY / step);
  return { k, err: Math.abs(scrollY - k * step) };
})()`);
out.snapsToPageHorizontal = hSnap.err <= 1
  ? `ok (settled on page ${hSnap.k})` : `FAIL: ${JSON.stringify(hSnap)}`;

// Keyboard in 橫排: the pairs swap — ↓/↑ page, ←/→ change chapter. (In 直排
// those same four keys mean the opposite thing; that is the point.)
await evalJs(`scrollTo(0, 0)`);
await sleep(300);
const hy0 = await evalJs(`scrollY`);
await key("ArrowDown");
const hy1 = await evalJs(`scrollY`);
await key("ArrowUp");
const hy2 = await evalJs(`scrollY`);
out.hArrowDownPagesForward = hy1 > hy0 ? `ok (${hy0} → ${hy1})` : `FAIL: ${hy0} → ${hy1}`;
out.hArrowUpPagesBack = hy2 === hy0 ? `ok (${hy1} → ${hy2})` : `FAIL: ${hy1} → ${hy2}`;
// relative to wherever the flow left us, and it must end where it started so
// the page-back-across-chapters check below still has its precondition
const hi0 = await evalJs(`state.idx`);
await key("ArrowRight");
const hi1 = await evalJs(`state.idx`);
await key("ArrowLeft");
const hi2 = await evalJs(`state.idx`);
out.hArrowRightNextChapter = hi1 === hi0 + 1 ? `ok (${hi0} → ${hi1})` : `FAIL: ${hi0} → ${hi1}`;
out.hArrowLeftPrevChapter = hi2 === hi0 ? `ok (${hi1} → ${hi2})` : `FAIL: ${hi1} → ${hi2}`;

// chapter crossing works in 橫排 too: page-back from the top of chapter 2
await evalJs(`scrollTo(0, 0)`);
await sleep(300); // past the momentum-brake window
await touchTap(0.8, 0.85);
await sleep(700);
const hCt = await evalJs(`document.getElementById("ctitle").textContent`);
const hEnd = await evalJs(`scrollY + innerHeight >= document.documentElement.scrollHeight - 2`);
out.pageBackCrossesHorizontal =
  hCt.includes("第1回") && hEnd ? "ok" : `FAIL: ${hCt} end=${hEnd}`;

// library must stay horizontal while the reader preference is vertical
// (bare "/" resumes the open book now — ?shelf is the library's address)
await evalJs(`document.getElementById("vertBtn").click()`);
await nav(`${BASE}/?shelf`);
out.libraryHorizontal = (await mode()) === "horizontal-tb" ? "ok" : `FAIL: ${await mode()}`;

// book cards show reading progress: thin bar + exact percent, fill width
// true to the server-computed pct
const prog = await evalJs(`(() => {
  const row = document.querySelector(".book-card .book-progress");
  if (!row) return null;
  const bar = row.querySelector(".bar").getBoundingClientRect().width;
  const fill = row.querySelector(".fill").getBoundingClientRect().width;
  return { label: row.querySelector("span").textContent, ratio: fill / bar };
})()`);
out.libraryProgress =
  prog && prog.label === "42.5%" && Math.abs(prog.ratio - 0.425) < 0.01
    ? "ok" : `FAIL: ${JSON.stringify(prog)}`;

// 新書通知 row: rendered where the platform can deliver, and it reflects
// the real subscription state rather than assuming one
const pushRow = await evalJs(`(() => {
  const btn = document.getElementById("pushBtn");
  return { supported: "PushManager" in window, text: btn?.textContent ?? null };
})()`);
out.pushRow = !pushRow.supported
  ? "ok (unsupported — row correctly absent)"
  : pushRow.text && /訂閱|封鎖/.test(pushRow.text)
    ? `ok (${pushRow.text})` : `FAIL: ${JSON.stringify(pushRow)}`;

// 恆亮 toggle: persists per device and marks itself active (the lock
// request itself can be denied by the platform — state must not depend on it)
await nav(`${BASE}/vt`);
await sleep(500);
const wake = await evalJs(`(async () => {
  const btn = document.getElementById("wakeBtn");
  if (!btn) return { supported: false };
  document.documentElement.toggleAttribute("data-bars", true);
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  const on = { ls: localStorage.getItem("bw_wake"), cls: btn.classList.contains("active") };
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  return { supported: true, on, off: { ls: localStorage.getItem("bw_wake"), cls: btn.classList.contains("active") } };
})()`);
out.wakeToggle = !wake.supported
  ? "ok (no wakeLock API — button correctly absent)"
  : wake.on.ls === "1" && wake.on.cls && wake.off.ls === "0" && !wake.off.cls
    ? "ok (on/off persists)" : `FAIL: ${JSON.stringify(wake)}`;

await finish(out);
