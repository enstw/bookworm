#!/usr/bin/env node
// The one-shot bootstrap (PM-10) against fakes — no account, no network. It
// stands up an instance end to end live in scripts/pm10 proofs; here the
// orchestration is pinned statement by statement: what it creates, in what
// order, with which bindings, and what it deliberately does NOT set (the
// updater's CF_API_TOKEN — the instance comes up unarmed).
//
//   node scripts/test-bootstrap.mjs

import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { bootstrap, putScript } from "../src/bootstrap-core.mjs";
import { parseMigrations } from "../src/migrations.mjs";

const out = {};
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const cfhash = (b, p) => "0".repeat(32); // uploadAssets keys on this; empty buckets means it is never looked up

// a minimal reader release: worker.js + one asset, a zip that matches
function fixture() {
  const worker = Buffer.from("export default { fetch(){ return new Response('ok'); } }");
  const app = Buffer.from("// app");
  const zip = Buffer.from(zipSync({ "worker.js": worker, "public/app.js": app }, { level: 0 }));
  const manifest = {
    version: "boot · x",
    worker: { file: "worker.js", sha256: sha256(worker), size: worker.length },
    assets: [{ path: "/app.js", file: "public/app.js", sha256: sha256(app), cfhash: cfhash(app, "/app.js"), size: app.length }],
    bundle: { url: "https://example/bundle.zip", sha256: sha256(zip), size: zip.length },
    compatibility_date: "2026-06-01", compatibility_flags: [],
    assetsConfig: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  };
  return { manifest, zip };
}

// A fake Cloudflare API that records what bootstrap() does. `d1Exists` /
// `ownerExists` steer the idempotency branches; `putFailFirst` makes the first
// script PUT answer the transient 10021 so the retry can be observed.
function fakeCf(opts = {}) {
  const existing = opts.existing ?? {}; // script name → [secret names] it already holds
  const rec = { d1Created: 0, r2Created: 0, schema: 0, put: {}, secrets: {}, schedules: {}, subdomain: [], insertedKey: null, uploadSession: 0, putAttempts: 0 };
  let putFails = opts.putFailFirst ? 1 : 0;
  const cf = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body;
    // D1 lifecycle
    if (path.startsWith("/d1/database?name=")) return opts.d1Exists ? [{ name: "bookworm", uuid: "existing-d1" }] : [];
    if (path === "/d1/database" && method === "POST") { rec.d1Created++; return { uuid: "new-d1" }; }
    if (/^\/d1\/database\/[^/]+\/query$/.test(path)) {
      const sql = JSON.parse(body).sql;
      if (/^SELECT key FROM readers/.test(sql)) return [{ results: opts.ownerExists ? [{ key: "old-owner-key" }] : [] }];
      if (/^INSERT INTO readers/.test(sql)) { rec.insertedKey = JSON.parse(body).params; return [{ results: [] }]; }
      rec.schema++; return [{ results: [] }];
    }
    // R2
    if (path === "/r2/buckets" && method === "POST") {
      if (opts.r2Exists) throw new Error("PUT /r2/buckets → 400 The bucket you tried to create already exists (10004)");
      rec.r2Created++; return {};
    }
    // does the script exist? (scriptExists → GET /settings)
    const settings = path.match(/^\/workers\/scripts\/([^/]+)\/settings$/);
    if (settings && method === "GET") {
      if (settings[1] in existing) return { bindings: [] };
      throw new Error("GET /settings → 404 workers.api.error.script_not_found (10007)");
    }
    // its existing secrets (listSecretNames → GET /secrets)
    const secGet = path.match(/^\/workers\/scripts\/([^/]+)\/secrets$/);
    if (secGet && method === "GET") return (existing[secGet[1]] ?? []).map((name) => ({ name }));
    // assets upload session — empty buckets, so nothing is uploaded and the
    // completion token is the session jwt (a base64url payload verifyBundle-free)
    if (/assets-upload-session$/.test(path)) { rec.uploadSession++; return { jwt: "a.eyJ4IjoxfQ.b", buckets: [] }; }
    // script PUT (multipart) — capture the metadata, and honour putFailFirst
    const put = path.match(/^\/workers\/scripts\/([^/]+)$/);
    if (put && method === "PUT") {
      rec.putAttempts++;
      if (putFails > 0) { putFails--; throw new Error("PUT → 400 binding DB of type d1 failed to generate (10021)"); }
      const meta = JSON.parse(await body.get("metadata").text());
      rec.put[put[1]] = meta;
      return {};
    }
    const sec = path.match(/^\/workers\/scripts\/([^/]+)\/secrets$/);
    if (sec && method === "PUT") { (rec.secrets[sec[1]] ??= []).push(JSON.parse(body).name); return {}; }
    const sch = path.match(/^\/workers\/scripts\/([^/]+)\/schedules$/);
    if (sch && method === "PUT") { rec.schedules[sch[1]] = JSON.parse(body).map((c) => c.cron); return {}; }
    if (/\/subdomain$/.test(path) && method === "POST") { rec.subdomain.push(path); return {}; }
    if (path === "/workers/subdomain") return { subdomain: "testsub" };
    throw new Error(`fakeCf: unhandled ${method} ${path}`);
  };
  return { cf, rec };
}

