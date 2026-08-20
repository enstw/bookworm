#!/usr/bin/env node
// bookworm-updater's read-only check, and the properties that make the split
// safe (PM-04). Pure node: checkOnce takes a store and a fetch seam, so the
// whole thing runs against an in-memory row and a fake upstream — no wrangler,
// no account, no D1.
//
//   node scripts/test-updater.mjs

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { checkOnce, d1Store, UPDATER_VERSION, verifyBundle, buildMetadata, install,
  ensureHealthKey, healthCheck, currentVersionId, rollbackTo, installWithRollback,
  decide, acquireInstallLock, releaseInstallLock, runInstall } from "../src/updater-core.mjs";
import { readPanel, setPolicy, queueInstallNow, shouldAlarm, shouldNotifyWaiting, shouldAnnounceInstall, isStale, SILENT_THRESHOLD_MS } from "../src/update-panel.mjs";
import { runMigrations } from "../src/updater-core.mjs";
import { parseMigrations, isAdditive } from "../src/migrations.mjs";

const out = {};
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  out[name] = a === e ? "ok" : `FAIL got ${a}, want ${e}`;
};

// an in-memory stand-in for the single status row
const memStore = () => {
  let row = null;
  return {
    async read() { return row; },
    async write(r) { row = { ...r }; },
    get() { return row; },
  };
};
// a fetch that records how it was called and answers a scripted response
const fakeFetch = (response) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  fn.calls = calls;
  return fn;
};
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const MANIFEST = { version: "9a3855f · 2026-08-19 15:53", released_at: "2026-08-19T07:53:00.000Z" };
const NOW = 1_700_000_000_000;

// 1. a good check records what upstream offered, from the right URL, uncached
{
  const store = memStore();
  const fetchFn = fakeFetch(jsonResponse(200, MANIFEST));
  const r = await checkOnce({ upstreamUrl: "https://example.invalid/releases/latest/download/", store, now: NOW, fetchFn });
  const row = store.get();
  eq("goodResult", { ok: r.ok, version: r.version, hasManifest: r.manifest?.version === MANIFEST.version }, { ok: true, version: MANIFEST.version, hasManifest: true });
  eq("goodRow", {
    at: row.last_check_at, ok: row.last_check_ok,
    v: row.upstream_version, ra: row.upstream_released_at, detail: row.detail,
  }, { at: NOW, ok: 1, v: MANIFEST.version, ra: MANIFEST.released_at, detail: "" });
  eq("manifestUrl", fetchFn.calls[0].url, "https://example.invalid/releases/latest/download/manifest.json");
  const init = fetchFn.calls[0].init ?? {};
  out.uncached = init.cache === "no-store" && /no-cache/.test(init.headers?.["cache-control"] ?? "")
    ? "ok (cache: no-store + no-cache header)" : `FAIL ${JSON.stringify(init)}`;
}

// 2. a base without a trailing slash still resolves manifest.json
{
  const store = memStore();
  const fetchFn = fakeFetch(jsonResponse(200, MANIFEST));
  await checkOnce({ upstreamUrl: "https://example.invalid/x", store, now: NOW, fetchFn });
  eq("noTrailingSlash", fetchFn.calls[0].url, "https://example.invalid/x/manifest.json");
}

// 3. TLS is the trust anchor: a non-https URL is refused WITHOUT a fetch
{
  const store = memStore();
  const fetchFn = fakeFetch(jsonResponse(200, MANIFEST));
  const r = await checkOnce({ upstreamUrl: "http://example.invalid/", store, now: NOW, fetchFn });
  out.refusesHttp = r.ok === false && fetchFn.calls.length === 0 && /https/.test(store.get().detail)
    ? "ok (refused, never fetched)" : `FAIL ${JSON.stringify(r)} calls=${fetchFn.calls.length}`;
}

// 4. unset URL: recorded, not thrown
{
  const store = memStore();
  const r = await checkOnce({ upstreamUrl: "", store, now: NOW, fetchFn: fakeFetch(new Error("should not fetch")) });
  out.unsetUrl = r.ok === false && /未設定/.test(store.get().detail) ? "ok" : `FAIL ${JSON.stringify(store.get())}`;
}

// 5. a failed check keeps the last known-good upstream version, only moves
// the check fields — a transient outage must not erase what /admin shows
{
  const store = memStore();
  await checkOnce({ upstreamUrl: "https://example.invalid/", store, now: NOW, fetchFn: fakeFetch(jsonResponse(200, MANIFEST)) });
  const later = NOW + 900_000;
  const r = await checkOnce({ upstreamUrl: "https://example.invalid/", store, now: later, fetchFn: fakeFetch(jsonResponse(503, {})) });
  const row = store.get();
  out.keepsLastKnown = r.ok === false && row.last_check_at === later && row.last_check_ok === 0 &&
    row.upstream_version === MANIFEST.version && /503/.test(row.detail)
    ? "ok (upstream_version survived a 503)" : `FAIL ${JSON.stringify(row)}`;
}

// 6. a thrown fetch (DNS, TLS) surfaces as a recorded failure, not a crash
{
  const store = memStore();
  const r = await checkOnce({ upstreamUrl: "https://example.invalid/", store, now: NOW, fetchFn: fakeFetch(new Error("boom")) });
  out.fetchThrow = r.ok === false && /boom/.test(store.get().detail) ? "ok" : `FAIL ${JSON.stringify(store.get())}`;
}

// 7. a manifest missing its version is refused (garbage upstream, or an HTML
// error page that happened to parse)
{
  const store = memStore();
  const r = await checkOnce({ upstreamUrl: "https://example.invalid/", store, now: NOW, fetchFn: fakeFetch(jsonResponse(200, { released_at: "x" })) });
  out.missingVersion = r.ok === false && /version/.test(store.get().detail) ? "ok" : `FAIL ${JSON.stringify(store.get())}`;
}

