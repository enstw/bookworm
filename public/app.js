"use strict";

// ---------- tiny DOM helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(2)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// stamped by deploy.sh at deploy time; "dev" means an unstamped local build.
// Lives inside app.js so it always names the shell actually running, even
// when the service worker served a cached copy.
const BUILD = "dev";

// ---------- the network cap ----------
//
// A dying cellular connection does not FAIL fetches, it hangs them for 60+ s.
// Every boot-path request that has something local to fall back on is capped
// here instead of waiting that out: past the cap the local copy wins and the
// next flush (or the next boot) reconciles. That is what "the app takes
// forever to open on bad signal" actually is — not a slow answer, but a
// question nobody was ever going to answer.
//
// The rule for using it: cap a request only when losing it costs nothing.
// A request with no local fallback (a book never cached, a shelf never seen)
// is deliberately left uncapped — there the network is the only answer, and
// cutting it short turns merely slow into broken. The service worker draws
// the same line with the same number (NET_MS in sw.js).
const NET_MS = 1000;
const capped = (ms = NET_MS) => ({ signal: AbortSignal.timeout(ms) });

// ---------- settings (font size / theme / paper color, per device) ----------

// paper colors: the [data-bg] values, in cycle order; "" is the theme
// default. Display names live in i18n.js under "bg.<value>".
const BACKGROUNDS = [
  "", "light-brown", "mid-brown", "gold-brown", "dark-brown", "snow-white",
  "pink", "light-orange", "light-yellow", "light-green", "light-cyan",
  "light-blue", "light-purple", "magenta",
];

// factory defaults: light theme, 金褐 paper (sampled off the user's preferred
// reader screenshot, #e0cb97), 直排 — a value the user ever set on this
// device (even back to these) always wins; null means untouched
const DEFAULTS = { theme: "light", bg: "gold-brown", vertical: true, lines: 11 };

// fontSize, vertical and bg sync to the server per reader id (settingsChanged
// marks + schedules the push); theme and lines deliberately stay per-device
const settings = {
  get fontSize() { return Number(localStorage.getItem("bw_font")) || 24; },
  set fontSize(v) { localStorage.setItem("bw_font", String(v)); applySettings(); settingsChanged(); },
  // 直排 text size, expressed the way the page is actually built: how many
  // columns fit on one page (字級 = pitch × ¾ follows from it). Per-device
  // like theme — a phone and a tablet want the same physical text size,
  // which is a DIFFERENT column count on each, so syncing it would make one
  // of them wrong (user 07-28).
  get lines() {
    const v = Number(localStorage.getItem("bw_lines"));
    return v >= 4 && v <= 40 ? v : DEFAULTS.lines;
  },
  set lines(v) {
    localStorage.setItem("bw_lines", String(Math.min(40, Math.max(4, Math.round(v)))));
    applySettings();
  },
  // the width 每頁行數 was calibrated against: the 直排 page in PORTRAIT.
  // Kept so that rotating or switching to 橫排 can reuse the SAME pitch
  // instead of re-deriving a different text size for a different viewport.
  get calibWidth() { return Number(localStorage.getItem("bw_calibw")) || 0; },
  set calibWidth(v) { localStorage.setItem("bw_calibw", String(Math.round(v))); },
  get theme() { return localStorage.getItem("bw_theme") ?? DEFAULTS.theme; },
  set theme(v) { localStorage.setItem("bw_theme", v); applySettings(); },
  get vertical() {
    const v = localStorage.getItem("bw_vertical");
    return v === null ? DEFAULTS.vertical : v === "1";
  },
  set vertical(v) { localStorage.setItem("bw_vertical", v ? "1" : "0"); applySettings(); settingsChanged(); },
  get bg() { return localStorage.getItem("bw_bg") ?? DEFAULTS.bg; },
  set bg(v) { localStorage.setItem("bw_bg", v); applySettings(); settingsChanged(); },
};

// Screen Wake Lock (iOS 16.4+): keep the display on while reading. A
// per-device choice like theme — it is about THIS screen's battery. The
// system releases the lock whenever the app hides; the visibilitychange
// hook re-acquires on return.
let wakeLock = null;
const wakeOn = () => localStorage.getItem("bw_wake") === "1";
async function applyWakeLock() {
  $("#wakeBtn")?.classList.toggle("active", wakeOn());
  const want = wakeOn() && document.visibilityState === "visible" && !!$("#content");
  if (want && !wakeLock && "wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch { /* denied (e.g. low-power mode) — retried on next visibility flip */ }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", applyWakeLock);
function toggleWake() {
  localStorage.setItem("bw_wake", wakeOn() ? "0" : "1");
  applyWakeLock();
}

function bgName() {
  return t("bg." + (settings.bg || "default"));
}

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty("--font-size", settings.fontSize + "px");
  root.dataset.theme = settings.theme;
  if (settings.vertical) root.dataset.vertical = "";
  else delete root.dataset.vertical;
  if (settings.bg) root.dataset.bg = settings.bg;
  else delete root.dataset.bg;
  applyGrid(); // 直排 typography is derived, so it re-derives with settings
  $("#vertBtn")?.classList.toggle("active", settings.vertical);
  const bgBtn = $("#bgBtn");
  if (bgBtn) {
    bgBtn.title = t("ui.bg", bgName());
    bgBtn.classList.toggle("active", !!settings.bg);
  }
}

function cycleTheme() {
  const order = ["auto", "light", "dark"];
  settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
}

function cycleBg() {
  const i = BACKGROUNDS.indexOf(settings.bg); // unknown value → -1 → back to 預設
  settings.bg = BACKGROUNDS[(i + 1) % BACKGROUNDS.length];
}

// A± reflows the whole line grid, so without re-anchoring the same scroll
// position shows DIFFERENT text — the reader visually jumps, and the next
// scroll would save that drifted point as the bookmark. Land back on the
// tracked offset instead (the same dance the 直排/橫排 toggle does). The
// bookmark itself is a char offset — font-independent by design — so this
// only re-aims the view, never rewrites the record.
// The size ladder IS the column count of the 直排 calibration: bigger text
// = one column fewer. A± means the same thing in 橫排 and in landscape —
// they render the calibrated size too, so re-deriving anything there would
// contradict "do not change the font size while rotating or switching
// modes" (user 07-28).
function setFont(d) {
  const next = Math.min(40, Math.max(4, settings.lines + (d > 0 ? -1 : 1)));
  if (next === settings.lines) return;
  settings.lines = next; // setter → applySettings → applyGrid
  if ($("#content p[data-off]")) restoreScroll(state.off);
}

function toggleVertical() {
  settings.vertical = !settings.vertical;
  // the whole layout just reflowed — reset both scrollers, then land back
  // on the same paragraph in the new orientation
  scrollTo(0, 0);
  const c = vScroller();
  if (c) c.scrollLeft = 0;
  restoreScroll(state.off);
}

// In 直排 the horizontal scroller is #content, never the document — iOS
// Safari lets position:fixed chrome drift off-screen when the document
// itself scrolls horizontally. scrollLeft follows the CSSOM flipped-blocks
// convention: 0 at the start (right edge), growing NEGATIVE as reading
// advances leftward.
const vScroller = () => $("#content");

// ---------- paged grid (整頁模式) ----------
//
// N (lines per page) is the primitive; everything else follows:
//
//     pitch = floor(avail / N)   INTEGER px — iOS snaps line advances to
//                                whole pixels, and a fractional pitch made
//                                the grid creep ~2 px per page (on-device
//                                /pagedtest, 2026-07-28)
//     字級  = pitch × ¾          keeps 行距 = 字號的 1/3, the reader's look
//     page  = N × pitch          one page's worth of the block axis
//
// Because the page is an exact multiple of the line pitch, page boundaries
// always fall BETWEEN lines: no line is ever sliced, and paging back is the
// same subtraction as paging forward — the asymmetry that killed every
// measured algorithm cannot exist here. Nothing is "filled" on the fly.
//
// N is derived per device from the synced 字級 rather than stored: two
// devices of different sizes then show the same physical text (and
// naturally different line counts), and A± simply picks N∓1.
//
// The two writing modes differ only in how the page is FENCED:
//   直排 — #content is the scroller and is exactly N×pitch wide, inside
//          #pagebox which clips; the scrollport IS the page.
//   橫排 — the DOCUMENT scrolls, so there is nothing to clip against;
//          instead the grid is anchored to the viewport's reading band
//          (#content's padding-top below the notch), and every landing puts
//          a line boundary exactly at the top of that band. band = k·step
//          then holds N whole lines with the leftover as bottom margin.
const GRID = { N: 0, pitch: 0, span: 0, band: 0 };

function gridAvail() {
  if (settings.vertical) {
    const box = $("#pagebox");
    if (!box) return 0;
    const cs = getComputedStyle(box);
    return box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }
  const c = $("#content");
  if (!c) return 0;
  const cs = getComputedStyle(c);
  // the band between the safe-area paddings; the bars are overlays and do
  // not reserve space (same call as 直排)
  return innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
}

// THE text size, and the only thing that is calibrated: 每頁行數 columns
// across the 直排 page in PORTRAIT. Rotating or switching to 橫排 must not
// resize the text (user 07-28) — those viewports simply fit a different
// NUMBER of lines of the same size. The calibration re-measures itself
// whenever 直排 is on screen in portrait, so a device only ever needs to be
// held upright once; until then min(innerWidth, innerHeight) stands in.
function gridPitch(avail) {
  if (settings.vertical && innerHeight >= innerWidth && avail > 0)
    settings.calibWidth = avail;
  const basis = settings.calibWidth || Math.min(innerWidth, innerHeight);
  return Math.max(8, Math.floor(basis / settings.lines));
}

function applyGrid() {
  const c = $("#content");
  if (!c) return;
  const avail = gridAvail();
  if (avail <= 0) return;
  const pitch = gridPitch(avail);
  // as many whole lines of that size as this viewport holds; 寬度除不盡的
  //餘數變成兩邊的 padding (the page box centers, so it splits evenly)
  const N = Math.max(1, Math.floor(avail / pitch));
  GRID.N = N;
  GRID.pitch = pitch;
  GRID.span = N * pitch;
  // 橫排: the document y where the first line sits — page k is exactly
  // k·span from it, so the band always opens on a line boundary
  GRID.band = settings.vertical ? 0 : parseFloat(getComputedStyle(c).paddingTop);
  c.style.width = settings.vertical ? GRID.span + "px" : "";
  c.style.fontSize = (pitch * 0.75).toFixed(2) + "px";
  c.style.lineHeight = pitch + "px";
  // paragraph gaps and the chapter head ride this, so every block's size
  // stays a whole number of lines without any quantization pass
  c.style.setProperty("--pitch", pitch + "px");
}

// Page arithmetic. 直排 runs on #content.scrollLeft (0 → negative), 橫排 on
// the document's scrollY (0 → positive); `dist` is the reading distance
// from the chapter's start in either, so the page maths below is shared.
const pageStep = () => GRID.span || 1;
const scrollDist = (c) => (settings.vertical ? -c.scrollLeft : scrollY);
const scrollEnd = (c) => (settings.vertical
  ? c.scrollWidth - c.clientWidth
  : Math.max(0, document.documentElement.scrollHeight - innerHeight));