const base = (extra = {}) => {
  const { manifest, zip } = fixture();
  return {
    names: { reader: "bookworm", updater: "bookworm-updater", d1: "bookworm", r2: "bookworm-books" },
    readerManifest: manifest,
    schemaStatements: ["CREATE TABLE IF NOT EXISTS a (x)", "INSERT OR IGNORE INTO a VALUES (1)"],
    updaterSource: "export default { async scheduled(){} }",
    readerCrons: ["* * * * *"], updaterCrons: ["*/15 * * * *"], updaterFlags: ["nodejs_compat"],
    upstreamUrl: "https://up/", secrets: { ADMIN_TOKEN: "adm", VAPID_PRIVATE_JWK: "{}", VAPID_SUBJECT: "mailto:x" },
    now: 111, mintKey: () => "fresh-key",
    fetchFn: async () => ({ ok: true, arrayBuffer: async () => zip }),
    ...extra,
  };
};

// 1. a fresh account: creates D1 + R2, applies schema, both scripts, secrets,
// crons, subdomain, and mints the owner key
{
  const { cf, rec } = fakeCf();
  const r = await bootstrap({ cf, ...base() });
  const reader = rec.put.bookworm, updater = rec.put["bookworm-updater"];
  const readerBinds = Object.fromEntries(reader.bindings.map((b) => [b.type, b]));
  const updaterBinds = Object.fromEntries(updater.bindings.map((b) => [b.type, b]));
  const good =
    rec.d1Created === 1 && rec.r2Created === 1 && rec.schema === 2 &&
    readerBinds.d1?.id === "new-d1" && readerBinds.r2_bucket?.bucket_name === "bookworm-books" && readerBinds.assets?.name === "ASSETS" &&
    !("keep_bindings" in reader) && reader.assets?.jwt && reader.compatibility_date === "2026-06-01" &&
    JSON.stringify(rec.secrets.bookworm?.sort()) === JSON.stringify(["ADMIN_TOKEN", "VAPID_PRIVATE_JWK", "VAPID_SUBJECT"]) &&
    JSON.stringify(rec.schedules.bookworm) === JSON.stringify(["* * * * *"]) &&
    rec.subdomain.length === 1 &&
    updater.compatibility_flags.includes("nodejs_compat") && updaterBinds.service?.service === "bookworm" && updaterBinds.d1 &&
    updaterBinds.plain_text?.name === "READER_SCRIPT" && updaterBinds.plain_text?.text === "bookworm" &&
    JSON.stringify(rec.schedules["bookworm-updater"]) === JSON.stringify(["*/15 * * * *"]) &&
    r.keyMinted === true && r.readerKey === "fresh-key" && r.d1Id === "new-d1";
  out.freshAccount = good ? "ok (D1+R2+schema, reader full bindings, secrets, crons, subdomain, updater w/ service binding, key minted)"
    : `FAIL ${JSON.stringify({ rec, r })}`;
}

// 2. the updater comes up UNARMED — UPSTREAM_URL set, CF_API_TOKEN never
{
  const { cf, rec } = fakeCf();
  await bootstrap({ cf, ...base() });
  const us = rec.secrets["bookworm-updater"] ?? [];
  out.updaterUnarmed = us.includes("UPSTREAM_URL") && !us.includes("CF_API_TOKEN")
    ? "ok (updater secrets = UPSTREAM_URL only)" : `FAIL ${JSON.stringify(us)}`;
}

// 3. idempotent re-run (PM-16): existing D1 reused, existing R2 tolerated, an
// existing owner key left alone — no second database, no new key
{
  const { cf, rec } = fakeCf({ d1Exists: true, r2Exists: true, ownerExists: true });
  const r = await bootstrap({ cf, ...base() });
  out.idempotent = rec.d1Created === 0 && rec.r2Created === 0 && r.d1Id === "existing-d1" && r.keyMinted === false && rec.insertedKey === null
    ? "ok (reuses D1, tolerates existing R2, keeps the owner key)" : `FAIL ${JSON.stringify({ rec, r })}`;
}

