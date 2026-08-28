// The wasmtts pin and its engine tarball, resolved in one place.
//
// wasmtts ships its engine as a release tarball (wasmtts-engine.tar.gz):
// the compiled lexicon, the runtime profile and the complete
// matcha-assets.json (stage: complete, with the lexicon and runtime blocks)
// are BUILT at release time and are not in the git tree — the tree's
// platform/matcha-assets.source.json is stage: source and useless to a
// consumer. So the git dependency in package.json is the version tracker
// (Renovate bumps it) and the source of the npm runtime pins (onnxruntime-web,
// lamejs resolve through it), while every engine file comes from the tarball
// of the same tag, verified against the release's .sha256 before extraction.
//
// Downloaded once per tag into node_modules/.cache/wasmtts-engine/<tag>/ —
// inside node_modules so it is gitignored and gone with a fresh checkout,
// and cached locally so vendor.mjs (which every test entry point runs) does
// not touch the network twice for the same pin.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WASMTTS_REPO = "enstw/wasmtts";
export const TARBALL = "wasmtts-engine.tar.gz";

// the tag package.json pins — the one place the version is written
export function pinnedTag() {
  const spec = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies?.wasmtts;
  const m = spec?.match(/^github:enstw\/wasmtts#(v\d+\.\d+\.\d+)$/u);
  if (!m) throw new Error(`package.json pins wasmtts as ${JSON.stringify(spec)} — expected github:enstw/wasmtts#vX.Y.Z`);
  return m[1];
}

export const engineDir = (tag = pinnedTag()) => join(root, "node_modules", ".cache", "wasmtts-engine", tag);

// a package that resolves THROUGH the wasmtts dependency's own tree — the
// version upstream's release gates actually tested, never a pin held here
export function viaWasmtts(pkg) {
  return join(realpathSync(join(root, "node_modules", "wasmtts")), "..", pkg);
}

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The extracted engine for the pinned tag: download + verify once, then
// answer from the cache. A stamp file names the tag, so a half-extracted
// directory (a killed run) is never mistaken for a verified one.
export async function ensureEngine(tag = pinnedTag()) {
  const dir = engineDir(tag);
  const stamp = join(dir, ".verified");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === tag) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/${WASMTTS_REPO}/releases/download/${tag}/`;
  const [tgz, sums] = await Promise.all([fetchBytes(base + TARBALL), fetchBytes(`${base}${TARBALL}.sha256`)]);
  // sha256sum format: "<hex>  <name>"; the name is informational
  const expected = sums.toString("utf8").trim().split(/\s+/u)[0];
  const actual = createHash("sha256").update(tgz).digest("hex");
  if (!/^[0-9a-f]{64}$/u.test(expected) || actual !== expected)
    throw new Error(`${TARBALL} for ${tag}: SHA-256 ${actual}, the release's .sha256 says ${expected}`);
  writeFileSync(join(dir, TARBALL), tgz);
  execFileSync("tar", ["xzf", TARBALL], { cwd: dir });
  const assets = readAssets(dir);
  if (assets.schemaVersion !== 4 || assets.stage !== "complete")
    throw new Error(`${tag} tarball's matcha-assets.json is schemaVersion ${assets.schemaVersion} stage ${assets.stage} — this repo understands 4/complete`);
  writeFileSync(stamp, `${tag}\n`);
  return dir;
}

export function readAssets(dir) {
  return JSON.parse(readFileSync(join(dir, "matcha-assets.json"), "utf8"));
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// The release-served pack: every file /api/wasmtts serves under its packName
// — the models, tokens and rule tables from their upstream sources, the
// compiled lexicon from the tarball, ort's wasm from the npm package. Each
// entry says where its bytes come from, so vendor, the asset sync, the weight
// fetcher and the e2e suite derive one list instead of four.
export function packEntries(assets, dir) {
  const matchaRepo = assets.matcha.repository.replace(/\.git$/u, "");
  const upstream = (file, meta) => ({
    name: meta.packName, bytes: meta.bytes, sha256: meta.sha256, file,
    url: `${matchaRepo}/resolve/${assets.matcha.revision}/${file}`,
  });
  const ort = viaWasmtts("onnxruntime-web");
  const ortWasm = assets.runtime["onnxruntime-web"].files["dist/ort-wasm-simd-threaded.wasm"];
  return [
    { name: assets.acoustic.packName, bytes: assets.acoustic.bytes, sha256: assets.acoustic.sha256, file: assets.acoustic.file,
      url: `${assets.acoustic.repository}/resolve/${assets.acoustic.revision}/${assets.acoustic.file}` },
    { name: assets.vocos.packName, bytes: assets.vocos.bytes, sha256: assets.vocos.sha256,
      file: assets.vocos.url.split("/").pop(), url: assets.vocos.url },
    ...Object.entries(assets.matcha.files).filter(([, meta]) => meta.packName).map(([file, meta]) => upstream(file, meta)),
    { name: assets.lexicon.packName, bytes: assets.lexicon.bytes, sha256: assets.lexicon.sha256,
      file: assets.lexicon.file, local: join(dir, assets.lexicon.file) },
    { name: ortWasm.packName, bytes: ortWasm.bytes, sha256: ortWasm.sha256,
      file: "ort-wasm-simd-threaded.wasm", local: join(ort, "dist", "ort-wasm-simd-threaded.wasm") },
  ];
}

// The runtime scripts the shell serves under their versioned packNames —
// everything in the runtime block except ort's wasm (a pack file, above).
export function runtimeScripts(assets) {
  const out = [];
  for (const [pkg, { version, files }] of Object.entries(assets.runtime)) {
    for (const [file, meta] of Object.entries(files)) {
      if (file.endsWith(".wasm")) continue;
      const dir = viaWasmtts(pkg);
      out.push({ pkg, version, file, name: meta.packName, bytes: meta.bytes, sha256: meta.sha256, dir, local: join(dir, file) });
    }
  }
  return out;
}
