#!/usr/bin/env node
// The release manifest as a stated contract (PM-02).
//
// N instances will read manifest.json unattended, each through an updater
// written against the table below. A field that is dropped, renamed or
// retyped upstream does not break upstream — it strands the fleet, quietly,
// one cron at a time. So the contract is asserted here the way the workflow
// permission split is asserted in test-deploy-policy.mjs: the real output
// must pass, and seeded violations must each be caught.
//
// It also packages the working tree TWICE and compares: the artifact claims
// to be reproducible from the commit (same asset hashes, same worker hash,
// same zip hash), and an artifact nobody can re-derive is one nobody can
// verify. Pure node — the only thing it runs is wrangler's dry-run bundler.
//
//   node scripts/test-release-manifest.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { unzipSync } from "fflate";
import { hash as blake3 } from "blake3-wasm";
import { buildId, root } from "./build-id.mjs";
import { packageRelease, readWranglerConfig } from "./package-release.mjs";
import { pendingRelease } from "./release-notes.mjs";
import { isAdditive } from "../src/migrations.mjs";

const hex = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const VERSION_RE = /^[0-9a-f]{7,40} · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const typeOf = (x) => (Array.isArray(x) ? "array" : x === null ? "null" : typeof x);
const keysOf = (o) => Object.keys(o).sort().join(",");
const isInt = (n) => Number.isInteger(n);

// --- the contract -----------------------------------------------------------
// Top-level fields, exactly these, with these types. What an updater may
// assume about each is asserted below the table.
export const FIELDS = {
  version: "string",             // the reader's BUILD, verbatim — identity, compared as a string
  released_at: "string",         // ISO instant: when this release was PUBLISHED (the soak clock)
  tag: "string",                 // the GitHub release tag: release-<sha>
  worker: "object",              // { file, sha256, size } — the bundled script, main module
  assets: "array",               // [{ path, file, sha256, cfhash, size }], sorted by path
  bundle: "object",              // { url, file, sha256, size } — the zip carrying worker + assets
  bindings: "array",             // [{ type, name }] — SHAPES only; the instance owns the values
  compatibility_date: "string",  // YYYY-MM-DD
  compatibility_flags: "array",  // strings
  assetsConfig: "object",        // { not_found_handling, run_worker_first }
  migrations: "array",           // SQL strings, additive only, run before the swap
  requiresAttention: "boolean",  // this release needs a human at every instance
  attention: "array",            // every commit in history that did: [{ commit, version, reason }]
  minUpdaterVersion: "number",   // an updater below this refuses the release
};

