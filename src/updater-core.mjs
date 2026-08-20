// The testable core of bookworm-updater (see src/updater.js for the entry and
// the split's rationale). Kept out of the entry module because a Worker's
// entry may export only handlers — workerd rejects a plain `export const` from
// it — and because a plain function behind a seam is testable with no wrangler,
// no account, no D1 (scripts/test-updater.mjs).

import { unzipSync } from "fflate";
import { Buffer } from "node:buffer";

// The updater's own version, an integer, deliberately separate from the
// reader's git BUILD stamp. A release's manifest carries minUpdaterVersion
// (PM-16); an updater below it refuses rather than half-installs. /admin shows
// this beside the running and upstream versions (PM-08), so a refusal names a
// number the owner can look up.
export const UPDATER_VERSION = 1;

// UPSTREAM_URL is `…/releases/latest/download/` — a stable URL whose contents
// change every release, so the one manifest we read must never come from cache
// (the plan's "Where it is published").
function manifestUrl(base) {
  return (base.endsWith("/") ? base : base + "/") + "manifest.json";
}

// D1-backed storage for the single status row. Split from the logic so the
// check can be tested against an in-memory store — the house preference for a
// seam over a mock.
export function d1Store(env) {
  return {
    async read() {
      return env.DB.prepare(
        `SELECT last_check_at, last_check_ok, upstream_version, upstream_released_at, detail
         FROM updater_status WHERE id = 1`,
      ).first();
    },
    async write(row) {
      await env.DB.prepare(
        `INSERT INTO updater_status
           (id, last_check_at, last_check_ok, upstream_version, upstream_released_at, detail)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           last_check_at = excluded.last_check_at,
           last_check_ok = excluded.last_check_ok,
           upstream_version = excluded.upstream_version,
           upstream_released_at = excluded.upstream_released_at,
           detail = excluded.detail`,
      ).bind(
        row.last_check_at, row.last_check_ok,
        row.upstream_version, row.upstream_released_at, row.detail,
      ).run();
    },
  };
}