// the scroll position that shows page k (clamped at the chapter's end)
const pagePos = (c, k) => {
  const dist = Math.min(scrollEnd(c), Math.max(0, k * pageStep()));
  return settings.vertical ? -dist : dist;
};
// which page a reading distance falls on (1 px of tolerance for rounding)
const pageAt = (dist) => Math.max(0, Math.floor((dist + 1) / pageStep()));
const pageAlign = (c, dist) => pagePos(c, pageAt(dist));

// Nearest landing for a free scroll. The valid points are the grid
// (0, step, 2·step, …) PLUS the chapter's end: the text usually stops
// mid-page, and that last clamped page is a real page — rounding it back
// onto the grid would make a chapter's final lines unreachable.
function snapTarget(c, dist) {
  const step = pageStep();
  const end = scrollEnd(c);
  const kMax = Math.max(0, Math.floor(end / step));
  const grid = Math.min(kMax, Math.max(0, Math.round(dist / step))) * step;
  const want = Math.abs(dist - end) < Math.abs(dist - grid) ? end : grid;
  return settings.vertical ? -want : want;
}

// One landing API for both modes: 直排 slides #content, 橫排 the document.
// The 橫排 watcher mirrors vSlide's — it OBSERVES the engine's smooth
// scroll and must end the moment the animation is over, a finger takes
// over, or anything else moves the document (a stale "still gliding" state
// makes the next tap turn from a destination we already left).
let hGlide = null;
function pageGlide(c, pos) {
  if (settings.vertical) return vSlide(c, pos);
  hGlide = { target: pos, born: Date.now(), last: Math.abs(scrollY - pos) };
  scrollTo({ top: pos, behavior: "smooth" });
  const watch = () => {
    if (!hGlide) return;
    const gap = Math.abs(scrollY - hGlide.target);
    if (gap <= 1 || lastUserScroll > hGlide.born) { hGlide = null; return; }
    if (gap > hGlide.last + 1) { hGlide = null; return; } // moved away: not ours
    if (Date.now() - hGlide.born > 1500) {
      const dest = hGlide.target;
      hGlide = null;
      scrollTo(0, dest); // animation died short — land it
      return;
    }
    hGlide.last = gap;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}
const gliding = () => (settings.vertical ? !!slide : !!hGlide);

// ---------- reader state ----------

const state = {
  slug: null,       // what the URL says — a label, and it can change
  id: null,         // what the book is stored and bookmarked under — it cannot
  uid: null,
  manifest: null,
  cum: [],          // cumulative chars up to and including chapter i
  idx: 0,
  off: 0,           // char offset within the current chapter file
  loading: true,    // chapter open in flight (or failed) — parks tap paging
  cache: new Map(), // chapter file -> text
  dirty: false,
  lastSaved: null,
  syncTimer: 0,
};

let syncState = "ok"; // ok | pending | err

// ---------- boot / routing ----------

applySettings();
console.log("bookworm build " + BUILD); // visible on any route via remote inspector
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
// installed app: ask for durable storage up front — the shell + font caches
// deserve evict-last even before any offline book (the offline toggle also
// calls persistStorage, so browser-tab reading is covered there)
if (isStandalone()) persistStorage();
// re-assert this device's push subscription (see healPush): the refresh
// button and a reinstall both invalidate it behind the user's back
healPush();
// the app icon badge has two writers: the service worker when a 新書上架
// push lands, and checkVersion below while an update sits unapplied.
// Looking at the app is what marks a push read — including switching back
// to an app that was already open, which is how iOS multitasking usually
// goes; checkVersion re-asserts its dot right after this clear for as long
// as the update is still pending.
const clearBadge = () => navigator.clearAppBadge?.().catch(() => {});
clearBadge();
addEventListener("visibilitychange", () => document.hidden || clearBadge());
// a deploy while the app sits open on a phone: the shell is network-first,
// so the update is one reload away — this only makes its ARRIVAL visible.
// Checked on open and whenever the app comes back to the foreground (how
// an installed PWA mostly lives); answered with a dismissible note, never
// a forced reload — the reader may be mid-sentence.
checkVersion();
addEventListener("visibilitychange", () => document.hidden || checkVersion());

// ---------- static chrome (the markup lives in index.html) ----------

// zh ships in the markup; a device that picked English gets its sweep here,
// before boot()'s first paint lands in the microtask queue
applyI18n();

$("#staleRetry").onclick = () => renderLibrary();
$("#changeKeyBtn").onclick = async () => {
  // switching identities means presenting a different KEY — an id is no
  // longer taken at a device's word. adoptKey does the settings-timestamp
  // handoff the old id prompt did here.
  const v = prompt(t("auth.changePrompt"));
  if (!v || !v.trim()) return;
  try {
    await adoptKey(extractKey(v));
    renderLibrary();
  } catch {
    alert(t("auth.bad"));
  }
};
$("#pushBtn").onclick = () => togglePush();
$("#pushTestBtn").onclick = () => testPush();
$("#refreshBtn").onclick = () => forceRefresh();
// the switch names the language you would GET, which is the one form a
// reader of either language can recognise without reading the other. A
// switch is a re-sweep plus a repaint of the JS-filled strings — never a
// refetch: the list on screen is already the list.
$("#langBtn").onclick = () => {
  bwSetLang(bwOtherLang());
  applyI18n();
  if (shelfPaint) paintShelf(...shelfPaint);
};
// a browser tab on a phone: the installed app is the product, so the way
// in stays one tap away (the guide auto-offers only once, at enrollment)
$("#installBtn").onclick = () => renderInstallGuide(renderLibrary);

boot();

// The route dispatch, async so enrolling (a /?key=… link) finishes before
// the first render — the very first paint must already belong to the right
// user. A declaration, not a const: this runs during script evaluation.
async function boot() {
  const enrolledNow = await swallowKey();
  const segs = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const wantShelf = new URLSearchParams(location.search).has("shelf");
  const dispatch = () => {
    // "/" is the installed app's start_url — what a phone reopens at — so it
    // continues the open book: everything it needs is already on the device,
    // where the shelf would ask the network first. /?shelf (the reader's
    // brand button, 回書架 on /admin) is the explicit way to the library, and
    // enrolling ends there too: a key link is device setup, not reading.
    if (segs.length === 0) {
      const last = enrolledNow || wantShelf ? null : lastBook();
      if (last) initReader(last);
      else renderLibrary();
    }
    else if (segs.length === 1) initReader(segs[0]);
    else renderMessage(t("err.badUrl"), [t("err.expected"), el("code", {}, "/<book>"), " — ", el("a", { href: "/?shelf" }, t("err.toLibrary"))]);
  };
  // Enrolling is the device-setup moment, so it is the one time the install
  // guide offers itself: iOS has no install-prompt API, and a guide shown
  // exactly when someone is setting a phone up is as automatic as 加入主畫面
  // ever gets. Once — the flag, not the guide, is what remembers.
  if (enrolledNow && installGuideDue()) return renderInstallGuide(dispatch);
  dispatch();
}

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || Boolean(navigator.standalone);
}

// The screens are static sections in index.html; raising one lowers the
// rest. The reader is not a screen: buildReaderShell renders into
// #readerRoot and lowers them all (id = null). Raising a screen also
// clears the reader's DOM, so a failed initReader cannot leave a
// half-built shell behind the message it fails into.
function showScreen(id) {
  for (const s of document.querySelectorAll("#app > section")) s.hidden = s.id !== id;
  if (id) $("#readerRoot").replaceChildren();
}

// ---------- new-version notice ----------

