#!/usr/bin/env node
// bookworm-updater's read-only check, and the properties that make the split
// safe (PM-04). Pure node: checkOnce takes a store and a fetch seam, so the
// whole thing runs against an in-memory row and a fake upstream — no wrangler,
// no account, no D1.
//
//   node scripts/test-updater.mjs

import { readFileSync } from "node:fs";
import { checkOnce, d1Store, UPDATER_VERSION } from "../src/updater-core.mjs";

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

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
