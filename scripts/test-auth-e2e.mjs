// E2E for the reader-key gate: the door every content route now sits behind.
//
// Node side proves the worker's contract — 401s without a credential, the
// three ways a key travels (header, cookie via /api/auth, ?key=), that a
// position belongs to the KEY's user and never to what a client asserts,
// and that revocation is immediate. Browser side proves the app's half: a
// bare visit renders the key gate, a /?key= link enrolls the device, strips
// itself from the address bar, and lands on the library as the right user.
//
// Prereqs: `pnpm run dev` running, ADMIN_TOKEN in .dev.vars.
//
//   node scripts/test-auth-e2e.mjs

import { readFileSync, rmSync } from "node:fs";
import { launch } from "./cdp-client.mjs";

const PORT = 9343;
const PROFILE = "/tmp/bookworm-auth-e2e-profile";
const BASE = process.env.BOOKWORM_URL ?? "http://localhost:8787";
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const BOOK = "b0auth001"; // never published: positions don't require the book
const out = {};

const auth = { authorization: `Bearer ${TOKEN}` };
const j = async (res) => [res.status, await res.json().catch(() => ({}))];
const mint = async (user, label) => (await (await fetch(`${BASE}/api/admin/readers`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ user, label }),
})).json()).key;
const revoke = (key) =>
  fetch(`${BASE}/api/admin/readers/${encodeURIComponent(key)}`, { method: "DELETE", headers: auth });

// 1. the gate, both directions, over the whole route surface.
//
// DESIGN.md points here rather than carrying its own copy of these lists,
// so these tables are the readable statement of which door each route is
// behind — and the structural check below refuses to let a route escape
// one. Both directions matter and only one of them is obvious: leaving a
// content route open leaks the book, but gating a deliberately-open route
// breaks something silently. Gating /api/wasmtts/* would strand every
// pack-less device (no /wasmtest, no voice-pack download) with a green
// suite, which is exactly the failure this table is here to catch.
//
// Bare = no credential at all. The gate runs before dispatch, so method
// and body never reach a gated route and a plain GET is enough to probe.
const READER_401 = [
  "/api/books", "/api/books/x", "/books/x/manifest.json",
  "/api/position", "/api/settings", "/api/tts/x/0000_x.txt/0",
  "/api/push/subscribe", "/api/push/test", "/api/testlog",
];
const ADMIN_401 = [
  "/api/admin/ping", "/api/admin/session", "/api/admin/feedback", "/api/admin/feedback/1",
  "/api/admin/readers", "/api/admin/reindex",
  "/api/admin/audit", "/api/admin/cleanup", "/api/admin/owner-test",
  "/api/admin/update", "/api/admin/update/policy", "/api/admin/update/install-now",
];
// Open, and each for its own reason: the shell is the public repo's
// contents, feedback is the AI's inbox, the build stamp of a public repo
// guards nothing, vapid is a public key, unsubscribe must work for a
// device whose key was revoked, and the wasmtts proxy serves public OSS
// binaries. Asserted as "not 401" rather than ok: an unknown asset name
// is allowed to 404, what it must never do is ask for a key.
const OPEN = [
  "/admin", "/api/feedback", "/api/version",
  "/api/push/vapid", "/api/push/unsubscribe", "/api/wasmtts/probe.wasm",
];
// /api/auth is the enrollment endpoint, neither gated nor open: it answers
// 400 bare and 401 to an unknown key, both pinned by authRefusals below.
const SPECIAL = ["/api/auth"];

const statuses = async (paths) =>
  Promise.all(paths.map(async (p) => [p, (await fetch(`${BASE}${p}`)).status]));
const [readerSt, adminSt, openSt] = await Promise.all([
  statuses(READER_401), statuses(ADMIN_401), statuses(OPEN),
]);
const wrong = [
  ...readerSt.filter(([, s]) => s !== 401),
  ...adminSt.filter(([, s]) => s !== 401),
  ...openSt.filter(([, s]) => s === 401),
];
out.gate = wrong.length === 0
  ? `ok (${READER_401.length} reader + ${ADMIN_401.length} admin routes 401 bare; ${OPEN.length} stay open)`
  : `FAIL ${wrong.map(([p, s]) => `${p}=${s}`).join(" ")}`;