// One build per session gets offered; dismissing it is answered, and a
// foreground flip must not re-raise the same note.
let versionNoticed = "";
let versionDismissed = "";
async function checkVersion() {
  try {
    const res = await fetch("/api/version", {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const { build } = await res.json();
    // "dev" on either side means an unstamped local run — nothing to announce
    if (!build || build === "dev" || build === BUILD) return;
    // a pending update keeps a dot on the app icon: clearBadge just wiped
    // the icon on this same open/foreground event, and re-asserting here is
    // what lets the dot outlive a session that closed without reloading.
    // A dismissed note stays dismissed — ✕ means "seen it, not now" — and a
    // reload clears naturally: the fresh shell's build matches, so this
    // line is never reached again.
    if (build !== versionDismissed) navigator.setAppBadge?.(1).catch(() => {});
    if (build === versionNoticed) return;
    versionNoticed = build;
    showUpdateNotice(build, await releaseNotes());
  } catch { /* offline or slow: the next foreground flip asks again */ }
}

// What the releases since THIS shell say to a reader. Fetched only once an
// update is known to exist — which is rare — so it costs nothing on the
// foreground flips that find nothing.
//
// Every release the device skipped is included, not just the newest: a phone
// left alone for a month should hear about the whole month. Walking stops at
// this shell's own build, so a reader is never told about what they are
// already running. releases.json is a deploy product (gitignored, written by
// gen-release-notes.mjs) — a dev run has none, and a 404 means "no notes",
// which is also the honest answer for a release that said nothing.
async function releaseNotes() {
  try {
    const res = await fetch("/releases.json", {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const { releases } = await res.json();
    if (!Array.isArray(releases)) return [];
    const mine = BUILD.split(" ")[0]; // the stamp is "<short sha> · <when>"
    const out = [];
    for (const r of releases) {
      // the ledger keys on a longer sha than the build stamp carries
      if (mine && typeof r.build === "string" && r.build.startsWith(mine)) break;
      out.push(...(r.notes ?? []));
    }
    return out;
  } catch {
    return []; // slow or offline: the pill still works, it just says less
  }
}

function showUpdateNotice(build, notes = []) {
  document.querySelector(".updatenote")?.remove();
  // The pill is one nowrap row and the notes are prose, so the list rides a
  // line of its own (.notelist takes the full basis of a wrapping flex row) —
  // no second layout, no restructuring of the row. It starts collapsed because
  // "a new version is live" is the message; the notes are the follow-up.
  const list = notes.length
    ? el("ul", { class: "notelist", hidden: true }, notes.map((n) => el("li", {}, n)))
    : null;
  const note = el("div", { class: "jumpnote updatenote" },
    el("span", { class: "jumpnote-text" }, t("update.available", build)),
    list
      ? el("button", {
          id: "whatsNewBtn", // an id, not the label: the label is translated
          class: "linklike",
          onclick: (e) => {
            list.hidden = !list.hidden;
            e.target.textContent = list.hidden ? t("update.whatsNew") : t("update.hideNew");
          },
        }, t("update.whatsNew"))
      : null,
    el("button", {
      id: "updateReloadBtn",
      class: "linklike",
      // a plain reload is the whole upgrade: the service worker fetches the
      // shell network-first, so fresh bytes win whenever the network answers
      onclick: () => location.reload(),
    }, t("update.reload")),
    el("button", {
      class: "iconbtn", title: t("ui.close"),
      onclick: () => {
        // an answered note takes its badge with it, and stays answered for
        // this session's foreground flips
        versionDismissed = versionNoticed;
        navigator.clearAppBadge?.().catch(() => {});
        note.remove();
      },
    }, "✕"),
    list);
  document.body.append(note);
}

function installGuideDue() {
  try {
    return !isStandalone() && localStorage.getItem("bw_install_seen") !== "1";
  } catch {
    return false; // private mode: a guide that would nag every open stays away
  }
}

// The way into the installed app, spelled out for the platform at hand.
// Also reachable any time from the library footer — isStandalone() cannot
// tell "not installed" from "installed but opened in a Safari tab", so the
// one-time auto-offer errs quiet and the footer link stays.
function renderInstallGuide(next) {
  try { localStorage.setItem("bw_install_seen", "1"); } catch { /* private mode */ }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
  $("#guideIos").hidden = !ios;
  $("#guideOther").hidden = ios;
  $("#guideContinue").onclick = next;
  showScreen("guideScreen");
}

// ---------- the reader key (the door) ----------
//
// Possession of a key is the identity: the server maps it to the reader id
// whose bookmarks and settings this device then lives under. The key rides
// as a server-set cookie (POST /api/auth), which is what lets <audio src>,
// sendBeacon and the service worker's fetches authenticate untouched; the
// copy in localStorage exists to re-earn that cookie when the browser
// evicts it, and to survive Safari's 7-day cookie caps.

// A /?key=… link is how a device is enrolled: trade the key for an
// identity, keep both, and scrub the key out of the address bar — it must
// not sit where a screenshot or a share sheet would leak it. A key that
// fails here (offline, revoked) is simply dropped: the 401 path asks again.
async function swallowKey() {
  const q = new URLSearchParams(location.search);
  const key = q.get("key");
  if (!key) return false;
  let adopted = false;
  try { await adoptKey(key); adopted = true; } catch { /* the gate will ask */ }
  q.delete("key");
  history.replaceState(null, "",
    location.pathname + (q.size ? "?" + q : "") + location.hash);
  return adopted;
}

// Validate a key against the server and become its user: the response sets
// the cookie, we keep the key and the id. A DIFFERENT id also orphans the
// local settings timestamp — zero it so this device adopts the new
// identity's synced settings instead of clobbering them (same rule the old
// URL-claiming flow had).
async function adoptKey(key) {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { user } = await res.json();
  try {
    if (localStorage.getItem("bw_uid") !== user)
      localStorage.setItem("bw_settings_ts", "0");
    localStorage.setItem("bw_key", key);
    localStorage.setItem("bw_uid", user);
  } catch { /* private mode: this session only */ }
  reauthTried = false; // a fresh success re-arms the self-heal
  return user;
}

// People paste whatever they have — the full enroll link, its query, or the
// bare key — and an iPhone paste of a link (iMessage, Notes) can smuggle in
// invisible characters: bidi isolate marks, non-breaking spaces, a trailing
// 。 from the sentence around it. Those survive URL parsing and end up
// INSIDE the extracted key, which then 401s while looking perfectly right.
// The key and its link are plain visible ASCII, so keep only that, then
// hunt for key= rather than trusting the paste to parse as a URL.
function extractKey(s) {
  const raw = String(s).replace(/[^\x21-\x7E]/g, "");
  const m = raw.match(/key=([^&#?]+)/);
  const key = m ? m[1] : raw;
  try { return decodeURIComponent(key); } catch { return key; }
}

function getKey() {
  try { return localStorage.getItem("bw_key"); } catch { return null; }
}

// A 401 with a stored key means the cookie is missing or evicted — re-post
// the key to repair it silently. Only one attempt until something succeeds
// again: a revoked key must fail into the gate, not into a request loop.
let reauthTried = false;
async function reauth() {
  const key = getKey();
  if (!key || reauthTried) return false;
  reauthTried = true;
  try { await adoptKey(key); return true; } catch { return false; }
}

// GET /api/auth: the cookie survived but localStorage did not — ask the
// server who this device is and re-seed the local id.
async function whoami() {
  try {
    const res = await fetch("/api/auth");
    if (!res.ok) return null;
    const { user } = await res.json();
    if (user) { try { localStorage.setItem("bw_uid", user); } catch { /* private mode */ } }
    return user;
  } catch { return null; }
}

// The locked door: no valid key reached the server, so nothing beyond the
// shell can load. Reached only after reauth() failed — by then the stored
// key (if any) is genuinely dead, not merely a lost cookie.
function renderKeyGate(retry, failed = false) {
  document.title = "Bookworm";
  $("#gateLead").textContent = t(failed ? "auth.bad" : "auth.need");
  $("#keyInput").placeholder = t("auth.placeholder");
  $("#keyMsg").textContent = "";
  $("#keyForm").onsubmit = async (e) => {
    e.preventDefault();
    const raw = $("#keyInput").value;
    if (!raw.trim()) return;
    try {
      await adoptKey(extractKey(raw));
      retry();
    } catch {
      $("#keyMsg").textContent = t("auth.bad");
    }
  };
  showScreen("gateScreen");
}

function renderMessage(title, children = []) {
  $("#msgTitle").replaceChildren(title);
  // filter, because replaceChildren stringifies a bare null into "null"
  $("#msgBody").replaceChildren(...[children].flat().filter((c) => c != null));
  showScreen("msgScreen");
}

// The wordmark: .brand carries the app icon as a ::before (see app.css). It
// goes on the title passed IN rather than on renderMessage's own h1, because
// the same h1 also carries "chapter loading", "not found" and "offline" —
// headings that should not be branded.
//
// A declaration, not a const: the route dispatch at the top of this file runs
// during evaluation and reaches renderLibrary before this point, so an arrow
// bound to a const is still in its temporal dead zone when the first call
// lands.
function brand() {
  return el("span", { class: "brand" }, "Bookworm");
}

// ---------- library ----------

// The reader id is whatever /api/auth said this device's key maps to
// (adoptKey stores it). It used to be minted here and claimed off shared
// URLs — with keys there is nothing to mint: a device with no id simply is
// not enrolled yet, and callers treat null as exactly that.
function getUid() {
  try { return localStorage.getItem("bw_uid"); } catch { return null; }
}

async function renderLibrary() {
  document.title = "Bookworm";
  let uid = getUid();
  // fire-and-forget: no settings UI here, so a late server-wins repaint is
  // purely cosmetic (paper color / theme vars on the library chrome)
  if (uid) resolveSettings(uid);
  // The last shelf this device saw paints NOW — device-first, the same rule
  // positions and settings follow — and the capped fetch below can only
  // improve on it: a fresh list, or a stale mark when nothing answers.
  // With nothing local to show, the network is the only answer: uncapped,
  // behind a loading line.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("bw_books")); } catch { /* ignore */ }
  const haveCached = Array.isArray(cached);
  if (haveCached) paintShelf(cached, { uid, stale: false });
  else renderMessage(brand(), t("lib.loading"));
  let books;
  try {
    // the key cookie says who is asking; the server adds that reader's
    // per-book progress (the same chars-based pct as the reader's line)
    const res = await fetch("/api/books", haveCached ? capped() : undefined);
    if (res.status === 401) {
      if (await reauth()) return renderLibrary();
      return renderKeyGate(renderLibrary, !!getKey());
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    books = (await res.json()).books;
    // the cookie knows who we are but localStorage forgot (a cleared site,
    // a new browser profile with the key re-entered elsewhere): recover it
    if (!uid) uid = await whoami();
    try {
      localStorage.setItem("bw_books", JSON.stringify(books));
      // seed the slug → id map from the shelf, so opening a book for the
      // first time on an underground train still knows where to look
      for (const b of books) if (b.id) localStorage.setItem(`bw_book_${b.slug}`, b.id);
    } catch { /* full */ }
  } catch (err) {
    // offline, capped, or a dead API: the painted cache stands, marked
    if (!haveCached) {
      return renderMessage(brand(), [
        t("lib.loadFail", err.message),
        el("button", { class: "linklike", onclick: renderLibrary }, t("lib.retry")),
      ]);
    }
    return paintShelf(cached, { uid, stale: true });
  }
  paintShelf(books, { uid, stale: false });
}

// What paintShelf last drew, so the language switch can re-render the
// JS-filled strings without asking the network for the same list again.
let shelfPaint = null;

function paintShelf(books, opts) {
  shelfPaint = [books, opts];
  showScreen("shelfScreen");
  $("#staleNote").hidden = !opts.stale;
  $("#emptyNote").hidden = books.length > 0;
  // 續讀: the device's open book leads — the same book bare "/" resumes
  const heroBook = books.find((b) => b.slug === lastBook()) ?? null;
  paintHero(heroBook);
  $("#bookList").replaceChildren(...books.filter((b) => b !== heroBook).map(shelfRow));
  $("#uidCode").textContent = opts.uid ?? "—";
  $("#buildLine").textContent = t("lib.build", BUILD);
  // the push row exists only where the platform can deliver — on iPhone
  // that means the installed PWA; a Safari tab has no PushManager
  $("#pushRow").hidden = !("PushManager" in window && "Notification" in window);
  $("#installWrap").hidden = isStandalone();
  refreshPushBtn();
  applyWakeLock(); // leaving the reader releases the screen hold
}

function paintHero(b) {
  const row = $("#heroRow");
  row.hidden = !b;
  if (!b) return;
  row.dataset.slug = b.slug;
  $("#heroLink").href = `/${encodeURIComponent(b.slug)}`;
  coverInto($("#heroCover"), b, false);
  $("#heroTitle").textContent = b.title;
  $("#heroWhere").textContent =
    b.progress ? t("lib.chapterN", b.progress.chapter + 1) : t("lib.notStarted");
  const pct = b.progress ? Math.round(b.progress.pct) : 0;
  $("#heroFill").style.width = `${pct}%`;
  $("#heroPct").textContent = `${pct}%`;
  const dl = $("#heroOffline");
  dl.hidden = !("caches" in window);
  dl.onclick = () => toggleShelfOffline(dl, b);
  paintShelfOffline(dl, b);
}

// 書衣: the cloth tone is keyed on the permanent id, so a re-slug keeps its
// cover; a real cover image (books/<id>/cover.jpg — the agent-enrichment
// slot, see DESIGN.md) paints over the cloth when the book has one, and the
// <img>'s error handler removes it, so the cloth is also what offline and
// cover-less books wear.
function clothTone(id) {
  let h = 0;
  for (const c of String(id)) h = (h + c.charCodeAt(0)) % 4;
  return h;
}

function coverInto(node, b, withTab) {
  const id = b.id ?? b.slug;
  node.className = `cover cloth-${clothTone(id)}`;
  // filter, because replaceChildren stringifies a bare null into "null"
  node.replaceChildren(...[
    // the 題簽 carries the title and, when the enrichment sidecar named one,
    // the author in smaller 落款 characters on their own column
    el("span", { class: "slip" }, b.title,
      b.author ? el("span", { class: "slip-author" }, b.author) : null),
    withTab && b.progress ? el("span", { class: "tab" }) : null,
    el("img", {
      class: "coverimg", alt: "", loading: "lazy",
      src: assetUrl(id, "cover.jpg"),
      onerror: (e) => e.target.remove(),
    }),
  ].filter(Boolean));
  return node;
}

function shelfRow(b) {
  const pct = b.progress ? Math.round(b.progress.pct) : null;
  // the ⇣ is a sibling of the card, not a child: a <button> inside an <a>
  // is invalid HTML, and tapping it would open the book
  return el("div", { class: "book-row", "data-slug": b.slug },
    el("a", { class: "book-card", href: `/${encodeURIComponent(b.slug)}` },
      coverInto(el("div"), b, true),
      el("div", { class: "grid-meta" },
        t("lib.meta", b.chapters, b.totalChars), " · ",
        pct === null ? t("lib.notStarted") : el("span", { class: "acc" }, t("lib.readPct", pct)))),
    "caches" in window ? shelfOfflineBtn(b) : null);
}

// ---------- the ⇣ on a book card ----------

// The ring lights when the book was explicitly saved AND this device actually
// holds chapters — the flag alone would claim "saved" over an empty cache
// (say, a fill that failed offline), and held-but-implicit is just the
// reader's safety net, not something the user asked for. A tap on an unlit
// ring saves the full window; on a lit one, removes the book. Same rule as
// the reader's ⇣.
function shelfOfflineBtn(book) {
  const btn = el("button", {
    class: "iconbtn shelf-offline",
    onclick: () => toggleShelfOffline(btn, book),
  }, "⇣");
  paintShelfOffline(btn, book);
  return btn;
}

// Saving from the shelf fills the same ±window the reader keeps, centred on
// wherever the server says this reader is: what you want on the way into the
// tunnel is the chapters you are about to read, not chapter one.
async function toggleShelfOffline(btn, book) {
  const id = book.id ?? book.slug;
  if (btn.classList.contains("busy")) return;
  if (offlineExplicit(id) && await cachedChapters(id) > 0) {
    setOffline(id, false);
    await caches.delete(bookCacheName(id));
    return paintShelfOffline(btn, book);
  }
  setOffline(id, true);
  persistStorage();
  btn.classList.add("busy");
  try {
    const res = await fetch(assetUrl(id, "manifest.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fillOfflineWindow(id, await res.json(), book.progress?.chapter ?? 0);
  } catch {
    // The flag stays on, so opening the book online later still fills it.
    // Said out loud rather than left in a title: this is a phone, and nothing
    // there ever hovers.
    alert(t("lib.offlineFail"));
  } finally {
    btn.classList.remove("busy");
  }
  return paintShelfOffline(btn, book);
}

async function paintShelfOffline(btn, book) {
  const id = book.id ?? book.slug;
  const n = await cachedChapters(id);
  const saved = offlineExplicit(id) && n > 0;
  btn.classList.toggle("active", saved);
  btn.title = saved ? t("lib.offlineSaved", n) : t("lib.offlineSave");
}

// ---------- 新書通知 (Web Push) ----------

async function refreshPushBtn() {
  const btn = $("#pushBtn");
  if (!btn) return;
  if (Notification.permission === "denied") {
    btn.textContent = t("push.blocked");
    btn.disabled = true;
    return;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    btn.textContent = t(sub ? "push.subscribed" : "push.subscribe");
    $("#pushTestWrap")?.toggleAttribute("hidden", !sub);
  } catch {
    btn.textContent = t("push.subscribe");
  }
}

// 測試: push one notification to THIS device and say what the push service
// answered. "已訂閱" is only the phone's own opinion — it stays true even if
// the row never reached the server, and it says nothing about whether Apple
// accepted the message. Three outcomes, three different fixes:
//   伺服器沒有這個訂閱 → the subscribe POST never landed; re-subscribe
//   已送出 201 but no banner → iOS side (通知設定 / 專注模式), not the app
//   其他狀態 → the push service rejected us; the detail says why
async function testPush() {
  const btn = $("#pushTestBtn");
  if (!btn) return;
  btn.textContent = t("push.sending");
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    // the phone's own account of itself goes to the log FIRST: if the push
    // never lands, this is the half of the story the server cannot see.
    // The testlog stays zh-TW whatever the UI language — it is an operator
    // channel, read next to the worker's own 中文 lines.
    pageLog("測試前 " + await phoneState());
    if (!sub) { btn.textContent = t("push.notSubscribed"); return refreshPushBtn(); }
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    const j = await res.json().catch(() => ({}));
    btn.textContent = res.status === 404
      ? t("push.noRow")
      : j.ok
        ? t("push.sent", j.status)
        : t("push.rejected", j.status ?? res.status, j.detail ?? "");
  } catch (err) {
    btn.textContent = t("push.fail", err?.message ?? err);
  }
}

async function togglePush() {
  const btn = $("#pushBtn");
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error(t("push.noSW"));
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe().catch(() => {});
      fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
    } else {
      // permission must be requested inside the tap gesture (iOS)
      if (await Notification.requestPermission() !== "granted") return refreshPushBtn();
      const { key } = await (await fetch("/api/push/vapid")).json();
      if (!key) throw new Error(t("push.noVapid"));
      const ns = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uDecode(key),
      });
      const j = ns.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: getUid() ?? "", endpoint: j.endpoint,
          p256dh: j.keys.p256dh, auth: j.keys.auth,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (btn) btn.textContent = t("push.fail", err?.message ?? err);
    return;
  }
  refreshPushBtn();
}

// Re-register this device's subscription on every app open. Two things
// silently break the pairing between phone and server, and neither is
// visible from either side:
//   · unregistering the service worker (the refresh button!) destroys the
//     push subscription — the server row survives and the push service can
//     keep answering 201 for a dead endpoint
//   · a reinstalled PWA, or an iOS-rotated subscription, changes the
//     endpoint and leaves the old row behind
// getSubscription() is authoritative for the device, and /subscribe is an
// upsert, so re-POSTing it makes the row true again for free. Stale rows
// age out the moment the push service reports them gone.
async function healPush() {
  if (!("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const revived = !sub;
    if (!sub) {
      const { key } = await (await fetch("/api/push/vapid")).json();
      if (!key) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: b64uDecode(key),
      });
    }
    const j = sub.toJSON();
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: getUid() ?? "", endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      }),
    });
    if (revived) pageLog("訂閱已失效，已重新建立 …" + j.endpoint.slice(-12));
    refreshPushBtn();
  } catch (err) {
    pageLog("healPush 失敗：" + (err?.message ?? err));
  }
}

// A line in the same testlog the worker and the service worker write to, so
// one /api/testlog?page=push read shows the whole chain: worker → push
// service status → service worker → notification shown. Only writes when
// something push-related actually happens (a 測試 tap, a repaired
// subscription) — no per-launch noise. This is why the testlog table
// outlives the temporary diagnostic pages that introduced it.
function pageLog(data) {
  fetch("/api/testlog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page: "push", device: "page", data: String(data).slice(0, 4000) }),
  }).catch(() => {});
}