// 4. the reader PUT retries the transient 10021 (a just-created D1 not yet
// bindable) and then succeeds
{
  let attempts = 0;
  const cf = async (path, init = {}) => {
    if (/^\/workers\/scripts\/[^/]+$/.test(path) && init.method === "PUT") {
      attempts++;
      if (attempts === 1) throw new Error("400 binding DB of type d1 failed to generate (10021)");
      return {};
    }
    throw new Error("unexpected");
  };
  await putScript(cf, "s", "worker.js", Buffer.from("x"), { main_module: "worker.js" }, { waitMs: 1, sleep: () => Promise.resolve() });
  out.putRetries = attempts === 2 ? "ok (10021 retried, then succeeded)" : `FAIL attempts=${attempts}`;
}

// 5. schema.sql splits cleanly for the bootstrap. The bootstrap applies it
// statement-by-statement over the D1 query API, split on ';' (parseMigrations),
// the same simple shape the deploy uses — so schema.sql must carry no compound
// statement whose body has internal semicolons (CREATE TRIGGER/VIEW) that a
// naive split would mangle, and every statement must be one the deploy also
// runs: CREATE … IF NOT EXISTS, INSERT OR IGNORE, or the one deliberate DELETE
// (the feedback-queue drain that re-applying this file performs, by design).
{
  const schema = (await import("node:fs")).readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const stmts = parseMigrations(schema);
  const KNOWN = /^(CREATE TABLE IF NOT EXISTS |CREATE (UNIQUE )?INDEX IF NOT EXISTS |INSERT OR IGNORE INTO |DELETE FROM )/i;
  const compound = /\bCREATE\s+(TRIGGER|VIEW)\b/i.test(schema);
  const stray = stmts.filter((s) => !KNOWN.test(s));
  out.schemaBootstrapSafe = stmts.length > 0 && !compound && stray.length === 0
    ? `ok (${stmts.length} statements split clean; no TRIGGER/VIEW to mangle)`
    : `FAIL compound=${compound} stray=${JSON.stringify(stray)}`;
}

// 6. update-the-updater (PM-16): only:"updater" touches JUST the updater — no
// reader PUT, no reader secrets, no subdomain, no key — and keeps the updater's
// secrets (keep_bindings), so an armed updater stays armed
{
  const { cf, rec } = fakeCf({ d1Exists: true, existing: { "bookworm-updater": ["UPSTREAM_URL", "CF_API_TOKEN"] } });
  const r = await bootstrap({ cf, ...base({ only: "updater" }) });
  const updater = rec.put["bookworm-updater"];
  const touchedReader = ("bookworm" in rec.put) || rec.subdomain.length > 0 || rec.insertedKey !== null || rec.r2Created > 0 || rec.schema > 0;
  out.updaterOnly =
    !touchedReader && updater && updater.keep_bindings?.includes("secret_text") &&
    !(rec.secrets["bookworm-updater"] ?? []).includes("UPSTREAM_URL") && // already present → not re-set
    r.updaterReplaced === true && r.updaterArmed === true && r.mode === "updater"
    ? "ok (updater-only: reader/D1/R2/key untouched, secrets kept, stays armed)"
    : `FAIL ${JSON.stringify({ rec, r })}`;
}

// 7. a full re-run preserves secrets: existing scripts are PUT with
// keep_bindings and their already-set secrets are not rotated
{
  const { cf, rec } = fakeCf({
    d1Exists: true, r2Exists: true, ownerExists: true,
    existing: { bookworm: ["ADMIN_TOKEN", "VAPID_PRIVATE_JWK", "VAPID_SUBJECT"], "bookworm-updater": ["UPSTREAM_URL"] },
  });
  await bootstrap({ cf, ...base() });
  out.rerunKeepsSecrets =
    rec.put.bookworm?.keep_bindings?.includes("secret_text") &&
    (rec.secrets.bookworm ?? []).length === 0 &&              // no reader secret re-set
    (rec.secrets["bookworm-updater"] ?? []).length === 0 &&   // UPSTREAM_URL already there
    rec.insertedKey === null
    ? "ok (existing scripts keep_bindings; no secret rotated, no key re-minted)"
    : `FAIL ${JSON.stringify(rec)}`;
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
