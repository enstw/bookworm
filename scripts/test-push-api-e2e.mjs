// End-to-end proof of 新書上架 and 新版本已上線 notifications against a
// locally running worker: this script IS the push service. It stands up a
// capture server, subscribes that endpoint, publishes a book through the
// real admin route, then DECRYPTS the notification the worker actually sent
// and checks the VAPID JWT that carried it. Also covers validation, upsert,
// unsubscribe, the re-publish (no duplicate announcement) case, and 410
// pruning.
//
// The build announcement needs a STAMPED worker — announceBuild refuses to
// ring for BUILD "dev" — so this script does deploy.sh's sed itself, on an
// unstamped src/worker.js only, and puts the original bytes back in the
// finally. Against a worker it did not start (BOOKWORM_URL) those checks
// report skipped rather than quietly passing.
//
// Prereqs: a worker on :8787 with VAPID_PRIVATE_JWK and ADMIN_TOKEN in
// .dev.vars — this script starts `wrangler dev` itself unless
// BOOKWORM_URL is set.
//
//   node scripts/test-push-api-e2e.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// shadows the global: the d1() shell-outs below outlive a pooled keep-alive
// socket, and the request that inherits the dead one has to be replayed
import { fetch } from "./retry-fetch.mjs";

// the API rightly requires https:// endpoints, so the loopback capture
// server is registered straight into the local D1 instead of through
// /api/push/subscribe (which is validated separately below)
const d1 = (sql) => {
  const raw = execFileSync("pnpm",
    ["exec", "wrangler", "d1", "execute", "bookworm", "--local", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return raw.slice(raw.indexOf("[")); // pnpm/wrangler print banners first
};

// its own port: a `pnpm run dev` server on 8787 belongs to the developer
// (and may predate the .dev.vars this test needs)
const DEV_PORT = 8789;
const BASE = process.env.BOOKWORM_URL ?? `http://localhost:${DEV_PORT}`;
// same default as every other e2e script — this one said "dev-token", so on a
// .dev.vars with the usual test token its admin calls 401'd and the 新書
// announcement it was checking never had a book to announce
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const CAP_PORT = 8993;
const out = {};
const te = new TextEncoder();
const td = new TextDecoder();
const b64u = {
  enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(
    atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0)),
};
const cat = (...ps) => {
  const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of ps) { o.set(p, i); i += p.length; }
  return o;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the fake push service: records every POST, answers with `nextStatus` ---
const captured = [];
let nextStatus = 201;
const cap = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured.push({
      path: req.url,
      auth: req.headers.authorization ?? "",
      encoding: req.headers["content-encoding"],
      ttl: req.headers.ttl,
      body: new Uint8Array(Buffer.concat(chunks)),
    });
    res.writeHead(nextStatus);
    res.end();
  });
});
await new Promise((r) => cap.listen(CAP_PORT, r));

// --- our subscription keys (we are the user agent) ---
const ua = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const uaRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const endpoint = `http://127.0.0.1:${CAP_PORT}/push/one`;
const sub = { user: "pushtest", endpoint, p256dh: b64u.enc(uaRaw), auth: b64u.enc(authSecret) };

// --- stamp a build in, the way deploy.sh does ---
// announceBuild() refuses to ring for BUILD "dev", so without this the whole
// 新版本 path is unreachable from a dev server. The original bytes are written
// back in the finally — not `git checkout`, which would take unrelated edits
// with it.
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "worker.js");
const workerSrc = readFileSync(workerPath, "utf8");
const TEST_BUILD = "abc1234 · 2026-01-01 00:00";
const stamped = !process.env.BOOKWORM_URL && workerSrc.includes('const BUILD = "dev";');
if (stamped)
  writeFileSync(workerPath,
    workerSrc.replace('const BUILD = "dev";', `const BUILD = "${TEST_BUILD}";`));
// every exit from here on goes through this, including the boot timeout below
const unstamp = () => { if (stamped) writeFileSync(workerPath, workerSrc); };
// deploy.sh names the build it just deployed, and the worker refuses to answer
// for any other one — see the stale-isolate note in announceBuild
const announceUrl = (b) => `/api/admin/announce-build?build=${encodeURIComponent(b)}`;

