// Bookworm worker: serves chapter files from R2, reading positions from D1,
// and on-demand TTS audio (Microsoft Edge read-aloud, cached in R2).
// Static assets (the reader app) are served directly by the assets binding;
// this worker only runs for /api/* and /books/* (see run_worker_first).

import { chunkChapter, ttsPrompt } from "../public/tts-core.mjs";
import { RESERVED_SLUGS, SLUG_RE } from "../public/split-core.mjs";
import { PACK_NAMES } from "../public/vendor/wasmtts/pack-manifest.mjs";
import { edgeSynthesize } from "./edge-tts.js";
import { vapidPublicKey, sendPush, b64u } from "./push.js";
import { readPanel, setPolicy, queueInstallNow, shouldAlarm, shouldNotifyWaiting, shouldAnnounceInstall } from "./update-panel.mjs";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// stamped by deploy.sh at deploy time, the same dance as app.js's BUILD:
// "dev" means an unstamped local run. /api/version serves it so a shell
// already open on a phone can learn that a newer one has deployed, and the
// cron's announceSelf() pushes it to the phones that have no shell open.
const BUILD = "dev";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    // every handler is awaited, not just returned: a returned promise settles
    // OUTSIDE this try, so an async throw used to escape as a bare platform
    // 1101 (HTTP 500, no body) and the caller lost the message entirely
    try {
      // The gate: everything that can open a book, read or move a bookmark,
      // or start a synthesis requires a reader key (see authenticate); the
      // admin Bearer passes too, because the /admin shelf reads /api/books.
      // Still open: the app shell (it is the public repo's contents),
      // /api/feedback (the AI's inbox reads it keyless by design),
      // /api/wasmtts/* (public OSS binaries proxied for the /wasmtest
      // diagnostic), and the push vapid/unsubscribe pair (a public key, and a
      // revoked device must always be able to unregister).
      //
      // /api/testlog is the one route split by verb, and by credential. GET
      // is listed here: a reader key or the admin Bearer, because the rows
      // quote the book. POST is NOT listed — it checks its own cookie inside
      // handleTestlog, because it wants ADMIN rights from writers that cannot
      // carry a header at all (see testlogSessionOk).
      //
      // /api/books (the shelf list, not /api/books/<slug>) is gated too, but
      // NOT through this authenticate: it answers every open of the app, and
      // the D1 round trips here add up from the far side of the Pacific — so
      // listBooks folds the key lookup into its own single batch. Same
      // credentials, same 401, one round trip.
      const gated =
        path.startsWith("/api/books/") ||
        path === "/api/position" || path === "/api/settings" ||
        path.startsWith("/api/tts/") || path.startsWith("/books/") ||
        path === "/api/push/subscribe" || path === "/api/push/test" ||
        (path === "/api/testlog" && request.method === "GET");
      const who = gated || path === "/api/auth"
        ? await authenticate(request, env, url) : null;
      if (gated && !who) return json({ error: "unauthorized" }, 401);

      // open like feedback: a build stamp of a public repo guards nothing,
      // and the app checks it from the gate screen too
      if (path === "/api/version")
        return json({ build: BUILD }, 200, { "cache-control": "no-store" });

      if (path === "/api/auth") return await handleAuth(request, env, url, who);
      if (path === "/api/books") return await listBooks(request, env, url);
      if (path.startsWith("/api/books/")) return await resolveBook(request, env, path);
      if (path === "/api/position") return await handlePosition(request, env, url, who);
      if (path === "/api/settings") return await handleSettings(request, env, url, who);
      if (path === "/api/testlog") return await handleTestlog(request, env, ctx, url);
      if (path === "/api/feedback") return await listFeedback(request, env);
      if (path.startsWith("/api/wasmtts/")) return await serveWasmttsAsset(path);
      if (path.startsWith("/api/tts/")) return await handleTts(request, env, ctx, path, url);
      if (path.startsWith("/api/push/")) return await handlePush(request, env, ctx, path, who);
      if (path.startsWith("/api/admin/")) return await handleAdmin(request, env, ctx, path);
      if (path.startsWith("/books/")) return await serveBook(request, env, path);
      if (path === "/admin")
        return await env.ASSETS.fetch(new URL("/admin.html", url.origin));
    } catch (err) {
      return json({ error: String(err?.message ?? err) }, 500);
    }
    return json({ error: "not found" }, 404);
  },

  // The reader's own cron (wrangler.jsonc triggers): every minute, the
  // version that is actually running asks whether it has been announced yet,
  // and whether the updater has gone silent. Nothing external fires this,
  // which is the whole point — see announceSelf. The reader raises the
  // silent-updater alarm because a dead updater cannot report its own death
  // (R10); the updater itself never pushes.
  async scheduled(controller, env, ctx) {
    await announceSelf(env, ctx);
    await alarmSilentUpdater(env, ctx);
    await notifyWaiting(env, ctx);
    await alarmFailedInstall(env, ctx);
  },
};

// The silent-updater alarm (PM-14, R10). A cron-only Worker fails invisibly —
// an expired token, a revoked credential, a cron that stopped firing all look
// identical: updater_status.last_check_at stops moving. The reader watches it
// and, past the threshold, warns the owner ONCE per stall (silent_alarm_for
// holds the value it last alarmed about). A fresh install with no updater
// leaves last_check_at 0 and never nags. Recorded before the push, so a second
// tick or a push failure does not double-fire; the panel's own stale warning
// is the durable signal either way.
async function alarmSilentUpdater(env, ctx) {
  const row = await env.DB.prepare(
    "SELECT last_check_at, silent_alarm_for FROM updater_status WHERE id = 1").first();
  if (!row) return;
  const now = Date.now();
  if (!shouldAlarm({ lastCheckAt: row.last_check_at, silentAlarmFor: row.silent_alarm_for, now })) return;
  await env.DB.prepare("UPDATE updater_status SET silent_alarm_for = ? WHERE id = 1")
    .bind(row.last_check_at).run();
  const hours = Math.max(1, Math.round((now - row.last_check_at) / 3600000));
  await pushOwner(env, ctx, "更新器失聯", {
    title: "更新器失聯", body: `更新器已約 ${hours} 小時沒有回報，請到 /admin 檢查。`, url: "/admin",
  });
}

// Waiting-for-you (PM-09, the second owner-only push). The updater writes
// notify_version when its decide() will not install a release without the
// owner — notify mode, or a requires-attention release automatic mode refuses
// to take on its own. The reader watches that column (a dead-or-unarmed
// updater simply never sets it, and nothing rings) and pushes the owner ONCE
// per waiting version; notify_sent_for records what it last rang so the same
// version across ticks stays quiet. notify_attention words it: a release that
// needs a human at the instance versus one the install-now button clears.
async function notifyWaiting(env, ctx) {
  const row = await env.DB.prepare(
    "SELECT notify_version, notify_attention, notify_sent_for FROM updater_status WHERE id = 1").first();
  if (!row) return;
  if (!shouldNotifyWaiting({ notifyVersion: row.notify_version, notifySentFor: row.notify_sent_for })) return;
  // recorded before the push, so a second tick or a push failure does not
  // double-ring; the panel's own 待您決定 line is the durable signal either way
  await env.DB.prepare("UPDATE updater_status SET notify_sent_for = ? WHERE id = 1")
    .bind(row.notify_version).run();
  const body = row.notify_attention
    ? `有新版本 ${row.notify_version} 需要您先處理才能安裝（可能要新增密鑰），請到 /admin。`
    : `有新版本 ${row.notify_version} 等您決定是否安裝，請到 /admin。`;
  await pushOwner(env, ctx, "待您決定", { title: "有新版本待您決定", body, url: "/admin" });
}

// Install-failed (PM-09, the third owner-only push). The updater's guarded
// install (PM-07) records its outcome in updater_status: 'ok', 'rolled-back'
// (the previous version was put back) or 'failed' (the install could not
// proceed, the site unharmed). The reader pushes the owner once per non-ok
// attempt — install_alarm_for holds the last_install_at it already rang, so a
// bad install rings once and every 'ok' stays silent (新版本已上線 is that
// one's broadcast, from announceSelf). A rolled-back install still stands on
// the panel; the push is the nudge, the panel is the record.
async function alarmFailedInstall(env, ctx) {
  const row = await env.DB.prepare(
    "SELECT last_install_at, last_install_version, last_install_result, install_alarm_for FROM updater_status WHERE id = 1").first();
  if (!row) return;
  if (!shouldAnnounceInstall({ result: row.last_install_result, installAt: row.last_install_at, installAlarmFor: row.install_alarm_for })) return;
  await env.DB.prepare("UPDATE updater_status SET install_alarm_for = ? WHERE id = 1")
    .bind(row.last_install_at).run();
  const rolled = row.last_install_result === "rolled-back";
  const body = rolled
    ? `安裝 ${row.last_install_version} 失敗，已回復前一版。到 /admin 查看原因。`
    : `安裝 ${row.last_install_version} 未成功（網站未受影響）。到 /admin 查看原因。`;
  await pushOwner(env, ctx, rolled ? "安裝已回復" : "安裝未成功", {
    title: rolled ? "更新失敗，已回復" : "更新未成功", body, url: "/admin",
  });
}

// ---------- reader auth ----------
//
// Possession of a key is the whole identity model: a key is minted on
// /admin, carried to a device as a /?key=… link, and maps to the user whose
// bookmarks and settings that device then reads and writes. A reader id in
// a request is never trusted — the key is looked up instead, which is what
// finally closes the old honor-system hole where any device could write
// positions as any id.

// Where a key may travel, in the order tried: an x-reader-key header
// (scripts, tests), the bw_key cookie (set by POST /api/auth — cookies are
// what let <audio src>, sendBeacon and the service worker's fetches
// authenticate, since none of them can carry a header), or ?key= (the
// enroll link before the app has swallowed it).
function readerKey(request, url) {
  const header = request.headers.get("x-reader-key");
  if (header) return header;
  const m = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)bw_key=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return url.searchParams.get("key");
}

