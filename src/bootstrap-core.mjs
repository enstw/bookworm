// The one-shot bootstrap (PM-10), core logic. Turns an EMPTY Cloudflare
// account into a working instance: create D1 and R2, apply the schema, place
// the reader Worker and its 12 MB of `public/`, place the cron-only updater,
// set the secrets, mint the owner's first key. No fork, no Actions, no clone —
// the reader bundle comes from the published release (the same artifact the
// updater installs), and the updater source + schema ride in the bootstrap
// itself (scripts/bootstrap.mjs bakes them in at package time).
//
// Why a laptop and not the updater: the 12 MB first install does not fit in a
// scheduled invocation's CPU budget (R8), and this is the one moment a human
// and a laptop are present anyway. The updater keeps the ~200 KB incremental
// path it runs three orders of magnitude inside that budget.
//
// The token this runs under is BROADER than the updater's: it creates D1, R2
// and two Workers, where the updater's only edits the reader script. It is a
// one-time credential — the owner can delete it the moment the bootstrap
// returns, and deliberately does NOT install it as the updater's CF_API_TOKEN.
// The instance comes up UNARMED (no automatic updates) until the owner sets
// that secret themselves (the plan's arming step).
//
// Idempotent by construction, because PM-16 re-runs it to replace the updater
// in place: find-or-create for D1/R2, CREATE IF NOT EXISTS schema, and a reader
// key minted only when none exists. A re-run leaves D1, R2 and every secret
// alone and simply re-PUTs the two scripts.

import { verifyBundle, uploadAssets } from "./updater-core.mjs";

const randHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

// --- account resources (create if absent; never destroy) --------------------