// what the phone believes, in one line: which service worker is in charge
// (no answer = a stale one without the message handler), permission, and
// whether this is the installed app — the facts that decide where a 201
// with no banner went
async function phoneState() {
  const bits = [];
  bits.push(matchMedia("(display-mode: standalone)").matches || navigator.standalone
    ? "standalone" : "browser 分頁");
  bits.push("permission " + Notification.permission);
  const ctrl = navigator.serviceWorker?.controller;
  bits.push("controller " + (ctrl ? new URL(ctrl.scriptURL).pathname : "無"));
  const v = await new Promise((resolve) => {
    if (!ctrl) return resolve("無");
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data?.sw ?? "?");
    setTimeout(() => resolve("沒回應（舊版 sw）"), 1500);
    try { ctrl.postMessage("version", [ch.port2]); } catch { resolve("postMessage 失敗"); }
  });
  bits.push("sw " + v);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    bits.push("subscription " + (sub ? "…" + sub.endpoint.slice(-12) : "無"));
  } catch (err) { bits.push("subscription 讀取失敗 " + (err?.message ?? err)); }
  return bits.join("；");
}

function b64uDecode(s) {
  return Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0));
}

// Force-refresh: drop the app-shell caches and the service worker, then
// reload from the network — the iPhone-friendly hard reload. Per-book
// offline chapter caches (bw-book-*) are deliberately kept.
async function forceRefresh() {
  if (navigator.onLine === false && !confirm(t("lib.refreshOffline"))) return;
  try {
    // unregistering the service worker DESTROYS this device's push
    // subscription, and the push service can go on accepting messages for
    // the dead endpoint — so retire the row on the way out. healPush()
    // creates a fresh one on the next load.
    const reg0 = await navigator.serviceWorker?.getRegistration();
    const sub = await reg0?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* refreshing matters more */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations() ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("bw-shell-")).map((k) => caches.delete(k)));
    }
  } catch { /* reload anyway */ }
  // back to the shelf (the refresh lives there); r= busts intermediary HTML caches
  location.replace("/?shelf&r=" + Date.now());
}

// ---------- reader ----------

function bookUrl(file) {
  return assetUrl(state.id, file, state.manifest?.generatedAt);
}