// Who is asking: {user, label} for a live reader key, {admin: true, user:
// null} for the admin Bearer, null for nobody. One D1 point read per gated
// request.
async function authenticate(request, env, url) {
  const auth = request.headers.get("authorization") ?? "";
  if (env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`)
    return { admin: true, user: null };
  const key = readerKey(request, url);
  if (!key) return null;
  const row = await env.DB.prepare(
    "SELECT user, label FROM readers WHERE key = ?",
  ).bind(key).first();
  // the key rides along so a push subscription can remember which DEVICE
  // registered it (push_subs.key) — the owner flag lives on keys, not users
  return row ? { user: row.user, label: row.label, key } : null;
}

// ---- the diagnostic-log session cookie ----------------------------------
//
// Writing /api/testlog takes admin rights, but every writer that matters is
// one that cannot carry an Authorization header. sendBeacon has no headers
// argument at all — only (url, data) — and it is what testlog.js, player.mjs
// and the pagehide flushes use, because it is the only send that survives a
// page going away. The service worker has no page to read a token from. That
// is the same problem the reader key already solved: cookies are what
// <audio src>, sendBeacon and service-worker fetches authenticate with (see
// readerKey), so admin gets a cookie too, minted from the Bearer when /admin
// unlocks.
//
// This is NOT the admin token in a cookie, and it does not open /api/admin/*.
// handleAdmin checks the Bearer header itself and never looks at a cookie, so
// this credential structurally cannot reach 發書 or 刪書 — no SameSite rule is
// holding that line, the route simply does not read it. What it authorizes is
// one thing: appending a log row.
//
// Stateless: <exp>.<HMAC(ADMIN_TOKEN, "testlog:<exp>")>. No session table and
// no D1 read on the write path — the write stays one INSERT. Rotating
// ADMIN_TOKEN invalidates every outstanding cookie at once, because the
// signature stops matching; there is nothing to revoke.
const TESTLOG_COOKIE = "bw_tlog";
// Long, deliberately. sendBeacon returns a boolean meaning "queued", never
// the status, so an expired cookie is a silent 401 — the phone stops logging
// and nothing anywhere says why. The blast radius of a leaked one is junk log
// rows, which the per-page quota already bounds, so lapsing is the worse risk
// of the two. /admin re-mints on every unlock anyway.
const TESTLOG_TTL_MS = 180 * 24 * 3600 * 1000;

async function testlogSign(env, exp) {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", te.encode(env.ADMIN_TOKEN), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  return `${exp}.${b64u.enc(await crypto.subtle.sign("HMAC", key, te.encode(`testlog:${exp}`)))}`;
}

async function testlogSessionOk(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const m = (request.headers.get("cookie") ?? "")
    .match(new RegExp(`(?:^|;\\s*)${TESTLOG_COOKIE}=([^;]+)`));
  if (!m) return false;
  const value = decodeURIComponent(m[1]);
  const exp = Number(value.split(".")[0]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  return value === await testlogSign(env, exp);
}

// POST /api/admin/session — trade the Bearer for that cookie. Reached only
// through handleAdmin, so the Bearer has already been checked.
async function mintTestlogSession(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  // Secure only on https, for the same reason handleAuth does it: wrangler
  // dev serves plain http, where a Secure cookie is silently dropped
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const exp = Date.now() + TESTLOG_TTL_MS;
  // Path is the route itself, not /: unlike the reader key this credential
  // has exactly one destination, so there is no reason for it to ride every
  // chapter fetch and every TTS request on the admin's own phone.
  return json({ ok: true, exp }, 200, {
    "set-cookie": `${TESTLOG_COOKIE}=${await testlogSign(env, exp)}; Path=/api/testlog; `
      + `Max-Age=${Math.floor(TESTLOG_TTL_MS / 1000)}; SameSite=Lax; HttpOnly${secure}`,
    "cache-control": "no-store",
  });
}

// POST /api/auth {key} — trade a key for an identity: validate it, answer
// Set-Cookie so every later request rides authenticated for free, and tell
// the app who it now is. GET /api/auth — what the current credentials
// amount to (the app's recovery path when localStorage lost the uid but the
// cookie survived). The cookie is server-set on purpose: Safari's ITP caps
// document.cookie writes at 7 days, and a weekly key prompt on the phone
// would read as the app breaking.
async function handleAuth(request, env, url, who) {
  if (request.method === "GET") {
    if (!who?.user) return json({ error: "unauthorized" }, 401);
    return json({ user: who.user, label: who.label ?? "" }, 200,
      { "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key) return json({ error: "key required" }, 400);
  const row = await env.DB.prepare(
    "SELECT user, label FROM readers WHERE key = ?",
  ).bind(key).first();
  if (!row) return json({ error: "unauthorized" }, 401);
  // Secure only when actually on https — wrangler dev serves plain http,
  // where a Secure cookie would be silently dropped
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return json({ ok: true, user: row.user, label: row.label }, 200, {
    "set-cookie":
      `bw_key=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`,
    "cache-control": "no-store",
  });
}

// GET /api/books — the library list. This answers every open of the app, and
// it used to answer in ~1.1 s flat: authenticate, the list, the reader's
// positions — three sequential D1 round trips — then an R2 manifest read per
// in-progress book for the chars-before-bookmark sum behind progress.pct.
// None of that was load; it was distance, paid serially. So this route does
// its own authentication (see the gate comment in fetch) and asks D1 for
// everything in ONE batch: the key's user, the shelf, and that user's
// positions (joined by the same key subquery, so no statement waits on
// another). The chars sum rides the index row (books.chapter_chars, written
// by registerBook; rows from before the column were backfilled once by a
// dispatch workflow on 2026-08-16, and the R2 fallback left with it). A row
// without a parsable array simply shows no progress — this route no longer
// touches R2. The admin Bearer gets the bare list: it has no reading identity.
async function listBooks(request, env, url) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const auth = request.headers.get("authorization") ?? "";
  const admin = env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`;
  const key = readerKey(request, url) ?? "";
  if (!admin && !key) return json({ error: "unauthorized" }, 401);
  const [keyRes, bookRes, posRes] = await env.DB.batch([
    env.DB.prepare("SELECT user FROM readers WHERE key = ?").bind(key),
    env.DB.prepare(
      "SELECT id, slug, title, author, chapters, total_chars, chapter_chars FROM books"),
    env.DB.prepare(
      "SELECT book, chapter, char_off FROM positions WHERE user = (SELECT user FROM readers WHERE key = ?)",
    ).bind(key),
  ]);
  const keyRow = keyRes.results?.[0];
  if (!admin && !keyRow) return json({ error: "unauthorized" }, 401);
  const user = admin ? null : keyRow.user;
  const rows = bookRes.results ?? [];
  const charsById = new Map();
  for (const r of rows) {
    try {
      const a = JSON.parse(r.chapter_chars);
      if (Array.isArray(a)) charsById.set(r.id, a);
    } catch { /* no parsable array: the book shows no progress */ }
  }
  const books = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title || r.slug,
    // only when the enrichment sidecar named one — no empty keys on the wire
    ...(r.author ? { author: r.author } : {}),
    chapters: r.chapters,
    totalChars: r.total_chars,
  }));

  if (user) {
    const posMap = new Map((posRes.results ?? []).map((r) => [r.book, r]));
    for (const b of books) {
      const pos = posMap.get(b.id);
      const chaps = charsById.get(b.id);
      if (!pos || !chaps || !(b.totalChars > 0)) continue;
      let before = 0;
      for (let i = 0; i < Math.min(pos.chapter, chaps.length); i++)
        before += chaps[i] ?? 0;
      b.progress = {
        chapter: pos.chapter,
        pct: Number(Math.min(100, ((before + pos.char_off) / b.totalChars) * 100).toFixed(1)),
      };
    }
  }

  books.sort((a, b) => a.title.localeCompare(b.title));
  // no-store for EVERY identity. This used to be public/max-age=60 for the
  // admin Bearer, but every 200 here is identified (keyless requests 401),
  // so the public copy served no one — and the browser HTTP cache does not
  // vary on credentials, so on the owner's phone the /admin list fetch would
  // seed a cacheable copy that "/" then read for the next minute: a book
  // uploaded on /admin was missing from the shelf (and progress blank) until
  // it expired. Offline reads come from the app's own bw_books copy, not
  // the HTTP cache, so nothing is lost by never caching.
  return json({ books }, 200, { "cache-control": "no-store" });
}

// GET /api/books/<slug> — the slug in a URL is a label; this is what turns it
// into the id the book is actually stored under. Former slugs resolve too
// (see book_slugs), so a re-slug never breaks a bookmark; the canonical slug
// comes back in the response for the reader to display.
async function resolveBook(request, env, path) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const slug = decodeURIComponent(path.slice("/api/books/".length));
  if (!slug) return json({ error: "not found" }, 404);
  const row = await env.DB.prepare(
    `SELECT b.id, b.slug, b.title, b.chapters, b.total_chars
       FROM book_slugs s JOIN books b ON b.id = s.book
      WHERE s.slug = ?`,
  ).bind(slug).first();
  if (!row) return json({ error: "not found" }, 404);
  return json({
    book: {
      id: row.id,
      slug: row.slug,
      title: row.title || row.slug,
      chapters: row.chapters,
      totalChars: row.total_chars,
    },
  }, 200, { "cache-control": "public, max-age=60" });
}

async function serveBook(request, env, path) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "method not allowed" }, 405);
  const key = decodeURIComponent(path.slice("/books/".length));
  if (!key || key.includes("..")) return json({ error: "bad key" }, 400);

  const obj = await env.BOOKS.get(key);
  if (!obj) return json({ error: "not found" }, 404);

  const isManifest = key.endsWith(".json");
  // covers (books/<id>/cover.jpg — the shelf's 書衣 slot) are the one image
  // in a book's prefix; without a real type the <img> would be sniffing
  // text/plain
  const isImage = /\.(jpe?g|png|webp)$/.test(key);
  const headers = {
    "content-type": isManifest
      ? "application/json"
      : key.endsWith(".png") ? "image/png"
      : key.endsWith(".webp") ? "image/webp"
      : isImage ? "image/jpeg"
      : "text/plain; charset=utf-8",
    // Chapter files are immutable once published — and the reader appends
    // ?v=<manifest.generatedAt> so a re-split book busts them — so they can
    // cache for a month. Manifests may change on republish; keep them fresh.
    // A cover can be replaced without a re-split, so it gets a day, not the
    // immutable month.
    "cache-control": isManifest
      ? "public, max-age=60"
      : isImage ? "public, max-age=86400"
      : "public, max-age=2592000, immutable",
    etag: obj.httpEtag,
  };
  if (request.headers.get("if-none-match") === obj.httpEtag)
    return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : obj.body, { headers });
}