// D1: match by name so a re-run reuses the instance's own database rather than
// stranding its books behind a second one.
async function ensureD1(cf, name, log) {
  const list = await cf(`/d1/database?name=${encodeURIComponent(name)}`);
  const found = (Array.isArray(list) ? list : list.databases ?? []).find((d) => d.name === name);
  if (found?.uuid) { log?.(`  D1 ${name} exists (${found.uuid})`); return found.uuid; }
  const made = await cf(`/d1/database`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  log?.(`  D1 ${name} created (${made.uuid})`);
  return made.uuid;
}

// R2: creating an existing bucket answers 10004; that is "already there", not a
// failure, so a re-run is a no-op rather than an error.
async function ensureR2(cf, name, log) {
  try {
    await cf(`/r2/buckets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    log?.(`  R2 ${name} created`);
  } catch (err) {
    if (/already exists|10004/i.test(String(err?.message ?? err))) { log?.(`  R2 ${name} exists`); return; }
    throw err;
  }
}

// The schema, statement by statement over the D1 query API. Every statement is
// CREATE … IF NOT EXISTS / INSERT OR IGNORE (schema.sql's shape), so this is
// safe to re-run — a bootstrap re-run adds nothing and drops nothing.
async function applySchema(cf, d1Id, statements, log) {
  for (const sql of statements)
    await cf(`/d1/database/${d1Id}/query`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }),
    });
  log?.(`  schema applied (${statements.length} statements)`);
}

// --- scripts ----------------------------------------------------------------

// A module-Worker PUT: multipart of the metadata plus the one bundled module.
// Same shape install() uses for the swap; here it CREATES the script (fresh
// bindings, no keep_bindings — there is nothing on the account to keep yet).
// A just-created D1 can lag before it is bindable — Cloudflare answers 10021
// "binding … failed to generate … try again later" — so a PUT that names a
// brand-new D1 is retried on exactly that transient. The multipart body is
// rebuilt each attempt because a sent FormData is spent.
export async function putScript(cf, script, moduleFile, moduleBytes, metadata, { tries = 6, waitMs = 4000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    const fd = new FormData();
    fd.append("metadata", new File([JSON.stringify(metadata)], "metadata.json", { type: "application/json" }));
    fd.append(moduleFile, new File([moduleBytes], moduleFile, { type: "application/javascript+module" }), moduleFile);
    try {
      await cf(`/workers/scripts/${script}`, { method: "PUT", body: fd });
      return;
    } catch (err) {
      if (i < tries - 1 && /failed to generate|10021/i.test(String(err?.message ?? err))) { await sleep(waitMs); continue; }
      throw err;
    }
  }
}

// Secrets go on AFTER the create, one PUT each — the shape the updater's
// keep_bindings then preserves on every future swap (R4). A secret is never a
// binding in the metadata above, so it is never sent (and so never cleared) by
// an update.
async function putSecret(cf, script, name, text) {
  await cf(`/workers/scripts/${script}/secrets`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, text, type: "secret_text" }),
  });
}

// Does the script already exist? A re-run (PM-16, replacing the updater) must
// keep the secrets a fresh create sets; a create must not. The settings
// endpoint answers 404/10007 for a script the account has never seen.
async function scriptExists(cf, script) {
  try { await cf(`/workers/scripts/${script}/settings`); return true; }
  catch (err) { if (/10007|not found|404/i.test(String(err?.message ?? err))) return false; throw err; }
}
const listSecretNames = async (cf, script) => (await cf(`/workers/scripts/${script}/secrets`) ?? []).map((s) => s.name);

// Cron triggers are their own endpoint, not script metadata.
async function putSchedules(cf, script, crons) {
  await cf(`/workers/scripts/${script}/schedules`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify((crons ?? []).map((cron) => ({ cron }))),
  });
}

// Give the reader a URL. The account's workers.dev subdomain is enabled once
// per account (a human step on a brand-new account); this turns it on for the
// reader script so `public/` is actually reachable. The updater gets no
// subdomain — it is cron-only and a Worker cannot fetch workers.dev anyway
// (error 1042, PM-00); it reaches the reader through the service binding.
async function enableSubdomain(cf, script, log) {
  await cf(`/workers/scripts/${script}/subdomain`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  let host = "";
  try { host = (await cf(`/workers/subdomain`))?.subdomain ?? ""; } catch { /* new account may not have one */ }
  const url = host ? `https://${script}.${host}.workers.dev` : "";
  log?.(`  ${script} subdomain enabled${url ? ` → ${url}` : ""}`);
  return url;
}

// Mint the owner's first reader key, but only if the account has none — a
// re-run (PM-16) must not spray new keys. is_owner = 1, so this key is the one
// the owner-only pushes (PM-09) reach.
async function ensureOwnerKey(cf, d1Id, { now, mintKey, log }) {
  const existing = await cf(`/d1/database/${d1Id}/query`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT key FROM readers WHERE is_owner = 1 LIMIT 1" }),
  });
  const had = existing?.[0]?.results?.[0]?.key;
  if (had) { log?.("  owner key already present — leaving it"); return { key: had, minted: false }; }
  const key = mintKey();
  await cf(`/d1/database/${d1Id}/query`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sql: "INSERT INTO readers (key, user, label, created_at, is_owner) VALUES (?, 'owner', 'first key (bootstrap)', ?, 1)",
      params: [key, now],
    }),
  });
  log?.("  owner key minted");
  return { key, minted: true };
}

