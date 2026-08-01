#!/usr/bin/env node
// Copy the browser bundles the /admin page uses from the pinned npm packages
// into public/vendor/ (gitignored). Runs automatically before `pnpm run dev`
// and `pnpm run deploy`, so the served assets always match package.json —
// Dependabot bumps a version, the next deploy ships it.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "vendor");

const BUNDLES = [
  // simplified→traditional only (1.0MB); the full bi-directional bundle is not needed
  { pkg: "opencc-js", src: "dist/esm/cn2t.js", dst: "opencc-cn2t.js" },
  { pkg: "fflate", src: "esm/browser.js", dst: "fflate.js" },
];

mkdirSync(outDir, { recursive: true });
const versions = {};
for (const { pkg, src, dst } of BUNDLES) {
  const pkgDir = join(root, "node_modules", pkg);
  copyFileSync(join(pkgDir, src), join(outDir, dst));
  versions[pkg] = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
}
writeFileSync(join(outDir, "versions.json"), JSON.stringify(versions, null, 2) + "\n");
console.log(`✓ vendored to public/vendor/: ${Object.entries(versions).map(([p, v]) => `${p}@${v}`).join(", ")}`);