// The user a position belongs to is the KEY's user, never a parameter: a
// device can only read and move its own bookmark. (Legacy clients still
// send user= / body.user — ignored.) The admin Bearer has no reading
// identity, so it has no business here.
async function handlePosition(request, env, url, who) {
  const user = who.user;
  if (!user) return json({ error: "reader key required" }, 401);
  if (request.method === "GET") {
    const book = url.searchParams.get("book");
    if (!book) return json({ error: "book required" }, 400);
    const row = await env.DB.prepare(
      "SELECT chapter, char_off, updated_at FROM positions WHERE book = ? AND user = ?",
    )
      .bind(book, user)
      .first();
    return json({ position: row ?? null }, 200, { "cache-control": "no-store" });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const { book, chapter, offset, updatedAt } = body ?? {};
    if (
      typeof book !== "string" || !book ||
      !Number.isInteger(chapter) || chapter < 0 ||
      !Number.isInteger(offset) || offset < 0
    )
      return json({ error: "invalid body" }, 400);
    // cap at server time: one device with its clock in the future would
    // otherwise own the LWW slot and reject every real update after it
    const ts = Math.min(
      Number.isFinite(updatedAt) ? Math.floor(updatedAt) : Date.now(),
      Date.now() + 60_000,
    );
    // Last-write-wins: an older update (e.g. a late beacon from another
    // device) never overwrites a newer position.
    await env.DB.prepare(
      `INSERT INTO positions (book, user, chapter, char_off, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (book, user) DO UPDATE SET
         chapter = excluded.chapter,
         char_off = excluded.char_off,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= positions.updated_at`,
    )
      .bind(book, user, chapter, offset, ts)
      .run();
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

// GET /api/settings / POST {settings, updatedAt} — the reader settings that
// follow the user across devices (直排, 字級, 背景色; theme is deliberately
// per-device). One JSON blob per user, same LWW-by-updated_at contract as
// positions — and the same identity rule: the user is the key's, never a
// parameter.
async function handleSettings(request, env, url, who) {
  const user = who.user;
  if (!user) return json({ error: "reader key required" }, 401);
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT data, updated_at FROM settings WHERE user = ?",
    )
      .bind(user)
      .first();
    let settings = null;
    try {
      if (row) settings = JSON.parse(row.data);
    } catch { /* corrupt blob reads as absent */ }
    return json(
      { settings, updatedAt: row?.updated_at ?? 0 },
      200,
      { "cache-control": "no-store" },
    );
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const { settings, updatedAt } = body ?? {};
    const s = settings ?? {};
    if (
      !Number.isInteger(s.fontSize) || s.fontSize < 8 || s.fontSize > 120 ||
      typeof s.vertical !== "boolean" ||
      typeof s.bg !== "string" || !/^[a-z-]{0,32}$/.test(s.bg)
    )
      return json({ error: "invalid body" }, 400);
    const ts = Math.min(
      Number.isFinite(updatedAt) ? Math.floor(updatedAt) : Date.now(),
      Date.now() + 60_000,
    );
    const data = JSON.stringify({
      fontSize: s.fontSize, vertical: s.vertical, bg: s.bg,
    });
    await env.DB.prepare(
      `INSERT INTO settings (user, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (user) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= settings.updated_at`,
    )
      .bind(user, data, ts)
      .run();
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

// GET /api/feedback — 改進建議, the owner's suggestion inbox for the AI.
// Written from /admin (POST /api/admin/feedback) when an idea strikes on the
// phone; read back by a dev agent with this plain unauthenticated GET, so no
// admin key ever has to be handed to a tool. Cleared only by the owner
// pressing 完成 on /admin (DELETE below): the deploy-time sweep that used to
// empty the table is gone — a pull-mode install runs additive migrations
// only, so it never reached the host, and it swept unaddressed notes along
// with the shipped ones anyway. Whatever this returns is what the owner
// still considers open.
async function listFeedback(request, env) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const rows = (await env.DB.prepare(
    "SELECT id, body, created_at FROM feedback ORDER BY id ASC",
  ).all()).results ?? [];
  return json(
    { notes: rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at })) },
    200, { "cache-control": "no-store" },
  );
}

// POST /api/admin/feedback {body} — one note onto the board (admin gate is
// handleAdmin's). The cap is roomy for an announcement and firm against a
// paste accident.
async function postFeedback(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text || text.length > 2000)
    return json({ error: "body must be 1–2000 chars" }, 400);
  await env.DB.prepare("INSERT INTO feedback (body, created_at) VALUES (?, ?)")
    .bind(text, Date.now()).run();
  return json({ ok: true });
}

// DELETE /api/admin/feedback/<id> — the owner marks a note done. The AI never
// calls this (it holds no admin key, by design); a shipped fix is reported
// back to the owner, who clears the note here.
async function deleteFeedback(request, env, id) {
  if (request.method !== "DELETE") return json({ error: "method not allowed" }, 405);
  const r = await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  return json({ ok: true, deleted: r.meta?.changes ?? 0 });
}

// GET /api/admin/readers — every key with its user and label, oldest first.
// POST /api/admin/readers {user?, label?} — mint a key: 16 random bytes as
// hex, stored in the clear (see schema.sql for why). `user` binds the key
// to an EXISTING reader id — the migration path for devices that had an
// identity before keys existed; left empty, a fresh 6-hex id is minted in
// the same format the app used to mint for itself.
async function handleReaders(request, env) {
  if (request.method === "GET") {
    const rows = (await env.DB.prepare(
      "SELECT key, user, label, created_at, is_owner FROM readers ORDER BY created_at, key",
    ).all()).results ?? [];
    return json({ readers: rows.map((r) => ({
      key: r.key, user: r.user, label: r.label, createdAt: r.created_at,
      owner: r.is_owner === 1,
    })) }, 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json().catch(() => ({}))) ?? {};
  const user = body.user ? String(body.user).trim() : randHex(3);
  if (!USER_RE.test(user)) return json({ error: "bad user id" }, 400);
  const label = String(body.label ?? "").trim().slice(0, 64);
  const key = randHex(16);
  await env.DB.prepare(
    "INSERT INTO readers (key, user, label, created_at) VALUES (?, ?, ?, ?)",
  ).bind(key, user, label, Date.now()).run();
  return json({ ok: true, key, user, label });
}

// DELETE /api/admin/readers/<key> — revocation is deletion: the next
// request carrying this key 401s and the app on that device asks for a new
// one. Chapters the device already cached keep working offline, which is
// right — revocation fences the server; it cannot reach into a phone.
// POST /api/admin/readers/<key> {owner: true|false} — mark or unmark this
// device as the owner's (readers.is_owner; see pushOwner for what it routes).
async function handleReaderKey(request, env, key) {
  if (request.method === "DELETE") {
    const res = await env.DB.prepare("DELETE FROM readers WHERE key = ?").bind(key).run();
    return json({ ok: true, removed: res.meta?.changes ?? 0 });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json().catch(() => ({}))) ?? {};
  if (typeof body.owner !== "boolean") return json({ error: "owner must be true or false" }, 400);
  const res = await env.DB.prepare("UPDATE readers SET is_owner = ? WHERE key = ?")
    .bind(body.owner ? 1 : 0, key).run();
  if ((res.meta?.changes ?? 0) === 0) return json({ error: "no such key" }, 404);
  return json({ ok: true, owner: body.owner });
}

// Reader ids keep the app's own alphabet (6-hex minted, but roomy enough
// for the legacy hand-picked ones like `j`).
const USER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const randHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)),
    (b) => b.toString(16).padStart(2, "0")).join("");

// GET /api/wasmtts/<file> — same-origin proxy for the offline TTS voice pack
// (the Matcha acoustic model, the Vocos vocoder, the lexicon and ort's own
// wasm). They live on the wasmtts-assets GitHub release, not in the deploy:
// releases have no 25 MiB per-file limit and keep the upload small — but their
// download host sends no CORS headers, so the page cannot fetch them
// cross-origin and this route is the thinnest same-origin door. Open like the
// shell (public OSS bytes guard nothing), but strictly allowlisted on a pinned
// tag — an open proxy would otherwise fetch arbitrary URLs on our egress.
//
// The v2 names deliberately share nothing with v1's: a phone that ran the
// piper-era diagnostic holds those keys in its bw-wasmtts cache, and distinct
// names mean the sweep in wasm-tts.mjs reclaims them instead of colliding.
const WASMTTS_RELEASE = "https://github.com/enstw/bookworm/releases/download/wasmtts-assets-v2/";
// The pack's file names come from the wasmtts pin (pack-manifest.mjs is
// generated by vendor.mjs from upstream's matcha-assets.json), so a model
// bump upstream moves this allowlist, the page's fetch list and CI's asset
// sync in one motion — no name is written here to drift.
const WASMTTS_FILES = new Set(PACK_NAMES);
// ort's version rides its filename (the page asks for the name vendor.mjs
// derived from the wasmtts pin), so the allowlist admits the shape rather
// than one version — CI's sync step keeps exactly one such file on the
// release, and egress is still bounded to the pinned tag's URL either way.
const ORT_WASM_RE = /^ort-\d+\.\d+\.\d+(?:[-.][\w.]+)?-wasm-simd-threaded\.wasm$/;

async function serveWasmttsAsset(path) {
  const name = path.slice("/api/wasmtts/".length);
  if (!WASMTTS_FILES.has(name) && !ORT_WASM_RE.test(name)) return json({ error: "not found" }, 404);
  const res = await fetch(WASMTTS_RELEASE + name, { redirect: "follow" });
  if (!res.ok) return json({ error: `upstream ${res.status}` }, 502);
  const headers = {
    "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
    // the tag is versioned: this URL will only ever serve these bytes
    "cache-control": "public, max-age=31536000, immutable",
  };
  const len = res.headers.get("content-length");
  if (len) headers["content-length"] = len;
  return new Response(res.body, { headers });
}

