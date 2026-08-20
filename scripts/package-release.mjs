#!/usr/bin/env node
// Build the release artifact — the thing an instance's updater installs
// (docs/pull-mode-updates.md, "The artifact"). Nothing produced one before:
// wrangler bundled and uploaded in one motion and the bytes were never kept.
//
// Out of one commit, into <outDir>:
//
//   manifest.json        what the release IS — version, per-file hashes,
//                        binding shapes, assets config, migrations, flags
//   bookworm-<sha>.zip   worker.js + public/… — the bytes the manifest hashes
//   notes.md             the release body, the same entry RELEASES.md gets
//
// Everything is built from a STAGING COPY of src/ and public/, never from
// the tree: the stamp goes into the copies, wrangler bundles the copy's
// worker (`--dry-run --outdir`, same esbuild pass a real deploy runs, no
// credentials), and the tree is left exactly as found. That is what lets
// this run both inside the deploy (where deploy.sh has already stamped the
// tree — the copies then carry the same stamp, and a mismatch is an error)
// and from a clean checkout, where it stamps for itself.
//
// Reproducible means the clock cannot reach the bytes. The stamp is the
// commit's (build-id.mjs), zip entry mtimes are the commit's, and the only
// wall-clock field is `released_at`, by design: it is the soak clock, so it
// has to say when the release was PUBLISHED — derived from the commit, a
// redeploy of an old commit would ship a released_at already days in the
// past and every instance on automatic would skip its wait. It lives in the
// manifest, outside the zip, so the zip's hash still reproduces. One asset
// is reproducible only up to the ledger: public/releases.json is written by
// gen-release-notes.mjs from RELEASES.md plus the commits since the
// `released` tag, and that tag moves after every deploy. Everything else
// re-derives from the commit, and test-release-manifest.mjs checks it does.
//
// Two hashes per asset, on purpose. `sha256` is download integrity — the
// updater verifies each file against it after unzipping (and it is only
// that: TLS to upstream is the trust anchor, see the plan's trust section).
// `cfhash` is what Cloudflare's assets-upload session keys its manifest on —
// blake3(base64(bytes) + extension-without-dot), 32 hex, wrangler's own
// hashFile — shipped so the updater never has to compute it on the edge.
//
// `requiresAttention` is the publishing half of PM-03: a commit that needs
// a human at every instance (a new secret, a non-additive migration) says so
// with a `Requires-Attention: <why>` trailer, the way Release-Note: carries
// the reader-facing line. `attention` carries every such commit in history,
// because an instance that skipped several releases must still see the one
// in the middle that needed it; each entry's version string dates itself,
// so the updater can compare against its own BUILD with no git.
//
//   node scripts/package-release.mjs out/release [--repo owner/name]

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { hash as blake3 } from "blake3-wasm";
import { buildId, root } from "./build-id.mjs";
import { attentionHistory, pendingRelease, renderEntry } from "./release-notes.mjs";
import { parseMigrations, isAdditive } from "../src/migrations.mjs";

// Bumped by hand when the install contract changes in a way an older updater
// cannot follow (PM-16); an updater below this number refuses the release
// with the number on its panel rather than half-installing it.
export const MIN_UPDATER_VERSION = 1;

// wrangler's own default exclusions for an assets directory (plus whatever
// .assetsignore lists — this repo has none, and must not grow one: the
// packaging would then have to read it too, and two exclusion lists drift)
const WRANGLER_IGNORES = new Set([".assetsignore", "_redirects", "_headers"]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// wrangler-dist/cli.js hashFile, verbatim in spirit: base64 of the bytes,
// then the extension with its dot removed, blake3, first 32 hex chars
export const cfHash = (bytes, file) =>
  blake3(Buffer.from(bytes).toString("base64") + extname(file).substring(1)).toString("hex").slice(0, 32);

// refuse to package a non-additive migration — the gate R5 asks for, at the
// one point every release passes through
function migAssert(migrations) {
  for (const m of migrations)
    if (!isAdditive(m)) throw new Error(`migrations.sql has a non-additive statement, refusing to package: ${m.slice(0, 80)}`);
  return migrations;
}

// wrangler.jsonc carries line comments only; strip those and parse
export function readWranglerConfig(dir = root) {
  const text = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(full, base));
    else if (!(dir === base && WRANGLER_IGNORES.has(name.name))) out.push(full);
  }
  return out;
}

const STAMP = /^const BUILD = "([^"]*)";/m;
// stamp a copy; a copy that is already stamped (deploy.sh got there first)
// must agree, or this artifact would describe a different build than the
// one deployed beside it
function stamp(file, version) {
  const text = readFileSync(file, "utf8");
  const current = text.match(STAMP)?.[1];
  if (current === undefined) throw new Error(`${file}: no BUILD constant to stamp`);
  if (current !== "dev" && current !== version)
    throw new Error(`${file} is stamped "${current}" but the commit says "${version}"`);
  writeFileSync(file, text.replace(STAMP, `const BUILD = "${version}";`));
}