// The same URL for a book that is NOT the one open in the reader — the shelf
// caches books it has never opened, so the id and the manifest generation
// have to be passed in rather than read off `state`.
function assetUrl(id, file, v) {
  const url = `/books/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
  // version chapter URLs by manifest generation: chapters get a month-long
  // immutable cache-control, and this busts them when a book is republished
  return file.endsWith(".txt") && v ? `${url}?v=${encodeURIComponent(v)}` : url;
}

function posKey() {
  return `bw_pos_${state.id}_${state.uid}`;
}

// slug (from the URL) → the id the book is stored under. Books published
// before ids existed have id === their original slug, which is also the
// fallback here: it is what makes an offline first open, a server that has
// not been reindexed, and a stale link all degrade to "try the obvious key"
// instead of an error page.
async function resolveBookId(slug) {
  try {
    // capped: the fallback below is a pure guess the device can make on its
    // own, so a hung lookup is never worth waiting for
    const res = await fetch(`/api/books/${encodeURIComponent(slug)}`, capped());
    if (res.ok) {
      const book = (await res.json()).book;
      if (book?.id) {
        try { localStorage.setItem(`bw_book_${slug}`, book.id); } catch { /* full */ }
        return book.id;
      }
    }
  } catch { /* offline */ }
  return cachedBookId(slug) ?? slug;
}

// What this device last knew this slug to mean. renderLibrary seeds it for
// every book on the shelf, so opening one costs no extra round trip.
function cachedBookId(slug) {
  try {
    return localStorage.getItem(`bw_book_${slug}`);
  } catch {
    return null; // private mode
  }
}

// The slug the reader last actually showed — what "/" resumes. Written only
// after a manifest loads, so a typo'd URL can never become the book every
// reopen runs into. The slug→id map (bw_book_<slug>) survives alongside it,
// which is what keeps the resume working offline and across a rename.
function lastBook() {
  try { return localStorage.getItem("bw_last_book"); } catch { return null; }
}

async function initReader(slug) {
  state.slug = slug;
  state.uid = getUid() ?? "";
  renderMessage(t("reader.loading"));
  // 401 and "not there" must part ways: the first is a dead cookie or a
  // revoked key (the gate's business), the second a bad slug
  let denied = false;
  const loadManifest = async () => {
    // what the device already holds decides how long the server gets: with a
    // copy in hand a hung connection costs a second, without one the network
    // is the only way to open this book at all and must be given its time.
    // (The service worker caps the same request when it is in charge; the
    // page's own cap is what covers a first open, before it has claimed.)
    const hit = "caches" in window
      ? await caches.match(bookUrl("manifest.json"))
      : null;
    let m = null;
    try {
      const res = await fetch(bookUrl("manifest.json"), hit ? capped() : undefined);
      if (res.status === 401) denied = true;
      else if (res.ok) m = await res.json();
    } catch { /* offline, or capped — the cached copy below */ }
    // the offline copy also serves a revoked device that still holds the
    // book: revocation fences the server, not what a phone already has
    if (!m && hit) m = await hit.json();
    return m;
  };
  // A remembered mapping is taken as-is: ids never change, so this saves a
  // round trip on every open and works with no network at all. Only when the
  // book turns out not to be there do we ask the server again — that is a
  // slug re-used by a different book, or a device back after a long absence.
  const remembered = cachedBookId(slug);
  state.id = remembered ?? await resolveBookId(slug);
  let manifest = await loadManifest();
  if (!manifest && remembered) {
    const fresh = await resolveBookId(slug);
    if (fresh && fresh !== state.id) {
      state.id = fresh;
      manifest = await loadManifest();
    }
  }
  if (!manifest) {
    if (denied) {
      if (await reauth()) return initReader(slug);
      return renderKeyGate(() => initReader(slug), !!getKey());
    }
    // distinguish "no such book" from "offline and never cached" — the
    // latter needs the ⇣ toggle enabled while online, not a different URL
    if (navigator.onLine === false)
      return renderMessage(t("err.offlineTitle"), [
        t("err.offlineBody", slug),
        el("code", {}, "⇣"), t("err.offlineBodyTail"),
        el("button", { class: "linklike", onclick: () => location.reload() }, t("lib.retry")),
      ]);
    // a resumed slug the server disowns (deleted, renamed away) must not
    // wedge every "/" open into this page — forget it and offer the shelf
    try {
      if (lastBook() === slug) localStorage.removeItem("bw_last_book");
    } catch { /* private mode */ }
    return renderMessage(t("err.notFoundTitle"), [
      t("err.notFoundBody", slug),
      el("a", { href: "/?shelf" }, t("err.backToLibrary")),
    ]);
  }
  state.manifest = manifest;
  try { localStorage.setItem("bw_last_book", slug); } catch { /* private mode */ }
  state.cum = manifest.chapters.reduce((acc, c) => {
    acc.push((acc[acc.length - 1] ?? 0) + c.chars);
    return acc;
  }, []);
  document.title = `${manifest.title} · Bookworm`;

  if (offlineEnabled()) persistStorage();
  // settings reconcile rides along with the position fetch — both must land
  // before the shell builds, so server-synced 直排/字級/背景 apply pre-paint
  const [pos] = await Promise.all([resolvePosition(), resolveSettings(state.uid)]);
  buildReaderShell();
  await openChapter(pos.chapter, pos.offset);
  if (pos.back) showJumpNotice(pos.back);
  if (state.dirty) flush(); // local progress the server hasn't seen — push it now

  wireReaderEvents();
  applyWakeLock(); // the reader is where 恆亮 applies
}

// Once per page load, not once per initReader. initReader RE-ENTERS today —
// a 401 that reauth repaired, the key gate's retry — and both of those turn
// back before this point, so nothing doubles as the code stands. The guard is
// what keeps that from being load-bearing: window listeners cannot be
// un-registered from here, so a re-entry that ever reached the tail would
// leave a second live copy of every one of them, doubling each flush and
// fighting itself over the re-anchor. Every handler reads module state
// (state, settings) rather than anything captured here, so one registration
// serves every later open.
let readerWired = false;

function wireReaderEvents() {
  if (readerWired) return;
  readerWired = true;
  // capture: in 直排 the scroller is #content and scroll events don't bubble
  addEventListener("scroll", onScroll, { passive: true, capture: true });
  addEventListener("keydown", onKey);
  addEventListener("click", onTap);
  addEventListener("touchstart", onTouchStart, { passive: true });
  addEventListener("touchend", onTouchEnd, { passive: true });
  // deliberate scrolling pauses the player's auto-follow for a few seconds
  addEventListener("wheel", () => (lastUserScroll = Date.now()), { passive: true });
  addEventListener("touchmove", () => (lastUserScroll = Date.now()), { passive: true });
  // preload the player module so tapping 🔊 can call audio.play() inside
  // the gesture (iOS blocks playback started after an await)
  loadPlayer().catch(() => {});
  // the network coming back: push first, then ask what the row holds — the
  // answer is only another device's if our own writes are already in it
  addEventListener("online", () => {
    flushSettings();
    updateOfflineWindow();
    flush().then(checkRemotePosition);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { flushSettings(true); return flush(true); }
    // narration crossed chapters while the screen was off — show it now
    playerMod?.visibleCatchup();
    // the foreground flip is how an installed PWA "reopens": the moment to
    // find out that the phone read three chapters on while this sat idle
    checkRemotePosition();
  });
  addEventListener("pagehide", () => { flushSettings(true); flush(true); });
  // rotation / window resize re-derives the grid, which MOVES every page
  // boundary — so re-anchor on the tracked offset instead of keeping a
  // scroll position that now means a different place in the text
  addEventListener("resize", () => {
    clearTimeout(resizeTick);
    resizeTick = setTimeout(() => {
      applyGrid();
      if ($("#content p[data-off]")) restoreScroll(state.off);
    }, 200);
  });
}

let resizeTick = 0;

// This reader's row for this book, or null for anything that went wrong
// (offline, timed out, a dead API, a revoked key) — every caller's answer to
// "no remote" is the same: keep what the device holds.
async function fetchRemotePosition(opts) {
  try {
    const res = await fetch(
      `/api/position?book=${encodeURIComponent(state.id)}&user=${encodeURIComponent(state.uid)}`,
      opts,
    );
    const data = await res.json();
    if (!data.position) return null;
    return {
      chapter: data.position.chapter,
      offset: data.position.char_off,
      updatedAt: data.position.updated_at,
    };
  } catch {
    return null;
  }
}

async function resolvePosition() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(posKey())); } catch { /* ignore */ }
  // capped: resuming must not wait on a bookmark the device already holds.
  // Losing this race cannot lose progress — the server takes a position
  // write only when its updated_at is newer (LWW), so the local-wins flush
  // that follows a timeout can never clobber a fresher remote bookmark.
  const remote = await fetchRemotePosition(capped());

  const pick =
    [local, remote].filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] ??
    { chapter: 0, offset: 0, updatedAt: 0 };
  if (local && (!remote || (local.updatedAt || 0) > (remote.updatedAt || 0))) {
    state.dirty = true; // local progress the server hasn't seen yet
    state.lastSaved = local;
  }
  // a synced bookmark that lands far from where THIS device last was gets a
  // one-tap way back (a runaway bookmark — narration left playing, a TOC
  // mis-tap on another device — must never cost the reader their position)
  if (pick === remote && local && Math.abs(remote.chapter - local.chapter) >= 2)
    pick.back = { chapter: local.chapter, offset: local.offset };
  pick.chapter = Math.min(Math.max(pick.chapter ?? 0, 0), state.manifest.chapters.length - 1);
  pick.offset = Math.max(pick.offset ?? 0, 0);
  // the resume baseline: savePos treats an unchanged position as already
  // synced — merely opening a link must never re-write the bookmark or
  // bump its timestamp (位置變動才觸發同步)
  state.lastSaved = { chapter: pick.chapter, offset: pick.offset, updatedAt: pick.updatedAt || 0 };
  return pick;
}

const chapterTitle = (i) => state.manifest.chapters[i]?.title ?? t("lib.chapterN", i + 1);

function showJumpNotice(back) {
  back.chapter = Math.min(Math.max(back.chapter, 0), state.manifest.chapters.length - 1);
  const note = el("div", { class: "jumpnote" },
    el("span", { class: "jumpnote-text" },
      t("jump.synced", chapterTitle(state.idx), chapterTitle(back.chapter))),
    el("button", {
      class: "linklike",
      onclick: () => { note.remove(); openChapter(back.chapter, back.offset).then(() => flush()); },
    }, t("jump.back")),
    el("button", { class: "iconbtn", title: t("ui.close"), onclick: () => note.remove() }, "✕"));
  document.body.append(note);
}

// ---------- the bookmark another device moved (background pull) ----------
//
// resolvePosition runs once, when the book opens — and an installed PWA is
// reopened, not reloaded, so that one open can stand for days. A device that
// opened offline, or opened before the phone read on ahead, would otherwise
// hold a stale bookmark with no way to ask again that does not involve
// telling the reader to pull-to-refresh a PWA. This is the missing pull: the
// same reconcile, re-run in the background when the app comes back to the
// foreground and when the network returns.
//
// It never moves the page — a pill offers the jump, the mirror of the
// runaway-bookmark pill that offers the way back. Text must not move under
// someone who is reading it, and "the other device is ahead" is a weaker
// claim than "this reader asked to go there".
let posNoticed = 0; // the remote updated_at already offered or ruled out

async function checkRemotePosition() {
  if (!state.manifest || !state.id || !state.uid) return;
  // local progress the server has not taken yet: whatever the row holds is
  // older than what this device is about to push, so there is nothing to
  // learn from it. The flush that clears this re-invites the check.
  if (state.dirty) return;
  // 4 s, not NET_MS: this blocks nothing (checkVersion's reasoning), and a
  // 1 s cap on a slow link would mean the notice simply never arrives.
  const remote = await fetchRemotePosition(capped(4000));
  if (!remote) return;
  if (remote.updatedAt <= Math.max(state.lastSaved?.updatedAt ?? 0, posNoticed)) return;
  posNoticed = remote.updatedAt; // asked and answered, including a dismissal
  // Same chapter is not worth a pill: it would name the chapter the reader is
  // already in, and two devices a few paragraphs apart resolve themselves —
  // whichever one moves next wins the LWW.
  if (remote.chapter === state.idx) return;
  showRemoteNotice(remote);
}

function showRemoteNotice(remote) {
  // one pill at a time — they are all parked on the same fixed corner. The
  // update note is spared: it is about the app, not about a position, and it
  // has its own answered/dismissed bookkeeping.
  document.querySelector(".jumpnote:not(.updatenote)")?.remove();
  const note = el("div", { class: "jumpnote syncnote" },
    el("span", { class: "jumpnote-text" }, t("jump.remote", chapterTitle(remote.chapter))),
    el("button", {
      class: "linklike",
      // arriving there IS this device moving, so it takes a fresh timestamp
      // through savePos — the row keeps meaning "last place anyone read".
      onclick: () => { note.remove(); openChapter(remote.chapter, remote.offset).then(() => flush()); },
    }, t("jump.go")),
    el("button", { class: "iconbtn", title: t("ui.close"), onclick: () => note.remove() }, "✕"));
  document.body.append(note);
}

function buildReaderShell() {
  const m = state.manifest;
  showScreen(null); // the reader lowers every screen and owns #readerRoot
  $("#readerRoot").replaceChildren(
    el("header", { class: "topbar" },
      el("a", { class: "iconbtn brand", href: "/?shelf", title: t("ui.library") }),
      el("div", { class: "titles" },
        el("div", { class: "btitle" }, m.title),
        el("div", { class: "ctitle", id: "ctitle" }, "")),
      el("button", { id: "tocBtn", class: "iconbtn", title: t("ui.contents"), onclick: toggleToc }, "☰"),
      el("button", { id: "audioBtn", class: "iconbtn", title: t("ui.listen"), onclick: toggleAudio }, "🔊"),
      el("button", { id: "offlineBtn", class: "iconbtn" + (offlineExplicit() ? " active" : ""), title: t("ui.offlineCache"), onclick: toggleOffline }, "⇣"),
      // ids, not titles, are what the e2e suites click: the titles move with
      // the interface language now
      el("button", { id: "fontDownBtn", class: "iconbtn", title: t("ui.smaller"), onclick: () => setFont(-2) }, "A−"),
      el("button", { id: "fontUpBtn", class: "iconbtn", title: t("ui.larger"), onclick: () => setFont(2) }, "A+"),
      "wakeLock" in navigator
        ? el("button", { id: "wakeBtn", class: "iconbtn" + (wakeOn() ? " active" : ""), title: t("ui.wake"), onclick: toggleWake }, "☀")
        : null,
      el("button", { id: "themeBtn", class: "iconbtn", title: t("ui.theme"), onclick: cycleTheme }, "◐"),
      el("button", { id: "bgBtn", class: "iconbtn" + (settings.bg ? " active" : ""), title: t("ui.bg", bgName()), onclick: cycleBg }, "🎨"),
      el("button", { id: "vertBtn", class: "iconbtn" + (settings.vertical ? " active" : ""), title: t("ui.writingMode"), onclick: toggleVertical }, t("ui.vertBtn"))),
    // #pagebox is the page frame: in 直排 it owns the margins and clips at
    // the page edge, so a column can never be sliced (see applyGrid)
    el("div", { id: "pagebox" }, el("main", { id: "content" })),
    // next sits on the LEFT: vertical-rl text reads right-to-left, so
    // forward motion is leftward and the buttons should match
    el("footer", { class: "botnav" },
      el("button", { id: "nextBtn", onclick: () => nav(1) }, t("ui.next")),
      el("div", { class: "progress", id: "progress" }),
      el("button", { id: "prevBtn", onclick: () => nav(-1) }, t("ui.prev"))),
    el("div", { id: "toc", class: "toc", hidden: true }),
  );
  applyGrid(); // #pagebox exists now — derive the page before any text lands
}

async function fetchChapter(i) {
  const file = state.manifest.chapters[i].file;
  if (state.cache.has(file)) return state.cache.get(file);
  let text;
  try {
    const res = await fetch(bookUrl(file));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    // offline before the service worker took over — try the offline cache
    const hit = "caches" in window ? await caches.match(bookUrl(file)) : null;
    if (!hit) throw err;
    text = await hit.text();
  }
  state.cache.set(file, text);
  while (state.cache.size > 8) state.cache.delete(state.cache.keys().next().value);
  return text;
}

async function openChapter(i, offset = 0) {
  const ch = state.manifest.chapters[i];
  if (!ch) return;
  state.idx = i;
  state.loading = true;
  const content = $("#content");
  content.replaceChildren(el("p", { class: "muted" }, t("reader.loading")));
  let text;
  try {
    text = await fetchChapter(i);
  } catch (err) {
    // loading stays true: the error screen has no chapter edges, so a tap
    // must not chain into nav — 重試 / the bars are the way out
    content.replaceChildren(
      el("p", {}, t("err.chapterFail", err.message),
        el("button", { class: "linklike", onclick: () => openChapter(i, offset) }, t("lib.retry"))),
    );
    return;
  }

  $("#ctitle").textContent = ch.title;
  const frag = document.createDocumentFragment();
  frag.append(el("h2", { class: "chapter-head" }, ch.title));
  let off = 0;
  let headingSkipped = false;
  for (const line of text.split("\n")) {
    const s = line.trim(); // not `t` — that name is the translator now
    // the heading line itself is rendered as the <h2>, skip its paragraph
    if (s && !(s === ch.title.trim() && !headingSkipped && (headingSkipped = true))) {
      // data-off names the trimmed line's FIRST char in raw-text coords, not
      // the raw line start: the node holds the trimmed line, so offset maths
      // over it (the sentence wash, per-char rects) only lines up when the
      // 段首 indent the trim removed is skipped here too.
      frag.append(el("p", { "data-off": off + (line.length - line.trimStart().length) }, s));
    }
    off += line.length + 1;
  }
  content.replaceChildren(frag);
  applyGrid();
  state.loading = false;

  $("#prevBtn").disabled = i === 0;
  $("#nextBtn").disabled = i === state.manifest.chapters.length - 1;

  // offset "end" = land on the chapter's last screen (paging backward);
  // the tracked offset becomes the last paragraph's, refined by trackScroll
  const atEnd = offset === "end";
  if (atEnd) {
    const ps = content.querySelectorAll("p[data-off]");
    offset = ps.length ? Number(ps[ps.length - 1].dataset.off) : 0;
  }
  state.off = offset;
  restoreScroll(atEnd ? "end" : offset);
  updateProgress();
  savePos();

  if (i + 1 < state.manifest.chapters.length) fetchChapter(i + 1).catch(() => {});
  updateOfflineWindow();

  // navigating while listening moves the narration too (the player ignores
  // chapter opens it initiated itself)
  playerMod?.chapterOpened(i, offset);
}

// ---------- offline chapter cache (service worker serves it; we fill it) ----------
//
// Per book, three states in one localStorage key:
//
//   absent — the default: a small safety net. Reading a book quietly keeps
//            [idx−5, idx+5] on the device, so a tunnel or a dead spot never
//            strands the chapter someone is in the middle of — without
//            pulling a whole reading window over cellular uninvited.
//   "1"    — explicit, armed by tapping ⇣ (in the reader or on the shelf):
//            the full window [idx−5, idx+50] — enough book for a flight.
//   "0"    — off: nothing cached, the book's cache deleted.
//
// A tap on an unlit ⇣ always arms, a tap on a lit one always turns off — the
// safety net is only ever the pristine state, never returned to. "Off" is a
// stored value rather than a removed key so a device that deliberately turned
// the cache off stays off; the old opt-in scheme stored nothing for off,
// which made it indistinguishable from never-touched.

const OFFLINE_BEHIND = 5;
const OFFLINE_AHEAD = 50;
const OFFLINE_AHEAD_IMPLICIT = 5;

const offlineKey = (id) => `bw_offline_${id}`;
const offlineEnabled = (id = state.id) => localStorage.getItem(offlineKey(id)) !== "0";
const offlineExplicit = (id = state.id) => localStorage.getItem(offlineKey(id)) === "1";
const bookCacheName = (id = state.id) => `bw-book-${id}`;

function setOffline(id, on) {
  try { localStorage.setItem(offlineKey(id), on ? "1" : "0"); } catch { /* private mode */ }
}

async function toggleOffline() {
  if (!("caches" in window)) return;
  if (offlineExplicit()) {
    setOffline(state.id, false);
    await caches.delete(bookCacheName());
    updateOfflineBtn();
  } else {
    setOffline(state.id, true);
    persistStorage();
    updateOfflineBtn();
    updateOfflineWindow();
  }
}

// Ask the browser not to evict our storage: without this, iOS Safari drops
// the Cache API contents AND the service worker registration after ~7 days
// of not visiting the site — which presents as "offline stopped working".
function persistStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

// Runs after every chapter open; a newer run cancels the fetch loop of an
// older one.
let offlineRun = 0;
async function updateOfflineWindow() {
  if (!offlineEnabled() || !("caches" in window)) return;
  // offline: can't refill, so don't evict either — keep what we have
  if (navigator.onLine === false) return;
  const run = ++offlineRun;
  await fillOfflineWindow(state.id, state.manifest, state.idx, () => run === offlineRun);
  updateOfflineBtn();
}

// Keep chapters [idx-5, idx+50] of one book cached, evict the rest. Takes the
// book explicitly instead of reading `state`, because the shelf fills books
// that are not open — `alive` is how the reader cancels a superseded run.
async function fillOfflineWindow(id, manifest, idx, alive = () => true) {
  const chs = manifest.chapters;
  const lo = Math.max(0, idx - OFFLINE_BEHIND);
  const ahead = offlineExplicit(id) ? OFFLINE_AHEAD : OFFLINE_AHEAD_IMPLICIT;
  const hi = Math.min(chs.length - 1, idx + ahead);
  const want = new Set();
  for (let i = lo; i <= hi; i++) want.add(assetUrl(id, chs[i].file, manifest.generatedAt));

  const cache = await caches.open(bookCacheName(id));
  await cache.put(
    assetUrl(id, "manifest.json"),
    new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }),
  );
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    // compare path+query: a republished book's old ?v= entries evict too
    if (u.pathname.endsWith(".txt") && !want.has(u.pathname + u.search))
      await cache.delete(req);
  }
  const missing = [];
  for (const p of want) if (!(await cache.match(p))) missing.push(p);
  for (let i = 0; i < missing.length && alive(); i += 3) {
    await Promise.all(missing.slice(i, i + 3).map((p) => cache.add(p).catch(() => {})));
  }
}

// How many chapters of a book this device actually holds. caches.open() would
// CREATE the cache, and an empty bw-book-<id> is not harmless: the service
// worker takes its existence as "this book is kept offline" and starts
// stashing manifests for it. So ask caches.has() first.
async function cachedChapters(id) {
  if (!("caches" in window) || !(await caches.has(bookCacheName(id)))) return 0;
  const keys = await (await caches.open(bookCacheName(id))).keys();
  return keys.filter((r) => new URL(r.url).pathname.endsWith(".txt")).length;
}

// lit = explicit only: with the safety net always on, "lit because caching"
// would light for every book and mean nothing. Lit means "you asked to keep
// this book here", the same thing the shelf's ring means.
async function updateOfflineBtn() {
  const btn = $("#offlineBtn");
  if (!btn) return;
  btn.classList.toggle("active", offlineExplicit());
  if (!offlineEnabled() || !("caches" in window)) {
    btn.title = t("ui.offlineOff");
    return;
  }
  const n = await cachedChapters(state.id);
  btn.title = offlineExplicit() ? t("ui.offlineOn", n) : t("ui.offlineAuto", n);
}

// ---------- TTS audiobook player (lives in /player.mjs) ----------
//
// Preloaded at reader init so the 🔊 tap can start playback synchronously
// inside the gesture (iOS requirement). If a cold-cache tap beats the
// preload, playback starts gesture-less once the import lands — iOS may
// then need one ▶ tap on the player bar.

let playerMod = null;
let lastUserScroll = 0;

function loadPlayer() {
  return import("/player.mjs").then((m) => {
    m.init({
      $, el, state, fetchChapter, openChapter, savePos, flush,
      updateProgress, followScroll, pageStartOffset, highlightSentence,
      lastUserScroll: () => lastUserScroll,
    });
    playerMod = m;
    return m;
  });
}

function toggleAudio() {
  if (playerMod) return playerMod.togglePlayer();
  loadPlayer().then((m) => m.togglePlayer()).catch(() => {});
}

// Reading distance of an on-screen rect's START edge (its first line):
// 直排 lines advance leftward so the start is the RIGHT edge, 橫排 the top.
const rectDist = (c, r) => (settings.vertical
  ? -c.scrollLeft + (c.getBoundingClientRect().right - r.right)
  : r.top + scrollY - GRID.band);

// The on-screen rect of the CHARACTER at char offset `offset` — page maths
// must work on the character, not the paragraph: a novel paragraph spans
// pages, and the paragraph's start edge would pin every offset inside it to
// the paragraph's first page. Falls back to the paragraph rect at its start
// (or when the Range yields nothing). data-off counts from the trimmed
// line's first char, so in-paragraph offsets map onto the node exactly; an
// offset inside a 段首 indent lands on the previous paragraph's tail rect,
// adjacent at page granularity.
function offsetRect(offset) {
  const ps = $("#content")?.querySelectorAll("p[data-off]");
  if (!ps?.length) return null;
  let target = null;
  for (const p of ps) {
    if (Number(p.dataset.off) <= offset) target = p;
    else break;
  }
  if (!target) return null;
  const node = target.firstChild;
  const i = offset - Number(target.dataset.off);
  if (node?.nodeType === 3 && i > 0 && node.length) {
    const range = document.createRange();
    const j = Math.min(i, node.length - 1);
    range.setStart(node, j);
    range.setEnd(node, j + 1);
    const r = range.getBoundingClientRect();
    if (r.width || r.height) return r;
  }
  return target.getBoundingClientRect();
}

function followScroll(offset) {
  const c = $("#content");
  if (!c) return;
  const r = offsetRect(offset);
  if (!r) return;
  // paged reading, both modes: turn to the PAGE holding the spoken
  // character (and only when that is not the page already on screen), never
  // a partial scroll. Absolute target, never scrollBy: on-device scrolltest
  // 2026-07-28 proved iOS applies relative scrolls TWICE (8/8 layouts)
  // while absolute APIs are idempotent.
  const want = pageAt(Math.max(0, rectDist(c, r)));
  if (want !== pageAt(scrollDist(c))) pageGlide(c, pagePos(c, want));
}

// Paint the sentence the voice is on. NOT the CSS Custom Highlight API: on
// the phone its paint never invalidates — replaced and deleted highlights
// stay washed until something else repaints (WebKit bugs 266250, 259897;
// on-device screenshot 2026-08-08 showed a whole page of stale washes). So
// the wash is self-painted: one absolutely-positioned rect per line
// fragment of the sentence's Range, inside #content so the rects ride page
// glides natively, replaced wholesale each call — ordinary DOM painting,
// which WebKit always invalidates. A sentence never crosses a paragraph
// (\n is an ender), so one Range in one text node, clamped to the trimmed
// line the node holds — the caller hands in a span that starts on ink
// (markSpoken skips the 段首 indent), so the raw→node mapping is exact.
// null removes the wash. The heading renders as <h2>, not p[data-off], so
// the title announcement has nothing to paint.
function highlightSentence(start, end) {
  if (start == null) return void $("#ttsHl")?.remove();
  const c = $("#content");
  const ps = c?.querySelectorAll("p[data-off]");
  if (!ps?.length) return;
  let p = null;
  for (const q of ps) {
    if (Number(q.dataset.off) <= start) p = q;
    else break;
  }
  const node = p?.firstChild;
  if (node?.nodeType !== 3 || !node.length) return;
  const off = Number(p.dataset.off);
  const a = Math.max(0, Math.min(start - off, node.length - 1));
  const b = Math.max(a + 1, Math.min(end - off, node.length));
  const range = document.createRange();
  range.setStart(node, a);
  range.setEnd(node, b);
  const w = $("#ttsHl") ?? c.appendChild(el("div", { id: "ttsHl", "aria-hidden": "true" }));
  w.dataset.start = start;
  w.dataset.end = end;
  const cr = c.getBoundingClientRect();
  w.replaceChildren(...[...range.getClientRects()].map((r) => {
    const d = el("div");
    d.style.cssText = `left:${r.left - cr.left - c.clientLeft + c.scrollLeft}px;` +
      `top:${r.top - cr.top - c.clientTop + c.scrollTop}px;` +
      `width:${r.width}px;height:${r.height}px`;
    return d;
  }));
}

// Char offset of the first character on the page now on screen — where a
// NEW listening session starts. The tracked state.off is deliberately
// paragraph-grained and sticky (see trackScroll), so after paging it
// routinely points a page or more behind what the eye is on; the reading
// must open with the visible page instead. Page 0 answers 0 so the heading
// chunk still announces the chapter. Binary search inside the straddling
// paragraph: reading order is monotone in rect distance.
function pageStartOffset() {
  const c = $("#content");
  const ps = c?.querySelectorAll("p[data-off]");
  if (!c || !ps?.length || !GRID.span) return null;
  if (pageAt(scrollDist(c)) === 0) return 0;
  // the visible window's start edge, minus 1 px of grid-rounding grace;
  // scrollDist (not page×span) so the chapter-end clamped page keeps its
  // true edge
  const lead = Math.max(0, scrollDist(c)) - 1;
  let prev = null, next = null;
  for (const p of ps) {
    if (rectDist(c, p.getBoundingClientRect()) <= lead) prev = p;
    else { next = p; break; }
  }
  const nextOff = () => (next ? Number(next.dataset.off) : null);
  const node = prev?.firstChild;
  if (node?.nodeType !== 3 || !node.length) return nextOff();
  // first char of `prev` sitting past the window's start edge, if any —
  // otherwise the page opens on the next paragraph
  const range = document.createRange();
  const at = (i) => {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    return rectDist(c, range.getBoundingClientRect());
  };
  let lo = 0, hi = node.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) > lead) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  if (ans < 0) return nextOff();
  return Number(prev.dataset.off) + ans;
}

function topbarHeight() {
  return $(".topbar")?.offsetHeight ?? 0;
}

// Land a 直排 scroll by direct scrollLeft assignment, then hold the target
// for a few frames. NEVER scrollBy: the on-device scrolltest matrix
// (2026-07-28) proved this iOS build applies relative scrolls TWICE in all
// 8 layouts (both writing modes × both scroller kinds, anchoring
// irrelevant) — which doubled every page turn AND every bookmark restore;
// a restore that lands long gets saved as the new position, so the
// bookmark walked forward on each open. Absolute APIs measured 1×
// everywhere (idempotent by nature); the guard is cheap insurance against
// anything else moving the scroller, and backs off the moment a finger
// touches down (or a newer vSnap takes over).
let vSnapSeq = 0;
function vSnap(c, target) {
  slideCancel(); // a direct landing supersedes any in-flight page slide
  const seq = ++vSnapSeq;
  c.scrollLeft = target;
  let frames = 0, fixes = 0;
  const guard = () => {
    if (seq !== vSnapSeq || ++frames > 10 || fixes >= 3 || touchStart) return;
    if (Math.abs(c.scrollLeft - target) > 1) { fixes++; c.scrollLeft = target; }
    requestAnimationFrame(guard);
  };
  requestAnimationFrame(guard);
}

// Page turns ride the ENGINE's smooth scroll (user verdict 07-28: the
// /pgtest 原生smooth trial landed exact on device): one scrollTo with an
// absolute target — idempotent, so the iOS relative-scroll doubling can't
// touch it even mid-animation. The rAF watcher only OBSERVES: it keeps
// `slide` alive while the animation runs (a tap mid-slide is the next turn,
// based off slide.target so rapid taps stay on the grid; the brake logic
// can tell our own motion from momentum), ends on arrival or user takeover
// (iOS also kills the native animation itself on touch), and repairs via
// vSnap only if the animation dies short of the target.
let slide = null; // { target, raf } — the active page-turn slide
function slideCancel() {
  if (slide) { cancelAnimationFrame(slide.raf); slide = null; }
}
function vSlide(c, target) {
  slideCancel();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return vSnap(c, target);
  const born = Date.now();
  const s = { target, raf: 0 };
  c.scrollTo({ left: target, behavior: "smooth" });
  const watch = () => {
    if (slide !== s) return; // a newer landing took over
    if (lastUserScroll > born) { slide = null; return; } // finger/wheel owns the scroll
    if (Math.abs(c.scrollLeft - target) <= 1) { slide = null; return; } // landed
    if (Date.now() - born > 1500) { slide = null; vSnap(c, target); return; }
    s.raf = requestAnimationFrame(watch);
  };
  slide = s;
  s.raf = requestAnimationFrame(watch);
}

function restoreScroll(offset) {
  requestAnimationFrame(() => {
    const c = vScroller();
    if (offset === "end") {
      // the very end (scrollLeft's minimum on the flipped axis)
      if (settings.vertical) vSnap(c, c.clientWidth - c.scrollWidth);
      else scrollTo(0, document.documentElement.scrollHeight);
      return;
    }
    if (!offset) {
      if (settings.vertical) vSnap(c, 0);
      else scrollTo(0, 0);
      return;
    }
    const r = offsetRect(offset);
    if (r) {
      // the reading distance of the bookmarked character, then the PAGE
      // that contains it: a bookmark must reopen on a whole page, never
      // mid-page, or restore→save→restore stops being a fixed point — and
      // it must be the character's page, not the paragraph's first page,
      // or a long paragraph reopens a page early
      const pos = pageAlign(c, Math.max(0, rectDist(c, r)));
      if (settings.vertical) vSnap(c, pos);
      else scrollTo(0, pos);
    }
  });
}

// ---------- position tracking / sync ----------

let scrollTick = 0;
let lastScrollEvent = 0;
function onScroll() {
  lastScrollEvent = Date.now();
  // paged reading: a free pan is allowed to move, but it must SETTLE on a
  // page — "捲動要嘛一頁、要嘛不動" (user 07-28). Scheduled on every scroll
  // and re-armed while a finger is still down or our own slide is running.
  clearTimeout(snapTick);
  snapTick = setTimeout(snapToPage, 180);
  if (scrollTick) return;
  scrollTick = setTimeout(() => { scrollTick = 0; trackScroll(); }, 400);
}

let snapTick = 0;
function snapToPage() {
  snapTick = 0;
  const c = $("#content");
  if (!c || state.loading || !GRID.span) return;
  // our own page turn is already heading for a page point; a finger on the
  // glass owns the scroller until it lifts
  if (gliding() || touchStart || Date.now() - lastScrollEvent < 150) {
    if (Date.now() - lastScrollEvent < 3000) snapTick = setTimeout(snapToPage, 180);
    return;
  }
  const target = snapTarget(c, scrollDist(c));
  const now = settings.vertical ? c.scrollLeft : scrollY;
  if (Math.abs(target - now) > 1) pageGlide(c, target);
}

function trackScroll() {
  if (playerMod?.player.playing) return; // audio owns the position while narrating
  const c = $("#content");
  const ps = c?.querySelectorAll("p[data-off]");
  if (!ps || !ps.length) return;
  // Paged reading: a page holds many paragraphs, and the page we are on is
  // the page that CONTAINS the tracked point — so while that point is still
  // in front of us, it is still the position. Without this the tracker
  // would coarsen every restore to the page's first paragraph, and each
  // reflow (A±, rotation) would ratchet the bookmark a page backward.
  if (state.off && GRID.span) {
    let cur = null;
    for (const p of ps) {
      if (Number(p.dataset.off) <= state.off) cur = p;
      else break;
    }
    const r = cur?.getBoundingClientRect();
    if (r) {
      const page = c.getBoundingClientRect();
      const onPage = settings.vertical
        ? r.right > page.left && r.left < page.right
        : r.bottom > GRID.band && r.top < GRID.band + GRID.span;
      if (onPage) return;
    }
  }
  // binary search: first paragraph not yet scrolled past the reading edge —
  // below the top bar when horizontal, left of the right edge when vertical
  // (vertical-rl columns exit rightward as reading advances leftward)
  const vert = settings.vertical;
  // the reading edge is where the page starts: 直排 the page box's right
  // edge (no longer the viewport edge — the page is centered in it), 橫排
  // the top of the reading band
  const edge = vert
    ? c.getBoundingClientRect().right - 4
    : GRID.band + 4;
  const past = (r) => (vert ? r.left > edge : r.bottom < edge);
  let lo = 0, hi = ps.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (!past(ps[mid].getBoundingClientRect())) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  const cur = Number(ps[ans].dataset.off);
  // still the same top paragraph: not a move — keeps the finer resumed/spoken
  // offset, and the settling scroll after a restore never re-syncs (位置變動
  // 才觸發同步)
  const next = ans + 1 < ps.length ? Number(ps[ans + 1].dataset.off) : Infinity;
  if (cur <= state.off && state.off < next) return;
  if (cur !== state.off) {
    state.off = cur;
    updateProgress();
    savePos();
  }
}

function savePos() {
  const last = state.lastSaved;
  if (last && last.chapter === state.idx && last.offset === state.off) return; // nothing moved
  const rec = { chapter: state.idx, offset: state.off, updatedAt: Date.now() };
  state.lastSaved = rec;
  try { localStorage.setItem(posKey(), JSON.stringify(rec)); } catch { /* full/blocked */ }
  state.dirty = true;
  setSyncDot("pending");
  if (!state.syncTimer) state.syncTimer = setTimeout(() => flush(), 10_000);
}

async function flush(useBeacon = false) {
  if (state.syncTimer) { clearTimeout(state.syncTimer); state.syncTimer = 0; }
  if (!state.dirty || !state.lastSaved) return;
  const body = JSON.stringify({
    book: state.id,
    user: state.uid,
    chapter: state.lastSaved.chapter,
    offset: state.lastSaved.offset,
    updatedAt: state.lastSaved.updatedAt,
  });
  state.dirty = false;
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/position", new Blob([body], { type: "application/json" }));
    return;
  }
  try {
    const res = await fetch("/api/position", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // an evicted cookie: repair it for the retry the timer already owns
    if (res.status === 401) reauth();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSyncDot("ok");
  } catch {
    state.dirty = true;
    setSyncDot("err");
    if (!state.syncTimer) state.syncTimer = setTimeout(() => flush(), 15_000);
  }
}

function setSyncDot(s) {
  syncState = s;
  const dot = $("#syncdot");
  if (dot) dot.className = "syncdot " + s;
}

// ---------- settings sync (mirrors the position sync above) ----------
// bw_settings_ts = ms epoch of the last local change (or the server
// updatedAt after a server-wins reconcile); LWW arbitrates across devices.

let settingsDirty = false;
let settingsTimer = 0;

function settingsChanged() {
  try { localStorage.setItem("bw_settings_ts", String(Date.now())); } catch { /* private mode */ }
  settingsDirty = true;
  if (!settingsTimer) settingsTimer = setTimeout(() => flushSettings(), 2000);
}

async function flushSettings(useBeacon = false) {
  if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = 0; }
  if (!settingsDirty) return;
  const uid = state.uid ?? localStorage.getItem("bw_uid");
  if (!uid) return;
  const body = JSON.stringify({
    user: uid,
    settings: { fontSize: settings.fontSize, vertical: settings.vertical, bg: settings.bg },
    updatedAt: Number(localStorage.getItem("bw_settings_ts")) || Date.now(),
  });
  settingsDirty = false;
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/settings", new Blob([body], { type: "application/json" }));
    return;
  }
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // an evicted cookie: repair it for the retry the timer already owns
    if (res.status === 401) reauth();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    // a push lost here self-heals: next boot's resolveSettings sees the
    // local ts still ahead of the server row and re-pushes
    settingsDirty = true;
    if (!settingsTimer) settingsTimer = setTimeout(() => flushSettings(), 15_000);
  }
}

// Boot-time reconcile against the server row for this reader id. Called
// BEFORE the reader shell is built (in parallel with resolvePosition), so a
// server-wins apply never reflows a rendered chapter — if this ever moves
// after openChapter, a vertical/fontSize change must redo the toggleVertical
// dance: reset both scrollers, then restoreScroll(state.off).
async function resolveSettings(uid) {
  const localTs = Number(localStorage.getItem("bw_settings_ts")) || 0;
  let remote = null;
  try {
    // capped for the same reason as the position, and safe for the same
    // reason: settings are LWW by updated_at too, so a timed-out reconcile
    // re-pushes local rather than losing a newer server row
    const res = await fetch(`/api/settings?user=${encodeURIComponent(uid)}`, capped());
    if (!res.ok) return;
    const data = await res.json();
    if (data.settings) remote = data;
  } catch { return; } // offline/slow: keep local, retry next boot
  if (remote && remote.updatedAt > localTs) {
    // server wins — write the mirrors directly, NOT via the setters (a
    // setter would bump the ts and re-push what we just received)
    try {
      localStorage.setItem("bw_font", String(remote.settings.fontSize));
      localStorage.setItem("bw_vertical", remote.settings.vertical ? "1" : "0");
      localStorage.setItem("bw_bg", remote.settings.bg); // "" = explicit 預設
      localStorage.setItem("bw_settings_ts", String(remote.updatedAt));
    } catch { /* private mode: applied for this session only */ }
    applySettings();
    return;
  }
  const hasLocal = ["bw_font", "bw_vertical", "bw_bg"]
    .some((k) => localStorage.getItem(k) !== null);
  if (hasLocal && (!remote || localTs > remote.updatedAt)) {
    // local newer, or the server has no row yet and this device has explicit
    // values — push up. Legacy devices (settings pre-date the sync feature,
    // no ts) claim now as their baseline.
    if (!localTs) {
      try { localStorage.setItem("bw_settings_ts", String(Date.now())); } catch { /* ok */ }
    }
    settingsDirty = true;
    flushSettings();
  }
}

function updateProgress() {
  const before = state.idx > 0 ? state.cum[state.idx - 1] : 0;
  const total = state.manifest.totalChars || 1;
  const pct = Math.min(100, ((before + state.off) / total) * 100);
  $("#progress")?.replaceChildren(
    el("span", { id: "syncdot", class: "syncdot " + syncState, title: t("ui.syncStatus") }),
    ` ${state.idx + 1}/${state.manifest.chapters.length} · ${pct.toFixed(1)}%`,
  );
}

// ---------- navigation ----------

function nav(d, to = 0) {
  const i = state.idx + d;
  if (i < 0 || i >= state.manifest.chapters.length) return;
  openChapter(i, to).then(() => flush());
}

// Keyboard, on a desk. One rule decides all of it: the axis the text FLOWS
// along turns pages, and the axis across it changes chapters. So the two
// writing modes swap which pair does what —
//
//   直排 (flows leftward)   ←/→ page (← forward)   ↑/↓ chapter (↓ next)
//   橫排 (flows downward)   ↓/↑ page (↓ forward)   ←/→ chapter (→ next)
//   space                   forward one page, in both
//
// This is the same physical logic the tap zones use (bottom-left is forward
// in 直排 because forward IS leftward), rather than an abstract "→ means
// next" that would contradict the text on screen.
//
// preventDefault matters: space and the arrows scroll the document natively,
// which in 橫排 would fight the page grid and land between two lines.
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
  // a focused control owns its own keys — space activates a button, and the
  // TOC list is a column of them
  if (e.target instanceof Element && e.target.closest("input, textarea, select, button, a")) return;
  // also keeps the lookup below off Object.prototype
  if (e.key !== " " && !e.key.startsWith("Arrow")) return;
  const KEYS = settings.vertical
    ? { ArrowLeft: ["page", 1], ArrowRight: ["page", -1],
        ArrowDown: ["chap", 1], ArrowUp: ["chap", -1] }
    : { ArrowDown: ["page", 1], ArrowUp: ["page", -1],
        ArrowRight: ["chap", 1], ArrowLeft: ["chap", -1] };
  const [what, d] = (e.key === " " ? ["page", 1] : KEYS[e.key]) ?? [];
  if (!what) return;
  e.preventDefault();
  if (what === "page") pageScroll(d);
  else nav(d);
}

// Tap zones over the text. The bars start hidden (nothing sets data-bars on
// load) so the whole screen is reading area:
//   middle ninth (3×3 grid)  — show/hide the top & bottom bars
//   bottom-left quarter      — one screen forward (next is leftward in 直排)
//   bottom-right quarter     — one screen back
//
// Taps are detected from touch events, not click: iOS Safari only
// synthesizes click for taps on "clickable" elements, so a click listener
// never hears taps on plain text. click stays as the mouse path.

let touchStart = null;
let lastTouchTap = 0;

function onTouchStart(e) {
  touchStart = e.touches.length === 1
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(),
        // a tap that stops momentum scrolling is a brake, not a page turn —
        // but scroll events from OUR page slide don't count as momentum: a
        // tap during the slide is the next page turn
        still: !!slide || Date.now() - lastScrollEvent > 100 }
    : null;
}

function onTouchEnd(e) {
  const s = touchStart;
  touchStart = null;
  if (!s || !s.still) return;
  const end = e.changedTouches[0];
  if (Math.hypot(end.clientX - s.x, end.clientY - s.y) > 12 || Date.now() - s.t > 350) return;
  lastTouchTap = Date.now();
  handleTap(end.clientX, end.clientY, e.target);
}

function onTap(e) {
  if (Date.now() - lastTouchTap < 500) return; // synthesized after a touch tap
  handleTap(e.clientX, e.clientY, e.target);
}

function handleTap(cx, cy, target) {
  if (!(target instanceof Element) || target.closest("a, button, .topbar, .botnav, .playerbar, .toc")) return;
  if (getSelection()?.toString()) return; // finishing a text selection, not a tap
  const x = cx / innerWidth;
  const y = cy / innerHeight;
  if (x > 1 / 3 && x < 2 / 3 && y > 1 / 3 && y < 2 / 3)
    document.documentElement.toggleAttribute("data-bars");
  else if (y >= 0.5) pageScroll(x < 0.5 ? 1 : -1);
}


// One-screen page turn; at the chapter's edge it crosses into the adjacent
// chapter — forward to the next one's beginning, backward to the previous
// one's END (so paging back reads naturally across the boundary).
let lastPageTurn = 0;
function pageScroll(d) {
  // mid-open the placeholder has no size, which reads as "at the chapter
  // edge" — without this, every tap during a slow load chained another nav
  if (state.loading) return;
  // de-bounce: at most one turn per 150 ms — a second delivery of the same
  // gesture (a re-fired tap, a synthesized click that slipped a guard) is
  // absorbed instead of turning twice. vSnap covers the engine side by
  // holding the landing target for the same ~10 frames.
  const now = Date.now();
  if (now - lastPageTurn < 150) return;
  lastPageTurn = now;
  lastUserScroll = now; // pause the player's auto-follow, like a swipe
  const c = $("#content");
  // A tap mid-slide turns again from the slide's DESTINATION, so rapid taps
  // stay on the page grid instead of compounding from mid-flight.
  const inFlight = settings.vertical ? slide?.target : (gliding() ? hGlide.target : null);
  const base = inFlight == null ? scrollDist(c) : (settings.vertical ? -inFlight : inFlight);
  const end = scrollEnd(c);
  if (d > 0 && base >= end - 2) return nav(1);
  if (d < 0 && base <= 2) return nav(-1, "end");
  // the final page is clamped short of its own page point (the chapter
  // simply ends there), so paging back off it must count UP to the page
  // it overlaps, not round down into the page before that
  const k = base >= end - 2
    ? Math.ceil(base / pageStep())
    : Math.round(base / pageStep());
  pageGlide(c, pagePos(c, Math.max(0, k + d)));
}

function toggleToc() {
  const toc = $("#toc");
  if (!toc.hidden) { toc.hidden = true; return; }
  toc.replaceChildren(
    el("div", { class: "toc-head" },
      el("strong", {}, t("ui.contents")),
      el("button", { class: "iconbtn", onclick: () => (toc.hidden = true) }, "✕")),
    el("div", { class: "toc-list" },
      state.manifest.chapters.map((c, i) =>
        el("button", {
          class: "toc-item" + (i === state.idx ? " current" : ""),
          onclick: () => { toc.hidden = true; openChapter(i, 0).then(() => flush()); },
        }, c.title))),
  );
  toc.hidden = false;
  toc.querySelector(".current")?.scrollIntoView({ block: "center" });
}
