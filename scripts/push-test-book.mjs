// Fire ONE real 新書上架 notification at every subscribed device, then
// remove the book again — the on-device half of the push test, which the
// local suite cannot do (it needs the production admin token and Apple's
// push service). Run from the "push test" GitHub Action, which injects
// BOOKWORM_URL and ADMIN_TOKEN; locally:
//   BOOKWORM_URL=… ADMIN_TOKEN=… node scripts/push-test-book.mjs
//
// The manifest PUT is what the worker treats as 新書上架, so the chapter
// goes up first — exactly like scripts/publish-book.mjs.

const BASE = process.env.BOOKWORM_URL;
const TOKEN = process.env.ADMIN_TOKEN;
const KEEP_MS = Number(process.env.KEEP_MS ?? 45000);
if (!BASE || !TOKEN) {
  console.error("BOOKWORM_URL and ADMIN_TOKEN are required");
  process.exit(1);
}

const slug = "push-check";
const text = "第一回 推播測試\n\n這是一本測試用的書，用來確認新書上架通知。\n";
const manifest = JSON.stringify({
  slug, title: "推播測試（自動刪除）", generatedAt: "push1",
  totalChars: text.length,
  chapters: [{ file: "ch1.txt", title: "第一回 推播測試", chars: text.length }],
});

// GitHub runners occasionally get their TLS connection to the edge reset
// mid-handshake (ECONNRESET before any request reaches the worker), so
// every call retries with backoff; a real HTTP error still fails fast.
const req = async (method, key, body, type) => {
  const url = `${BASE}/api/admin/objects/${encodeURIComponent(key)}`;
  const init = {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "bookworm-push-test",
      ...(type ? { "content-type": type } : {}),
    },
    body,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      const out = await res.text();
      if (!res.ok) throw new Error(`${method} ${key} → ${res.status} ${out}`);
      return out;
    } catch (err) {
      if (attempt >= 4 || !/fetch failed|ECONNRESET|socket/i.test(String(err?.cause ?? err)))
        throw err;
      console.log(`  ${method} ${key} failed (${err.cause?.code ?? err.message}), retry ${attempt}/3`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
};

// a stale test book from an interrupted run would suppress the push (the
// worker only announces a manifest that did not exist), so clear it first
for (const f of ["manifest.json", "ch1.txt"])
  await req("DELETE", `${slug}/${f}`).catch(() => {});

console.log("uploading chapter…");
await req("PUT", `${slug}/ch1.txt`, text, "text/plain");
console.log("uploading manifest — this is the 新書上架 trigger");
await req("PUT", `${slug}/manifest.json`, manifest, "application/json");
console.log(`✓ published; the notification should arrive within seconds.`);
console.log(`  removing the test book in ${Math.round(KEEP_MS / 1000)} s…`);

await new Promise((r) => setTimeout(r, KEEP_MS));
for (const f of ["manifest.json", "ch1.txt"]) await req("DELETE", `${slug}/${f}`);
console.log("✓ test book removed");