// GET /api/testlog?page=&limit= / POST {page, device, data} — readout drop
// box for the on-device diagnostic pages (/pgtest, /vhtest, /scrolltest,
// linked from /admin): the phone uploads each readout, the laptop curls it
// back instead of trading screenshots. Born as temporary scaffolding, kept
// on purpose — it is also where the service worker reports push delivery
// (see swlog), which only a phone can observe.
//
// Split by verb at the gate above: GET needs a reader key (the rows quote
// the book), POST needs the admin cookie (see testlogSessionOk — a header is
// not an option for the writers that matter). Inputs are firmly capped, the
// timestamp is server-side, and the table self-prunes per page.
//
// The quota is per page, not one newest-500 window, because that window is
// shared and the noisiest bucket wins it. The player's flight recorder
// heartbeats once every 10 s (player.mjs), so about six rows a minute: a
// single 83-minute listening session used to evict everything else in the
// table, including the push breadcrumbs — the lowest-volume, highest-value
// rows there are, and the only witness to whether a phone got a notification.
// Splitting the same 500 rows by page fixes that without buying more of them.
//
// The page list is therefore load-bearing twice over: it names the buckets,
// and because a quota is per bucket, an open-ended set of page names would be
// an open-ended row count. A new diagnostic page adds its own line. Rows in a
// page nobody lists are dropped by the ELSE 0 below, which is also how rows
// written before this list existed clean themselves up.
const TESTLOG_PAGES = {
  // the field diagnostic: worker → push service → service worker → banner
  push: 120,
  // the flight recorder; 200 rows is a little over half an hour of playback,
  // and background-suspension bugs show up as a GAP, so the tail is the part
  // worth keeping
  player: 200,
  // 🚩 taps from the player bar — the owner's listening tickets. Tiny volume,
  // but each row is a position plus the sentence being spoken, unreproducible
  // once the session moves on, so it gets its own bucket instead of riding
  // the recorder's and being evicted by an evening of heartbeats
  report: 40,
  wasmtest: 30, speechtest: 30, vhtest: 30, pgtest: 30, scrolltest: 30, pagedtest: 30,
};
// keys are literals in the object above, never anything a request supplies
const TESTLOG_QUOTA_CASE = Object.entries(TESTLOG_PAGES)
  .map(([page, rows]) => `WHEN '${page}' THEN ${rows}`).join(" ");
// The prune is a full-table scan, and on D1's free plan rows-READ is the
// meter that binds first, not rows-written. Running it on every insert cost
// ~500 reads per logged line — about 3000 a minute with the player recorder
// on. Every 25th insert is the same ceiling (the table drifts at most 25 rows
// over quota in between) for a twenty-fifth of the reads.
const TESTLOG_PRUNE_EVERY = 25;

async function handleTestlog(request, env, ctx, url) {
  if (request.method === "GET") {
    const page = url.searchParams.get("page");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 200);
    const q = page
      ? env.DB.prepare(
          "SELECT id, page, device, ts, data FROM testlog WHERE page = ? ORDER BY id DESC LIMIT ?",
        ).bind(page, limit)
      : env.DB.prepare(
          "SELECT id, page, device, ts, data FROM testlog ORDER BY id DESC LIMIT ?",
        ).bind(limit);
    const rows = await q.all();
    return json({ logs: rows.results ?? [] }, 200, { "cache-control": "no-store" });
  }

  if (request.method === "POST") {
    if (!(await testlogSessionOk(request, env)))
      return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const { page, device, data } = body ?? {};
    if (
      typeof page !== "string" || !Object.hasOwn(TESTLOG_PAGES, page) ||
      typeof data !== "string" || !data || data.length > 4000 ||
      (device !== undefined && typeof device !== "string")
    )
      return json({ error: "invalid body" }, 400);
    const { meta } = await env.DB.prepare(
      "INSERT INTO testlog (page, device, ts, data) VALUES (?, ?, ?, ?)",
    )
      .bind(page, String(device ?? "").slice(0, 64), Date.now(), data)
      .run();
    if ((meta?.last_row_id ?? 0) % TESTLOG_PRUNE_EVERY === 0)
      ctx.waitUntil(
        env.DB.prepare(
          `DELETE FROM testlog WHERE id NOT IN (
             SELECT id FROM (
               SELECT id, page, ROW_NUMBER() OVER (PARTITION BY page ORDER BY id DESC) AS rn
               FROM testlog
             ) WHERE rn <= CASE page ${TESTLOG_QUOTA_CASE} ELSE 0 END
           )`,
        ).run(),
      );
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

// GET /api/tts/<book-id>/<chapter-file>/<chunkIdx>?v=<generatedAt> — one chunk
// of a chapter as MP3 (edge-tts, 24 kHz 48 kbps mono). Synthesized on first
// request, then served from R2 under _tts/ (safe from listBooks: no
// manifest there). Every request also warms chunk+1 into R2 in the
// background (one step, no cascade — warming isn't a request) so
// sequential listening never waits on synthesis.
//
// Backend history: launched on Workers AI MeloTTS (@cf/myshell-ai/melotts,
// lang "zh") — its Chinese voice broke upstream on 2026-07-15, emitting one
// noise-beat per hanzi (English kept working; every zh lang-code variant
// failed). Whisper-transcribe a sample before trusting any backend switch.
// The ?v= version keys the cache so a republished book gets fresh audio.
async function handleTts(request, env, ctx, path, url) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const m = path.match(/^\/api\/tts\/([^/]+)\/([^/]+)\/(\d{1,4})$/);
  if (!m) return json({ error: "not found" }, 404);
  const id = decodeURIComponent(m[1]);
  const file = decodeURIComponent(m[2]);
  const chunkIdx = Number(m[3]);
  if (id.includes("..") || id.includes("/") || file.includes("/") || !file.endsWith(".txt"))
    return json({ error: "bad key" }, 400);
  const v = (url.searchParams.get("v") ?? "0").replace(/[^0-9A-Za-z.:TZ-]/g, "");

  const headers = {
    "content-type": "audio/mpeg",
    "cache-control": "public, max-age=2592000, immutable",
  };
  const audioKey = `_tts/${id}/${v}/${file}/${chunkIdx}.mp3`;
  ctx.waitUntil(warmChunk(env, id, v, file, chunkIdx + 1));
  const hit = await env.BOOKS.get(audioKey);
  if (hit) return new Response(hit.body, { headers });

  const chap = await env.BOOKS.get(`${id}/${file}`);
  if (!chap) return json({ error: "not found" }, 404);
  const chunk = chunkChapter(await chap.text())[chunkIdx];
  if (!chunk) return json({ error: "no such chunk" }, 404);

  let bytes;
  try {
    bytes = await edgeSynthesize(ttsPrompt(chunk.text));
  } catch (err) {
    return json({ error: `tts failed: ${err?.message ?? err}` }, 502);
  }
  ctx.waitUntil(env.BOOKS.put(audioKey, bytes));
  return new Response(bytes, { headers });
}

// Best-effort pre-synthesis of a chunk into R2 (no response, no cascade).
async function warmChunk(env, id, v, file, chunkIdx) {
  try {
    const key = `_tts/${id}/${v}/${file}/${chunkIdx}.mp3`;
    if (await env.BOOKS.head(key)) return;
    const chap = await env.BOOKS.get(`${id}/${file}`);
    if (!chap) return;
    const chunk = chunkChapter(await chap.text())[chunkIdx];
    if (!chunk) return;
    await env.BOOKS.put(key, await edgeSynthesize(ttsPrompt(chunk.text)));
  } catch { /* the on-demand path still covers it */ }
}