// Every route the worker dispatches on must be claimed by one of the
// tables above. A new route ships with a decision about its door, or this
// fails — which is the whole reason the doc delegates the list to the code.
const worker = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const claimed = [...READER_401, ...ADMIN_401, ...OPEN, ...SPECIAL];
const routeLit = (re) => [...worker.matchAll(re)].map((m) => m[1]).filter((r) => r.startsWith("/"));
const exact = [...new Set(routeLit(/path === "([^"]+)"/g))];
const prefix = [...new Set(routeLit(/path\.startsWith\("([^"]+)"\)/g))];
const unclaimed = [
  ...exact.filter((r) => !claimed.includes(r)),
  ...prefix.filter((r) => !claimed.some((p) => p.startsWith(r))),
];
out.routeSurface = unclaimed.length === 0
  ? `ok (${exact.length} routes + ${prefix.length} prefixes all claimed)`
  : `FAIL unclaimed in src/worker.js: ${unclaimed.join(", ")}`;

// 1b. testlog is split by verb AND by credential: reads take a reader key
// (the rows quote the book), writes take the bw_tlog cookie /admin mints from
// the Bearer. The cookie exists because sendBeacon and the service worker —
// the writers that matter — cannot send a header at all, so proving the
// Bearer alone does NOT open the write is the point of this block: a header
// that worked here would be a header nothing in the field can send.
const logBare = await fetch(`${BASE}/api/testlog?limit=1`);
const logAuth = await fetch(`${BASE}/api/testlog?limit=1`, { headers: auth });
const writeAs = (cookie, page = "wasmtest") => fetch(`${BASE}/api/testlog`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  body: JSON.stringify({ page, device: "auth-e2e", data: "gate check" }),
});
const writeBare = await writeAs(null);
const writeBearer = await fetch(`${BASE}/api/testlog`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ page: "wasmtest", device: "auth-e2e", data: "gate check" }),
});
const session = await fetch(`${BASE}/api/admin/session`, { method: "POST", headers: auth });
const tlog = (session.headers.get("set-cookie") ?? "").split(";")[0];
const writeCookie = await writeAs(tlog);
// a page nobody lists is refused rather than given a bucket of its own: the
// quota is per page, so an open-ended set of names is an open-ended row count
const writeUnknown = await writeAs(tlog, "authe2e");
// the cookie is scoped to logging — it must not stand in for the Bearer
const adminByCookie = await fetch(`${BASE}/api/admin/ping`, { headers: { cookie: tlog } });
out.testlogGate =
  logBare.status === 401 && logAuth.ok && writeBare.status === 401
  && writeBearer.status === 401 && tlog.startsWith("bw_tlog=") && writeCookie.ok
  && writeUnknown.status === 400 && adminByCookie.status === 401
    ? "ok (read needs a key; write needs the cookie, not the Bearer; unlisted page 400s)"
    : `FAIL bare=${logBare.status} auth=${logAuth.status} write=${writeBare.status} `
      + `bearer=${writeBearer.status} cookie=${writeCookie.status} `
      + `unknown=${writeUnknown.status} adminByCookie=${adminByCookie.status}`;

// 2. /api/auth refuses what it should
const [badStatus] = await j(await fetch(`${BASE}/api/auth`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "not-a-real-key" }),
}));
const [emptyStatus] = await j(await fetch(`${BASE}/api/auth`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
}));
out.authRefusals = badStatus === 401 && emptyStatus === 400
  ? "ok (unknown key 401, no key 400)" : `FAIL ${badStatus}/${emptyStatus}`;

// 3. mint two keys for two users through the admin route
const key1 = await mint("authe2e", "auth-e2e primary");
const key2 = await mint("authe2f", "auth-e2e second device");
const [listStatus, listed] = await j(await fetch(`${BASE}/api/admin/readers`, { headers: auth }));
out.minted = key1 && key2 && listStatus === 200 &&
  ["authe2e", "authe2f"].every((u) => (listed.readers ?? []).some((r) => r.user === u))
  ? "ok (minted and listed)" : `FAIL list=${listStatus}`;

// 4. the three transports: header, ?key=, and the cookie /api/auth sets
const viaHeader = await fetch(`${BASE}/api/books`, { headers: { "x-reader-key": key1 } });
const viaQuery = await fetch(`${BASE}/api/books?key=${encodeURIComponent(key1)}`);
const authRes = await fetch(`${BASE}/api/auth`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: key1 }),
});
const cookie = authRes.headers.get("set-cookie") ?? "";
const [whoStatus, who] = await j(await fetch(`${BASE}/api/auth`, {
  headers: { cookie: `bw_key=${encodeURIComponent(key1)}` },
}));
out.transports = viaHeader.ok && viaQuery.ok &&
  cookie.includes("bw_key=") && cookie.includes("HttpOnly") &&
  whoStatus === 200 && who.user === "authe2e"
  ? "ok (header, query, and a cookie that answers GET /api/auth)"
  : `FAIL hdr=${viaHeader.status} q=${viaQuery.status} cookie=${JSON.stringify(cookie)} who=${whoStatus}/${who.user}`;

// 5. a position belongs to the key's user — asserted ids are dead weight.
// key1 writes chapter 2; key2 writes chapter 7 on the same book WHILE
// claiming to be authe2e in the body; each key still reads its own row.
await fetch(`${BASE}/api/position`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-reader-key": key1 },
  body: JSON.stringify({ book: BOOK, chapter: 2, offset: 9, updatedAt: Date.now() }),
});
await fetch(`${BASE}/api/position`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-reader-key": key2 },
  body: JSON.stringify({ book: BOOK, user: "authe2e", chapter: 7, offset: 1, updatedAt: Date.now() }),
});
const [, pos1] = await j(await fetch(`${BASE}/api/position?book=${BOOK}`, { headers: { "x-reader-key": key1 } }));
const [, pos2] = await j(await fetch(`${BASE}/api/position?book=${BOOK}`, { headers: { "x-reader-key": key2 } }));
out.positionIdentity = pos1.position?.chapter === 2 && pos2.position?.chapter === 7
  ? "ok (each key reads its own bookmark; the asserted user was ignored)"
  : `FAIL pos1=${JSON.stringify(pos1)} pos2=${JSON.stringify(pos2)}`;