export function repoFromGit(cwd = root) {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!m) throw new Error(`cannot read owner/name out of origin (${url}); pass --repo`);
  return m[1];
}

export function packageRelease({ outDir, repo, cwd = root }) {
  const version = buildId("HEAD", cwd);
  const sha = version.split(" ")[0];
  const committed = new Date(execFileSync("git", ["log", "-1", "--format=%cI", "HEAD"],
    { cwd, encoding: "utf8" }).trim());
  const cfg = readWranglerConfig(cwd);

  const stage = mkdtempSync(join(tmpdir(), "bookworm-release-"));
  try {
    cpSync(join(cwd, "src"), join(stage, "src"), { recursive: true });
    cpSync(join(cwd, "public"), join(stage, "public"), { recursive: true });
    cpSync(join(cwd, "wrangler.jsonc"), join(stage, "wrangler.jsonc"));
    stamp(join(stage, "public", "app.js"), version);
    stamp(join(stage, "src", "worker.js"), version);

    // the same bundling pass a deploy runs; --config makes every path in the
    // copied wrangler.jsonc (main, assets.directory) resolve inside the stage
    execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run",
      "--outdir", join(stage, "dist"), "--config", join(stage, "wrangler.jsonc")], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    });
    const workerBytes = readFileSync(join(stage, "dist", "worker.js"));

    const publicDir = join(stage, "public");
    const assets = walk(publicDir).map((full) => {
      const rel = relative(publicDir, full).split(sep).join(posix.sep);
      const bytes = readFileSync(full);
      return { path: `/${rel}`, file: `public/${rel}`, sha256: sha256(bytes), cfhash: cfHash(bytes, rel), size: bytes.length, bytes };
    });

    // entry mtimes are the commit's, so the zip's bytes — and its hash —
    // come out the same on every machine that packages this commit
    const entries = { "worker.js": [workerBytes, { mtime: committed }] };
    for (const a of assets) entries[a.file] = [a.bytes, { mtime: committed }];
    const zip = zipSync(entries, { level: 6, mtime: committed });
    const zipName = `bookworm-${sha}.zip`;
    const tag = `release-${sha}`;

    const pending = pendingRelease(cwd);
    const attention = attentionHistory(cwd);
    const shipping = new Set(pending.commits.map((l) => l.split(" ")[0]));
    const manifest = {
      version,
      released_at: new Date().toISOString(),
      tag,
      worker: { file: "worker.js", sha256: sha256(workerBytes), size: workerBytes.length },
      assets: assets.map(({ bytes, ...a }) => a),
      bundle: {
        url: `https://github.com/${repo}/releases/download/${tag}/${zipName}`,
        file: zipName, sha256: sha256(zip), size: zip.length,
      },
      // the SHAPE of what the worker needs; the instance owns the values
      // (its own D1 id, its own bucket) — crossing that line is R4
      bindings: [
        ...(cfg.d1_databases ?? []).map((d) => ({ type: "d1", name: d.binding })),
        ...(cfg.r2_buckets ?? []).map((r) => ({ type: "r2_bucket", name: r.binding })),
        ...(cfg.assets?.binding ? [{ type: "assets", name: cfg.assets.binding }] : []),
      ],
      compatibility_date: cfg.compatibility_date,
      compatibility_flags: cfg.compatibility_flags ?? [],
      assetsConfig: {
        not_found_handling: cfg.assets?.not_found_handling ?? "none",
        run_worker_first: cfg.assets?.run_worker_first ?? [],
      },
      // additive migrations the updater runs BEFORE the script swap (PM-06),
      // read from migrations.sql. A non-additive statement is refused here, at
      // packaging — a release cannot ship one a rolled-back swap could not
      // survive (R5).
      migrations: migAssert(parseMigrations(existsSync(join(cwd, "migrations.sql")) ? readFileSync(join(cwd, "migrations.sql"), "utf8") : "")),
      requiresAttention: attention.some((a) => shipping.has(a.commit)),
      attention,
      minUpdaterVersion: MIN_UPDATER_VERSION,
    };

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(outDir, zipName), zip);
    writeFileSync(join(outDir, "notes.md"), renderEntry(pending));
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const repoAt = args.indexOf("--repo");
  const repo = repoAt === -1 ? (process.env.GITHUB_REPOSITORY ?? repoFromGit()) : args.splice(repoAt, 2)[1];
  const outDir = args[0];
  if (!outDir) {
    console.error("usage: node scripts/package-release.mjs <outDir> [--repo owner/name]");
    process.exit(1);
  }
  if (!existsSync(join(root, "public", "vendor", "fflate.js"))) {
    console.error("public/vendor/ is empty — run `node scripts/vendor.mjs` first, the deploy does");
    process.exit(1);
  }
  const m = packageRelease({ outDir, repo });
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`✓ ${outDir}: ${m.version} — ${m.assets.length} assets, worker ${statSync(join(outDir, "manifest.json")).size > 0 ? mb(m.worker.size) : "?"} MB, bundle ${mb(m.bundle.size)} MB` +
    (m.requiresAttention ? " — REQUIRES ATTENTION" : ""));
}