// --- Web Push (新書上架 and 新版本已上線 notifications) ---
//
// GET /api/push/vapid — the applicationServerKey for pushManager.subscribe.
// POST /api/push/subscribe {user, endpoint, p256dh, auth} — upsert by
// endpoint; POST /api/push/unsubscribe {endpoint} — drop; POST
// /api/push/test {endpoint} — send that one device a 測試通知 and hand the
// push service's verdict straight back. subscribe and test sit behind the
// reader gate (the dispatch checks); vapid is only a public key, and
// unsubscribe stays open — a device whose key was revoked must always be
// able to unregister. Inputs stay firmly capped regardless, and the
// subscription's user is the key's user, never the body's word for it.
async function handlePush(request, env, ctx, path, who) {
  if (path === "/api/push/vapid") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return json({ error: "push not configured" }, 503);
    return json({ key: vapidPublicKey(env) }, 200, { "cache-control": "public, max-age=3600" });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const { endpoint, user, p256dh, auth } = body ?? {};
  // subscribe must be a real push service (https); unsubscribe only needs
  // the exact string to delete by, so it stays permissive — a device whose
  // endpoint predates a rule change must always be able to unregister
  const endpointOk = typeof endpoint === "string" && endpoint && endpoint.length <= 1024;

  if (path === "/api/push/unsubscribe") {
    if (!endpointOk) return json({ error: "invalid body" }, 400);
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(endpoint).run();
    return json({ ok: true });
  }
  // the self-test: the phone can tell "the server has no row for me" from
  // "Apple took it and the phone never showed it" without any admin access
  if (path === "/api/push/test") {
    if (!endpointOk) return json({ error: "invalid body" }, 400);
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return json({ error: "push not configured" }, 503);
    const sub = await env.DB.prepare(
      "SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ?",
    ).bind(endpoint).first();
    if (!sub) return json({ error: "not subscribed", subscribed: false }, 404);
    const { status, detail } = await pushOne(env, sub, {
      title: "測試通知", body: "推播管道正常", url: "/",
    });
    logPush(env, ctx, `測試 ${subTag(endpoint)} → ${status}${detail ? " " + detail : ""}`);
    return json({ ok: status >= 200 && status < 300, status, detail });
  }
  if (path !== "/api/push/subscribe") return json({ error: "not found" }, 404);

  // the key's user; the admin Bearer (scripts, tests) may name one instead
  const u = who?.user ?? (typeof user === "string" ? user : "");
  const B64U = /^[A-Za-z0-9_-]+$/;
  if (
    !endpointOk || !endpoint.startsWith("https://") || u.length > 64 ||
    typeof p256dh !== "string" || p256dh.length > 128 || !B64U.test(p256dh) ||
    typeof auth !== "string" || auth.length > 64 || !B64U.test(auth)
  )
    return json({ error: "invalid body" }, 400);
  // the key is remembered too, so readers.is_owner can single out this
  // device; the Bearer has none, and healPush() re-upserting at every open is
  // what fills the column in on rows that predate it
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, user, p256dh, auth, created_at, key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       user = excluded.user, p256dh = excluded.p256dh, auth = excluded.auth,
       key = excluded.key`,
  )
    .bind(endpoint, u, p256dh, auth, Date.now(), who?.key ?? "")
    .run();
  return json({ ok: true });
}

// Send one notification and report what the push service said. Shared by
// the 新書上架 announcement and the per-device self-test; drops the row when
// the service says the subscription is gone.
async function pushOne(env, sub, payload) {
  try {
    const { status, detail } = await sendPush(env, sub, payload);
    if (status === 404 || status === 410)
      await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?")
        .bind(sub.endpoint).run();
    return { status, detail };
  } catch (err) {
    // a throw here is ours (bad key, encryption, DNS) — never the phone's
    return { status: 0, detail: String(err?.message ?? err).slice(0, 200) };
  }
}

// Push outcomes land in the testlog table, because pushNewBook runs inside
// waitUntil: nobody is left holding a response by the time it finishes, so
// without this a silent zero-subscriber run and a rejected JWT look exactly
// alike from the outside. Read it back with /api/testlog?page=push.
function logPush(env, ctx, line) {
  ctx?.waitUntil(env.DB.prepare(
    "INSERT INTO testlog (page, device, ts, data) VALUES (?, ?, ?, ?)",
  ).bind("push", "worker", Date.now(), line.slice(0, 4000)).run().catch(() => {}));
}

// The owner-only channel: push to the devices whose key is flagged
// readers.is_owner, and to nobody else. This is the one sender for every
// message that is the owner's business rather than every reader's (an
// update waiting for a decision, an install rolled back, a silent updater —
// see DESIGN.md). With no key flagged it
// sends NOTHING, deliberately: falling back to a broadcast would put the
// owner's business on every reader's lock screen. The silence is not
// invisible, though — the log line says so, and /admin says so in as many
// words, because an unset flag that looked like a quiet channel would be the
// kind of defect nobody ever finds. `owners` is the flagged-key count, which
// is what tells "no device is marked" apart from "the marked device never
// subscribed to push".
async function pushOwner(env, ctx, tag, payload) {
  const owners = (await env.DB.prepare(
    "SELECT COUNT(*) n FROM readers WHERE is_owner = 1").first())?.n ?? 0;
  if (owners === 0) {
    logPush(env, ctx, `${tag}: 沒有標記為管理者的裝置，未送出`);
    return { owners, subs: 0, statuses: [] };
  }
  const rows = (await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subs
     WHERE key IN (SELECT key FROM readers WHERE is_owner = 1)`).all()).results ?? [];
  const out = await Promise.all(rows.map(async (sub) => {
    const { status, detail } = await pushOne(env, sub, payload);
    return { line: `${subTag(sub.endpoint)} → ${status}${detail ? " " + detail : ""}`, status };
  }));
  logPush(env, ctx,
    `${tag}: ${owners} 把管理者鑰匙，${rows.length} 訂閱\n${out.map((r) => r.line).join("\n")}`);
  return { owners, subs: rows.length, statuses: out.map((r) => r.status) };
}

// POST /api/admin/owner-test — ring the owner's devices and only those, so
// the flag can be proven from the phone it is meant to reach (the same
// reason the per-device 測試 button exists). A fixed payload on purpose: an
// admin route that pushed arbitrary text would be a door the design
// otherwise refuses to open. Nothing rides on the response but /admin, so
// it is awaited and carries the push service's verdicts.
async function ownerTest(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return json({ error: "push not configured" }, 503);
  const r = await pushOwner(env, ctx, "管理者測試", {
    title: "管理者通知測試", body: "只有標記為管理者的裝置會收到這則。", url: "/admin",
  });
  return json({ ok: r.subs > 0 && r.statuses.every((s) => s >= 200 && s < 300), ...r });
}

// Announce a new book to every subscription. Runs in waitUntil — a push
// failure never fails the publish, so the outcome goes to the log instead.
async function pushNewBook(env, ctx, title) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return logPush(env, ctx, `新書 ${title}: VAPID 未設定`);
  const rows = (await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subs",
  ).all()).results ?? [];
  // the shelf, explicitly: "/" resumes whatever book is open, and the point
  // of tapping this notification is seeing the NEW book on the shelf
  const payload = { title: "新書上架", body: title, url: "/?shelf" };
  const out = await Promise.all(
    rows.map(async (sub) => {
      const { status, detail } = await pushOne(env, sub, payload);
      return `${subTag(sub.endpoint)} → ${status}${detail ? " " + detail : ""}`;
    }),
  );
  logPush(env, ctx, `新書 ${title}: ${rows.length} 訂閱\n${out.join("\n")}`);
}

// Announce THIS version to every subscription, from the worker's own cron —
// the server side of checkVersion() in app.js, which can only run while a
// page is open. An installed phone nobody opened never learns a newer shell
// exists, and the badge checkVersion would have set never appears; this is
// the same channel 新書上架 uses, so the app icon gets its dot with the app
// closed.
//
// It runs every minute and announces its OWN stamp, which is what makes it
// correct without a handshake. The old shape — an admin route deploy.sh
// POSTed right after the deploy — had a race: the edge can still serve the
// PREVIOUS version seconds after `wrangler deploy` returns, and the call
// landed on the old isolate, which announced ITS stamp, found it recorded,
// and reported success while the build that had just shipped never rang
// (measured on e96279f; the fix was a ?build= check and a 30 s retry). A
// version asking about itself from its own cron cannot be stale: an old
// isolate that ticks once more finds its build recorded and does nothing,
// and the next tick on the new version rings. Exactly-once is the
// announced_builds row, keyed on the commit, so a workflow re-run, a
// rollback and the 1439 other ticks of the day all stay silent — silent in
// the log too, because a line per minute would evict page=push's quota.
async function announceSelf(env, ctx) {
  // An unstamped worker is a local `wrangler deploy` with edits in the tree
  // (see deploy.sh) or `wrangler dev`. "dev" is not a version anyone can be
  // told to update to, and a dev run must never ring the owner's phone.
  if (BUILD === "dev") return { announced: false, reason: "unstamped build" };
  const commit = BUILD.split(" ")[0];
  // Counted before the insert: on a fresh install every build is new, and the
  // first one is not news — it IS the install. Record it silently so the next
  // deploy is the first thing a subscriber hears about.
  const first = ((await env.DB.prepare(
    "SELECT COUNT(*) n FROM announced_builds").first())?.n ?? 0) === 0;
  const ins = await env.DB.prepare(
    `INSERT INTO announced_builds (build, stamp, created_at) VALUES (?, ?, ?)
     ON CONFLICT (build) DO NOTHING`,
  ).bind(commit, BUILD, Date.now()).run();
  if (ins.meta?.changes !== 1) return { announced: false, reason: "already announced" };
  if (first) return { announced: false, reason: "first build on this install" };
  // the row is already written, so this logs once per build, not per tick
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) {
    logPush(env, ctx, `新版本 ${BUILD}: VAPID 未設定`);
    return { announced: false, reason: "push not configured" };
  }
  const rows = (await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subs").all()).results ?? [];
  // "/" — the shell. On a phone that already has the app open this focuses the
  // OLD one, and checkVersion raises 立即更新 the moment it comes forward,
  // which is the reload path that already exists. Reloading from here instead
  // would fight that note's "seen it, not now" dismissal.
  const payload = { title: "新版本已上線", body: BUILD, url: "/" };
  const out = await Promise.all(rows.map(async (sub) => {
    const { status, detail } = await pushOne(env, sub, payload);
    return `${subTag(sub.endpoint)} → ${status}${detail ? " " + detail : ""}`;
  }));
  // the log is the only witness now that nothing awaits this; page=push is
  // where "did the build ring" is answered, per device
  logPush(env, ctx, `新版本 ${BUILD}: ${rows.length} 訂閱\n${out.join("\n")}`);
  return { announced: true, subs: rows.length };
}

// endpoint host + last 12 chars: enough to tell two devices apart in a log
// without writing down the whole capability URL
const subTag = (endpoint) => {
  try {
    return new URL(endpoint).host + "…" + endpoint.slice(-12);
  } catch {
    return "?…" + String(endpoint).slice(-12);
  }
};

