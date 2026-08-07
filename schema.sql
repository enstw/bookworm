-- The shelf index: one row per book, keyed by the immutable book id, which is
-- also the R2 prefix its chapter files live under. Everything here is derived
-- from that book's manifest.json (the source of truth) and rebuildable with
-- POST /api/admin/reindex — so a lost or drifted index is a repair, not a
-- restore. indexed_at is stamped by each reindex run; rows left with an older
-- stamp at the end of a run are books whose files are gone, and get pruned.
CREATE TABLE IF NOT EXISTS books (
  id          TEXT PRIMARY KEY,
  slug        TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  chapters    INTEGER NOT NULL DEFAULT 0,
  total_chars INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL DEFAULT 0
);

-- Every URL a book answers to → its id. The book's current slug is in
-- books.slug; the rows that are not it are its former slugs, kept so that
-- re-slugging never breaks a bookmark or a link someone shared. Dropped with
-- the book, and pruned when reindex finds no book behind them.
CREATE TABLE IF NOT EXISTS book_slugs (
  slug       TEXT PRIMARY KEY,
  book       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Reading positions, one row per (book, user), where book is the book ID —
-- a bookmark outlives every rename and re-slug because nothing it points at
-- can change. (Books published before ids existed have id = their original
-- slug, so those rows kept working untouched.)
CREATE TABLE IF NOT EXISTS positions (
  book       TEXT    NOT NULL,
  user       TEXT    NOT NULL,
  chapter    INTEGER NOT NULL DEFAULT 0,
  char_off   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book, user)
);

-- Reader settings (直排/字級/背景色), one JSON blob per user, LWW by
-- updated_at. A blob rather than columns: this file is re-applied verbatim on
-- every deploy with no ALTER path, so future synced settings must not need a
-- schema change. The worker re-serializes only known fields on write.
CREATE TABLE IF NOT EXISTS settings (
  user       TEXT PRIMARY KEY,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- On-device readouts from the diagnostic pages (/pgtest, /vhtest,
-- /scrolltest — linked from /admin) and the service worker's push
-- breadcrumbs: each row is one uploaded readout, so the laptop can curl the
-- phone's results (GET /api/testlog) instead of trading screenshots.
-- Self-pruned to the newest 500 rows on write.
CREATE TABLE IF NOT EXISTS testlog (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  page   TEXT    NOT NULL,
  device TEXT    NOT NULL DEFAULT '',
  ts     INTEGER NOT NULL DEFAULT 0,
  data   TEXT    NOT NULL
);

-- 改進建議 (the feedback queue): improvement notes the owner writes from
-- /admin, for an AI dev session to read back through the unauthenticated
-- GET /api/feedback — no admin key changes hands. Add: admin only. Clear: no
-- route at all — deploy.sh re-applies this file on every deploy, so the
-- DELETE below empties the queue; a note that can still be read is a
-- suggestion that has not shipped yet.
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
DELETE FROM feedback;

-- Reader keys: possession of a key IS the reading identity. Each row is one
-- device credential mapping a bearer key to the user whose positions and
-- settings it reads and writes; several keys may share a user (one per
-- device, so a lost phone costs one revoked row, not a re-keyed family).
-- Created, re-shown and revoked only on /admin. Stored in the clear on
-- purpose: /admin re-showing a key to a wiped device is a feature, and
-- anyone who can read this table already has every book and bookmark.
-- Persistent like positions — no DELETE here, rows survive every deploy.
CREATE TABLE IF NOT EXISTS readers (
  key        TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Builds that have already been announced by push (新版本已上線 — see
-- announceBuild in the worker). Keyed on the COMMIT alone, not the whole
-- stamp: re-running the deploy workflow on the same commit restamps the
-- clock but is the same version, and a rollback lands on a build that
-- already rang. Persistent like readers and positions — no DELETE here, or
-- every deploy would re-announce the build it just wrote.
CREATE TABLE IF NOT EXISTS announced_builds (
  build      TEXT PRIMARY KEY,
  stamp      TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

-- Web Push subscriptions (新書上架、新版本通知), one row per browser push
-- endpoint, registered from the library footer. Rows are dropped when the
-- push service reports the endpoint gone (404/410) or the user unsubscribes.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user       TEXT NOT NULL DEFAULT '',
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