// One check: read the manifest, record what upstream offers. Read-only and
// side-effect-free by construction — it is the "check", not the "install", and
// the two run at different rates for exactly that reason. On any failure the
// last KNOWN-GOOD upstream version is kept (only last_check_at/ok/detail move),
// so a transient upstream outage downgrades the panel to "checked N ago,
// failed" rather than erasing what it last saw. `now` and `fetchFn` are
// parameters so the test can pin the clock and stand in a fake upstream;
// production passes Date.now() and the global fetch.
export async function checkOnce({ upstreamUrl, store, now, fetchFn = fetch }) {
  const prev = await store.read();
  const keep = {
    upstream_version: prev?.upstream_version ?? "",
    upstream_released_at: prev?.upstream_released_at ?? "",
  };
  const fail = async (detail) => {
    await store.write({ last_check_at: now, last_check_ok: 0, ...keep, detail });
    return { ok: false, detail };
  };

  if (!upstreamUrl) return fail("UPSTREAM_URL 未設定");
  // TLS is the entire trust anchor (the plan's trust section), so a non-https
  // URL is refused here rather than fetched — the same rule the install path
  // will enforce before it uploads anything.
  if (!upstreamUrl.startsWith("https://")) return fail("UPSTREAM_URL 必須是 https://");

  let manifest;
  try {
    const res = await fetchFn(manifestUrl(upstreamUrl), {
      // `latest/download` is a stable URL with changing contents, so a cached
      // copy is indistinguishable from "no new release". `cache: "no-store"`
      // is the Workers-supported way to bypass the cache entirely; it cannot
      // be combined with a `cf.cacheTtl` (the runtime rejects the pair), so it
      // stands alone with the request header as belt-and-braces.
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!res.ok) return fail(`manifest HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    return fail(String(err?.message ?? err).slice(0, 200));
  }
  if (typeof manifest?.version !== "string" || !manifest.version)
    return fail("manifest 缺少 version");

  await store.write({
    last_check_at: now,
    last_check_ok: 1,
    upstream_version: manifest.version,
    upstream_released_at: typeof manifest.released_at === "string" ? manifest.released_at : "",
    detail: "",
  });
  return { ok: true, version: manifest.version };
}

// ---- the install path (PM-05) -------------------------------------------
//
// The updater's one risky act: rewrite the reader Worker to a new release.
// Everything below is portable between the Workers runtime and node (the
// live proof in the deploy runs it in the Worker; scripts/test-updater.mjs
// runs the pieces in node), which is why fflate and node:buffer are imported
// rather than assumed global.
//
// NOT yet wired into the cron: the scheduled handler only checks. Automatic
// installation waits for the health check and rollback that protect it
// (PM-07) and the policy that decides when (PM-15) — the credential and the
// trigger arrive together with the safety net, never before it.

const MIME = {
  js: "application/javascript", mjs: "application/javascript", css: "text/css",
  html: "text/html", json: "application/json", woff2: "font/woff2",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml",
  wasm: "application/wasm", webmanifest: "application/manifest+json",
  txt: "text/plain", ico: "image/x-icon", map: "application/json", md: "text/markdown",
};
const contentTypeFor = (p) => MIME[p.slice(p.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
function decodeJwt(jwt) {
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload, "base64").toString());
}

// Verify a downloaded bundle against its manifest and return the unzipped
// files. This is download integrity, not source authenticity — it catches a
// truncated or corrupt release, never proves the manifest genuine (TLS to
// upstream is the trust anchor, the plan's trust section). Throws on any
// mismatch, before a byte of it reaches the script.
export async function verifyBundle(manifest, zipBytes) {
  if ((await sha256Hex(zipBytes)) !== manifest.bundle.sha256)
    throw new Error("bundle sha256 mismatch");
  const files = unzipSync(zipBytes);
  const want = new Map([[manifest.worker.file, manifest.worker], ...manifest.assets.map((a) => [a.file, a])]);
  for (const [file, entry] of want) {
    const bytes = files[file];
    if (!bytes) throw new Error(`bundle missing ${file}`);
    if (bytes.length !== entry.size) throw new Error(`${file} size ${bytes.length} ≠ ${entry.size}`);
    if ((await sha256Hex(bytes)) !== entry.sha256) throw new Error(`${file} sha256 mismatch`);
  }
  return files;
}

// The PUT metadata. Only ASSETS is re-declared — it must carry the fresh
// upload token — so every other binding is kept BY TYPE via keep_bindings,
// and the updater never sends (and so can never clear) a value it does not
// hold: the D1 id, the bucket name, ADMIN_TOKEN, the VAPID pair (R4). Compat
// date and flags come from the manifest, never re-typed here (R6). Proven in
// PM-00: keep_bindings composes with the assets token in this one PUT.
export function buildMetadata(manifest, assetsJwt, keepBindingTypes) {
  const assetsBinding = manifest.bindings.find((b) => b.type === "assets");
  if (!assetsBinding) throw new Error("manifest declares no assets binding");
  return {
    main_module: manifest.worker.file,
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags ?? [],
    bindings: [{ type: "assets", name: assetsBinding.name }],
    keep_bindings: keepBindingTypes,
    assets: { jwt: assetsJwt, config: manifest.assetsConfig },
    observability: { enabled: true },
  };
}

const listBindings = async (cf, script) =>
  ((await cf(`/workers/scripts/${script}/settings`)).bindings ?? []).map((b) => ({ type: b.type, name: b.name }));
const listSecrets = async (cf, script) =>
  (await cf(`/workers/scripts/${script}/secrets`) ?? []).map((s) => ({ name: s.name, type: s.type }));

// Install a release onto the reader script. `cf(path, init, bearer?)` is the
// Cloudflare API bound to the updater's token — path relative to
// /accounts/{id}, bearer overriding the token for the asset uploads (they
// carry the session's own JWT). `fetchFn` downloads the bundle. Confirmation
// is CF-API-side on purpose: a Worker cannot fetch the reader over
// workers.dev (error 1042, PM-00), so proving the swap actually SERVES is the
// HTTP health check in PM-07. What this proves is narrower and is R4's Done:
// every binding and secret that was on the script before the PUT is still
// there after it. Throws before the PUT on any verify/claim failure, so a bad
// release never reaches the swap; throws after it if anything was dropped.
export async function install({ manifest, cf, script, fetchFn = fetch }) {
  // the R4 baseline: what is bound before the swap
  const [preBindings, preSecrets] = await Promise.all([listBindings(cf, script), listSecrets(cf, script)]);

  // download and verify BEFORE touching the script
  const res = await fetchFn(manifest.bundle.url, { cache: "no-store", redirect: "follow" });
  if (!res.ok) throw new Error(`bundle HTTP ${res.status}`);
  const files = await verifyBundle(manifest, new Uint8Array(await res.arrayBuffer()));

  // the upload session: Cloudflare answers with only the file hashes it lacks
  // from THIS script's store (PM-00), so a code-only release uploads nothing
  const session = await cf(`/workers/scripts/${script}/assets-upload-session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: Object.fromEntries(manifest.assets.map((a) => [a.path, { hash: a.cfhash, size: a.size }])) }),
  });
  // read the session JWT's claims before uploading anything. When the server
  // sets wrangler_single_asset_uploads it wants one file per request, which
  // breaks the 50-subrequest budget at 42 files — a refusal with a reason,
  // not a fallback (PM-00 fact 2). It is a per-account server-side claim, so
  // it can only be discovered here, at run time.
  const claims = decodeJwt(session.jwt);
  if (claims.wrangler_single_asset_uploads)
    throw new Error("upstream session set wrangler_single_asset_uploads; refusing (see PM-00)");

  // upload each bucket, base64 via Buffer — never chunked btoa, which costs 5×
  // the CPU on the edge core (PM-00). The last response carries the
  // completion token; an empty bucket list leaves it as the session JWT.
  const byHash = new Map(manifest.assets.map((a) => [a.cfhash, a]));
  let completion = session.jwt, uploaded = 0;
  for (const bucket of session.buckets ?? []) {
    const fd = new FormData();
    for (const h of bucket) {
      const a = byHash.get(h);
      if (!a) throw new Error(`session asked for unknown hash ${h}`);
      const bytes = files[a.file];
      if (!bytes) throw new Error(`bundle lacks ${a.file}`);
      fd.append(h, new File([Buffer.from(bytes).toString("base64")], h, { type: contentTypeFor(a.path) }), h);
      uploaded++;
    }
    const r = await cf(`/workers/assets/upload?base64=true`, { method: "POST", body: fd }, session.jwt);
    if (r.jwt) completion = r.jwt;
  }

  // the swap: keep every non-assets binding that is on the script now, by
  // type, and re-declare only ASSETS with the fresh token. Reading the types
  // off the live script rather than a fixed list means the keep set is exactly
  // what exists — nothing stale kept, nothing present dropped.
  const keepBindings = [...new Set(preBindings.filter((b) => b.type !== "assets").map((b) => b.type))];
  const metadata = buildMetadata(manifest, completion, keepBindings);
  const workerBytes = files[manifest.worker.file];
  const fd = new FormData();
  fd.append("metadata", new File([JSON.stringify(metadata)], "metadata.json", { type: "application/json" }));
  fd.append(manifest.worker.file, new File([workerBytes], manifest.worker.file, { type: "application/javascript+module" }), manifest.worker.file);
  await cf(`/workers/scripts/${script}`, { method: "PUT", body: fd });

  // R4's loud test: everything bound before the swap must still be bound after
  const [postBindings, postSecrets] = await Promise.all([listBindings(cf, script), listSecrets(cf, script)]);
  const missing = [
    ...preBindings.filter((b) => !postBindings.some((p) => p.name === b.name && p.type === b.type)).map((b) => `binding ${b.type}:${b.name}`),
    ...preSecrets.filter((s) => !postSecrets.some((p) => p.name === s.name)).map((s) => `secret ${s.name}`),
  ];
  if (missing.length) throw new Error(`install dropped ${missing.join(", ")}`);

  return {
    version: manifest.version,
    uploaded,
    buckets: (session.buckets ?? []).length,
    keptBindings: keepBindings,
    secretsHeld: postSecrets.map((s) => s.name),
  };
}