// PUT/DELETE /api/admin/objects/<key> — used by scripts/publish-book.mjs.
// Guarded by a shared secret: wrangler secret put ADMIN_TOKEN (prod)
// or ADMIN_TOKEN in .dev.vars (local dev).
async function handleAdmin(request, env, ctx, path) {
  const auth = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`)
    return json({ error: "unauthorized" }, 401);

  // GET /api/admin/ping — lets the /admin page validate a token up front
  if (path === "/api/admin/ping") return json({ ok: true });

  // POST /api/admin/session — the bw_tlog cookie, so this device's
  // sendBeacon-only writers can log (see testlogSign)
  if (path === "/api/admin/session") return await mintTestlogSession(request, env);

  // POST /api/admin/feedback — one 改進建議 onto the AI's queue;
  // DELETE /api/admin/feedback/<id> — the owner marks one done
  if (path === "/api/admin/feedback") return postFeedback(request, env);
  const fm = path.match(/^\/api\/admin\/feedback\/(\d+)$/);
  if (fm) return deleteFeedback(request, env, Number(fm[1]));

  // /api/admin/readers — mint, list, revoke and flag reader keys; the whole
  // lifecycle lives on /admin (see the readers table in schema.sql)
  if (path === "/api/admin/readers") return handleReaders(request, env);
  const km = path.match(/^\/api\/admin\/readers\/([^/]+)$/);
  if (km) return handleReaderKey(request, env, decodeURIComponent(km[1]));

  // POST /api/admin/owner-test — the owner-only push channel's self-test
  if (path === "/api/admin/owner-test") return ownerTest(request, env, ctx);

  // The pull-mode panel (PM-08): all D1 the updater wrote — the reader never
  // contacts upstream (see update-panel.mjs).
  if (path === "/api/admin/update") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json(await readPanel(env, BUILD), 200, { "cache-control": "no-store" });
  }
  if (path === "/api/admin/update/policy") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const r = await setPolicy(env, await request.json().catch(() => ({})));
    return json(r, r.ok ? 200 : 400);
  }
  if (path === "/api/admin/update/install-now") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const r = await queueInstallNow(env, Date.now(), BUILD);
    return json(r, r.ok ? 200 : 400);
  }

  // POST /api/admin/reindex — rebuild the D1 shelf index from the bucket
  if (path === "/api/admin/reindex") return reindex(request, env);

  // POST /api/admin/audit — read-only housekeeping sweep; /api/admin/cleanup
  // is the only thing it can ask for that the other routes cannot already do
  if (path === "/api/admin/audit") return audit(request, env);
  if (path === "/api/admin/cleanup") return cleanup(request, env);

  // /api/admin/books/<id> — whole-book operations on the /admin page
  // (retitle, re-slug, delete). By ID, never by slug: the slug is the thing
  // being changed.
  const bm = path.match(/^\/api\/admin\/books\/([^/]+)$/);
  if (bm) return handleAdminBook(request, env, decodeURIComponent(bm[1]));

  const m = path.match(/^\/api\/admin\/objects\/(.+)$/);
  if (!m) return json({ error: "not found" }, 404);
  const key = decodeURIComponent(m[1]);
  if (!key || key.includes("..")) return json({ error: "bad key" }, 400);

  if (request.method === "PUT") {
    const bytes = await request.arrayBuffer();
    // A manifest PUT is a publish: it is the last thing an upload writes (so
    // chapters are already there) and the one place the shelf index is
    // written from. A manifest nobody had before is also 新書上架 → notify.
    const nb = key.match(/^([^/]+)\/manifest\.json$/);
    if (nb) {
      const id = nb[1];
      if (!SLUG_RE.test(id)) return json({ error: "bad book id" }, 400);
      let m2;
      try {
        m2 = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return json({ error: "manifest is not json" }, 400);
      }
      const isNew = !(await env.BOOKS.head(key));
      // registered BEFORE the object is written: a slug someone else already
      // owns must fail the publish outright, not leave a book on the shelf
      // under a name that resolves to a different one. The sidecar is already
      // in the bucket — an enriched upload PUTs it before the manifest.
      const reg = await registerBook(env, id, m2, await sidecarAuthor(env, id));
      if (!reg.ok) return json({ error: `slug "${reg.slug}" 已被其他書使用` }, 409);
      await env.BOOKS.put(key, bytes);
      if (isNew) ctx.waitUntil(pushNewBook(env, ctx, m2.title || id));
      // a manifest that already existed is a re-publish, not 新書上架 — the
      // one way the announcement can be skipped without anything failing
      else logPush(env, ctx, `manifest ${key} 已存在，不算新書，未推播`);
      return json({ ok: true, key, id, slug: reg.slug });
    }
    await env.BOOKS.put(key, bytes);
    return json({ ok: true, key });
  }
  if (request.method === "DELETE") {
    await env.BOOKS.delete(key);
    return json({ ok: true, key });
  }
  return json({ error: "method not allowed" }, 405);
}

// The author line rides the enrichment sidecar (books/<id>/meta.json, see
// the enriched-zip contract), never the manifest: a plain republish rebuilds
// the manifest but leaves the sidecar alone, so every registerBook caller
// re-reads it here and the shelf keeps its author through re-splits,
// retitles and reindexes alike. One subrequest; "" when there is no sidecar
// or one that will not parse.
async function sidecarAuthor(env, id) {
  try {
    const meta = await (await env.BOOKS.get(`${id}/meta.json`))?.json();
    return String(meta?.author ?? "").trim().slice(0, 100);
  } catch { return ""; }
}

// Write one book's row in the shelf index, plus the slug → id row that makes
// its URL resolve. The manifest stays the source of truth; this is the
// derived copy the library page reads. A slug already pointing at a DIFFERENT
// book is refused ({ok:false}) rather than stolen — callers decide whether
// that is a 409 (a publish) or a reason to fall back (a reindex).
async function registerBook(env, id, m, author = "", indexedAt = Date.now()) {
  const slug = String(m.slug ?? id);
  if (!SLUG_RE.test(slug)) return { ok: false, slug, reason: "bad slug" };
  if (RESERVED_SLUGS.includes(slug)) return { ok: false, slug, reason: "reserved" };
  const owner = await env.DB.prepare("SELECT book FROM book_slugs WHERE slug = ?")
    .bind(slug).first();
  if (owner && owner.book !== id) return { ok: false, slug, reason: "taken" };
  const now = Date.now();
  // per-chapter chars ride the index row so listBooks can sum a reader's
  // progress without opening the manifest — the manifest stays the source
  // of truth, this is the same derived-copy bargain as every column here
  const chapterChars = JSON.stringify(
    Array.isArray(m.chapters) ? m.chapters.map((c) => c.chars ?? 0) : []);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO books (id, slug, title, author, chapters, total_chars, chapter_chars, updated_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         slug = excluded.slug, title = excluded.title, author = excluded.author,
         chapters = excluded.chapters, total_chars = excluded.total_chars,
         chapter_chars = excluded.chapter_chars,
         updated_at = excluded.updated_at, indexed_at = excluded.indexed_at`,
    ).bind(id, slug, String(m.title ?? slug), author, m.chapters?.length ?? 0,
      Number(m.totalChars) || 0, chapterChars, now, indexedAt),
    env.DB.prepare(
      `INSERT INTO book_slugs (slug, book, created_at) VALUES (?, ?, ?)
       ON CONFLICT (slug) DO UPDATE SET book = excluded.book`,
    ).bind(slug, id, now),
  ]);
  return { ok: true, slug };
}

// POST /api/admin/reindex {cursor, runAt, indexed} — rebuild the shelf index
// from the bucket, one page of book prefixes per call (the client loops,
// handing the cursor back). This is the repair path for a D1 that has drifted
// from R2 — and the migration path for books published before the index
// existed, whose prefix simply becomes their id.
//
// Books are visited sequentially: one open connection at a time, so the size
// of the shelf can never run into the Worker's connection limit. Rows not
// re-stamped by the run are books whose files are gone, and get pruned at the
// end; former-slug rows survive because they hang off the book, not the run.
//
// This writes, and writing is all it does: it makes no findings and reports
// no damage. 健康檢查 looks for that, without touching anything — see audit().
// The one exception is a slug collision, which only shows itself when the row
// is written, so there is nowhere else it could be found.
//
// Ten books a round: one listing, then per book a manifest read, the author
// sidecar read, and an upsert (a second upsert on a slug collision). That is
// the subrequest budget (50) with room to spare.
const REINDEX_PAGE = 10;
async function reindex(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json().catch(() => ({}))) ?? {};
  const runAt = Number.isFinite(body.runAt) ? body.runAt : Date.now();
  let indexed = Number(body.indexed) || 0;
  const notes = Array.isArray(body.notes) ? body.notes.slice(0, 50) : [];

  const page = await env.BOOKS.list({
    delimiter: "/", cursor: body.cursor || undefined, limit: REINDEX_PAGE,
  });

  for (const p of page.delimitedPrefixes ?? []) {
    const id = p.replace(/\/$/, "");
    if (!SLUG_RE.test(id)) continue; // _tts/ and anything else not a book
    const obj = await env.BOOKS.get(`${id}/manifest.json`);
    // No manifest, or one that will not parse: nothing this can put on a
    // shelf. Both are real problems and neither is reported here — 健康檢查
    // finds them (orphan-files, bad-manifest) by reading, which is where
    // finding things belongs.
    if (!obj) continue;
    const m = await obj.json().catch(() => null);
    if (!m) continue;
    const author = await sidecarAuthor(env, id);
    let reg = await registerBook(env, id, m, author, runAt);
    if (!reg.ok) {
      // its slug belongs to another book: index it under its id instead, so
      // it stays reachable and the collision is visible rather than silent
      reg = await registerBook(env, id, { ...m, slug: id }, author, runAt);
      notes.push({ code: "slug-taken", id, slug: String(m.slug ?? "") });
    }
    indexed++;
  }
  if (page.truncated)
    return json({ done: false, cursor: page.cursor, runAt, indexed, notes });

  const pruned = await env.DB.prepare("DELETE FROM books WHERE indexed_at < ?")
    .bind(runAt).run();
  await env.DB.prepare(
    "DELETE FROM book_slugs WHERE book NOT IN (SELECT id FROM books)",
  ).run();
  return json({
    done: true, runAt, indexed, notes, pruned: pruned.meta?.changes ?? 0,
  });
}