export function checkManifest(m, { cfg, repo }) {
  const v = [];
  const is = (ok, msg) => { if (!ok) v.push(msg); };
  if (typeOf(m) !== "object") return ["manifest is not an object"];
  for (const [k, t] of Object.entries(FIELDS)) is(typeOf(m[k]) === t, `${k}: expected ${t}, got ${typeOf(m[k])}`);
  for (const k of Object.keys(m)) is(k in FIELDS, `unexpected field ${k}`);
  if (v.length) return v; // shape first — everything below assumes it

  is(VERSION_RE.test(m.version), `version "${m.version}" is not "<sha> · YYYY-MM-DD HH:MM"`);
  const sha = m.version.split(" ")[0];
  is(m.tag === `release-${sha}`, `tag ${m.tag} does not name the version's commit (release-${sha})`);
  is(!Number.isNaN(Date.parse(m.released_at)), `released_at "${m.released_at}" is not an instant`);

  is(keysOf(m.worker) === "file,sha256,size", `worker keys: ${keysOf(m.worker)}`);
  is(m.worker.file === "worker.js", `worker.file ${m.worker.file}`);
  is(hex(64).test(m.worker.sha256), "worker.sha256 is not 64 hex");
  is(isInt(m.worker.size) && m.worker.size > 0, "worker.size");

  is(m.assets.length > 0, "assets is empty");
  const paths = m.assets.map((a) => a.path);
  is(JSON.stringify(paths) === JSON.stringify([...new Set(paths)].sort()), "assets are not sorted by path, or a path repeats");
  for (const a of m.assets) {
    is(keysOf(a) === "cfhash,file,path,sha256,size", `asset ${a.path}: keys ${keysOf(a)}`);
    is(typeof a.path === "string" && a.path.startsWith("/"), `asset path ${a.path} must start with /`);
    is(a.file === `public${a.path}`, `asset ${a.path}: file ${a.file} is not public${a.path}`);
    is(hex(64).test(a.sha256), `asset ${a.path}: sha256 is not 64 hex`);
    is(hex(32).test(a.cfhash), `asset ${a.path}: cfhash is not 32 hex`);
    is(isInt(a.size) && a.size >= 0, `asset ${a.path}: size`);
    is(!a.path.endsWith("icon-source.png"), "icon-source.png is shipped — it is make-icons.mjs's input, not an asset");
  }
  for (const must of ["/app.js", "/sw.js", "/index.html", "/i18n.js"])
    is(paths.includes(must), `${must} is missing from assets`);

  is(keysOf(m.bundle) === "file,sha256,size,url", `bundle keys: ${keysOf(m.bundle)}`);
  is(m.bundle.file === `bookworm-${sha}.zip`, `bundle.file ${m.bundle.file}`);
  is(m.bundle.url === `https://github.com/${repo}/releases/download/${m.tag}/${m.bundle.file}`,
    `bundle.url ${m.bundle.url} is not the per-tag GitHub download URL`);
  is(hex(64).test(m.bundle.sha256), "bundle.sha256 is not 64 hex");
  is(isInt(m.bundle.size) && m.bundle.size > 0, "bundle.size");

  for (const b of m.bindings)
    is(typeOf(b) === "object" && keysOf(b) === "name,type" && typeof b.type === "string" && typeof b.name === "string",
      `binding ${JSON.stringify(b)} is not { type, name }`);
  const declared = [
    ...(cfg.d1_databases ?? []).map((d) => ({ type: "d1", name: d.binding })),
    ...(cfg.r2_buckets ?? []).map((r) => ({ type: "r2_bucket", name: r.binding })),
    ...(cfg.assets?.binding ? [{ type: "assets", name: cfg.assets.binding }] : []),
  ];
  const sortB = (bs) => JSON.stringify([...bs].sort((a, b) => `${a.type}${a.name}`.localeCompare(`${b.type}${b.name}`)));
  is(sortB(m.bindings) === sortB(declared), `bindings ${JSON.stringify(m.bindings)} ≠ wrangler.jsonc's ${JSON.stringify(declared)}`);
  for (const b of m.bindings)
    is(!("id" in b || "database_id" in b || "bucket_name" in b), `binding ${b.name} carries an instance value — shapes only (R4)`);

  is(/^\d{4}-\d{2}-\d{2}$/.test(m.compatibility_date) && m.compatibility_date === cfg.compatibility_date,
    `compatibility_date ${m.compatibility_date} ≠ wrangler.jsonc's ${cfg.compatibility_date}`);
  is(m.compatibility_flags.every((f) => typeof f === "string"), "compatibility_flags must be strings");

  is(keysOf(m.assetsConfig) === "not_found_handling,run_worker_first", `assetsConfig keys: ${keysOf(m.assetsConfig)}`);
  is(m.assetsConfig.not_found_handling === (cfg.assets?.not_found_handling ?? "none"), "assetsConfig.not_found_handling ≠ wrangler.jsonc");
  is(JSON.stringify(m.assetsConfig.run_worker_first) === JSON.stringify(cfg.assets?.run_worker_first ?? []), "assetsConfig.run_worker_first ≠ wrangler.jsonc");

  is(m.migrations.every((s) => typeof s === "string"), "migrations must be SQL strings");
  // R5's gate: a release must not carry a migration a rolled-back swap could
  // not survive — additive-only, checked at the manifest as at packaging
  for (const mig of m.migrations)
    is(isAdditive(mig), `migration is not additive: ${String(mig).slice(0, 50)}`);
  for (const a of m.attention)
    is(typeOf(a) === "object" && keysOf(a) === "commit,reason,version" && VERSION_RE.test(a.version) && typeof a.reason === "string" && a.reason.length > 0,
      `attention entry ${JSON.stringify(a)} is not { commit, version, reason }`);
  is(isInt(m.minUpdaterVersion) && m.minUpdaterVersion >= 1, `minUpdaterVersion ${m.minUpdaterVersion}`);
  return v;
}

