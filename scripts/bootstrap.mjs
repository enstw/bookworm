// The one-shot bootstrap (PM-10), command form. This is what an INSTALLATION
// step runs to turn an empty Cloudflare account into a working instance — no
// fork, no GitHub Actions, no clone of this repo. It is published as a single
// self-contained file on every release (package-release.mjs bundles it, with
// schema.sql and the updater source baked in); a clone can also run it straight
// from `scripts/`, where it rebuilds that payload from the tree.
//
//   CF_API_TOKEN=…  CF_ACCOUNT_ID=…  UPSTREAM_URL=https://github.com/OWNER/REPO/releases/latest/download/  \
//   [VAPID_SUBJECT=mailto:you@example.com]  node bootstrap.mjs
//
// Secrets travel by ENV only — never argv, never a file — the same rule the
// fork-mode INSTALLATION kept. The token is the broad, one-time kind that can
// create D1/R2/Workers; delete it once this returns. The instance comes up
// UNARMED: no CF_API_TOKEN reaches the updater, so nothing auto-installs until
// the owner sets that secret themselves.

import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bootstrap } from "../src/bootstrap-core.mjs";
import { parseMigrations } from "../src/migrations.mjs";

const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

// A fresh VAPID keypair (Web Push). The worker derives the public key from the
// private JWK at runtime, so the private JWK is the only thing to keep.
async function genVapidJwk() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y, ext: true });
}

// The Cloudflare API bound to the one-time token and account. Same shape the
// updater and install() use — path relative to /accounts/{id}, bearer overrides
// the token for the asset-upload calls (they carry the session's own JWT).
function makeCf(token, account) {
  return async (path, init = {}, bearer = token) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      ...init, headers: { authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let j = {}; try { j = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok || j.success === false)
      throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(j.errors ?? text).slice(0, 200)}`);
    return j.result ?? {};
  };
}

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`missing ${name} — see the header of this file`); process.exit(1); }
  return v;
};

// The whole command: read the environment, fetch the reader release upstream
// publishes, generate this instance's own secrets, run the bootstrap, and print
// the two things the owner has to keep and the one thing they do next. `payload`
// is { schema, updaterSource, readerCrons, updaterCrons, updaterFlags } — baked
// into the published file, rebuilt from the tree in a clone.
export async function runBootstrap(payload) {
  const token = need("CF_API_TOKEN");
  const account = need("CF_ACCOUNT_ID");
  const upstreamUrl = need("UPSTREAM_URL").endsWith("/") ? process.env.UPSTREAM_URL : process.env.UPSTREAM_URL + "/";
  const names = {
    reader: process.env.BW_READER_NAME || "bookworm",
    updater: process.env.BW_UPDATER_NAME || "bookworm-updater",
    d1: process.env.BW_D1_NAME || "bookworm",
    r2: process.env.BW_R2_NAME || "bookworm-books",
  };
  const cf = makeCf(token, account);

  console.error(`==> fetching reader release from ${upstreamUrl}`);
  const mres = await fetch(upstreamUrl + "manifest.json", { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!mres.ok) { console.error(`could not read the manifest (HTTP ${mres.status}); is UPSTREAM_URL a …/releases/latest/download/ URL?`); process.exit(1); }
  const readerManifest = await mres.json();
  console.error(`    ${readerManifest.version} — ${readerManifest.assets.length} assets, ${(readerManifest.bundle.size / 1048576).toFixed(1)} MB`);

  const adminToken = process.env.ADMIN_TOKEN || randHex(24);
  const secrets = {
    ADMIN_TOKEN: adminToken,
    VAPID_PRIVATE_JWK: process.env.VAPID_PRIVATE_JWK || await genVapidJwk(),
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || "mailto:owner@example.com",
  };

  console.error("==> bootstrapping");
  const r = await bootstrap({
    cf, names, readerManifest,
    schemaStatements: parseMigrations(payload.schema),
    updaterSource: payload.updaterSource,
    readerCrons: payload.readerCrons, updaterCrons: payload.updaterCrons, updaterFlags: payload.updaterFlags,
    upstreamUrl, secrets, now: Date.now(), log: (...a) => console.error(...a),
  });

  const url = r.readerUrl || `https://${names.reader}.<your-subdomain>.workers.dev`;
  // stdout carries the durable output (redirectable); the progress above is on stderr
  console.log("");
  console.log("instance is up.");
  console.log(`  reader:       ${url}`);
  console.log(`  admin:        ${url}/admin`);
  if (r.keyMinted) console.log(`  owner key:    ${url}/?key=${r.readerKey}   (open on your phone, add to home screen)`);
  else console.log(`  owner key:    (an owner key already existed — kept it)`);
  console.log(`  ADMIN_TOKEN:  ${adminToken}   (save to a password manager now — it is not shown again)`);
  console.log("");
  console.log("the updater is UNARMED (no automatic updates). to arm it, set CF_API_TOKEN on");
  console.log(`bookworm-updater — a token scoped to edit only the ${names.reader} script.`);
  return r;
}

// --- payload from a clone ---------------------------------------------------
// Rebuild what the published file bakes in, from the tree: schema.sql as-is, the
// updater bundled the way the deploy bundles it (wrangler dry-run, no
// credentials), and the crons/flags out of the two wrangler configs. Used by
// scripts/bootstrap-cli.mjs so a clone can run the same command; the published
// bootstrap.mjs carries this payload inline and never calls this.
export function payloadFromTree() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const readJsonc = (f) => JSON.parse(readFileSync(join(root, f), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const reader = readJsonc("wrangler.jsonc");
  const updater = readJsonc("wrangler.updater.jsonc");
  return {
    schema: readFileSync(join(root, "schema.sql"), "utf8"),
    updaterSource: bundleUpdater(root),
    readerCrons: reader.triggers?.crons ?? [],
    updaterCrons: updater.triggers?.crons ?? [],
    updaterFlags: updater.compatibility_flags ?? ["nodejs_compat"],
  };
}
function bundleUpdater(root) {
  const out = mkdtempSync(join(tmpdir(), "bw-boot-upd-"));
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out, "--config", "wrangler.updater.jsonc"],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, CI: "true", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" } });
  return readFileSync(join(out, "updater.js"), "utf8");
}