// 8. the split's structural promises, read off the source and configs
{
  const src = readFileSync(new URL("../src/updater.js", import.meta.url), "utf8");
  const cfg = JSON.parse(readFileSync(new URL("../wrangler.updater.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const reader = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const deploy = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");

  // NO fetch handler: nothing outside Cloudflare can invoke the updater (R1)
  out.noFetchHandler = /async scheduled\(/.test(src) && !/\basync fetch\(/.test(src) && !/[^.]\bfetch\s*\(request/.test(src)
    ? "ok (scheduled only, no fetch handler)" : "FAIL updater has a fetch handler";
  // cron-only, no routes, no assets
  out.cronOnly = Array.isArray(cfg.triggers?.crons) && cfg.triggers.crons.length > 0 && !cfg.assets && !cfg.routes
    ? `ok (crons ${JSON.stringify(cfg.triggers.crons)}, no assets/routes)` : `FAIL ${JSON.stringify(cfg.triggers)}`;
  // both Workers bind the same D1 binding name, so the report crosses the split
  out.sharesD1 = cfg.d1_databases?.[0]?.binding === "DB" && cfg.d1_databases[0].database_name === reader.d1_databases[0].database_name
    ? "ok (same DB binding and database)" : "FAIL updater does not bind the reader's D1";
  // PM-04's Done-when, from the deploy script: the reader is handed no
  // Cloudflare credential as a secret, and UPSTREAM_URL goes ONLY to the
  // updater. (CLOUDFLARE_API_TOKEN is wrangler's own deploy env, never a
  // `secret put` on either Worker.)
  const readerSecretPuts = [...deploy.matchAll(/\$W secret put (\w+)/g)].map((m) => m[1]);
  const updaterSecretPuts = [...deploy.matchAll(/\$UPDATER secret put (\w+)/g)].map((m) => m[1]);
  out.readerHoldsNoCfToken =
    !readerSecretPuts.some((s) => /CLOUDFLARE|CF_API|UPSTREAM/.test(s)) && updaterSecretPuts.includes("UPSTREAM_URL")
      ? `ok (reader: ${readerSecretPuts.join(",")}; updater: ${updaterSecretPuts.join(",")})`
      : `FAIL reader=${readerSecretPuts.join(",")} updater=${updaterSecretPuts.join(",")}`;
  // the deploy actually stands the updater up
  out.deploysUpdater = /\$UPDATER deploy/.test(deploy) && /--config wrangler\.updater\.jsonc/.test(deploy)
    ? "ok" : "FAIL deploy.sh does not deploy the updater";
  out.updaterVersion = Number.isInteger(UPDATER_VERSION) && UPDATER_VERSION >= 1 ? `ok (v${UPDATER_VERSION})` : "FAIL";
}

// d1Store is a thin wrapper; prove it issues the single-row upsert/read
{
  const seen = [];
  const env = { DB: { prepare(sql) { return { bind(...a) { return { async run() { seen.push({ sql, a }); }, async first() { seen.push({ sql, a }); return null; } }; }, async first() { seen.push({ sql }); return null; } }; } } };
  const store = d1Store(env);
  await store.read();
  await store.write({ last_check_at: 1, last_check_ok: 1, upstream_version: "v", upstream_released_at: "r", detail: "" });
  out.d1Store = /WHERE id = 1/.test(seen[0].sql) && /ON CONFLICT \(id\)/.test(seen[1].sql)
    ? "ok (single-row read + upsert)" : `FAIL ${JSON.stringify(seen.map((s) => s.sql.slice(0, 40)))}`;
}

// ---- the install path (PM-05) -------------------------------------------

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64url = (str) => Buffer.from(str).toString("base64url");
const jwtWith = (claims) => `x.${b64url(JSON.stringify(claims))}.y`;

// a tiny release: worker.js + one asset, hashed for real
function fixture() {
  const worker = Buffer.from("export default { fetch(){ return new Response('hi') } }");
  const app = Buffer.from("console.log('app')\n");
  const entries = { "worker.js": worker, "public/app.js": app };
  const zip = Buffer.from(zipSync(entries, { level: 0 }));
  const manifest = {
    version: "abc1234 · 2026-01-01 00:00",
    worker: { file: "worker.js", sha256: sha(worker), size: worker.length },
    assets: [{ path: "/app.js", file: "public/app.js", sha256: sha(app), cfhash: "cafe0000000000000000000000000001", size: app.length }],
    bundle: { url: "https://example.invalid/bundle.zip", file: "b.zip", sha256: sha(zip), size: zip.length },
    bindings: [{ type: "d1", name: "DB" }, { type: "r2_bucket", name: "BOOKS" }, { type: "assets", name: "ASSETS" }],
    compatibility_date: "2026-06-01",
    compatibility_flags: ["nodejs_compat"],
    assetsConfig: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  };
  return { manifest, zip, worker, app };
}

// 9. verifyBundle: a good bundle returns the files; each mismatch throws
{
  const { manifest, zip } = fixture();
  const files = await verifyBundle(manifest, new Uint8Array(zip));
  out.verifyGood = files["worker.js"] && files["public/app.js"] ? "ok (unzipped, all hashes match)" : "FAIL";
  const threw = async (mutate) => { try { const m = JSON.parse(JSON.stringify(manifest)); mutate(m); await verifyBundle(m, new Uint8Array(zip)); return false; } catch { return true; } };
  const bundleTamper = await (async () => { const bad = Buffer.from(zip); bad[bad.length - 1] ^= 0xff; try { await verifyBundle(manifest, new Uint8Array(bad)); return false; } catch { return true; } })();
  out.verifyCatches = bundleTamper && await threw((m) => { m.assets[0].sha256 = "0".repeat(64); }) && await threw((m) => { m.assets[0].size = 999; }) && await threw((m) => { m.worker.sha256 = "0".repeat(64); })
    ? "ok (bundle-hash, asset-hash, size, worker-hash all caught)" : "FAIL a tampered bundle verified";
}

// 10. buildMetadata: only ASSETS is declared, everything else kept by type,
// compat carried from the manifest, the assets token wired in
{
  const { manifest } = fixture();
  const m = buildMetadata(manifest, "completion.jwt", ["secret_text", "d1", "r2_bucket"]);
  out.metadata =
    JSON.stringify(m.bindings) === JSON.stringify([{ type: "assets", name: "ASSETS" }]) &&
    JSON.stringify(m.keep_bindings) === JSON.stringify(["secret_text", "d1", "r2_bucket"]) &&
    m.assets.jwt === "completion.jwt" &&
    JSON.stringify(m.assets.config) === JSON.stringify(manifest.assetsConfig) &&
    m.main_module === "worker.js" && m.compatibility_date === "2026-06-01" &&
    JSON.stringify(m.compatibility_flags) === JSON.stringify(["nodejs_compat"]) &&
    !("keep_assets" in m)
      ? "ok (assets re-declared, rest kept, compat from manifest)" : `FAIL ${JSON.stringify(m)}`;
}

// a fake Cloudflare API + a fake bundle host, driving the whole install().
// bindings/secrets can differ before and after the PUT so a dropped one is
// detectable; the session hands out one bucket keyed by the asset's cfhash.
function fakeCf({ pre, post = pre, claims = {} }) {
  const calls = [];
  let putDone = false;
  const cf = async (path, init = {}, bearer) => {
    calls.push({ path, method: init.method ?? "GET", bearer });
    const now = putDone ? post : pre;
    if (/\/settings$/.test(path)) return { bindings: now.bindings };
    if (/\/secrets$/.test(path)) return now.secrets;
    if (/assets-upload-session$/.test(path)) return { jwt: jwtWith(claims), buckets: [["cafe0000000000000000000000000001"]] };
    if (/\/workers\/assets\/upload/.test(path)) return { jwt: "completion.jwt" };
    if (/\/workers\/scripts\/[^/]+$/.test(path) && init.method === "PUT") { putDone = true; return {}; }
    throw new Error("unexpected cf path " + path);
  };
  cf.calls = calls;
  return cf;
}
const READER = { bindings: [{ type: "secret_text", name: "ADMIN_TOKEN" }, { type: "assets", name: "ASSETS" }, { type: "r2_bucket", name: "BOOKS" }, { type: "d1", name: "DB" }], secrets: [{ name: "ADMIN_TOKEN", type: "secret_text" }] };

// 11. a full install: uploads the asset, PUTs, confirms nothing was dropped,
// and keeps exactly the non-assets binding types that were on the script
{
  const { manifest, zip } = fixture();
  const cf = fakeCf({ pre: READER });
  const fetchFn = async () => ({ ok: true, arrayBuffer: async () => zip });
  const r = await install({ manifest, cf, script: "bookworm", fetchFn });
  const putBody = cf.calls.find((c) => c.method === "PUT");
  out.installHappy = r.version === manifest.version && r.uploaded === 1 &&
    JSON.stringify(r.keptBindings.sort()) === JSON.stringify(["d1", "r2_bucket", "secret_text"]) &&
    r.secretsHeld.includes("ADMIN_TOKEN") && putBody
    ? "ok (asset uploaded, kept secret_text/d1/r2_bucket, ADMIN_TOKEN survived)" : `FAIL ${JSON.stringify(r)}`;
  // the asset upload carries the session JWT, the script calls the account token
  const upload = cf.calls.find((c) => /assets\/upload/.test(c.path));
  out.uploadBearer = upload?.bearer && upload.bearer.startsWith("x.") ? "ok (upload used the session token)" : `FAIL ${JSON.stringify(upload)}`;
}

// 12. the single-asset-uploads refusal fires BEFORE any upload (PM-00 fact 2)
{
  const { manifest, zip } = fixture();
  const cf = fakeCf({ pre: READER, claims: { wrangler_single_asset_uploads: true } });
  const fetchFn = async () => ({ ok: true, arrayBuffer: async () => zip });
  let threw = "";
  try { await install({ manifest, cf, script: "bookworm", fetchFn }); } catch (e) { threw = String(e.message); }
  const uploaded = cf.calls.some((c) => /assets\/upload/.test(c.path));
  const putted = cf.calls.some((c) => c.method === "PUT");
  out.refusesSingleAsset = /single_asset_uploads/.test(threw) && !uploaded && !putted
    ? "ok (refused, nothing uploaded or PUT)" : `FAIL threw=${threw} uploaded=${uploaded} put=${putted}`;
}

// 13. R4's loud failure: a secret gone after the PUT is a thrown install, not
// a silent success
{
  const { manifest, zip } = fixture();
  const post = { bindings: READER.bindings, secrets: [] }; // ADMIN_TOKEN vanished
  const cf = fakeCf({ pre: READER, post });
  const fetchFn = async () => ({ ok: true, arrayBuffer: async () => zip });
  let threw = "";
  try { await install({ manifest, cf, script: "bookworm", fetchFn }); } catch (e) { threw = String(e.message); }
  out.detectsDropped = /dropped/.test(threw) && /ADMIN_TOKEN/.test(threw)
    ? "ok (a dropped secret throws)" : `FAIL ${threw}`;
}

// 14. the cron wires check → runInstall, but runInstall is ARMED only with a
// token: no CF_API_TOKEN, no install, whatever the policy says
{
  const entry = readFileSync(new URL("../src/updater.js", import.meta.url), "utf8");
  const wired = /checkOnce\(/.test(entry) && /runInstall\(/.test(entry);
  // a fresh manifest, a reader on the old version, automatic policy soaked —
  // decide() would say install, but an unarmed env must not
  const manifest = { version: "new · x", released_at: "2020-01-01T00:00:00Z", requiresAttention: false, minUpdaterVersion: 1, bundle: {}, assets: [], bindings: [] };
  let installed = false;
  const deps = { cf: async () => ({}), fetchReader: async () => ({ ok: true, status: 200, json: async () => ({ build: "old · x" }) }), install: async () => { installed = true; return { outcome: "ok" }; } };
  const dbUnarmed = { prepare: () => ({ bind() { return this; }, async first() { return { mode: "automatic", soak_days: 0 }; }, async run() {} }) };
  const r = await runInstall({ env: { DB: dbUnarmed }, manifest, now: 2_000_000_000_000, deps });
  out.cronArmedGate = wired && r.armed === false && installed === false
    ? "ok (cron calls runInstall; no token → armed false, nothing installed)"
    : `FAIL wired=${wired} ${JSON.stringify(r)} installed=${installed}`;
}

// ---- health check + rollback (PM-07) ------------------------------------

const nap = () => Promise.resolve();
// a reader that answers /api/version and /api/books off a mutable state, so a
// rollback can be seen to change what it serves
const fakeReader = (state) => async (path, init) => {
  if (path === "/api/version") return { ok: true, status: 200, json: async () => ({ build: state.version }) };
  if (path === "/api/books") {
    if (!init?.headers?.["x-reader-key"]) return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
    const ok = state.books < 400;
    return { ok, status: state.books, json: async () => (ok ? { books: [] } : { error: "boom" }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// 15. healthCheck: healthy; version never propagates; books broken; no key
{
  const good = await healthCheck({ fetchReader: fakeReader({ version: "v2", books: 200 }), readerKey: "k", expectedVersion: "v2", tries: 3, sleep: nap });
  const stuck = await healthCheck({ fetchReader: fakeReader({ version: "v1", books: 200 }), readerKey: "k", expectedVersion: "v2", tries: 3, sleep: nap });
  const broken = await healthCheck({ fetchReader: fakeReader({ version: "v2", books: 500 }), readerKey: "k", expectedVersion: "v2", tries: 3, sleep: nap });
  const nokey = await healthCheck({ fetchReader: fakeReader({ version: "v2", books: 200 }), readerKey: "", expectedVersion: "v2", tries: 3, sleep: nap });
  out.healthCheck =
    good.ok === true && stuck.ok === false && /version stayed/.test(stuck.detail) &&
    broken.ok === false && /→ 500/.test(broken.detail) && nokey.ok === false && /401/.test(nokey.detail)
      ? "ok (healthy / version-stuck / books-500 / no-key all judged right)"
      : `FAIL ${JSON.stringify({ good, stuck, broken, nokey })}`;
}

// 16. currentVersionId + rollbackTo speak the deployments API
{
  let posted = null;
  const cf = async (path, init) => {
    if (/\/deployments$/.test(path) && init?.method === "POST") { posted = JSON.parse(init.body); return { id: "dep1" }; }
    if (/\/deployments$/.test(path)) return { deployments: [{ versions: [{ version_id: "VER-CURRENT" }] }] };
    throw new Error("unexpected " + path);
  };
  const cur = await currentVersionId(cf, "bookworm");
  await rollbackTo(cf, "bookworm", "VER-PREV", "test rollback");
  out.rollbackApi = cur === "VER-CURRENT" && posted?.strategy === "percentage" &&
    posted.versions[0].version_id === "VER-PREV" && posted.versions[0].percentage === 100
    ? "ok (reads current version, POSTs the previous at 100%)" : `FAIL cur=${cur} ${JSON.stringify(posted)}`;
}

// 17. ensureHealthKey mints once in readers, then reuses it
{
  const rows = [];
  const env = { DB: { prepare(sql) { return {
    bind(...a) { return {
      async first() { return /SELECT key FROM readers/.test(sql) ? (rows.find((r) => r.user === a[0]) ?? null) : null; },
      async run() { if (/INSERT INTO readers/.test(sql)) rows.push({ key: a[0], user: a[1], label: a[2] }); },
    }; },
  }; } } };
  const k1 = await ensureHealthKey(env, () => "mintedkey00000000000000000000000");
  const k2 = await ensureHealthKey(env, () => "SHOULD-NOT-BE-USED");
  out.healthKey = k1 === "mintedkey00000000000000000000000" && k2 === k1 && rows.length === 1 &&
    rows[0].user === "updater" && /health check/.test(rows[0].label)
    ? "ok (minted once as reader `updater`, reused)" : `FAIL k1=${k1} k2=${k2} rows=${JSON.stringify(rows)}`;
}

// 18. installWithRollback — the decision matrix. cf serves deployments and,
// on a rollback POST, restores what the reader serves.
function harness({ before, throwInstall, afterVersion, afterBooks }) {
  const state = { version: before.version, books: before.books };
  const events = [];
  const cf = async (path, init) => {
    if (/\/deployments$/.test(path) && init?.method === "POST") { events.push("rollback"); state.version = before.version; state.books = before.books; return { id: "d" }; }
    if (/\/deployments$/.test(path)) return { deployments: [{ versions: [{ version_id: "PREV" }] }] };
    throw new Error("unexpected cf " + path);
  };
  const installFn = async () => { if (throwInstall) throw new Error("install boom"); state.version = afterVersion; state.books = afterBooks; return { version: afterVersion }; };
  return { cf, installFn, fetchReader: fakeReader(state), events, state };
}
const runRB = async (opts) => {
  const h = harness(opts);
  const rec = [];
  const r = await installWithRollback({
    manifest: { version: opts.afterVersion, bundle: {}, assets: [] }, cf: h.cf, script: "bookworm",
    fetchReader: h.fetchReader, readerKey: "hk", installFn: h.installFn,
    recordOutcome: async (o) => rec.push(o), sleep: nap,
  });
  return { r, events: h.events, rec: rec[0], state: h.state };
};
{
  // (a) success + healthy → ok, no rollback
  const a = await runRB({ before: { version: "v1", books: 200 }, afterVersion: "v2", afterBooks: 200 });
  // (b) success but the new version is broken → rollback, previous restored
  const b = await runRB({ before: { version: "v1", books: 200 }, afterVersion: "v2", afterBooks: 500 });
  // (c) install threw, site unharmed → failed, no rollback
  const c = await runRB({ before: { version: "v1", books: 200 }, throwInstall: true, afterVersion: "v2", afterBooks: 200 });
  // (d) already broken before AND still broken after → failed, NO oscillating rollback
  const d = await runRB({ before: { version: "v1", books: 500 }, afterVersion: "v2", afterBooks: 500 });
  out.rollbackOk = a.r.outcome === "ok" && a.events.length === 0 && a.rec.outcome === "ok" ? "ok" : `FAIL ${JSON.stringify(a.r)}`;
  out.rollbackRegressed = b.r.outcome === "rolled-back" && b.r.rolledBack && b.events[0] === "rollback" &&
    b.r.restored?.ok === true && b.state.version === "v1" && b.rec.outcome === "rolled-back"
    ? "ok (broken release rolled back, v1 serving again)" : `FAIL ${JSON.stringify(b.r)} events=${b.events}`;
  out.rollbackInstallThrew = c.r.outcome === "failed" && c.events.length === 0 && /boom/.test(c.rec.detail) ? "ok (failed, site unharmed, no rollback)" : `FAIL ${JSON.stringify(c.r)}`;
  out.rollbackNoOscillate = d.r.outcome === "failed" && d.events.length === 0 ? "ok (already broken: no pointless rollback)" : `FAIL ${JSON.stringify(d.r)} events=${d.events}`;
}

// 18b. runInstall armed — decide says install → lock, installWithRollback,
// clear install-now, release; decide says skip → nothing; lock held → skip
function cronDb(state) {
  return { prepare(sql) {
    let args = [];
    const self = {
      bind(...a) { args = a; return self; },
      async first() {
        if (/FROM updater_policy/.test(sql)) return state.policy;
        if (/last_install_version, last_install_result FROM updater_status/.test(sql)) return state.lastInstall;
        if (/SELECT key FROM readers/.test(sql)) return state.readerKey ? { key: state.readerKey } : null;
        return null;
      },
      async run() {
        if (/UPDATE install_lock SET held_at = \?, holder/.test(sql)) {
          const [now, , stale] = args;
          if (state.lock.held_at === 0 || state.lock.held_at < stale) { state.lock.held_at = now; return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
        if (/UPDATE install_lock SET held_at = 0/.test(sql)) { state.lock.held_at = 0; state.released = true; return { meta: { changes: 1 } }; }
        if (/INSERT INTO readers/.test(sql)) { state.readerKey = args[0]; return { meta: { changes: 1 } }; }
        if (/UPDATE updater_status SET last_install_at/.test(sql)) { state.recorded = { at: args[0], version: args[1], result: args[2] }; return { meta: { changes: 1 } }; }
        if (/UPDATE updater_policy SET install_now_version = ''/.test(sql)) { state.policy.install_now_version = ""; state.clearedNow = true; return { meta: { changes: 1 } }; }
        if (/UPDATE updater_status SET notify_version/.test(sql)) { state.notify = { version: args[0], attention: args[1] }; return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      },
    };
    return self;
  } };
}
const MAN = { version: "new · x", released_at: "2020-01-01T00:00:00Z", requiresAttention: false, minUpdaterVersion: 1, bundle: {}, assets: [], bindings: [] };
const readerAt = (build) => async () => ({ ok: true, status: 200, json: async () => ({ build }) });
{
  // (a) automatic + soaked → installs, records, clears a matching install-now, releases the lock
  const state = { policy: { mode: "automatic", soak_days: 0, install_now_version: "new · x" }, lastInstall: {}, lock: { held_at: 0 }, readerKey: "hk" };
  let got = null;
  // the fake stands in for installWithRollback, so it drives recordOutcome the
  // way the real one does — that is the wiring runInstall is responsible for
  const deps = { cf: async () => ({}), fetchReader: readerAt("old · x"), install: async (o) => { got = o; await o.recordOutcome({ at: o.now, version: o.manifest.version, outcome: "ok", detail: "" }); return { outcome: "ok" }; } };
  const r = await runInstall({ env: { DB: cronDb(state), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, manifest: MAN, now: 2_000_000_000_000, deps });
  out.cronInstalls = r.armed && r.action === "install" && r.outcome === "ok" &&
    got?.manifest === MAN && got.readerKey === "hk" && got.script === "bookworm" &&
    state.recorded?.result === "ok" && state.clearedNow === true && state.lock.held_at === 0 && state.released
    ? "ok (installs, records, clears install-now, releases the lock)" : `FAIL ${JSON.stringify(r)} got=${!!got} rec=${JSON.stringify(state.recorded)} cleared=${state.clearedNow}`;
}
{
  // (b) pinned → decide skips, nothing installs, lock never taken
  const state = { policy: { mode: "pinned", soak_days: 0, install_now_version: "" }, lastInstall: {}, lock: { held_at: 0 }, readerKey: "hk" };
  let installed = false;
  const r = await runInstall({ env: { DB: cronDb(state), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, manifest: MAN, now: 2_000_000_000_000, deps: { cf: async () => ({}), fetchReader: readerAt("old · x"), install: async () => { installed = true; return {}; } } });
  out.cronSkips = r.armed && r.action === "skip" && /pinned/.test(r.reason) && !installed && state.lock.held_at === 0
    ? "ok (pinned: skipped, nothing installed, lock untouched)" : `FAIL ${JSON.stringify(r)} installed=${installed}`;
}
{
  // (c) lock already held → skip this tick
  const state = { policy: { mode: "automatic", soak_days: 0, install_now_version: "" }, lastInstall: {}, lock: { held_at: 1_999_999_999_999 }, readerKey: "hk" };
  let installed = false;
  const r = await runInstall({ env: { DB: cronDb(state), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, manifest: MAN, now: 2_000_000_000_000, deps: { cf: async () => ({}), fetchReader: readerAt("old · x"), install: async () => { installed = true; return {}; } } });
  out.cronLocked = r.armed && r.action === "locked" && !installed
    ? "ok (a held lock skips the tick)" : `FAIL ${JSON.stringify(r)} installed=${installed}`;
}

// 19. the service binding the health check reaches the reader through
{
  const cfg = JSON.parse(readFileSync(new URL("../wrangler.updater.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  out.readerBinding = cfg.services?.[0]?.binding === "READER" && cfg.services[0].service === "bookworm"
    ? "ok (READER service binding → bookworm)" : `FAIL ${JSON.stringify(cfg.services)}`;
}

// ---- the install decision (PM-15) ---------------------------------------

const DAY = 86400000;
const NOWD = 2_000_000_000_000; // fixed clock for the table
const rel = (daysAgo) => new Date(NOWD - daysAgo * DAY).toISOString();
// a release that is `age` days old; overrides off unless named
const man = (over = {}) => ({ version: "new · x", released_at: rel(over.age ?? 5), requiresAttention: over.requiresAttention ?? false, minUpdaterVersion: over.minUpdaterVersion ?? 1 });
const auto = { mode: "automatic", soakDays: 2 };
const base = { runningVersion: "old · x", updaterVersion: 1, now: NOWD };

const CASES = [
  ["up to date", { policy: auto, manifest: { ...man(), version: "old · x" } }, "skip", /up to date/],
  ["automatic, soaked", { policy: auto, manifest: man({ age: 5 }) }, "install", /soak/],
  ["automatic, still soaking", { policy: auto, manifest: man({ age: 1 }) }, "skip", /soaking/],
  ["canary (soakDays 0) installs at once", { policy: { mode: "automatic", soakDays: 0 }, manifest: man({ age: 0 }) }, "install", /elapsed/],
  ["pinned skips a new release", { policy: { mode: "pinned", soakDays: 2 }, manifest: man({ age: 5 }) }, "skip", /pinned/],
  ["pinned + install-now installs", { policy: { mode: "pinned", soakDays: 2 }, manifest: man({ age: 0 }), installNow: "new · x" }, "install", /install now/],
  ["notify mode notifies", { policy: { mode: "notify", soakDays: 2 }, manifest: man({ age: 5 }) }, "notify", /notify-only/],
  ["notify + install-now installs", { policy: { mode: "notify", soakDays: 2 }, manifest: man({ age: 5 }), installNow: "new · x" }, "install", /install now/],
  ["requiresAttention downgrades automatic to notify", { policy: auto, manifest: man({ age: 9, requiresAttention: true }) }, "notify", /attention/],
  ["requiresAttention + install-now installs", { policy: auto, manifest: man({ age: 9, requiresAttention: true }), installNow: "new · x" }, "install", /install now/],
  ["minUpdaterVersion too new refuses", { policy: auto, manifest: man({ age: 9, minUpdaterVersion: 2 }) }, "refuse", /needs updater v2/],
  ["minUpdaterVersion refuses even install-now", { policy: auto, manifest: man({ age: 9, minUpdaterVersion: 2 }), installNow: "new · x" }, "refuse", /needs updater v2/],
  ["failed version is not auto-retried", { policy: auto, manifest: man({ age: 9 }), lastInstall: { version: "new · x", result: "rolled-back" } }, "skip", /not retried/],
  ["failed version + install-now retries", { policy: auto, manifest: man({ age: 9 }), lastInstall: { version: "new · x", result: "rolled-back" }, installNow: "new · x" }, "install", /install now/],
  ["a DIFFERENT failed version does not block this one", { policy: auto, manifest: man({ age: 9 }), lastInstall: { version: "other · x", result: "failed" } }, "install", /soak/],
];
{
  const fails = [];
  for (const [name, input, action, reasonRe] of CASES) {
    const d = decide({ ...base, ...input });
    if (d.action !== action || !reasonRe.test(d.reason)) fails.push(`${name}: got ${d.action}/${d.reason}`);
  }
  out.decide = fails.length === 0 ? `ok (${CASES.length} cases: soak, 3 overrides, install-now, canary)` : `FAIL ${fails.join(" | ")}`;
}

// 21. the install lock, modeled on standard SQLite UPDATE ... WHERE semantics
// (the conditional UPDATE's row-count is the verdict). A live check against
// D1 runs in run-ci-tests where a local database exists; here the row is a
// faithful in-memory stand-in.
{
  const row = { held_at: 0, holder: "" };
  const env = { DB: { prepare(sql) {
    let args = [];
    const self = {
      bind(...a) { args = a; return self; },
      async run() {
        if (/SET held_at = \?, holder = \?/.test(sql)) {
          const [now, holder, staleBefore] = args;
          if (row.held_at === 0 || row.held_at < staleBefore) { row.held_at = now; row.holder = holder; return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
        if (/SET held_at = 0/.test(sql)) { row.held_at = 0; row.holder = ""; return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      },
    };
    return self;
  } } };
  const t = 1_000_000_000_000;
  const a1 = await acquireInstallLock(env, "cronA", t);
  const a2 = await acquireInstallLock(env, "cronB", t + 1000);       // held → refused
  await releaseInstallLock(env);
  const a3 = await acquireInstallLock(env, "cronC", t + 2000);       // free again → acquired
  // hold it, then a much later attempt reclaims a stale lock
  const a4 = await acquireInstallLock(env, "cronD", t + 3000);       // held by cronC → refused
  const a5 = await acquireInstallLock(env, "cronE", t + 20 * 60 * 1000); // >15 min later → stale, reclaimed
  out.installLock = a1 && !a2 && a3 && !a4 && a5 && row.holder === "cronE"
    ? "ok (one at a time; released frees it; a stale lock is reclaimed)"
    : `FAIL ${JSON.stringify({ a1, a2, a3, a4, a5, holder: row.holder })}`;
}

// ---- the panel, reader side (PM-08) -------------------------------------

function panelDb(state) {
  return { prepare(sql) {
    let args = [];
    const self = {
      bind(...a) { args = a; return self; },
      async first() {
        if (/FROM updater_status/.test(sql)) return state.status;
        if (/FROM updater_policy/.test(sql)) return state.policy;
        return null;
      },
      async run() {
        if (/INSERT INTO updater_policy/.test(sql)) {
          state.policy = state.policy || {};
          if (/mode = excluded\.mode/.test(sql)) { state.policy.mode = args[0]; state.policy.soak_days = args[1]; }
          if (/install_now_version = excluded/.test(sql)) { state.policy.install_now_version = args[0]; state.policy.install_now_at = args[1]; }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return self;
  } };
}

// 22. readPanel reflects the updater's D1 rows and never contacts upstream
{
  const state = {
    status: { upstream_version: "9a · x", upstream_released_at: "2026-08-19T00:00:00Z", last_check_at: 123, last_check_ok: 1, detail: "", last_install_at: 456, last_install_version: "9a · x", last_install_result: "ok", last_install_detail: "", updater_version: 1 },
    policy: { mode: "notify", soak_days: 3, install_now_version: "", install_now_at: 0 },
  };
  const d = await readPanel({ DB: panelDb(state) }, "old · x");
  out.panelRead = d.running === "old · x" && d.upstream.version === "9a · x" && d.lastCheck.ok === true &&
    d.updaterVersion === 1 && d.policy.mode === "notify" && d.policy.soakDays === 3 && d.lastInstall.result === "ok"
    ? "ok (running, upstream, last-check, updater version, policy, last-install)" : `FAIL ${JSON.stringify(d)}`;
  // a fresh install with no rows → sensible defaults, not a crash
  const empty = await readPanel({ DB: panelDb({ status: null, policy: null }) }, "b · x");
  out.panelDefaults = empty.running === "b · x" && empty.upstream.version === "" && empty.policy.mode === "automatic" && empty.policy.soakDays === 2 && empty.lastCheck.at === 0
    ? "ok (no rows: running only, automatic/2 default)" : `FAIL ${JSON.stringify(empty)}`;
}

// 23. setPolicy validates and writes; bad input is refused
{
  const state = { status: null, policy: { mode: "automatic", soak_days: 2 } };
  const env = { DB: panelDb(state) };
  const okr = await setPolicy(env, { mode: "pinned", soakDays: 7 });
  const badMode = await setPolicy(env, { mode: "whenever", soakDays: 1 });
  const badSoak = await setPolicy(env, { mode: "automatic", soakDays: -1 });
  out.panelPolicy = okr.ok && state.policy.mode === "pinned" && state.policy.soak_days === 7 &&
    badMode.ok === false && /mode/.test(badMode.error) && badSoak.ok === false && /soakDays/.test(badSoak.error)
    ? "ok (valid written; bad mode and bad soak refused)" : `FAIL ${JSON.stringify({ okr, badMode, badSoak, policy: state.policy })}`;
}

// 24. queueInstallNow stores the version the updater last saw; refuses when
// nothing has been seen
{
  const seen = { status: { upstream_version: "9a · x" }, policy: {} };
  const q1 = await queueInstallNow({ DB: panelDb(seen) }, 999);
  const none = { status: { upstream_version: "" }, policy: {} };
  const q2 = await queueInstallNow({ DB: panelDb(none) }, 999);
  out.panelInstallNow = q1.ok && q1.version === "9a · x" && seen.policy.install_now_version === "9a · x" && seen.policy.install_now_at === 999 &&
    q2.ok === false && /no upstream/.test(q2.error)
    ? "ok (queues the seen version; refuses when none seen)" : `FAIL ${JSON.stringify({ q1, q2, policy: seen.policy })}`;
}

// ---- the silent-updater alarm (PM-14, R10) ------------------------------

// 25. shouldAlarm fires once per stall, never for a never-checked updater
{
  const now = 2_000_000_000_000;
  const stale = now - SILENT_THRESHOLD_MS - 1;   // just past the threshold
  const fresh = now - 60_000;                     // a minute ago
  const cases = [
    ["never checked", { lastCheckAt: 0, silentAlarmFor: 0, now }, false],
    ["fresh", { lastCheckAt: fresh, silentAlarmFor: 0, now }, false],
    ["stale, not yet alarmed", { lastCheckAt: stale, silentAlarmFor: 0, now }, true],
    ["stale, already alarmed for this stall", { lastCheckAt: stale, silentAlarmFor: stale, now }, false],
    ["recovered then stalled at a new value", { lastCheckAt: stale, silentAlarmFor: stale - 999, now }, true],
  ];
  const bad = cases.filter(([, input, want]) => shouldAlarm(input) !== want).map(([n]) => n);
  out.shouldAlarm = bad.length === 0 && isStale(stale, now) && !isStale(fresh, now) && !isStale(0, now)
    ? "ok (once per stall; silent when never checked or fresh)" : `FAIL ${bad.join(", ")}`;
}

// 26. readPanel exposes the stale flag the panel warns on
{
  const staleRow = { last_check_at: 1000, last_check_ok: 1, updater_version: 1 };
  const pStale = await readPanel({ DB: panelDb({ status: staleRow, policy: null }) }, "b · x");
  const freshRow = { last_check_at: Date.now(), last_check_ok: 1, updater_version: 1 };
  const pFresh = await readPanel({ DB: panelDb({ status: freshRow, policy: null }) }, "b · x");
  const pNone = await readPanel({ DB: panelDb({ status: null, policy: null }) }, "b · x");
  out.panelStale = pStale.stale === true && pFresh.stale === false && pNone.stale === false
    ? "ok (old last-check stale; fresh and never-checked not)" : `FAIL ${JSON.stringify({ s: pStale.stale, f: pFresh.stale, n: pNone.stale })}`;
}

// ---- migrations before the swap (PM-06, R5) -----------------------------

// 27. isAdditive / parseMigrations: only the survivable forms pass
{
  const additive = [
    "CREATE TABLE IF NOT EXISTS t (id INTEGER)",
    "ALTER TABLE books ADD COLUMN author TEXT NOT NULL DEFAULT ''",
    "CREATE INDEX IF NOT EXISTS ix ON t (id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux ON t (id)",
    "INSERT OR IGNORE INTO t (id) VALUES (1)",
  ];
  const forbidden = [
    "DROP TABLE readers", "DELETE FROM books", "UPDATE books SET title = ''",
    "ALTER TABLE books RENAME COLUMN a TO b", "ALTER TABLE books DROP COLUMN author",
    "CREATE TABLE t (id INTEGER)", // no IF NOT EXISTS → would fail on an existing table
  ];
  const parsed = parseMigrations("-- a comment\nCREATE TABLE IF NOT EXISTS a (x INTEGER);\n\nALTER TABLE a ADD COLUMN y TEXT;\n");
  out.migAdditive = additive.every(isAdditive) && !forbidden.some(isAdditive) &&
    parsed.length === 2 && /^CREATE TABLE/.test(parsed[0]) && /^ALTER TABLE/.test(parsed[1])
    ? "ok (additive forms pass, DROP/DELETE/UPDATE/rename refused; parse splits + strips comments)"
    : `FAIL additive=${additive.map(isAdditive)} forbidden=${forbidden.map(isAdditive)} parsed=${JSON.stringify(parsed)}`;
}

// 28. runMigrations: additive-only, idempotent (a duplicate column is a
// migration already applied), a real error throws, a non-additive refuses
{
  const ran = [];
  const mkDb = (fail) => ({ prepare(sql) { return { async run() { ran.push(sql); if (fail && fail(sql)) throw new Error(fail(sql)); return { meta: { changes: 1 } }; } }; } });
  ran.length = 0;
  await runMigrations(mkDb(), ["CREATE TABLE IF NOT EXISTS a (x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT NOT NULL DEFAULT ''"]);
  const bothRan = ran.length === 2;
  // a duplicate-column error is swallowed (already applied on this instance)
  ran.length = 0;
  let idem = true;
  try { await runMigrations(mkDb((s) => /ADD COLUMN/.test(s) ? "duplicate column name: y" : null), ["ALTER TABLE a ADD COLUMN y TEXT"]); } catch { idem = false; }
  // a real error throws (the swap must not proceed)
  let realThrew = false;
  try { await runMigrations(mkDb(() => "no such table: a"), ["ALTER TABLE a ADD COLUMN z TEXT"]); } catch { realThrew = true; }
  // a non-additive statement is refused before it runs
  ran.length = 0;
  let refused = false;
  try { await runMigrations(mkDb(), ["DROP TABLE readers"]); } catch (e) { refused = /non-additive/.test(e.message); }
  out.runMigrations = bothRan && idem && realThrew && refused && ran.length === 0
    ? "ok (runs additive, swallows duplicate-column, throws on real error, refuses non-additive)"
    : `FAIL both=${bothRan} idem=${idem} real=${realThrew} refused=${refused} ran=${ran.length}`;
}

// 29. install runs migrations BEFORE the swap (R5)
{
  const { manifest, zip } = fixture();
  manifest.migrations = ["ALTER TABLE demo ADD COLUMN c TEXT NOT NULL DEFAULT ''"];
  const order = [];
  const cf = fakeCf({ pre: READER });
  const cfLogged = async (path, init, bearer) => { if (init?.method === "PUT") order.push("put"); return cf(path, init, bearer); };
  const db = { prepare(sql) { return { async run() { order.push("migrate"); return { meta: { changes: 1 } }; } }; } };
  const fetchFn = async () => ({ ok: true, arrayBuffer: async () => zip });
  await install({ manifest, cf: cfLogged, script: "bookworm", fetchFn, db });
  out.migBeforeSwap = order.includes("migrate") && order.includes("put") && order.indexOf("migrate") < order.indexOf("put")
    ? "ok (migration ran before the PUT)" : `FAIL ${JSON.stringify(order)}`;
}

// ---- the owner's other two pushes (PM-09) -------------------------------

// 30. runInstall records the NOTIFY verdict for the reader to push, and clears
// it on any other action — the updater writes, it never pushes
{
  // notify mode: decide → notify, notify_version set, attention 0, no install
  const nState = { policy: { mode: "notify", soak_days: 0, install_now_version: "" }, lastInstall: {}, lock: { held_at: 0 }, readerKey: "hk" };
  let installed = false;
  const nDeps = { cf: async () => ({}), fetchReader: readerAt("old · x"), install: async () => { installed = true; return {}; } };
  const rn = await runInstall({ env: { DB: cronDb(nState), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, manifest: MAN, now: 2_000_000_000_000, deps: nDeps });
  const notifyOk = rn.action === "notify" && !installed && nState.notify?.version === "new · x" && nState.notify.attention === 0;

  // automatic + requiresAttention: decide downgrades to notify, attention 1
  const aState = { policy: { mode: "automatic", soak_days: 0, install_now_version: "" }, lastInstall: {}, lock: { held_at: 0 }, readerKey: "hk" };
  const ra = await runInstall({ env: { DB: cronDb(aState), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, manifest: { ...MAN, requiresAttention: true }, now: 2_000_000_000_000, deps: { cf: async () => ({}), fetchReader: readerAt("old · x"), install: async () => ({}) } });
  const attnOk = ra.action === "notify" && aState.notify?.version === "new · x" && aState.notify.attention === 1;

  // an INSTALL decision clears any pending notify (version "", attention 0)
  const iState = { policy: { mode: "automatic", soak_days: 0, install_now_version: "new · x" }, lastInstall: {}, lock: { held_at: 0 }, readerKey: "hk" };
  await runInstall({ env: { DB: cronDb(iState), CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" }, manifest: MAN, now: 2_000_000_000_000, deps: { cf: async () => ({}), fetchReader: readerAt("old · x"), install: async (o) => { await o.recordOutcome({ at: o.now, version: o.manifest.version, outcome: "ok", detail: "" }); return { outcome: "ok" }; } } });
  const clearOk = iState.notify?.version === "" && iState.notify.attention === 0;

  out.cronRecordsNotify = notifyOk && attnOk && clearOk
    ? "ok (notify sets version+attention; install clears it; never pushes)"
    : `FAIL notify=${JSON.stringify(nState.notify)} attn=${JSON.stringify(aState.notify)} clear=${JSON.stringify(iState.notify)} installed=${installed}`;
}

// 31. the reader's send-once predicates: waiting-for-you and install-failed
{
  const waitCases = [
    ["nothing waiting", { notifyVersion: "", notifySentFor: "" }, false],
    ["waiting, not yet sent", { notifyVersion: "v2", notifySentFor: "" }, true],
    ["already sent this version", { notifyVersion: "v2", notifySentFor: "v2" }, false],
    ["a new version now waits", { notifyVersion: "v3", notifySentFor: "v2" }, true],
  ];
  const instCases = [
    ["fresh install, nothing recorded", { result: "", installAt: 0, installAlarmFor: 0 }, false],
    ["ok install", { result: "ok", installAt: 500, installAlarmFor: 0 }, false],
    ["rolled-back, not yet rung", { result: "rolled-back", installAt: 500, installAlarmFor: 0 }, true],
    ["failed, not yet rung", { result: "failed", installAt: 500, installAlarmFor: 0 }, true],
    ["already rung this attempt", { result: "rolled-back", installAt: 500, installAlarmFor: 500 }, false],
    ["a newer attempt failed", { result: "failed", installAt: 700, installAlarmFor: 500 }, true],
  ];
  const wBad = waitCases.filter(([, i, w]) => shouldNotifyWaiting(i) !== w).map(([n]) => n);
  const iBad = instCases.filter(([, i, w]) => shouldAnnounceInstall(i) !== w).map(([n]) => n);
  out.senderPredicates = wBad.length === 0 && iBad.length === 0
    ? "ok (waiting rings once per version; install-failed once per non-ok attempt)"
    : `FAIL waiting=[${wBad.join(", ")}] install=[${iBad.join(", ")}]`;
}

// 32. readPanel exposes the waiting state so /admin says why nothing installed
{
  const waitRow = { last_check_at: Date.now(), last_check_ok: 1, updater_version: 1, notify_version: "v9 · x", notify_attention: 1 };
  const pWait = await readPanel({ DB: panelDb({ status: waitRow, policy: null }) }, "v8 · x");
  const pNone = await readPanel({ DB: panelDb({ status: { last_check_at: Date.now(), notify_version: "" }, policy: null }) }, "v8 · x");
  out.panelWaiting = pWait.waiting.version === "v9 · x" && pWait.waiting.attention === true && pNone.waiting.version === "" && pNone.waiting.attention === false
    ? "ok (waiting version + attention surfaced; empty when none)" : `FAIL ${JSON.stringify({ w: pWait.waiting, n: pNone.waiting })}`;
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