// This suite writes push_subs and announced_builds straight into local D1, so
// it applies the schema itself: a table the dev server has never seen is not
// a failure worth debugging, and the file is idempotent.
execFileSync("pnpm",
  ["exec", "wrangler", "d1", "execute", "bookworm", "--local", "--file=schema.sql"],
  { stdio: "ignore" });

// --- boot wrangler dev unless a worker was pointed at ---
let dev = null;
if (!process.env.BOOKWORM_URL) {
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(DEV_PORT)],
    { stdio: "ignore", env: { ...process.env, CI: "true" } });
}
const deadline = Date.now() + 60000;
while (true) {
  try {
    // the Bearer, not a bare fetch: /api/books 401s without a credential now
    const r = await fetch(`${BASE}/api/books`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.ok) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) { dev?.kill(); cap.close(); unstamp(); throw new Error("worker never came up"); }
  await sleep(500);
}

// subscribe/test sit behind the reader gate now. The admin Bearer passes it
// and — having no reader identity of its own — lets body.user through, which
// the upsert-rename check below depends on.
const post = (path, body, headers = {}) => fetch(BASE + path, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
    ...headers,
  },
  body: JSON.stringify(body),
});

async function decrypt(body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asRaw = body.slice(21, 21 + idlen);
  const record = body.slice(21 + idlen);
  const asPub = await crypto.subtle.importKey("raw", asRaw,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: asPub }, ua.privateKey, 256));
  const hkdf = async (s, ikm, info, len) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: s, info }, k, len * 8));
  };
  const ikm = await hkdf(authSecret, shared,
    cat(te.encode("WebPush: info\0"), uaRaw, asRaw), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce }, aes, record));
  return JSON.parse(td.decode(plain.slice(0, -1)));
}