// ---- health check + rollback (PM-07) ------------------------------------
//
// The safety net install() is not allowed to run without. A bad release is
// unrecoverable by update (R2, the verification code is itself replaced), so
// the only recovery is to put the previous version back — which is what the
// two-Worker split bought (R3) and this spends.

const randHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

// The health key. /api/books is the shelf query that touches the worker, the
// D1 binding, the readers row and the books table in one request, and it is
// what "healthy" means here — but it needs a reader key. The updater mints one
// in the readers table it already writes, granting itself nothing it could not
// already insert. It is a normal reader key: it shows on /admin as the reader
// `updater` and is revocable there like any other, and carries no admin power
// if it leaks. Minted once and reused.
const HEALTH_USER = "updater";
export async function ensureHealthKey(env, mint = () => randHex(16)) {
  const row = await env.DB.prepare(
    "SELECT key FROM readers WHERE user = ? ORDER BY created_at LIMIT 1").bind(HEALTH_USER).first();
  if (row?.key) return row.key;
  const key = mint();
  await env.DB.prepare(
    "INSERT INTO readers (key, user, label, created_at) VALUES (?, ?, ?, ?)")
    .bind(key, HEALTH_USER, "health check (updater)", Date.now()).run();
  return key;
}

// `fetchReader(path, init)` is how the updater reaches the reader. A Worker
// cannot fetch its own instance over workers.dev (error 1042, PM-00), so in
// production this goes through the READER service binding; the node proof uses
// plain fetch to the instance URL. Either way the logic below is identical.
export const readerVia = (env) => (path, init) =>
  env.READER.fetch(new Request("https://reader" + path, init));

