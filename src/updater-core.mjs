// The testable core of bookworm-updater (see src/updater.js for the entry and
// the split's rationale). Kept out of the entry module because a Worker's
// entry may export only handlers — workerd rejects a plain `export const` from
// it — and because a plain function behind a seam is testable with no wrangler,
// no account, no D1 (scripts/test-updater.mjs).

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
