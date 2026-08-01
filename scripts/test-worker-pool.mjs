// mapPool is the ceiling that keeps the worker under Cloudflare's 6
// simultaneous open connections. Nothing local enforces that limit — a
// `wrangler dev` run happily fans out over a whole book — so the bound gets
// asserted here instead, where a regression is visible without a deploy.
//
//   node scripts/test-worker-pool.mjs

import { mapPool } from "../src/worker.js";

const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. never more than `limit` running at once, whatever the timings
{
  let live = 0, peak = 0;
  const items = Array.from({ length: 40 }, (_, i) => i);
  await mapPool(items, 2, async (n) => {
    peak = Math.max(peak, ++live);
    await sleep(n % 5); // uneven work: a naive pool drains and over-fills
    live--;
  });
  out.concurrencyCap = peak === 2 && live === 0
    ? "ok (peak 2 of a 40-item list)"
    : `FAIL peak=${peak} live=${live}`;
}

// 2. results come back in INPUT order, not completion order — listBooks
//    indexes into them and the shelf would otherwise scramble
{
  const items = [30, 5, 20, 1, 10];
  const res = await mapPool(items, 3, async (ms) => { await sleep(ms); return ms; });
  out.order = JSON.stringify(res) === JSON.stringify(items)
    ? "ok (input order preserved)"
    : `FAIL ${JSON.stringify(res)}`;
}

// 3. every item runs exactly once, including when the list is shorter than
//    the limit and when it is empty (an empty list must not hang)
{
  const seen = [];
  await mapPool([1, 2], 8, async (n) => { seen.push(n); });
  const empty = await mapPool([], 4, async () => "never");
  out.edges = seen.length === 2 && seen.includes(1) && seen.includes(2) &&
    Array.isArray(empty) && empty.length === 0
    ? "ok (short list, empty list)"
    : `FAIL seen=${JSON.stringify(seen)} empty=${JSON.stringify(empty)}`;
}

// 4. a rejection surfaces rather than being swallowed — a failed copy has to
//    reach the caller as a 500 with a message, not a silently short move
{
  let threw = null;
  try {
    await mapPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      await sleep(1);
    });
  } catch (err) {
    threw = err.message;
  }
  out.rejects = threw === "boom" ? "ok (rejection propagates)" : `FAIL ${threw}`;
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