// The whole bootstrap. `cf` is the Cloudflare API bound to the broad one-time
// token and the account (path relative to /accounts/{id}); `fetchFn` downloads
// the reader bundle. Everything else is passed in so scripts/test-bootstrap.mjs
// can drive it against fakes and pm10-e2e can drive it against a throwaway
// account with throwaway names.
// `only: "updater"` is PM-16's update-the-updater: re-place JUST the updater
// script from a newer bootstrap, leaving the reader, D1, R2 and every secret
// alone — the remedy for a release the running updater refused on
// minUpdaterVersion. The default ("full") is PM-10's whole first install.
//
// A re-run of either preserves secrets: a script that already exists is PUT
// with keep_bindings for its secret types (so ADMIN_TOKEN, the VAPID pair,
// UPSTREAM_URL and — if the owner armed it — CF_API_TOKEN survive the swap,
// R4), and a secret that is already set is not re-set, so nothing rotates and
// an armed updater stays armed.
export async function bootstrap({
  cf, fetchFn = fetch, names, readerManifest, schemaStatements, updaterSource,
  readerCrons, updaterCrons, updaterFlags = ["nodejs_compat"], upstreamUrl,
  secrets = {}, now = 0, mintKey = () => randHex(16), only = "full", log,
}) {
  // the shared D1 both scripts bind — created on a first install, found on a
  // re-run (never a second database)
  const d1Id = await ensureD1(cf, names.d1, log);

  let readerUrl = "", uploaded = 0, owner = { key: "", minted: false };
  if (only !== "updater") {
    await ensureR2(cf, names.r2, log);
    await applySchema(cf, d1Id, schemaStatements, log);

    // the reader bundle — from the published release, verified against its
    // manifest before a byte of it is uploaded (download integrity; TLS to
    // upstream is the trust anchor, the plan's trust section)
    const res = await fetchFn(readerManifest.bundle.url, { cache: "no-store", redirect: "follow" });
    if (!res.ok) throw new Error(`reader bundle HTTP ${res.status}`);
    const files = await verifyBundle(readerManifest, new Uint8Array(await res.arrayBuffer()));

    // upload assets, then place the reader with FULL bindings — its own D1 id
    // and bucket name and the assets token. On a first install nothing is kept;
    // on a re-run its secrets are kept and not re-set.
    const readerExisted = await scriptExists(cf, names.reader);
    const { completion, uploaded: u } = await uploadAssets({ cf, script: names.reader, manifest: readerManifest, files });
    uploaded = u;
    await putScript(cf, names.reader, readerManifest.worker.file, files[readerManifest.worker.file], {
      main_module: readerManifest.worker.file,
      compatibility_date: readerManifest.compatibility_date,
      compatibility_flags: readerManifest.compatibility_flags ?? [],
      bindings: [
        { type: "d1", name: "DB", id: d1Id },
        { type: "r2_bucket", name: "BOOKS", bucket_name: names.r2 },
        { type: "assets", name: "ASSETS" },
      ],
      ...(readerExisted ? { keep_bindings: ["secret_text", "secret_key"] } : {}),
      assets: { jwt: completion, config: readerManifest.assetsConfig },
      observability: { enabled: true },
    });
    const have = readerExisted ? await listSecretNames(cf, names.reader) : [];
    for (const [name, text] of Object.entries(secrets)) if (!have.includes(name)) await putSecret(cf, names.reader, name, text);
    await putSchedules(cf, names.reader, readerCrons);
    readerUrl = await enableSubdomain(cf, names.reader, log);
    log?.(`  reader ${names.reader} up (${uploaded} assets${readerExisted ? ", secrets kept" : ""})`);

    owner = await ensureOwnerKey(cf, d1Id, { now, mintKey, log });
  }

  // the updater: the bundled source baked into the bootstrap, its D1 binding
  // (the shared row it writes and the reader reads) and the READER service
  // binding pointed at THIS reader's script name. On a first install UPSTREAM_URL
  // is set and CF_API_TOKEN deliberately absent (unarmed); on a re-run both are
  // kept, so updating the updater neither loses its config nor disarms it.
  const updaterExisted = await scriptExists(cf, names.updater);
  await putScript(cf, names.updater, "updater.js", updaterSource, {
    main_module: "updater.js",
    compatibility_date: readerManifest.compatibility_date,
    compatibility_flags: updaterFlags,
    bindings: [
      { type: "d1", name: "DB", id: d1Id },
      { type: "service", name: "READER", service: names.reader },
    ],
    ...(updaterExisted ? { keep_bindings: ["secret_text", "secret_key"] } : {}),
    observability: { enabled: true },
  });
  const updaterHave = updaterExisted ? await listSecretNames(cf, names.updater) : [];
  if (!updaterHave.includes("UPSTREAM_URL")) await putSecret(cf, names.updater, "UPSTREAM_URL", upstreamUrl);
  await putSchedules(cf, names.updater, updaterCrons);
  const armed = updaterHave.includes("CF_API_TOKEN");
  log?.(`  updater ${names.updater} ${updaterExisted ? "replaced" : "up"} (${armed ? "armed — kept CF_API_TOKEN" : "unarmed — no CF_API_TOKEN"})`);

  return { d1Id, readerUrl, readerKey: owner.key, keyMinted: owner.minted, uploaded, updaterReplaced: updaterExisted, updaterArmed: armed, mode: only };
}