// --- run it against the real thing ------------------------------------------
const out = {};
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const repo = "example/bookworm";
const cfg = readWranglerConfig();

if (!existsSync(join(root, "public", "vendor", "fflate.js"))) {
  console.error("public/vendor/ is empty — run `node scripts/vendor.mjs` first (the pnpm test chain does)");
  process.exit(1);
}
// the deploy writes releases.json before packaging; do the same so the asset
// list under test is the one a release actually carries
execFileSync("node", [join(root, "scripts", "gen-release-notes.mjs")], { cwd: root, stdio: "ignore" });

const dirA = mkdtempSync(join(tmpdir(), "bw-manifest-a-"));
const dirB = mkdtempSync(join(tmpdir(), "bw-manifest-b-"));
try {
  const A = packageRelease({ outDir: dirA, repo });
  const B = packageRelease({ outDir: dirB, repo });
  const written = JSON.parse(readFileSync(join(dirA, "manifest.json"), "utf8"));

  const violations = checkManifest(written, { cfg, repo });
  out.contract = violations.length === 0 ? `ok (${Object.keys(FIELDS).length} fields, ${written.assets.length} assets)` : `FAIL ${violations.join("; ")}`;

  // reproducible: the second packaging of the same tree must hash the same,
  // released_at aside (it is the publish instant, by design)
  const same = (k, a, b) => (a === b ? null : `${k} differs`);
  const diffs = [
    same("worker.sha256", A.worker.sha256, B.worker.sha256),
    same("assets", JSON.stringify(A.assets), JSON.stringify(B.assets)),
    same("bundle.sha256", A.bundle.sha256, B.bundle.sha256),
    same("version", A.version, B.version),
    A.released_at !== B.released_at || true ? null : "unreachable",
  ].filter(Boolean);
  out.reproducible = diffs.length === 0 ? "ok (worker, every asset and the zip hash the same twice)" : `FAIL ${diffs.join("; ")}`;

  // the zip carries exactly what the manifest describes, byte for byte
  const zip = unzipSync(new Uint8Array(readFileSync(join(dirA, A.bundle.file))));
  const described = new Map([[A.worker.file, A.worker], ...A.assets.map((a) => [a.file, a])]);
  const zipProblems = [];
  for (const [file, entry] of described) {
    const bytes = zip[file];
    if (!bytes) { zipProblems.push(`${file} missing from zip`); continue; }
    if (bytes.length !== entry.size) zipProblems.push(`${file}: size ${bytes.length} ≠ ${entry.size}`);
    if (sha256(bytes) !== entry.sha256) zipProblems.push(`${file}: sha256 mismatch`);
  }
  for (const file of Object.keys(zip)) if (!described.has(file) && !file.endsWith("/")) zipProblems.push(`${file} in zip but not in manifest`);
  if (sha256(readFileSync(join(dirA, A.bundle.file))) !== A.bundle.sha256) zipProblems.push("bundle.sha256 is not the zip's hash");
  out.zipMatchesManifest = zipProblems.length === 0 ? `ok (${described.size} files)` : `FAIL ${zipProblems.slice(0, 5).join("; ")}`;

  // cfhash is wrangler's hashFile (wrangler-dist/cli.js): blake3 over the
  // base64 of the bytes followed by the extension without its dot, 32 hex —
  // recomputed here independently for a few assets of different types
  const picks = A.assets.filter((a) => [".js", ".png", ".woff2", ".html"].includes(extname(a.path))).slice(0, 6);
  const badCf = picks.filter((a) =>
    blake3(Buffer.from(zip[a.file]).toString("base64") + extname(a.path).substring(1)).toString("hex").slice(0, 32) !== a.cfhash);
  out.cfhashIsWranglers = picks.length >= 3 && badCf.length === 0 ? `ok (${picks.length} assets recomputed)` : `FAIL ${badCf.map((a) => a.path).join(",")}`;

  // the stamp: the manifest's version IS the BUILD inside both shipped copies.
  // esbuild writes string literals ASCII-only, so the bundle spells the
  // middle dot "\xB7" — the runtime string is the same; unescape to compare
  const unescape = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const literal = (bytes) => unescape(Buffer.from(bytes).toString("utf8").match(/BUILD = "([^"]*)"/)?.[1] ?? "");
  const appHas = literal(zip["public/app.js"]) === A.version;
  const workerHas = literal(zip["worker.js"]) === A.version;
  out.stamped = A.version === buildId() && appHas && workerHas
    ? "ok (version = build-id.mjs's stamp, present in app.js and worker.js)"
    : `FAIL version=${A.version} buildId=${buildId()} app=${appHas} worker=${workerHas}`;

  // requiresAttention is exactly "an attention commit ships in this release"
  const shipping = new Set(pendingRelease().commits.map((l) => l.split(" ")[0]));
  out.attentionConsistent = A.requiresAttention === A.attention.some((a) => shipping.has(a.commit))
    ? `ok (${A.attention.length} attention commit(s) in history, this release: ${A.requiresAttention})`
    : "FAIL requiresAttention disagrees with the attention list";

  // cfhash is only wrangler's hash if it is wrangler's blake3: the pin in
  // package.json must be the one wrangler itself resolves (renovate is told
  // to leave it alone — .github/renovate.json5 — so this is what moves it)
  const ours = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["blake3-wasm"];
  const theirs = JSON.parse(readFileSync(join(root, "node_modules", "wrangler", "package.json"), "utf8")).dependencies["blake3-wasm"];
  out.blake3PinTracksWrangler = ours === theirs
    ? `ok (blake3-wasm ${ours}, same as wrangler's)`
    : `FAIL package.json pins blake3-wasm ${ours}, wrangler depends on ${theirs} — move the pin`;

  // every seeded violation must be caught — an assertion that can only pass
  // is not a gate
  const clone = () => JSON.parse(JSON.stringify(written));
  const mutations = [
    ["field dropped", (m) => { delete m.version; }],
    ["field renamed", (m) => { m.files = m.assets; delete m.assets; }],
    ["field retyped", (m) => { m.minUpdaterVersion = "1"; }],
    ["unknown field", (m) => { m.extra = 1; }],
    ["asset without cfhash", (m) => { delete m.assets[0].cfhash; }],
    ["asset hash shortened", (m) => { m.assets[0].sha256 = m.assets[0].sha256.slice(0, 40); }],
    ["assets unsorted", (m) => { m.assets.reverse(); }],
    ["binding carrying an instance value", (m) => { m.bindings[0].database_id = "abc"; }],
    ["binding dropped", (m) => { m.bindings.pop(); }],
    ["bundle on another host", (m) => { m.bundle.url = m.bundle.url.replace("github.com", "example.com"); }],
    ["tag not the version's", (m) => { m.tag = "release-0000000"; }],
    ["assetsConfig drifting", (m) => { m.assetsConfig.run_worker_first = []; }],
    ["icon source shipped", (m) => { m.assets.push({ ...m.assets.at(-1), path: "/zz/icon-source.png", file: "public/zz/icon-source.png" }); }],
    ["attention entry without reason", (m) => { m.attention.push({ commit: "abc1234", version: A.version }); }],
    ["non-additive migration", (m) => { m.migrations.push("DROP TABLE readers"); }],
  ];
  const missed = mutations.filter(([, mutate]) => {
    const m = clone();
    mutate(m);
    return checkManifest(m, { cfg, repo }).length === 0;
  }).map(([label]) => label);
  out.mutationsCaught = missed.length === 0 ? `ok (${mutations.length} seeded violations caught)` : `FAIL not caught: ${missed.join(", ")}`;
} finally {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
