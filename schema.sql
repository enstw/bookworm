-- The shelf index: one row per book, keyed by the immutable book id, which is
-- also the R2 prefix its chapter files live under. Everything here is derived
-- from that book's manifest.json (the source of truth) plus its meta.json
-- enrichment sidecar (the author line), and rebuildable with
-- POST /api/admin/reindex — so a lost or drifted index is a repair, not a
-- restore. indexed_at is stamped by each reindex run; rows left with an older
-- stamp at the end of a run are books whose files are gone, and get pruned.
-- NOTE: IF NOT EXISTS never alters a live table — a new column here must also
-- be backfilled by the guarded ALTER in deploy.sh (see books.author there).
CREATE TABLE IF NOT EXISTS books (
  id          TEXT PRIMARY KEY,
  slug        TEXT    NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  author      TEXT    NOT NULL DEFAULT '',
  chapters    INTEGER NOT NULL DEFAULT 0,
  total_chars INTEGER NOT NULL DEFAULT 0,
  -- JSON array of per-chapter char counts, so listBooks can sum a reader's
  -- progress without an R2 manifest read per book. '' on rows from before
  -- the column: listBooks falls back to the manifest, a republish or
  -- reindex fills it in.
  chapter_chars TEXT  NOT NULL DEFAULT '',
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
-- Self-pruned on write to a quota PER PAGE (TESTLOG_PAGES in src/worker.js),
-- summing to the same 500 rows it used to hold as one shared window — a
-- shared window is won by whichever page writes fastest, which is never the
-- one worth keeping.
CREATE TABLE IF NOT EXISTS testlog (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  page   TEXT    NOT NULL,
  device TEXT    NOT NULL DEFAULT '',
  ts     INTEGER NOT NULL DEFAULT 0,
  data   TEXT    NOT NULL
);
-- Both readers walk one page newest-first: the GET above and the per-page
-- prune's window function. Without this they scan the table.
CREATE INDEX IF NOT EXISTS testlog_page_id ON testlog (page, id DESC);

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
  created_at INTEGER NOT NULL DEFAULT 0,
  -- The owner's devices: the audience for the messages that are the
  -- owner's business and nobody else's (an update waiting for a decision,
  -- an install rolled back, a silent updater). On the key, not the user —
  -- a household may share a user and the owner may carry two phones. With
  -- no key flagged those messages go nowhere, never to everyone.
  is_owner   INTEGER NOT NULL DEFAULT 0
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

-- The updater's report to the reader, one row (id = 1). bookworm-updater is
-- cron-only and holds the one trust relationship with upstream; it writes
-- here what it last saw, and /admin reads it (never contacting upstream
-- itself — see docs/pull-mode-updates.md, "What /admin shows"). Both Workers
-- bind the same D1, which is what carries the report across the split.
-- last_check_ok distinguishes fresh data from stale: on a failed check only
-- last_check_at/ok/detail move, so upstream_version keeps the last known-good
-- rather than being erased by a transient outage. Persistent like readers —
-- no DELETE here, or every deploy would forget what upstream last offered.
-- The last_install_* columns are the outcome of the guarded install (PM-07):
-- 'ok', 'rolled-back' (the release failed its health check and the previous
-- version was put back), or 'failed'. A rolled-back install stays on the
-- panel — a push that scrolls away is not a record. Added after this table
-- first shipped, so scripts/deploy.sh carries the guarded ALTERs too.
CREATE TABLE IF NOT EXISTS updater_status (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  last_check_at        INTEGER NOT NULL DEFAULT 0,
  last_check_ok        INTEGER NOT NULL DEFAULT 0,
  upstream_version     TEXT    NOT NULL DEFAULT '',
  upstream_released_at TEXT    NOT NULL DEFAULT '',
  detail               TEXT    NOT NULL DEFAULT '',
  last_install_at      INTEGER NOT NULL DEFAULT 0,
  last_install_version TEXT    NOT NULL DEFAULT '',
  last_install_result  TEXT    NOT NULL DEFAULT '',
  last_install_detail  TEXT    NOT NULL DEFAULT '',
  -- the updater's own version (UPDATER_VERSION), written on every check, shown
  -- on /admin beside the running and upstream ones so a minUpdaterVersion
  -- refusal (PM-16) names a number the owner can look up.
  updater_version      INTEGER NOT NULL DEFAULT 0
);

-- The update policy (PM-08), set from /admin by the owner and read by the
-- updater's decide() (PM-15). One row. mode is automatic | notify | pinned;
-- soak_days is the wait before an automatic install. install_now_* is the
-- notify-mode "install now" request, queued through D1 rather than opening a
-- callable surface on the updater — it picks the request up on its next check.
-- Seeded with the shipped default (automatic, 2 days) and kept across deploys.
CREATE TABLE IF NOT EXISTS updater_policy (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  mode                TEXT    NOT NULL DEFAULT 'automatic',
  soak_days           INTEGER NOT NULL DEFAULT 2,
  install_now_version TEXT    NOT NULL DEFAULT '',
  install_now_at      INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO updater_policy (id) VALUES (1);

-- The install lock (PM-15): one row, so an overrunning cron and a queued
-- install-now cannot interleave — at most one install runs at a time.
-- acquireInstallLock() is a conditional UPDATE whose row-count is the verdict
-- (atomic in the DB, not a read-then-write race); held_at 0 is free, and a
-- lock older than the stale window is reclaimed so a died-mid-install isolate
-- cannot wedge the updater. The row is seeded here and kept across deploys
-- (INSERT OR IGNORE never resets a held lock).
CREATE TABLE IF NOT EXISTS install_lock (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  held_at INTEGER NOT NULL DEFAULT 0,
  holder  TEXT    NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO install_lock (id, held_at, holder) VALUES (1, 0, '');

-- Web Push subscriptions (新書上架、新版本通知), one row per browser push
-- endpoint, registered from the library footer. Rows are dropped when the
-- push service reports the endpoint gone (404/410) or the user unsubscribes.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user       TEXT NOT NULL DEFAULT '',
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  -- The reader key that registered the endpoint — what lets
  -- readers.is_owner pick out a DEVICE rather than everyone sharing its
  -- user. '' on rows the admin Bearer wrote (scripts, tests) and on rows
  -- from before the column; healPush() re-upserts every phone's row at each
  -- open, so the field fills itself in without a migration.
  key        TEXT NOT NULL DEFAULT ''
);
