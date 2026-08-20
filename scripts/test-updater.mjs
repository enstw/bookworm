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
import { checkOnce, d1Store, UPDATER_VERSION, verifyBundle, buildMetadata, install } from "../src/updater-core.mjs";

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
  eq("goodResult", r, { ok: true, version: MANIFEST.version });
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

// 14. install() is built but NOT wired into the cron — the credential and the
// trigger wait for the safety net (PM-07 rollback, PM-15 policy). The entry's
// scheduled handler must still call only checkOnce.
{
  const entry = readFileSync(new URL("../src/updater.js", import.meta.url), "utf8");
  out.installNotArmed = /checkOnce\(/.test(entry) && !/\binstall\(/.test(entry)
    ? "ok (cron checks only; install not auto-invoked)" : "FAIL the cron calls install()";
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