// Is the reader healthy? With expectedVersion set, poll /api/version until the
// new BUILD answers first — the swap can take seconds to propagate past the
// PUT, and a check that runs at once reads the OLD worker and calls it green.
// But /api/version is a compiled-in constant: a release that unbound D1 would
// answer it cheerfully. /api/books is the request that actually exercises the
// worker and its D1, so it is the verdict. With expectedVersion null this is a
// single-shot baseline of whatever is live now.
export async function healthCheck({ fetchReader, readerKey, expectedVersion = null, tries = 15, waitMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let versionSeen = null;
  const loops = expectedVersion === null ? 1 : tries;
  for (let i = 0; i < loops; i++) {
    try {
      const r = await fetchReader("/api/version", { headers: { "cache-control": "no-cache" } });
      versionSeen = r.ok ? (await r.json()).build : `http ${r.status}`;
    } catch (err) { versionSeen = String(err?.message ?? err).slice(0, 100); }
    if (expectedVersion === null || versionSeen === expectedVersion) break;
    if (i < loops - 1) await sleep(waitMs);
  }
  if (expectedVersion !== null && versionSeen !== expectedVersion)
    return { ok: false, versionSeen, detail: `version stayed ${versionSeen}, wanted ${expectedVersion}` };
  let booksStatus = 0, booksOk = false;
  try {
    const r = await fetchReader("/api/books", { headers: { "x-reader-key": readerKey, "cache-control": "no-cache" } });
    booksStatus = r.status;
    booksOk = r.ok && Array.isArray((await r.json())?.books);
  } catch (err) {
    return { ok: false, versionSeen, detail: `/api/books threw ${String(err?.message ?? err).slice(0, 80)}` };
  }
  return booksOk ? { ok: true, versionSeen } : { ok: false, versionSeen, detail: `/api/books → ${booksStatus}` };
}

// The version currently deployed, to roll back TO. Read BEFORE the install, so
// the target is the last-known-good, not whatever the failed install left.
export async function currentVersionId(cf, script) {
  const deps = await cf(`/workers/scripts/${script}/deployments`);
  return deps.deployments?.[0]?.versions?.[0]?.version_id ?? null;
}

// Put a previous version back: one POST, script and assets restored together
// (PM-00 fact 4). No bundle is kept on the instance — keeping it would re-run
// the very install path that may be what broke.
export async function rollbackTo(cf, script, versionId, message = "bookworm-updater rollback") {
  return cf(`/workers/scripts/${script}/deployments`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }], annotations: { "workers/message": message } }),
  });
}

// The guarded install: health BEFORE, install, health AFTER, roll back only if
// a WORKING site regressed. The pre-install baseline is not optional — without
// it a site that was already broken oscillates install → red → rollback
// forever, blaming each release for damage that predates it. Records the
// outcome for the panel (PM-08 reads it, including a rolled-back one). This is
// the loop PM-15's policy will fire; nothing calls it automatically yet.
export async function installWithRollback({ manifest, cf, script, fetchReader, readerKey, installFn = install, recordOutcome, now = 0, fetchFn = fetch, sleep }) {
  const preVersionId = await currentVersionId(cf, script);
  const before = await healthCheck({ fetchReader, readerKey, sleep });

  let installErr = null, report = null;
  try {
    report = await installFn({ manifest, cf, script, fetchFn });
  } catch (err) {
    installErr = String(err?.message ?? err);
  }

  // if the install threw we do not trust the version it aimed for, so probe
  // whatever is live; on success, wait for the new BUILD to propagate
  const after = await healthCheck({ fetchReader, readerKey, expectedVersion: installErr ? null : manifest.version, sleep });

  let outcome, rolledBack = false, restored = null, detail = installErr ?? after.detail ?? "";
  if (!installErr && after.ok) {
    outcome = "ok";
    detail = "";
  } else if (!after.ok && before.ok && preVersionId) {
    // the install regressed a working site — put the previous version back
    await rollbackTo(cf, script, preVersionId, `rollback: ${manifest.version} failed health check`);
    restored = await healthCheck({ fetchReader, readerKey, expectedVersion: before.versionSeen, sleep });
    outcome = "rolled-back";
    rolledBack = true;
  } else {
    // install failed but the site is unharmed, or it was already broken and
    // there is nothing better to go back to — either way, no rollback
    outcome = "failed";
  }

  if (recordOutcome) await recordOutcome({ at: now, version: manifest.version, outcome, detail: detail.slice(0, 300) });
  return { outcome, rolledBack, before, after, restored, report, installErr };
}

