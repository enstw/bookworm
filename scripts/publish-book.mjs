#!/usr/bin/env node
// Upload a split book (output of split-book.mjs) to the worker's R2 bucket
// through its authenticated admin endpoint. No redeploy needed.
//
//   node scripts/publish-book.mjs out/<slug> --url https://bookworm.<you>.workers.dev \
//        --token <ADMIN_TOKEN>            (or env BOOKWORM_ADMIN_TOKEN)

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    concurrency: { type: "string", default: "6" },
    help: { type: "boolean", short: "h" },
  },
});

if (opts.help || positionals.length !== 1) {
  console.log("usage: node scripts/publish-book.mjs out/<slug> --url <worker-url> [--token T]");
  process.exit(opts.help ? 0 : 1);
}

const dir = positionals[0].replace(/\/+$/, "");
const slug = basename(dir);
const base = (opts.url ?? die("--url required (e.g. http://localhost:8787)")).replace(/\/+$/, "");
const token = opts.token ?? process.env.BOOKWORM_ADMIN_TOKEN ?? die("--token or BOOKWORM_ADMIN_TOKEN required");

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
} catch {
  die(`${dir}/manifest.json not found — run split-book.mjs first`);
}
if (manifest.slug !== slug) die(`slug mismatch: dir is "${slug}" but manifest says "${manifest.slug}"`);
// Files go under the book id, not the slug — that is what makes a later
// re-slug free. Manifests written before ids existed have none; their prefix
// has always been the slug, so that stays their id.
const id = manifest.id ?? slug;

async function put(name) {
  const body = readFileSync(join(dir, name));
  const url = `${base}/api/admin/objects/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": name.endsWith(".json")
          ? "application/json"
          : "text/plain; charset=utf-8",
      },
      body,
    });
    if (res.ok) return;
    if (res.status === 401) die("unauthorized — check ADMIN_TOKEN");
    if (attempt >= 3) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).sort();
if (!files.length) die(`no chapter files in ${dir}`);

console.log(`uploading ${files.length} chapters of "${manifest.title}" to ${base} …`);
let done = 0;
const queue = [...files];
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(Number(opts.concurrency), queue.length)) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      await put(f);
      done++;
      if (done % 25 === 0 || done === files.length) console.log(`  ${done}/${files.length}`);
    }
  }),
);

// manifest goes last so readers never see it referencing missing chapters
await put("manifest.json");
console.log(`✓ published: ${base}/${encodeURIComponent(slug)}/<your-user-id>`);