try {
  // 1. the public key is a valid uncompressed P-256 point
  const vres = await fetch(`${BASE}/api/push/vapid`);
  const vkey = (await vres.json()).key ?? "";
  const vraw = vkey ? b64u.dec(vkey) : new Uint8Array();
  out.vapidKey = vres.ok && vraw.length === 65 && vraw[0] === 4
    ? "ok (65-byte P-256 point)" : `FAIL ${vres.status} ${vkey}`;

  // 2. validation: bad endpoint / bad key charset / missing fields — and the
  // gate itself: a bare request (no key, no Bearer) stops at 401
  const bad = await Promise.all([
    post("/api/push/subscribe", { ...sub, endpoint: "ftp://x" }),
    post("/api/push/subscribe", { ...sub, p256dh: "not base64url!!" }),
    post("/api/push/subscribe", { endpoint }),
    fetch(`${BASE}/api/push/subscribe`),
  ]);
  out.validation = bad.slice(0, 3).every((r) => r.status === 400) && bad[3].status === 401
    ? "ok (400s; bare request 401s at the gate)"
    : "FAIL " + bad.map((r) => r.status).join(",");

  // 3. the real subscribe route: same endpoint twice must upsert, not
  // duplicate; then unsubscribe removes it
  const web = { ...sub, endpoint: "https://push.example.invalid/sub-A" };
  const s1 = await post("/api/push/subscribe", web);
  const s2 = await post("/api/push/subscribe", { ...web, user: "renamed" });
  const rows = JSON.parse(d1(
    "SELECT COUNT(*) c, MAX(user) u FROM push_subs WHERE endpoint = 'https://push.example.invalid/sub-A'",
  ))[0].results[0];
  const un0 = await post("/api/push/unsubscribe", { endpoint: web.endpoint });
  const gone = JSON.parse(d1(
    "SELECT COUNT(*) c FROM push_subs WHERE endpoint = 'https://push.example.invalid/sub-A'",
  ))[0].results[0].c;
  out.subscribe = s1.ok && s2.ok && rows.c === 1 && rows.u === "renamed" && un0.ok && gone === 0
    ? "ok (upsert 1 row, unsubscribe removes it)"
    : `FAIL ${s1.status}/${s2.status} rows=${JSON.stringify(rows)} gone=${gone}`;

  // register the loopback capture endpoint for the delivery tests
  d1(`DELETE FROM push_subs; INSERT INTO push_subs (endpoint, user, p256dh, auth, created_at)
      VALUES ('${endpoint}', 'pushtest', '${sub.p256dh}', '${sub.auth}', 0)`);

  // 4. publish a NEW book → exactly one push, decryptable, right payload
  const slug = "pushtest-" + Math.floor(Date.now() / 1000).toString(36);
  // a publish that quietly fails would look exactly like a push that never
  // fired, so this one refuses to be quiet
  const put = async (key, body, type) => {
    const res = await fetch(
      `${BASE}/api/admin/objects/${encodeURIComponent(key)}`,
      { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": type }, body });
    if (!res.ok) throw new Error(`PUT ${key}: HTTP ${res.status} ${await res.text()}`);
    return res;
  };
  await put(`${slug}/ch1.txt`, "第一回 測試\n\n內容。", "text/plain");
  const manifest = JSON.stringify({
    slug, title: "推播測試書", generatedAt: "p1", totalChars: 12,
    chapters: [{ file: "ch1.txt", title: "第一回 測試", chars: 12 }],
  });
  captured.length = 0;
  await put(`${slug}/manifest.json`, manifest, "application/json");
  for (let i = 0; i < 40 && !captured.length; i++) await sleep(250);
  const hit = captured[0];
  out.pushSent = hit ? "ok (1 request)" : "FAIL no push arrived";
  if (hit) {
    const payload = await decrypt(hit.body).catch((e) => ({ error: String(e) }));
    // /?shelf, not "/": bare "/" resumes whatever book is open, and the point
    // of this notification is seeing the NEW book on the shelf
    out.payload = payload.title === "新書上架" && payload.body === "推播測試書" && payload.url === "/?shelf"
      ? "ok (decrypted: 新書上架 / 推播測試書)" : "FAIL " + JSON.stringify(payload);
    // the VAPID header must be a well-formed ES256 JWT for OUR audience,
    // signed by the key /api/push/vapid advertises
    const m = hit.auth.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
    let sigOk = false, claims = {};
    if (m) {
      claims = JSON.parse(td.decode(b64u.dec(m[2])));
      const pub = await crypto.subtle.importKey("raw", b64u.dec(m[4]),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      sigOk = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub,
        b64u.dec(m[3]), te.encode(m[1] + "." + m[2]));
    }
    out.vapidHeader = m && sigOk && m[4] === vkey &&
      claims.aud === `http://127.0.0.1:${CAP_PORT}` && claims.exp > Date.now() / 1000
      ? "ok (ES256 verifies, aud/exp/k correct)"
      : `FAIL sig=${sigOk} claims=${JSON.stringify(claims)}`;
    out.headers = hit.encoding === "aes128gcm" && hit.ttl === "86400"
      ? "ok (aes128gcm, ttl 86400)" : `FAIL ${hit.encoding}/${hit.ttl}`;
  }

  // 5. re-publishing the SAME book must not announce again
  captured.length = 0;
  await put(`${slug}/manifest.json`, manifest, "application/json");
  await sleep(2500);
  out.noDuplicate = captured.length === 0
    ? "ok (silent on republish)" : `FAIL ${captured.length} extra pushes`;

  // 6. a 410 from the push service prunes the subscription
  nextStatus = 410;
  captured.length = 0;
  const slug2 = slug + "b";
  await put(`${slug2}/ch1.txt`, "x", "text/plain");
  await put(`${slug2}/manifest.json`,
    JSON.stringify({ slug: slug2, title: "第二本", generatedAt: "p1", totalChars: 1,
      chapters: [{ file: "ch1.txt", title: "一", chars: 1 }] }), "application/json");
  for (let i = 0; i < 40 && !captured.length; i++) await sleep(250);
  const got410 = captured.length === 1;
  nextStatus = 201;
  captured.length = 0;
  const slug3 = slug + "c";
  await put(`${slug3}/ch1.txt`, "x", "text/plain");
  await put(`${slug3}/manifest.json`,
    JSON.stringify({ slug: slug3, title: "第三本", generatedAt: "p1", totalChars: 1,
      chapters: [{ file: "ch1.txt", title: "一", chars: 1 }] }), "application/json");
  await sleep(2500);
  out.prunes410 = got410 && captured.length === 0
    ? "ok (dropped after 410)" : `FAIL sent410=${got410} after=${captured.length}`;

  // 7. unsubscribe stops delivery
  d1(`INSERT OR REPLACE INTO push_subs (endpoint, user, p256dh, auth, created_at)
      VALUES ('${endpoint}', 'pushtest', '${sub.p256dh}', '${sub.auth}', 0)`);
  const un = await post("/api/push/unsubscribe", { endpoint });
  captured.length = 0;
  const slug4 = slug + "d";
  await put(`${slug4}/ch1.txt`, "x", "text/plain");
  await put(`${slug4}/manifest.json`,
    JSON.stringify({ slug: slug4, title: "第四本", generatedAt: "p1", totalChars: 1,
      chapters: [{ file: "ch1.txt", title: "一", chars: 1 }] }), "application/json");
  await sleep(2500);
  out.unsubscribe = un.ok && captured.length === 0
    ? "ok (no delivery after unsubscribe)" : `FAIL ${un.status} ${captured.length}`;

  // 8. the self-test route: it must report the push service's own verdict
  // back to the phone, since that is the only thing separating "the server
  // never had my row" from "iOS swallowed the banner"
  const unknown = await post("/api/push/test", { endpoint: "https://push.example.invalid/nope" });
  const unknownBody = await unknown.json().catch(() => ({}));
  out.selfTestUnknown = unknown.status === 404 && unknownBody.subscribed === false
    ? "ok (404 not subscribed)" : `FAIL ${unknown.status} ${JSON.stringify(unknownBody)}`;

  d1(`INSERT OR REPLACE INTO push_subs (endpoint, user, p256dh, auth, created_at)
      VALUES ('${endpoint}', 'pushtest', '${sub.p256dh}', '${sub.auth}', 0)`);
  captured.length = 0;
  const t1 = await post("/api/push/test", { endpoint });
  const t1b = await t1.json().catch(() => ({}));
  const tPayload = captured.length === 1
    ? await decrypt(captured[0].body).catch((e) => ({ error: String(e) }))
    : {};
  out.selfTest = t1.ok && t1b.ok && t1b.status === 201 && tPayload.title === "測試通知"
    ? "ok (201 reported, 測試通知 decrypted)"
    : `FAIL ${t1.status} ${JSON.stringify(t1b)} ${JSON.stringify(tPayload)}`;

  // a rejection must surface as a status, not as a thrown 500, and still prune
  nextStatus = 410;
  const t2 = await post("/api/push/test", { endpoint });
  const t2b = await t2.json().catch(() => ({}));
  nextStatus = 201;
  const t3 = await post("/api/push/test", { endpoint });
  out.selfTestReject = t2.ok && t2b.ok === false && t2b.status === 410 && t3.status === 404
    ? "ok (410 reported and pruned)"
    : `FAIL ${t2.status}/${JSON.stringify(t2b)} then ${t3.status}`;

  // 9. push outcomes are readable afterwards — the whole point, since
  // pushNewBook answers to nobody (it runs inside waitUntil)
  await sleep(500);
  // the Bearer, not a bare fetch: reading the log is gated now (writing it
  // is not — the service worker could never hold a credential)
  const logs = (await (await fetch(`${BASE}/api/testlog?page=push&limit=20`,
    { headers: { authorization: `Bearer ${TOKEN}` } })).json()).logs ?? [];
  const joined = logs.map((l) => l.data).join("\n");
  out.pushLog = /測試 .+ → 201/.test(joined) && /新書 推播測試書: 1 訂閱/.test(joined) &&
    /已存在，不算新書/.test(joined)
    ? "ok (測試 / 新書 / republish all logged)"
    : "FAIL " + JSON.stringify(joined.slice(0, 300));

  // 10. 新版本已上線 — the same channel, triggered by the deploy hook rather
  // than by a publish. deploy.sh calls it on EVERY deploy, so exactly-once is
  // the whole feature: what must never happen is a banner per workflow re-run.
  if (!stamped) {
    out.announceGate = out.announceStale = out.announceFirst = out.announce =
      out.announceOnce = out.announceLog =
      "skipped (BOOKWORM_URL set, or src/worker.js already carries a stamp)";
  } else {
    // a trigger anyone could pull is a trigger anyone could ring the owner's
    // phone with, so the admin gate is part of this route's contract
    const naked = await fetch(`${BASE}/api/admin/announce-build`, { method: "POST" });
    out.announceGate = naked.status === 401
      ? "ok (401 without the admin Bearer)" : `FAIL ${naked.status}`;

    d1(`INSERT OR REPLACE INTO push_subs (endpoint, user, p256dh, auth, created_at)
        VALUES ('${endpoint}', 'pushtest', '${sub.p256dh}', '${sub.auth}', 0)`);

    // A call that lands on the previous version — Cloudflare kept routing to
    // it for seconds after `wrangler deploy` returned — must not answer for a
    // build it isn't. Left unchecked it recorded the OLD stamp as announced
    // and reported success, and the build that had just shipped never rang.
    d1("DELETE FROM announced_builds");
    captured.length = 0;
    const aS = await (await post(announceUrl("9999999 · 2099-01-01 00:00"), {})).json();
    await sleep(500);
    const staleRows = JSON.parse(
      d1("SELECT COUNT(*) n FROM announced_builds"))[0]?.results?.[0]?.n;
    out.announceStale = aS.announced === false && aS.reason === "stale worker" &&
      captured.length === 0 && staleRows === 0
      ? "ok (a stamp that isn't ours announces nothing and records nothing)"
      : `FAIL ${JSON.stringify(aS)} pushes=${captured.length} rows=${staleRows}`;

    // a fresh install must not greet its owner with "there is a new version"
    // (from here on the calls carry the matching stamp, the way deploy.sh
    // does, which is also what proves the guard lets the right one through)
    d1("DELETE FROM announced_builds");
    captured.length = 0;
    const a0 = await (await post(announceUrl(TEST_BUILD), {})).json();
    await sleep(1000);
    out.announceFirst = a0.announced === false && /first build/.test(a0.reason ?? "") &&
      captured.length === 0
      ? "ok (first build recorded, not announced)"
      : `FAIL ${JSON.stringify(a0)} pushes=${captured.length}`;

    // with a history behind it, the same call rings — once
    d1(`DELETE FROM announced_builds;
        INSERT INTO announced_builds (build, stamp, created_at) VALUES ('0000000', 'older', 0)`);
    captured.length = 0;
    const a1 = await (await post(announceUrl(TEST_BUILD), {})).json();
    for (let i = 0; i < 40 && !captured.length; i++) await sleep(250);
    const aPayload = captured.length
      ? await decrypt(captured[0].body).catch((e) => ({ error: String(e) }))
      : {};
    // the body is the stamp the WORKER carries, never anything the caller
    // sent: deploy.sh says when to ring, the worker says what shipped
    out.announce = a1.announced === true && a1.subs === 1 && captured.length === 1 &&
      aPayload.title === "新版本已上線" && aPayload.body === TEST_BUILD && aPayload.url === "/"
      ? "ok (decrypted: 新版本已上線 / the worker's own stamp)"
      : `FAIL ${JSON.stringify(a1)} ${JSON.stringify(aPayload)}`;

    // ...and never again for the same commit
    captured.length = 0;
    const a2 = await (await post(announceUrl(TEST_BUILD), {})).json();
    await sleep(2000);
    out.announceOnce = a2.announced === false && a2.reason === "already announced" &&
      captured.length === 0
      ? "ok (silent on re-deploy)" : `FAIL ${JSON.stringify(a2)} pushes=${captured.length}`;

    await sleep(500);
    const alogs = (await (await fetch(`${BASE}/api/testlog?page=push&limit=20`,
      { headers: { authorization: `Bearer ${TOKEN}` } })).json()).logs ?? [];
    out.announceLog = alogs.some((l) => l.data.includes(`新版本 ${TEST_BUILD}: 1 訂閱`))
      ? "ok (logged)" : "FAIL not in the push log";
  }

  // cleanup: drop the books this test published, index rows and all — these
  // were published under prefix == slug, so the prefix is also the book id
  for (const s of [slug, slug2, slug3, slug4])
    for (let round = 0; round < 10; round++) {
      const res = await fetch(
        `${BASE}/api/admin/books/${encodeURIComponent(s)}${round ? "?sweep=1" : ""}`,
        { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.done) break;
    }
} finally {
  cap.close();
  // kill first, then unstamp: wrangler dev watches src/ and would hot-reload
  // the worker out from under a test that has not finished reading its logs
  dev?.kill();
  unstamp();
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