// POST /api/admin/audit {phase, cursor, offset, findings, dropped} — 健康檢查:
// walk the bucket and the index against each other and report everything
// nothing can reach any more, plus every book that is damaged.
//
// Read-only from start to finish, and — the part that took a rewrite — it
// never assumes a repair has run. R2 is the truth; the index is one of the
// things being checked against it, never a premise. That is what lets this be
// a phase of its own: press it any time, trust what it says, and if it says
// nothing is wrong then nothing is. (It used to run only after a reindex, so
// a finding could mean "the index is behind" rather than "this is broken" —
// which made the check unrunnable on its own and its silence worth nothing.)
//
//   stray-object     something at the root of the bucket that is not a book.
//   bad-prefix       a prefix outside the id alphabet (it can never be served).
//   orphan-files     an R2 prefix with chapter files but no manifest — an
//                    upload that stopped early. Nothing lists it, ever.
//   bad-manifest     the manifest is there and will not parse. Exactly as
//                    unreachable as having none: every route into a book goes
//                    through the index, and the index is written from this.
//   unindexed        a book with a manifest that the shelf index has no row
//                    for: invisible on the library page. 重建索引 fixes it.
//   ghost-book       an index row whose manifest is gone: listed but 404s.
//   orphan-audio     _tts/<id>/ for a book that no longer exists — the most
//                    expensive kind, since TTS caches dwarf the text.
//   incomplete-book  the manifest names chapter files the bucket does not
//                    have, or has at the wrong size. Nothing else in the
//                    system ever checks this: the shelf's chapter count and
//                    字數 come from the manifest, which is the uploader's
//                    claim, so a book can look perfect and 404 on chapter 900.
//   stale-file       the other direction — files under the book id that its
//                    manifest does not name, left by a re-split or a rename.
//   orphan-slug      a URL that resolves to a book that is not there.
//   orphan-position  bookmarks for a book nobody can open.
//
// Phases run books → tts → index → chapters → refs, a page per request, and
// each hands the next its starting point. Paged like reindex, and for the same
// reason: a Worker gets 6 open connections and 50 subrequests.
const AUDIT_PAGE = 10;
// Fewer per round for the chapter pass: it reads a manifest and lists a whole
// book's prefix (a 1,835-chapter book is two pages).
const CHAPTER_PAGE = 3;
// One manifest HEAD per referenced book, plus two queries for the rows.
const REF_PAGE = 10;
// Enough findings to describe any real mess. Reaching it is itself worth
// saying — a check that quietly stops counting reads as a clean bill of
// health, which is the one thing it must never do.
const FINDING_CAP = 200;

async function audit(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json().catch(() => ({}))) ?? {};
  const findings = Array.isArray(body.findings) ? body.findings.slice(0, FINDING_CAP) : [];
  // what the cap swallowed, carried round to round so the verdict can admit it
  let dropped = Number(body.dropped) || 0;
  const add = (f) => {
    if (findings.length < FINDING_CAP) findings.push(f);
    else dropped++;
  };
  const phase = ["tts", "index", "chapters", "refs"].includes(body.phase) ? body.phase : "books";

  if (phase === "books") {
    const page = await env.BOOKS.list({
      delimiter: "/", cursor: body.cursor || undefined, limit: AUDIT_PAGE,
    });
    const indexed = new Set(
      ((await env.DB.prepare("SELECT id FROM books").all()).results ?? []).map((r) => r.id));
    // with a delimiter, page.objects is only what sits at the ROOT of the
    // bucket — no book ever puts anything there
    for (const o of page.objects ?? []) add({ kind: "stray-object", id: o.key, bytes: o.size });
    const checked = await mapPool(
      (page.delimitedPrefixes ?? []).map((p) => p.replace(/\/$/, "")).filter((id) => id !== "_tts"),
      4,
      async (id) => {
        if (!SLUG_RE.test(id)) return { kind: "bad-prefix", id };
        if (await env.BOOKS.head(`${id}/manifest.json`))
          return indexed.has(id) ? null : { kind: "unindexed", id };
        return { kind: "orphan-files", id, ...(await prefixSize(env, `${id}/`)) };
      },
    );
    for (const f of checked) if (f) add(f);
    return json(page.truncated
      ? { done: false, phase: "books", cursor: page.cursor, findings, dropped }
      : { done: false, phase: "tts", findings, dropped });
  }

  if (phase === "tts") {
    const page = await env.BOOKS.list({
      prefix: "_tts/", delimiter: "/", cursor: body.cursor || undefined, limit: AUDIT_PAGE,
    });
    const checked = await mapPool(
      (page.delimitedPrefixes ?? []).map((p) => p.slice("_tts/".length).replace(/\/$/, "")),
      4,
      async (id) => (await env.BOOKS.head(`${id}/manifest.json`))
        ? null
        : { kind: "orphan-audio", id, ...(await prefixSize(env, `_tts/${id}/`)) },
    );
    for (const f of checked) if (f) add(f);
    return json(page.truncated
      ? { done: false, phase: "tts", cursor: page.cursor, findings, dropped }
      : { done: false, phase: "index", offset: 0, findings, dropped });
  }

  // index phase: the shelf's rows, checked against the bucket a page at a time
  if (phase === "index") {
    const offset = Number.isFinite(body.offset) ? Math.max(0, Math.floor(body.offset)) : 0;
    const rows = (await env.DB.prepare(
      "SELECT id FROM books ORDER BY id LIMIT ? OFFSET ?",
    ).bind(AUDIT_PAGE, offset).all()).results ?? [];
    const checked = await mapPool(rows, 4, async (r) =>
      (await env.BOOKS.head(`${r.id}/manifest.json`)) ? null : { kind: "ghost-book", id: r.id });
    for (const f of checked) if (f) add(f);
    return json(rows.length === AUDIT_PAGE
      ? { done: false, phase: "index", offset: offset + AUDIT_PAGE, findings, dropped }
      : { done: false, phase: "chapters", findings, dropped });
  }

  // Chapter phase: for each book in the BUCKET, does it hold what its manifest
  // says it does — and only that? Over prefixes, not over `books` rows: a book
  // the index has never heard of is exactly the kind whose chapters nobody has
  // ever counted, and walking rows meant those were the one kind this could not
  // look at. Sequentially, one open connection: each book gets a manifest read
  // and a listing of its whole prefix.
  if (phase === "chapters") {
    const page = await env.BOOKS.list({
      delimiter: "/", cursor: body.cursor || undefined, limit: CHAPTER_PAGE,
    });
    for (const p of page.delimitedPrefixes ?? []) {
      const id = p.replace(/\/$/, "");
      if (!SLUG_RE.test(id)) continue; // _tts/ and bad-prefix: said already
      const obj = await env.BOOKS.get(`${id}/manifest.json`);
      if (!obj) continue; // orphan-files: said already
      const m = await obj.json().catch(() => null);
      // The manifest is read here and nowhere else in the check, so this is
      // where a corrupt one is caught. The books phase can only HEAD it, and a
      // HEAD cannot tell a book from a broken one.
      if (!m) { add({ kind: "bad-manifest", id, ...(await prefixSize(env, `${id}/`)) }); continue; }
      for (const f of await checkChapters(env, id, m)) add(f);
    }
    return json(page.truncated
      ? { done: false, phase: "chapters", cursor: page.cursor, findings, dropped }
      : { done: false, phase: "refs", offset: 0, findings, dropped });
  }

  // Ref phase, and the last one: the rows that point AT a book — its slugs and
  // everyone's bookmarks. "No row in `books`" is not the question, however cheap
  // it is to ask: a ghost book still holds its row, so its slugs and bookmarks
  // passed that test and went unreported until a reindex pruned the row out from
  // under them. The question is the only one that has ever mattered — are the
  // files there? — so every referenced book is checked against the bucket.
  const at = Number.isFinite(body.offset) ? Math.max(0, Math.floor(body.offset)) : 0;
  const ids = ((await env.DB.prepare(
    `SELECT book FROM (SELECT book FROM book_slugs UNION SELECT book FROM positions)
      ORDER BY book LIMIT ? OFFSET ?`,
  ).bind(REF_PAGE, at).all()).results ?? []).map((r) => r.book);
  const alive = await mapPool(ids, 4, async (book) =>
    Boolean(await env.BOOKS.head(`${book}/manifest.json`)));
  const dead = ids.filter((_, i) => !alive[i]);
  if (dead.length) {
    const marks = dead.map(() => "?").join(",");
    const slugRows = (await env.DB.prepare(
      `SELECT slug, book FROM book_slugs WHERE book IN (${marks}) ORDER BY slug`,
    ).bind(...dead).all()).results ?? [];
    const posRows = (await env.DB.prepare(
      `SELECT book, COUNT(*) n FROM positions WHERE book IN (${marks}) GROUP BY book ORDER BY book`,
    ).bind(...dead).all()).results ?? [];
    for (const s of slugRows) add({ kind: "orphan-slug", id: s.slug, book: s.book });
    for (const p of posRows) add({ kind: "orphan-position", id: p.book, count: p.n });
  }
  return json(ids.length === REF_PAGE
    ? { done: false, phase: "refs", offset: at + REF_PAGE, findings, dropped }
    : { done: true, findings, dropped });
}

// One book, both directions: every chapter the manifest names against what is
// actually under its prefix, and everything under the prefix against the
// manifest. The size comparison needs `bytes`, which manifests only carry from
// the release that added this check — without it presence is all we can say,
// which is still the difference between "the shelf claims 1,835 chapters" and
// "1,835 chapters are there".
async function checkChapters(env, id, manifest) {
  let m = manifest;
  if (!m) {
    const obj = await env.BOOKS.get(`${id}/manifest.json`);
    if (!obj) return []; // ghost-book already said so
    m = await obj.json().catch(() => null);
  }
  if (!m || !Array.isArray(m.chapters)) return [];

  const have = new Map();
  let cursor, complete = false;
  for (let page = 0; page < 10; page++) {
    const list = await env.BOOKS.list({ prefix: `${id}/`, cursor, limit: 1000 });
    for (const o of list.objects) have.set(o.key.slice(id.length + 1), o.size);
    if (!list.truncated) { complete = true; break; }
    cursor = list.cursor;
  }

  const out = [];
  let missing = 0, wrongSize = 0, sample = "";
  for (const c of m.chapters) {
    const size = have.get(c.file);
    have.delete(c.file);
    if (size === undefined) {
      missing++;
      sample ||= c.file;
    } else if (Number.isFinite(c.bytes) && size !== c.bytes) {
      wrongSize++;
      sample ||= c.file;
    }
  }
  // a listing that ran past the cap can't prove anything about what is missing
  if (complete && (missing || wrongSize))
    out.push({
      kind: "incomplete-book", id, missing, wrongSize,
      chapters: m.chapters.length, sample,
    });

  have.delete("manifest.json");
  // the 書衣 slot: a cover is a first-class book file, not a stray — the
  // convention is exactly this name (the enrichment path normalizes to it)
  have.delete("cover.jpg");
  // the enrichment sidecar (author/簡介, see the enriched-zip contract):
  // like the cover it survives a re-split, so it is never a stale file
  have.delete("meta.json");
  if (complete && have.size)
    out.push({
      kind: "stale-file", id, files: have.size,
      bytes: [...have.values()].reduce((n, s) => n + (s ?? 0), 0),
    });
  return out;
}