// the admin Bearer passes the gate but has no reading identity
const adminPos = await fetch(`${BASE}/api/position?book=${BOOK}`, { headers: auth });
out.adminNoIdentity = adminPos.status === 401
  ? "ok (admin Bearer cannot read a bookmark)" : `FAIL ${adminPos.status}`;

// 6. revocation is immediate
await revoke(key2);
const revoked = await fetch(`${BASE}/api/books`, { headers: { "x-reader-key": key2 } });
const stillOk = await fetch(`${BASE}/api/books`, { headers: { "x-reader-key": key1 } });
out.revocation = revoked.status === 401 && stillOk.ok
  ? "ok (revoked key 401s, the other key lives)" : `FAIL ${revoked.status}/${stillOk.status}`;

// --- browser half: the gate screen, and enrolling through a /?key= link ---
rmSync(PROFILE, { recursive: true, force: true });
const { evalJs, send, close, sessionId } = await launch({ port: PORT, profile: PROFILE });
const nav = async (url) => {
  await send("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, 1500));
};

// a bare visit has no key: the app must show the door, not a broken shelf
await nav(`${BASE}/`);
out.gateScreen = await evalJs(`!document.getElementById("gateScreen").hidden`)
  ? "ok (key gate rendered)" : "FAIL: no key gate";

// paste the LINK the way a phone actually delivers it — wrapped in the
// invisible bidi isolate marks and trailing punctuation an iMessage copy
// smuggles along — and submit through the form
const dirty = `\u2068${BASE}/?key=${key1}\u2069\n\u00A0\u3002`;
const unlocked = await evalJs(`(async () => {
  document.getElementById("keyInput").value = ${JSON.stringify(dirty)};
  document.getElementById("keyForm").requestSubmit();
  await new Promise((r) => setTimeout(r, 1500));
  return {
    library: !document.getElementById("shelfScreen").hidden,
    uid: localStorage.getItem("bw_uid"),
    msg: document.getElementById("keyMsg")?.textContent ?? "",
  };
})()`);
out.gatePasteLink = unlocked.library && unlocked.uid === "authe2e"
  ? "ok (a dirty pasted link still unlocks)"
  : `FAIL ${JSON.stringify(unlocked)}`;

// the enroll link: swallow the key, strip the URL, land signed in
await nav(`${BASE}/?key=${encodeURIComponent(key1)}`);
const enrolled = await evalJs(`({
  uid: localStorage.getItem("bw_uid"),
  key: localStorage.getItem("bw_key") !== null,
  search: location.search,
  gate: !document.getElementById("gateScreen").hidden,
})`);
out.enroll = enrolled.uid === "authe2e" && enrolled.key && enrolled.search === "" && !enrolled.gate
  ? "ok (enrolled as authe2e, key scrubbed from the URL)"
  : `FAIL ${JSON.stringify(enrolled)}`;

// a headless Chromium is never standalone, so enrolling must offer the
// install guide exactly once; continue lands on the library
const guideShown = await evalJs(`!document.getElementById("guideScreen").hidden`);
await evalJs(`document.getElementById("guideContinue")?.click()`);
await new Promise((r) => setTimeout(r, 1200));
const afterGuide = await evalJs(`({
  library: !!document.getElementById("changeKeyBtn"),
  seen: localStorage.getItem("bw_install_seen"),
})`);
out.installGuide = guideShown && afterGuide.library && afterGuide.seen === "1"
  ? "ok (offered once on enrollment, continue lands on the shelf)"
  : `FAIL shown=${guideShown} ${JSON.stringify(afterGuide)}`;

// the cookie carries a plain reload — no ?key=, no localStorage needed;
// and the guide, once seen, stays away
await evalJs(`localStorage.removeItem("bw_uid")`);
await nav(`${BASE}/`);
out.cookieCarries = !(await evalJs(`!document.getElementById("gateScreen").hidden`)) &&
  !(await evalJs(`!document.getElementById("guideScreen").hidden`)) &&
  (await evalJs(`localStorage.getItem("bw_uid")`)) === "authe2e"
  ? "ok (cookie alone re-seeds the identity; no repeat guide)"
  : "FAIL: cookie did not carry the reload";

// --- cleanup: this suite's keys and the fake book's bookmarks ---
await revoke(key1);
await fetch(`${BASE}/api/admin/cleanup`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ kind: "orphan-position", id: BOOK }),
});

console.log(JSON.stringify(out, null, 2));
await close();
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