// ---- deciding whether to install (PM-15) --------------------------------
//
// The decision, separate from how to install (PM-05) and did-it-work (PM-07):
// three modes and one soak number, plus three overrides that are NOT the
// owner's choice. Pure — every input is passed in, so the table test can pin
// the whole matrix — and it decides only; installWithRollback() acts. Nothing
// calls it automatically yet; PM-08 wires it into the cron and stores the
// policy this reads.
//
//   policy  : { mode: "automatic"|"notify"|"pinned", soakDays: number }
//   manifest: { version, released_at, requiresAttention, minUpdaterVersion }
//   lastInstall: { version, result } — updater_status.last_install_* (R: never
//                 auto-retry a version that failed)
//   installNow: the version /admin queued for immediate install, or null
//
// Returns { action, reason }:
//   install — take it now
//   skip    — do nothing (up to date, soaking, pinned, or a failed version)
//   notify  — a new release is waiting for the owner's decision (notify mode,
//             or requiresAttention downgrading automatic)
//   refuse  — cannot install (minUpdaterVersion newer than this updater)
export function decide({ policy, manifest, runningVersion, updaterVersion, lastInstall = {}, installNow = null, now }) {
  const v = manifest.version;
  if (v === runningVersion) return { action: "skip", reason: "up to date" };

  // an updater too old to install the release safely stops — always better
  // than installing half of it (override 2). Even an install-now cannot pass.
  if (Number.isInteger(manifest.minUpdaterVersion) && manifest.minUpdaterVersion > updaterVersion)
    return { action: "refuse", reason: `needs updater v${manifest.minUpdaterVersion}, this is v${updaterVersion}` };

  // the owner asked for THIS version from /admin: a deliberate human choice
  // overrides the soak, the mode, the attention downgrade and the failed-
  // version block (a manual retry is not an automatic one). minUpdaterVersion
  // above already had the last word.
  if (installNow === v) return { action: "install", reason: "install now (owner requested)" };

  // a version that failed to install is never retried automatically, or the
  // next check finds it, installs it, fails, rolls back — forever (override 3)
  if (lastInstall.version === v && lastInstall.result && lastInstall.result !== "ok")
    return { action: "skip", reason: `${v} failed to install; not retried automatically` };

  if (policy.mode === "pinned") return { action: "skip", reason: "pinned" };

  // upstream says a human is needed (a new secret, a non-additive migration):
  // downgrade automatic to notify (override 1)
  if (manifest.requiresAttention) return { action: "notify", reason: "requires attention — waiting for you" };

  if (policy.mode === "notify") return { action: "notify", reason: "notify-only — waiting for install now" };

  // automatic, no override: the soak. Install once it has been out N days —
  // upstream's own instance runs with soakDays 0, which makes it the fleet's
  // canary at no code cost.
  const ageMs = now - Date.parse(manifest.released_at);
  if (!Number.isFinite(ageMs)) return { action: "skip", reason: "released_at unreadable" };
  const soakMs = (policy.soakDays ?? 0) * 86400000;
  if (ageMs < soakMs) {
    const leftDays = ((soakMs - ageMs) / 86400000).toFixed(1);
    return { action: "skip", reason: `soaking (${leftDays} days left)` };
  }
  return { action: "install", reason: `soak of ${policy.soakDays} day(s) elapsed` };
}

// One install at a time (the plan's second safeguard): an overrunning cron and
// a queued install-now must not interleave. The lock is one D1 row, seeded by
// schema.sql; acquire is a conditional UPDATE whose row-count is the verdict,
// so it is atomic in the database rather than a read-then-write race. A lock
// older than staleMs is reclaimed — an install that died mid-flight (the
// isolate was evicted) must not wedge the updater forever.
export async function acquireInstallLock(env, holder, now, staleMs = 15 * 60 * 1000) {
  const res = await env.DB.prepare(
    "UPDATE install_lock SET held_at = ?, holder = ? WHERE id = 1 AND (held_at = 0 OR held_at < ?)",
  ).bind(now, holder, now - staleMs).run();
  return (res.meta?.changes ?? 0) === 1;
}
export async function releaseInstallLock(env) {
  await env.DB.prepare("UPDATE install_lock SET held_at = 0, holder = '' WHERE id = 1").run();
}
