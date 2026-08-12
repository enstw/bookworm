// E2E for the diagnostic-upload switch, and the first coverage the on-device
// diagnostic pages have ever had.
//
// Self-contained: serves public/ from an in-process static server that counts
// POSTs to /api/testlog, so "did this page upload" is answered by the wire
// rather than by a spy in the page.
//
// The switch is a courtesy to your own phones, not the gate on the endpoint —
// that is the bw_tlog cookie, asserted in test-auth-e2e.mjs — so what is
// asserted here is exactly the switch: this device stops uploading, and
// nothing else changes. The static server below answers every POST 200 on
// purpose: whether the worker would have accepted the write is a different
// suite's question, and stubbing it keeps this one about the flag.
//
//   node scripts/test-testlog-e2e.mjs

import { rmSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp-client.mjs";

const PORT = 9345;
const HTTP_PORT = 8991;
const PROFILE = "/tmp/bookworm-testlog-e2e-profile";
const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

const posted = []; // every body the pages sent to /api/testlog
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const out = (code, body, type) => { res.writeHead(code, { "content-type": type }); res.end(body); };
  if (path === "/api/testlog" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { posted.push(JSON.parse(raw)); } catch { posted.push({ page: "unparseable" }); }
      out(200, '{"ok":true}', MIME[".json"]);
    });
    return;
  }
  if (path === "/api/version") return out(200, '{"build":"dev"}', MIME[".json"]);
  if (path.startsWith("/api/")) return out(404, "{}", MIME[".json"]);
  // Cloudflare's assets layer serves /admin and /vhtest from admin.html and
  // vhtest.html (it 307s the .html form to the bare one), so the same rule
  // belongs here: without it the SPA fallback hands back the reader shell and
  // every assertion below passes vacuously against a page that never loaded.
  let file = path === "/" ? "/index.html" : path;
  if (!file.includes(".") && existsSync(join(PUB, `${file}.html`))) file += ".html";
  if (file.includes(".") && existsSync(join(PUB, file)))
    return out(200, readFileSync(join(PUB, file)), MIME[extname(file)] ?? "application/octet-stream");
  return out(200, readFileSync(join(PUB, "index.html")), MIME[".html"]);
});
await new Promise((r) => server.listen(HTTP_PORT, r));
const BASE = `http://localhost:${HTTP_PORT}`;

rmSync(PROFILE, { recursive: true, force: true });
const { evalJs, send, close, sessionId } = await launch({
  port: PORT, profile: PROFILE, args: ["--window-size=430,900"],
  onFail: () => server.close(),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = async (url) => {
  await send("Page.navigate", { url }, sessionId);
  await sleep(1800); // the readout loops tick about once a second
};
const finish = async (out) => {
  console.log(JSON.stringify(out, null, 2));
  await close();
  server.close();
  process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
};

const out = {};
const since = () => posted.length;

// 1. the helper reaches every page. This is the regression the refactor can
//    actually cause — six files had their own copy of the upload block and
//    now share one <script>, so a tag that landed wrong (wasmtest's is a
//    module, speechtest's batches) shows up here and nowhere else until
//    someone is on a phone wondering why the log is empty.
const pages = ["vhtest", "pgtest", "pagedtest", "scrolltest", "speechtest", "wasmtest"];
for (const p of pages) {
  await nav(`${BASE}/${p}`);
  out[`${p}Helper`] = (await evalJs(`typeof bwTestlogSend`)) === "function"
    ? "ok" : `FAIL: ${p} cannot reach bwTestlogSend`;
}

// 2. and one of them reaches the WIRE. vhtest is the one that uploads on its
//    own: the others post on a page turn or a finished run, which this suite
//    deliberately does not drive — asserting them here would mean asserting
//    interactions, not the switch.
const before = since();
await nav(`${BASE}/vhtest`);
out.vhtestUploads = posted.length > before ? "ok" : "FAIL: nothing reached /api/testlog";
out.pageNamedItself = posted.some((b) => b.page === "vhtest")
  ? "ok" : `FAIL: ${JSON.stringify([...new Set(posted.map((b) => b.page))])}`;

// 3. the switch on /admin writes the flag the pages read
await nav(`${BASE}/admin`);
out.switchDefaultsOn = (await evalJs(`document.getElementById("testlogOn").checked`)) === true
  ? "ok" : "FAIL: the box was not checked with the flag unset";
await evalJs(`document.getElementById("testlogOn").click()`);
out.flagWritten = (await evalJs(`localStorage.getItem("bw_testlog")`)) === "0"
  ? "ok" : `FAIL: ${await evalJs(`localStorage.getItem("bw_testlog")`)}`;

// 4. off means off, checked against the page that demonstrably does upload —
//    a silence assertion against a page that never posts proves nothing
const quietFrom = since();
await nav(`${BASE}/vhtest`);
out.silenced = posted.length === quietFrom
  ? "ok (nothing uploaded while off)"
  : `FAIL: ${posted.length - quietFrom} upload(s) escaped`;

// 5. and the switch remembers, so the box reflects the device on the next visit
await nav(`${BASE}/admin`);
out.switchPersists = (await evalJs(`document.getElementById("testlogOn").checked`)) === false
  ? "ok" : "FAIL: the box forgot it was turned off";

// 6. back on, back to uploading — a switch that cannot be undone is a bug
await evalJs(`document.getElementById("testlogOn").click()`);
const backFrom = since();
await nav(`${BASE}/vhtest`);
out.reversible = posted.length > backFrom ? "ok" : "FAIL: still silent after turning it back on";

await finish(out);