// How much a prefix is holding. One listing — a book is well under the 1000-key
// page, and `more` says so when something is not.
async function prefixSize(env, prefix) {
  const page = await env.BOOKS.list({ prefix, limit: 1000 });
  return {
    files: page.objects.length,
    bytes: page.objects.reduce((n, o) => n + (o.size ?? 0), 0),
    more: Boolean(page.truncated),
  };
}

// POST /api/admin/cleanup {kind, id} — the findings nothing else can clear.
// Orphan FILES are dropped with DELETE /api/admin/books/<id> (which sweeps the
// prefix and the audio with it), and the index-only findings are what 重建索引
// already fixes; these are the leftovers inside a live book, and the D1 rows
// still pointing at a book that is gone.
//
// Deleting bookmarks is the one thing here that destroys something a person
// would miss, so the finding is never taken on trust: the bucket is asked
// again, right here, and a book whose manifest is present keeps everything.
// That one check is the whole guard, and deliberately so — an `id NOT IN books`
// clause used to ride along with it, which made the delete depend on a reindex
// having pruned the row first. The files are the book; a row is an opinion.
async function cleanup(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const { kind, id } = (await request.json().catch(() => ({}))) ?? {};
  if (typeof id !== "string" || !id) return json({ error: "id required" }, 400);

  if (kind === "orphan-position") {
    if (await env.BOOKS.head(`${id}/manifest.json`))
      return json({ error: "book still exists" }, 409);
    const res = await env.DB.prepare("DELETE FROM positions WHERE book = ?")
      .bind(id).run();
    return json({ ok: true, kind, id, removed: res.meta?.changes ?? 0 });
  }
  // Files under a live book that its manifest does not name. The ordinary
  // sweep is no good here — it would take the book with them — so the set is
  // recomputed server-side from the manifest and only the difference goes.
  // One listing per call; `done` false means there is another page.
  if (kind === "stale-file") {
    const obj = await env.BOOKS.get(`${id}/manifest.json`);
    if (!obj) return json({ error: "no manifest" }, 409);
    const m = await obj.json().catch(() => null);
    if (!m || !Array.isArray(m.chapters)) return json({ error: "bad manifest" }, 409);
    // the same first-class names the audit exempts — a stray next to a cover
    // must not take the 書衣 (or the meta sidecar) with it
    const named = new Set([
      ...m.chapters.map((c) => c.file), "manifest.json", "cover.jpg", "meta.json",
    ]);
    const list = await env.BOOKS.list({ prefix: `${id}/`, limit: 1000 });
    const keys = list.objects
      .map((o) => o.key)
      .filter((k) => !named.has(k.slice(id.length + 1)));
    if (keys.length) await env.BOOKS.delete(keys);
    return json({ ok: true, kind, id, removed: keys.length, done: !list.truncated });
  }

  if (kind === "orphan-slug") {
    // `id` is the slug; what has to be gone is the book behind it
    const row = await env.DB.prepare("SELECT book FROM book_slugs WHERE slug = ?")
      .bind(id).first();
    if (!row) return json({ ok: true, kind, id, removed: 0 });
    if (await env.BOOKS.head(`${row.book}/manifest.json`))
      return json({ error: "book still exists" }, 409);
    const res = await env.DB.prepare("DELETE FROM book_slugs WHERE slug = ?")
      .bind(id).run();
    return json({ ok: true, kind, id, removed: res.meta?.changes ?? 0 });
  }
  return json({ error: "unknown kind" }, 400);
}

// A slug is a URL path segment, and a book id is that plus an R2 key prefix,
// so both are validated with SLUG_RE, which lives in split-core.mjs beside
// the deriveSlug() whose alphabet it describes — /admin checks the same rule
// before it sends.

// Promise.all with a ceiling on how many run at once. A Worker gets 6
// simultaneous open connections and every R2 binding call holds one, so
// fanning out over a whole list is a production-only failure that never shows
// up in a local run — miniflare has no connection cap. (This cost a day:
// re-slugging used to copy the bucket, and `Promise.all` over a 20-chapter
// batch answered "Response closed due to connection limit" in production
// while passing locally at the same scale. Re-slugging no longer moves a
// byte, but anything that touches R2 once per book still comes through here.)
export async function mapPool(items, limit, fn) {
  const queue = [...items].map((item, i) => [item, i]);
  const out = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const [item, i] = queue.shift();
        out[i] = await fn(item, i);
      }
    }),
  );
  return out;
}

// Whole-book admin, the operations /admin offers on each shelf row. The book
// is addressed by its id, which is also the R2 prefix its files live under:
//
//   PATCH {title, slug}  retitle and/or re-slug. Both are metadata: the
//                        manifest is rewritten and the index row updated, and
//                        not one chapter file moves. generatedAt stays put
//                        because it versions the chapter and audio caches
//                        (?v=) and neither edit invalidates them. The old
//                        slug keeps resolving — see book_slugs.
//   DELETE               chapters, manifest, cached audio, index rows and
//                        every reader's position for this book.
//
// (Re-slugging used to be a bucket-wide copy: 1,835 chapters through a paged
// cursor, minutes of round trips, bookmarks migrated by an UPDATE, and a
// sweep afterwards. Giving books an id that never changes turned all of it
// into two rows. That is the entire point of the id.)
async function handleAdminBook(request, env, id) {
  if (!SLUG_RE.test(id)) return json({ error: "bad book id" }, 400);
  const manifestKey = `${id}/manifest.json`;

  if (request.method === "PATCH") {
    const body = (await request.json().catch(() => ({}))) ?? {};
    const title = body.title === undefined ? undefined : String(body.title).trim();
    const slug = body.slug === undefined ? undefined : String(body.slug).trim();
    if (title !== undefined && !title) return json({ error: "title required" }, 400);
    if (slug !== undefined && (!SLUG_RE.test(slug) || RESERVED_SLUGS.includes(slug)))
      return json({ error: "bad slug" }, 400);

    const obj = await env.BOOKS.get(manifestKey);
    if (!obj) return json({ error: "not found" }, 404);
    const m = await obj.json();
    if (title !== undefined) m.title = title;
    if (slug !== undefined && slug !== m.slug) {
      const owner = await env.DB.prepare("SELECT book FROM book_slugs WHERE slug = ?")
        .bind(slug).first();
      if (owner && owner.book !== id) return json({ error: "slug taken" }, 409);
      m.slug = slug;
    }
    // manifest first, index second: the manifest is what a reindex reads back,
    // so a half-applied edit must be the half that survives repair
    m.id = id;
    await env.BOOKS.put(manifestKey, JSON.stringify(m, null, 2) + "\n");
    const reg = await registerBook(env, id, m, await sidecarAuthor(env, id));
    if (!reg.ok) return json({ error: "slug taken" }, 409);
    return json({ ok: true, id, slug: m.slug, title: m.title });
  }

  // Delete, a page per request (`?sweep=1` on every call after the first). A
  // book with a large TTS cache is thousands of objects, and one request is
  // no place to put thousands of deletes.
  if (request.method === "DELETE") {
    const q = new URL(request.url).searchParams;
    const sweeping = q.get("sweep") === "1";
    // ?expect=<reason> — what 修復 believed about this book when it decided to
    // sweep it. The finding was made by an earlier request, in a phase that ran
    // before the operator even said yes, so the premise is re-checked here
    // before anything is deleted: a book that no longer matches it is refused
    // rather than swept on the strength of a stale scan. This is what makes it
    // safe to split checking from fixing — the window between them is real, and
    // this is where it is closed.
    if (!sweeping) {
      const wrong = await premiseFails(env, id, q.get("expect"));
      if (wrong) return json({ error: wrong }, 409);
    }
    // index rows go first, in the same call that takes the manifest: they are
    // what the shelf and the URL resolve through, so the book disappears
    // cleanly even if the sweep is cut short, and no later step needs them
    const hadManifest = Boolean(await env.BOOKS.head(manifestKey));
    let indexed = 0;
    if (!sweeping) {
      const res = await env.DB.batch([
        env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM book_slugs WHERE book = ?").bind(id),
      ]);
      indexed = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
      if (hadManifest) await env.BOOKS.delete(manifestKey);
    }
    const swept = await deletePage(env, [`${id}/`, `_tts/${id}/`]);
    const removed = (hadManifest ? 1 : 0) + swept;
    if (!removed && !indexed && !sweeping) return json({ error: "not found" }, 404);
    if (swept) return json({ done: false, id, removed });
    const res = await env.DB.prepare("DELETE FROM positions WHERE book = ?")
      .bind(id).run();
    return json({ done: true, ok: true, id, removed, positions: res.meta?.changes ?? 0 });
  }

  return json({ error: "method not allowed" }, 405);
}

// Each reason a sweep can give for itself, re-verified against the bucket.
// Returns why the sweep must not go ahead, or null to let it through — and null
// for no reason given, which is the shelf's own 刪除 button: a human typed the
// slug of a book they are looking at, and that is its own premise.
async function premiseFails(env, id, expect) {
  const key = `${id}/manifest.json`;
  if (!expect) return null;
  // orphan files, or an audio cache outliving its book: nothing to serve
  if (expect === "gone")
    return (await env.BOOKS.head(key)) ? "book still exists" : null;
  // a manifest that will not parse. Present and broken is the premise; present
  // and fine, or absent entirely, are both different findings than the one made
  if (expect === "bad-manifest") {
    const obj = await env.BOOKS.get(key);
    if (!obj) return "no manifest";
    return (await obj.json().catch(() => null)) ? "manifest is fine" : null;
  }
  if (expect === "incomplete") {
    const bad = (await checkChapters(env, id)).find((f) => f.kind === "incomplete-book");
    return bad ? null : "book is complete";
  }
  return "unknown reason";
}

// One page of deletes: the first prefix that still has anything under it gets
// a listing and a single bulk delete (R2 takes 1000 keys per call, exactly one
// page). Paging across calls is the caller's job — see the sweep phase.
async function deletePage(env, prefixes) {
  for (const prefix of prefixes) {
    const page = await env.BOOKS.list({ prefix, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (!keys.length) continue;
    await env.BOOKS.delete(keys);
    return keys.length;
  }
  return 0;
}
