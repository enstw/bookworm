// Shared Chromium discovery for CDP-driving scripts. Resolution order:
//
//   1. BROWSER_BIN (explicit override)
//   2. the browser-cdp skill's provisioned wrapper (~/.cache/
//      headless-chromium/chrome) — if it exists it was provisioned
//      deliberately and probed working, with lib paths and sandbox flags
//      baked in; trust it over a possibly-broken system install (snap
//      chromium in a container)
//   3. the usual desktop installs (Brave / Chrome / chromium)
//   4. playwright's chromium-headless-shell under ~/.cache/ms-playwright —
//      including the extracted-libs LD_LIBRARY_PATH shim for boxes where
//      libnss3/libnspr4 can't be apt-installed (extra-libs/ next to it)
//
// Returns { bin, env }; pass env to spawn() so the lib shim applies. No
// browser at all is fatal — install one with:
//   pnpm dlx playwright install chromium-headless-shell
// or, on locked-down/container boxes (no root, broken snap), provision one
// with the browser-cdp skill's scripts/provision.sh.

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function findBrowser() {
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  const env = { ...process.env };

  const known =
    process.env.BROWSER_BIN ??
    [
      join(homedir(), ".cache", "headless-chromium", "chrome"),
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(isFile);
  if (known) return { bin: known, env };

  const pw = join(homedir(), ".cache", "ms-playwright");
  const shell = ls(pw)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((d) => join(pw, d, "chrome-linux", "headless_shell"))
    .find(isFile);
  if (shell) {
    const libRoot = join(pw, "extra-libs", "usr", "lib");
    const libs = ls(libRoot).map((d) => join(libRoot, d));
    if (libs.length)
      env.LD_LIBRARY_PATH = [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    return { bin: shell, env };
  }

  console.error("no Chromium found; set BROWSER_BIN, run: pnpm dlx playwright install chromium-headless-shell, or provision one with the browser-cdp skill's provision.sh");
  process.exit(1);
}
