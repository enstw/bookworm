// End-to-end proof of the whole-book admin routes behind /admin: publish,
// retitle, re-slug, resolve a slug, rebuild the index, delete. The point of
// most of it is what does NOT happen — a book is stored under an id that
// never changes, so re-slugging must move no files, keep every bookmark, keep
// the audio cache, and leave the old URL working. Every guard has to answer
// with a status rather than a 500.
//
// Prereqs: a worker with ADMIN_TOKEN in .dev.vars — this script starts
// `wrangler dev` itself unless BOOKWORM_URL is set.
//
//   node scripts/test-shelf-admin-e2e.mjs

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// shadows the global: the d1()/r2put() shell-outs below outlive a pooled
// keep-alive socket, and the request that inherits the dead one has to be
// replayed — this suite has the same exposure push-api-e2e went red on
import { fetch } from "./retry-fetch.mjs";

// its own port: a `pnpm run dev` server on 8787 belongs to the developer
const DEV_PORT = 8790;
const BASE = process.env.BOOKWORM_URL ?? `http://localhost:${DEV_PORT}`;
const TOKEN = process.env.ADMIN_TOKEN ?? "test-token-123";
const USER = "shelfe2e";
const CHAPTERS = 6;
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// straight at the local D1 — the only way to stage the drift the reindex
// route exists to repair (nothing in the API can corrupt the index on purpose)
const d1 = (sql) => {
  const raw = execFileSync("pnpm",
    ["exec", "wrangler", "d1", "execute", "bookworm", "--local", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return raw.slice(raw.indexOf("[")); // pnpm/wrangler print banners first
};

// and straight at the local R2, for the same reason: the publish route refuses
// to write a manifest that is not JSON — correctly, it is the guard that keeps
// the bucket honest — so a corrupt one cannot be staged through the API at all.
// Which is the whole problem: it can still HAPPEN, so it has to be checked for.
const r2put = (key, body) => {
  const file = join(tmpdir(), "bookworm-e2e-stage");
  writeFileSync(file, body);
  execFileSync("pnpm",
    ["exec", "wrangler", "r2", "object", "put", `bookworm-books/${key}`,
      "--file", file, "--local"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
};

const auth = { authorization: `Bearer ${TOKEN}` };
const put = (key, body, type = "text/plain; charset=utf-8") =>
  fetch(`${BASE}/api/admin/objects/${encodeURIComponent(key)}`,
    { method: "PUT", headers: { ...auth, "content-type": type }, body });
const book = (id, init = {}) =>
  fetch(`${BASE}/api/admin/books/${encodeURIComponent(id)}`, {
    ...init,
    headers: { "content-type": "application/json", ...auth, ...(init.headers ?? {}) },
  });
const jsonOf = async (res) => [res.status, await res.json().catch(() => ({}))];
// Content routes sit behind the reader gate: RKEY carries the key this suite
// mints for itself once the worker is up (an empty header set until then).
let RKEY = {};
const shelf = async () =>
  (await (await fetch(`${BASE}/api/books`, { headers: RKEY })).json()).books ?? [];
const resolve = async (slug) =>
  jsonOf(await fetch(`${BASE}/api/books/${encodeURIComponent(slug)}`, { headers: RKEY }));

// delete is a page per call, driven the way /admin drives it: ?sweep=1 on
// every round after the first says "keep going", so a call that finds nothing
// left finishes instead of 404ing. `expect` is the premise 修復 is acting on,
// re-checked server-side on the first call — no premise means a human typed the
// slug, which is its own.
async function delBook(id, expect) {
  let removed = 0, rounds = 0, status = 0, last = {};
  for (; rounds < 50; rounds++) {
    const q = rounds ? "?sweep=1" : expect ? `?expect=${expect}` : "";
    const res = await fetch(
      `${BASE}/api/admin/books/${encodeURIComponent(id)}${q}`,
      { method: "DELETE", headers: auth });
    status = res.status;
    last = await res.json().catch(() => ({}));
    removed += last.removed ?? 0;
    if (!res.ok || last.done) { rounds++; break; }
  }
  return { status, removed, rounds, positions: last.positions ?? 0, done: Boolean(last.done) };
}

const chapterFile = (i) => `${String(i).padStart(4, "0")}_第${i}章.txt`;
const chapterText = (i) => `第${i}章\n這是第 ${i} 章的內文。\n`;

// publish exactly the way the /admin page does: chapter files under the book
// ID, manifest last (it is what registers the book on the shelf)
async function publish(id, slug, title) {
  const chapters = [];
  for (let i = 1; i <= CHAPTERS; i++) {
    const file = chapterFile(i);
    const body = chapterText(i);
    await put(`${id}/${file}`, body);
    // bytes, like a real manifest: it is what the completeness check compares
    // against what R2 reports back
    chapters.push({
      title: `第${i}章`, file,
      chars: body.length, bytes: new TextEncoder().encode(body).length,
    });
  }
  const manifest = {
    id, slug, title, charset: "utf-8",
    totalChars: chapters.reduce((n, c) => n + c.chars, 0),
    chapters,
    generatedAt: new Date().toISOString(),
  };
  const res = await put(`${id}/manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n", "application/json");
  return [res.status, manifest];
}

const manifestOf = async (id) => {
  const res = await fetch(`${BASE}/books/${id}/manifest.json`, { headers: RKEY });
  return res.ok ? await res.json() : null;
};

// --- boot wrangler dev unless a worker was pointed at ---
let dev = null;
if (!process.env.BOOKWORM_URL) {
  dev = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(DEV_PORT)],
    { stdio: "ignore", env: { ...process.env, CI: "true" } });
}
const deadline = Date.now() + 60000;
while (true) {
  try {
    // the Bearer, not a bare fetch: /api/books 401s without a credential now
    if ((await fetch(`${BASE}/api/books`, { headers: auth })).ok) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) { dev?.kill(); throw new Error("worker never came up"); }
  await sleep(500);
}

// mint this suite its reader identity through the route /admin uses; every
// content fetch below rides the key, and positions land under its user
{
  const res = await fetch(`${BASE}/api/admin/readers`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ user: USER, label: "shelf-admin-e2e" }),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok || !r.key) { dev?.kill(); throw new Error(`minting a reader key failed: HTTP ${res.status}`); }
  RKEY = { "x-reader-key": r.key };
  // the gate itself: no key, no admin Bearer → 401, never content
  out.readerGate = (await fetch(`${BASE}/api/books`)).status === 401 &&
    (await fetch(`${BASE}/books/x/manifest.json`)).status === 401
    ? "ok (bare content requests 401)"
    : "FAIL: content answered without a key";
}

// ids and slugs are deliberately unrelated strings here: anything that still
// works when they are equal is exactly the bug this design removes
const ID = "b0e2e001", ID2 = "b0e2e002", ID3 = "b0e2e003";
const SRC = "zz", DEST = "zy", OTHER = "zx";
try {
  // clean slate: previous runs of this test, if any
  for (const id of [ID, ID2, ID3, SRC, DEST, OTHER]) await delBook(id);

  const [pubStatus, published] = await publish(ID, SRC, "測試書");
  await publish(ID2, OTHER, "另一本測試書");
  // a bookmark and a stray audio object: neither may be touched by a re-slug
  // the key decides whose bookmark this is (body.user is ignored now)
  await fetch(`${BASE}/api/position`, {
    method: "POST",
    headers: { "content-type": "application/json", ...RKEY },
    body: JSON.stringify({ book: ID, chapter: 3, offset: 5, updatedAt: Date.now() }),
  });
  await put(`_tts/${ID}/v1/${chapterFile(1)}/0.mp3`, "not really audio");

  // 1. publishing registers the book: the shelf knows it by id, and its slug
  //    resolves to that id (which is how every reader finds its files)
  const listed = (await shelf()).find((b) => b.id === ID);
  const [rStatus, resolved] = await resolve(SRC);
  out.publish = pubStatus === 200 && listed?.slug === SRC && listed.title === "測試書" &&
    listed.chapters === CHAPTERS && rStatus === 200 && resolved.book?.id === ID
    ? "ok (indexed on publish, slug resolves to the id)"
    : `FAIL ${pubStatus} ${JSON.stringify(listed)} resolve=${rStatus} ${JSON.stringify(resolved)}`;

  // 2. the routes are behind the same secret as the rest of /api/admin
  const noAuth = await Promise.all([
    fetch(`${BASE}/api/admin/books/${ID}`, { method: "DELETE" }),
    fetch(`${BASE}/api/admin/books/${ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ title: "駭進來的書名" }),
    }),
    fetch(`${BASE}/api/admin/reindex`, { method: "POST" }),
    fetch(`${BASE}/api/admin/audit`, { method: "POST" }),
    fetch(`${BASE}/api/admin/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "orphan-position", id: ID }),
    }),
  ]);
  out.auth = noAuth.every((r) => r.status === 401)
    ? "ok (401 without a valid key)"
    : `FAIL ${noAuth.map((r) => r.status).join("/")}`;

  // 3. PATCH retitles in place: same slug, same chapters, same generatedAt
  //    (it versions the chapter and audio caches — a new title busts neither)
  const [pStatus] = await jsonOf(await book(ID, {
    method: "PATCH", body: JSON.stringify({ title: "改過的書名" }),
  }));
  const retitled = await manifestOf(ID);
  out.retitle = pStatus === 200 && retitled?.title === "改過的書名" &&
    retitled.generatedAt === published.generatedAt &&
    retitled.chapters.length === CHAPTERS &&
    (await shelf()).find((b) => b.id === ID)?.title === "改過的書名"
    ? "ok (manifest + shelf, chapters and generatedAt untouched)"
    : `FAIL ${pStatus} ${JSON.stringify(retitled?.title)}`;

  // 4. guards: the alphabet, the reserved audio namespace, a slug another
  //    book already answers to, and a book that is not there
  const guards = await Promise.all([
    book(ID, { method: "PATCH", body: JSON.stringify({ title: "   " }) }),
    book(ID, { method: "PATCH", body: JSON.stringify({ slug: "has/slash" }) }),
    book(ID, { method: "PATCH", body: JSON.stringify({ slug: "_tts" }) }),
    book(ID, { method: "PATCH", body: JSON.stringify({ slug: "UPPER" }) }),
    book(ID, { method: "PATCH", body: JSON.stringify({ slug: OTHER }) }),
    book("nosuchbook", { method: "PATCH", body: JSON.stringify({ title: "x" }) }),
  ]);
  out.guards = guards.slice(0, 4).every((r) => r.status === 400) &&
    guards[4].status === 409 && guards[5].status === 404
    ? "ok (blank title/bad alphabet/reserved 400, taken slug 409, unknown book 404)"
    : `FAIL ${guards.map((r) => r.status).join("/")}`;

  // 5. the re-slug itself — ONE request, and nothing on disk moves. The old
  //    prefix IS the book, so every chapter, the bookmark and the audio cache
  //    stay exactly where they were.
  const [sStatus, saved] = await jsonOf(await book(ID, {
    method: "PATCH", body: JSON.stringify({ slug: DEST }),
  }));
  const ch3 = await fetch(`${BASE}/books/${ID}/${encodeURIComponent(chapterFile(3))}`, { headers: RKEY });
  const audio = await fetch(`${BASE}/books/_tts/${ID}/v1/${encodeURIComponent(chapterFile(1))}/0.mp3`, { headers: RKEY });
  const moved = await manifestOf(ID);
  const onShelf = (await shelf()).find((b) => b.id === ID);
  out.reslug = sStatus === 200 && saved.slug === DEST && moved?.slug === DEST &&
    onShelf?.slug === DEST && ch3.ok && (await ch3.text()) === chapterText(3) && audio.ok
    ? "ok (one request; chapters, audio and prefix untouched)"
    : `FAIL ${sStatus} ${JSON.stringify(saved)} shelf=${onShelf?.slug} ch3=${ch3.status} audio=${audio.status}`;

  // 6. both URLs resolve: the new slug and the one people already bookmarked
  const [newStatus, byNew] = await resolve(DEST);
  const [oldStatus, byOld] = await resolve(SRC);
  const [missStatus] = await resolve("nosuchslug");
  out.slugAlias = newStatus === 200 && byNew.book.id === ID && byNew.book.slug === DEST &&
    oldStatus === 200 && byOld.book.id === ID && byOld.book.slug === DEST &&
    missStatus === 404
    ? "ok (old slug still resolves, and reports the canonical one)"
    : `FAIL new=${newStatus}/${byNew.book?.id} old=${oldStatus}/${byOld.book?.id} miss=${missStatus}`;

  // 7. the bookmark never moved because it was never keyed by the slug — the
  //    whole reason the id exists
  const [, pos] = await jsonOf(
    await fetch(`${BASE}/api/position?book=${ID}`, { headers: RKEY }));
  const progress = (await (await fetch(`${BASE}/api/books`, { headers: RKEY })).json()).books
    ?.find((b) => b.id === ID)?.progress;
  // pct must be a real chars-before-bookmark sum, not 0 or a clamp at 100:
  // the shelf reads it from D1 but computes it from the manifest
  out.bookmarkKept = pos.position?.chapter === 3 && pos.position?.char_off === 5 &&
    progress?.chapter === 3 && progress.pct > 0 && progress.pct < 100
    ? `ok (chapter 3 / char 5 intact, shelf shows ${progress.pct}%)`
    : `FAIL ${JSON.stringify(pos)} progress=${JSON.stringify(progress)}`;

  // 8. reindex rebuilds the shelf from the bucket: it is the repair path for
  //    a D1 that has drifted, and the migration path for books published
  //    before the index existed (their prefix simply becomes their id)
  d1("DELETE FROM books; DELETE FROM book_slugs; " +
    "INSERT INTO books (id, slug, title) VALUES ('b0eghost', 'ghost', '不存在的書')");
  const emptied = await shelf();
  let rr = {};
  for (let round = 0; !rr.done && round < 20; round++) {
    [, rr] = await jsonOf(await fetch(`${BASE}/api/admin/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ cursor: rr.cursor, runAt: rr.runAt, indexed: rr.indexed }),
    }));
  }
  const rebuilt = await shelf();
  const [, reResolved] = await resolve(DEST);
  out.reindex = emptied.every((b) => b.id === "b0eghost") &&
    rr.done && rebuilt.some((b) => b.id === ID && b.slug === DEST) &&
    rebuilt.some((b) => b.id === ID2) && !rebuilt.some((b) => b.id === "b0eghost") &&
    reResolved.book?.id === ID
    ? `ok (${rr.indexed} books re-indexed from manifests, ${rr.pruned} stale row(s) pruned)`
    : `FAIL ${JSON.stringify(rr)} shelf=${JSON.stringify(rebuilt.map((b) => b.id + ":" + b.slug))}`;
  // the alias is index-only state, so a rebuild-from-manifests loses it —
  // the canonical slug is the one the manifest carries. Documented, not a bug.
  const [aliasAfter] = await resolve(SRC);
  out.aliasAfterReindex = aliasAfter === 404
    ? "ok (former slugs are index state; a rebuild keeps only the canonical one)"
    : `FAIL ${aliasAfter}`;

  // 9. a book published under a slug someone else already answers to is
  //    refused outright, rather than quietly shadowing them
  const [dupStatus] = await publish(ID3, DEST, "冒名頂替");
  const dupListed = (await shelf()).some((b) => b.id === ID3);
  out.slugConflict = dupStatus === 409 && !dupListed
    ? "ok (409, and nothing lands on the shelf)"
    : `FAIL ${dupStatus} listed=${dupListed}`;
  await delBook(ID3);

  // 10. delete takes the objects, the index rows and the bookmarks; a repeat
  //     delete is a clean 404, not a 500 and not a silent success
  const del = await delBook(ID);
  const delAgain = await jsonOf(await book(ID, { method: "DELETE" }));
  const gone = await fetch(`${BASE}/books/${ID}/manifest.json`, { headers: RKEY });
  const goneChapter = await fetch(`${BASE}/books/${ID}/${encodeURIComponent(chapterFile(3))}`, { headers: RKEY });
  const [goneResolve] = await resolve(DEST);
  const [, posGone] = await jsonOf(
    await fetch(`${BASE}/api/position?book=${ID}`, { headers: RKEY }));
  out.delete = del.done && del.removed === CHAPTERS + 2 && del.positions === 1 &&
    delAgain[0] === 404 && gone.status === 404 && goneChapter.status === 404 &&
    goneResolve === 404 && posGone.position === null &&
    !(await shelf()).some((b) => b.id === ID)
    ? `ok (${del.removed} objects + ${del.positions} bookmark in ${del.rounds} rounds, repeat delete 404s)`
    : `FAIL ${JSON.stringify(del)} again=${delAgain[0]} manifest=${gone.status} chapter=${goneChapter.status} resolve=${goneResolve}`;

  // 11. 健康檢查: it has to find every way data can become unreachable, and —
  //     the part worth testing — must NOT offer to delete anything belonging to
  //     a book that is merely missing its index row. Nothing repairs anything
  //     first: the check runs on the mess as found, which is the whole point of
  //     it being a phase of its own.
  const ORPH = "b0e2eorph", GONE = "b0e2egone", GHOST = "b0e2eghost";
  const STRAY = "b0e2e-stray.txt";
  await put(`${ORPH}/${chapterFile(1)}`, chapterText(1));      // upload that stopped early
  await put(`_tts/${GONE}/v1/${chapterFile(1)}/0.mp3`, "x");   // audio for a deleted book
  await put(STRAY, "loose");                                   // object at the bucket root
  // Two dead books' worth of pointers. GHOST is the one that used to slip
  // through: it still HOLDS its index row, so its slug and its bookmarks passed
  // a `book NOT IN (SELECT id FROM books)` test and went unreported until a
  // reindex pruned the row out from under them. Nothing has been pruned here.
  d1(`INSERT OR REPLACE INTO books (id, slug, title) VALUES ('${GHOST}', 'ghostslug', '沒有檔案的書');
      INSERT OR REPLACE INTO book_slugs (slug, book) VALUES ('ghostslug', '${GHOST}');
      INSERT OR REPLACE INTO book_slugs (slug, book) VALUES ('deadslug', '${GHOST}2');
      INSERT OR REPLACE INTO positions (book, user, chapter, char_off, updated_at)
        VALUES ('${GHOST}', '${USER}', 1, 0, 1);
      INSERT OR REPLACE INTO positions (book, user, chapter, char_off, updated_at)
        VALUES ('${GHOST}2', '${USER}', 1, 0, 1)`);
  // …and a book that IS fine but has no index row: its slug and its bookmarks
  // must survive the check untouched (reindex is what it needs, not a broom)
  d1(`DELETE FROM books WHERE id = '${ID2}'`);

  let ar = {};
  for (let round = 0; !ar.done && round < 60; round++) {
    [, ar] = await jsonOf(await fetch(`${BASE}/api/admin/audit`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        phase: ar.phase, cursor: ar.cursor, offset: ar.offset,
        findings: ar.findings, dropped: ar.dropped,
      }),
    }));
  }
  const found = (kind, id) => (ar.findings ?? []).some((f) => f.kind === kind && f.id === id);
  out.audit = ar.done &&
    found("orphan-files", ORPH) && found("orphan-audio", GONE) &&
    found("stray-object", STRAY) && found("ghost-book", GHOST) &&
    found("orphan-slug", "deadslug") && found("orphan-position", `${GHOST}2`) &&
    found("unindexed", ID2) &&
    !found("orphan-slug", OTHER) && !found("orphan-position", ID2)
    ? "ok (all six kinds found; an unindexed book's slug and bookmarks are not touched)"
    : `FAIL ${JSON.stringify(ar.findings)}`;

  // the ordering bug, named: a ghost book's leftovers, found while its index
  // row is still sitting there. No reindex has run, and the check does not need
  // one — it asks the bucket whether the files are there, which is the only
  // question that was ever being asked.
  out.auditNeedsNoRepair =
    found("orphan-slug", "ghostslug") && found("orphan-position", GHOST)
    ? "ok (a ghost book's slug and bookmarks found without pruning its row first)"
    : `FAIL ${JSON.stringify((ar.findings ?? []).filter((f) => f.id === GHOST || f.id === "ghostslug"))}`;

  // and it changed nothing on the way through: still no row for ID2, and the
  // ghost's row is still there. A check that repairs cannot be trusted to
  // report, because you can never tell which of the two you are reading.
  const afterCheck = (await shelf()).map((b) => b.id);
  const ghostRow = JSON.parse(d1(`SELECT id FROM books WHERE id = '${GHOST}'`));
  out.auditReadOnly = !afterCheck.includes(ID2) &&
    (ghostRow[0]?.results ?? []).length === 1
    ? "ok (read-only: it fixed nothing while looking)"
    : `FAIL shelf=${JSON.stringify(afterCheck)} ghostRow=${JSON.stringify(ghostRow[0]?.results)}`;

  // the guard, from the other side: asking to clear a live book's rows fails
  const guardPos = await fetch(`${BASE}/api/admin/cleanup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ kind: "orphan-position", id: ID2 }),
  });
  const clear = async (kind, id) => jsonOf(await fetch(`${BASE}/api/admin/cleanup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ kind, id }),
  }));
  const [, slugCleared] = await clear("orphan-slug", "deadslug");
  const [, posCleared] = await clear("orphan-position", `${GHOST}2`);
  // the ghost's own leftovers, cleared while its index row is STILL there —
  // the manifest check is the whole guard now, so this must not need a reindex
  // to have run first any more than finding them did
  const [, ghostSlug] = await clear("orphan-slug", "ghostslug");
  const [, ghostPos] = await clear("orphan-position", GHOST);
  const orphSwept = await delBook(ORPH, "gone");
  const goneSwept = await delBook(GONE, "gone");
  await fetch(`${BASE}/api/admin/objects/${encodeURIComponent(STRAY)}`,
    { method: "DELETE", headers: auth });

  let ar2 = {};
  for (let round = 0; !ar2.done && round < 60; round++) {
    [, ar2] = await jsonOf(await fetch(`${BASE}/api/admin/audit`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({
        phase: ar2.phase, cursor: ar2.cursor, offset: ar2.offset,
        findings: ar2.findings, dropped: ar2.dropped,
      }),
    }));
  }
  const left = (ar2.findings ?? []).filter((f) =>
    [ORPH, GONE, STRAY, "deadslug", "ghostslug", GHOST, `${GHOST}2`].includes(f.id) &&
    f.kind !== "ghost-book"); // GHOST's row is reindex's to prune, not a broom's
  out.auditCleanup = guardPos.status === 409 &&
    slugCleared.removed === 1 && posCleared.removed === 1 &&
    ghostSlug.removed === 1 && ghostPos.removed === 1 &&
    orphSwept.done && goneSwept.done && !left.length
    ? "ok (cleared, and a live book's bookmarks refuse to be cleared)"
    : `FAIL guard=${guardPos.status} slug=${JSON.stringify(slugCleared)} pos=${JSON.stringify(posCleared)} ghost=${JSON.stringify(ghostSlug)}/${JSON.stringify(ghostPos)} left=${JSON.stringify(left)}`;

  // 12. the completeness check: the shelf's chapter count comes from the
  //     manifest, which is the uploader's claim. This is the only thing that
  //     ever compares that claim with the bucket — in both directions.
  const [, whole] = await publish(ID3, "zc", "完整性測試");
  await fetch(
    `${BASE}/api/admin/objects/${encodeURIComponent(`${ID3}/${chapterFile(2)}`)}`,
    { method: "DELETE", headers: auth });                       // a chapter goes missing
  await put(`${ID3}/${chapterFile(1)}`, "short");               // and one is truncated
  await put(`${ID3}/9999_leftover.txt`, "from an older split"); // and one is left over
  // and the enrichment pair rides along — cover and meta sidecar are
  // first-class book files the sweep must NOT count as stale (their
  // exemptions are what keeps `stale.files` at exactly 1 below)
  await put(`${ID3}/cover.jpg`, "not-a-real-jpeg", "image/jpeg");
  await put(`${ID3}/meta.json`, JSON.stringify({ author: "審計測試" }), "application/json");

  const runCheck = async () => {
    let r = {};
    for (let round = 0; !r.done && round < 60; round++) {
      [, r] = await jsonOf(await fetch(`${BASE}/api/admin/audit`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          phase: r.phase, cursor: r.cursor, offset: r.offset,
          findings: r.findings, dropped: r.dropped,
        }),
      }));
    }
    return r;
  };

  const cr = await runCheck();
  const broken = (cr.findings ?? []).find((f) => f.kind === "incomplete-book" && f.id === ID3);
  const stale = (cr.findings ?? []).find((f) => f.kind === "stale-file" && f.id === ID3);
  out.completeness = broken?.missing === 1 && broken.wrongSize === 1 &&
    broken.chapters === CHAPTERS && stale?.files === 1
    ? `ok (1 missing, 1 wrong size, 1 leftover; cover+meta exempt — out of ${CHAPTERS} chapters)`
    : `FAIL ${JSON.stringify(broken)} ${JSON.stringify(stale)}`;

  // 12b. the case that motivated all of this: the index row is gone and the
  //      damaged files are still there. Counting chapters used to happen inside
  //      the rebuild, because the chapter pass walked `books` rows and a book
  //      with no row was the one kind it could not look at — so the only way to
  //      see this damage was to repair the index first. The pass walks bucket
  //      prefixes now, so the read-only check sees it on its own.
  d1(`DELETE FROM books WHERE id = '${ID3}'`);
  const nr = await runCheck();
  const unseen = (kind) => (nr.findings ?? []).find((f) => f.kind === kind && f.id === ID3);
  const stillOffShelf = !(await shelf()).some((b) => b.id === ID3);
  out.checksUnindexedBooks = unseen("incomplete-book")?.missing === 1 &&
    unseen("incomplete-book").wrongSize === 1 &&
    unseen("incomplete-book").chapters === CHAPTERS &&
    unseen("unindexed") && stillOffShelf
    ? "ok (a book the shelf never heard of gets its chapters counted, and stays off it)"
    : `FAIL ${JSON.stringify((nr.findings ?? []).filter((f) => f.id === ID3))} offShelf=${stillOffShelf}`;

  // and the rebuild puts it back saying nothing about chapters: diagnosis moved
  // out of the writing step entirely, which is the point of the split
  let rr2 = {};
  for (let round = 0; !rr2.done && round < 20; round++) {
    [, rr2] = await jsonOf(await fetch(`${BASE}/api/admin/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ cursor: rr2.cursor, runAt: rr2.runAt, indexed: rr2.indexed, notes: rr2.notes }),
    }));
  }
  const backOnShelf = (await shelf()).some((b) => b.id === ID3);
  out.reindexOnlyWrites = backOnShelf &&
    (rr2.notes ?? []).every((n) => n.code === "slug-taken")
    ? "ok (restored; the only thing it reports is a collision it alone can see)"
    : `FAIL ${JSON.stringify(rr2.notes)} onShelf=${backOnShelf}`;

  // 12b2. a manifest that will not parse: as unreachable as having none, and
  //       the books phase only HEADs the manifest, so this is the one finding
  //       that has to come out of the pass that actually reads it.
  const CORRUPT = "b0e2ecorrupt";
  await put(`${CORRUPT}/${chapterFile(1)}`, chapterText(1));
  r2put(`${CORRUPT}/manifest.json`, "{not json");
  const br = await runCheck();
  const corrupt = (br.findings ?? []).find((f) => f.kind === "bad-manifest" && f.id === CORRUPT);
  // and it is refused the wrong premise: this book HAS a manifest, so a sweep
  // calling itself "the files are gone" must not be believed
  const wrongPremise = await fetch(
    `${BASE}/api/admin/books/${encodeURIComponent(CORRUPT)}?expect=gone`,
    { method: "DELETE", headers: auth });
  const corruptSwept = await delBook(CORRUPT, "bad-manifest");
  out.badManifest = corrupt?.files === 2 && wrongPremise.status === 409 &&
    corruptSwept.done && !(await runCheck()).findings.some((f) => f.id === CORRUPT)
    ? "ok (found by the pass that reads it, refused the wrong premise, then swept)"
    : `FAIL ${JSON.stringify(corrupt)} wrongPremise=${wrongPremise.status} swept=${JSON.stringify(corruptSwept)}`;

  // 12c. an incomplete book is deleted, not kept — but only after the server
  //      has checked the claim itself. A complete book handed the same
  //      "this one is incomplete" reason must be refused, because the finding
  //      that produced it was made in an earlier request and may be stale.
  const guarded = await fetch(
    `${BASE}/api/admin/books/${encodeURIComponent(ID2)}?expect=incomplete`,
    { method: "DELETE", headers: auth });
  const ID2Alive = await manifestOf(ID2);
  out.incompleteGuard = guarded.status === 409 && ID2Alive?.chapters.length === CHAPTERS
    ? "ok (409 for a book that is actually whole, and it is still there)"
    : `FAIL ${guarded.status} chapters=${ID2Alive?.chapters.length}`;

  // clearing the leftovers must not touch the chapters the manifest DOES
  // name — nor the enrichment pair, which no manifest ever names
  const [, staleCleared] = await clear("stale-file", ID3);
  const survivor = await fetch(`${BASE}/books/${ID3}/${encodeURIComponent(chapterFile(3))}`, { headers: RKEY });
  const leftover = await fetch(`${BASE}/books/${ID3}/9999_leftover.txt`, { headers: RKEY });
  const coverKept = await fetch(`${BASE}/books/${ID3}/cover.jpg`, { headers: RKEY });
  const metaKept = await fetch(`${BASE}/books/${ID3}/meta.json`, { headers: RKEY });
  const stillListed = (await shelf()).some((b) => b.id === ID3);
  const stillManifest = (await manifestOf(ID3))?.chapters.length === CHAPTERS;
  out.staleCleanup = staleCleared.removed === 1 && staleCleared.done &&
    survivor.ok && leftover.status === 404 && coverKept.ok && metaKept.ok &&
    stillListed && stillManifest
    ? "ok (leftover gone; the book, its manifest, its cover and its meta untouched)"
    : `FAIL ${JSON.stringify(staleCleared)} ch3=${survivor.status} leftover=${leftover.status} cover=${coverKept.status} meta=${metaKept.status} listed=${stillListed} manifest=${stillManifest}`;

  // and the manifest carries per-chapter byte sizes, which is what makes the
  // wrong-size half of that check possible at all
  out.manifestBytes = whole.chapters.every((c) => Number.isFinite(c.bytes) && c.bytes > 0)
    ? "ok (every chapter records its byte size)"
    : `FAIL ${JSON.stringify(whole.chapters[0])}`;

  // and the incomplete book itself goes, the way 修復 sends it: the premise on
  // the first call, ?sweep=1 after
  const swept3 = await delBook(ID3, "incomplete");
  out.incompleteSwept = swept3.removed > 0 && !(await shelf()).some((b) => b.id === ID3) &&
    (await manifestOf(ID3)) === null
    ? `ok (${swept3.removed} objects, off the shelf)`
    : `FAIL ${JSON.stringify(swept3)}`;

  // 12d. and the last thing the check owes anyone: after all of that, run it
  //      once more and it comes back with nothing. A complete check's silence is
  //      the verdict 修復 is proved by — so it has to be worth something.
  const finalCheck = await runCheck();
  const mine = (finalCheck.findings ?? []).filter((f) =>
    String(f.id).startsWith("b0e2e") || String(f.book ?? "").startsWith("b0e2e"));
  out.checkComesBackClean = finalCheck.done && !mine.length
    ? "ok (nothing left of everything this run broke)"
    : `FAIL ${JSON.stringify(mine)} dropped=${finalCheck.dropped}`;

  await delBook(GHOST);
  await delBook(ID2);
  // the key this run minted goes too — runs must not pile up rows
  if (RKEY["x-reader-key"])
    await fetch(`${BASE}/api/admin/readers/${encodeURIComponent(RKEY["x-reader-key"])}`,
      { method: "DELETE", headers: auth });
} finally {
  dev?.kill();
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
