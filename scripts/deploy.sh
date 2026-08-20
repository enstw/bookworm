#!/usr/bin/env bash
# Non-interactive Cloudflare deploy. Credentials come from .deploy.env when
# present (local use — see .deploy.env.example) or from the environment
# (GitHub Actions, which gets them from repo secrets).
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .deploy.env ]] && { set -a; source .deploy.env; set +a; }
: "${CLOUDFLARE_API_TOKEN:?set in .deploy.env or the environment}"
: "${CLOUDFLARE_ACCOUNT_ID:?set in .deploy.env or the environment}"
: "${ADMIN_TOKEN:?set in .deploy.env or the environment}"
export CI=true   # keep wrangler non-interactive

W="pnpm exec wrangler"

echo "==> verifying API token"
# Captured, not printed: whoami names the Cloudflare account's EMAIL, and a
# fork's Actions log is world-readable on a public repo. Its only job here is
# to fail early on a bad token, so the output is only interesting when it does.
if ! WHOAMI=$($W whoami 2>&1); then
  echo "$WHOAMI" >&2
  exit 1
fi
echo "    token ok"

echo "==> ensuring D1 database 'bookworm'"
if ! $W d1 list --json | grep -q '"name": *"bookworm"'; then
  $W d1 create bookworm
fi
DB_ID=$($W d1 list --json | python3 -c \
  'import json,sys; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="bookworm"))')
# Point both Worker configs at THIS account's database — the reader and the
# updater bind the same D1 (that shared binding is what carries the updater's
# report to /admin). The id is committed, so a fresh clone carries the
# original author's — rewrite whatever is there, not just the placeholder, or
# every self-install would stop at the check below.
# portable in-place sed (BSD sed needs -i '', GNU sed needs -i without arg)
for CONFIG in wrangler.jsonc wrangler.updater.jsonc; do
  if ! grep -q "\"database_id\": \"${DB_ID}\"" "$CONFIG"; then
    sed -i.bak -E "s/(\"database_id\"): *\"[^\"]*\"/\1: \"${DB_ID}\"/" "$CONFIG"
    rm -f "${CONFIG}.bak"
    echo "    (rewrote database_id in ${CONFIG} — commit it to keep diffs quiet)"
  fi
  grep -q "\"database_id\": \"${DB_ID}\"" "$CONFIG" || {
    echo "error: ${CONFIG} does not carry database_id ${DB_ID}" >&2
    exit 1
  }
done
echo "    database_id = ${DB_ID}"

echo "==> ensuring R2 bucket 'bookworm-books'"
if OUT=$($W r2 bucket create bookworm-books 2>&1); then
  echo "    created"
elif grep -qi "already exists" <<<"$OUT"; then
  echo "    (already exists)"
else
  echo "$OUT" >&2
  echo "hint: if this says R2 is not enabled, activate R2 once in the dashboard" >&2
  echo "      (it may ask for billing info; the free tier still costs \$0)" >&2
  exit 1
fi

echo "==> applying schema.sql to remote D1"
$W d1 execute bookworm --remote --file=schema.sql

# schema.sql is CREATE TABLE IF NOT EXISTS — re-applied every deploy, it can
# never ALTER a table that already exists. Columns added to a live table get
# backfilled here, each behind its own PRAGMA probe so the step is idempotent.
# (Captured into a variable, not piped: grep -q closing a pipe early would
# trip pipefail on a probe that actually matched.)
echo "==> ensuring books.author column"
COLS=$($W d1 execute bookworm --remote --json --command "PRAGMA table_info(books)")
if grep -q '"author"' <<<"$COLS"; then
  echo "    (already present)"
else
  $W d1 execute bookworm --remote --command \
    "ALTER TABLE books ADD COLUMN author TEXT NOT NULL DEFAULT ''"
  echo "    added"
fi

echo "==> ensuring books.chapter_chars column"
if grep -q '"chapter_chars"' <<<"$COLS"; then
  echo "    (already present)"
else
  $W d1 execute bookworm --remote --command \
    "ALTER TABLE books ADD COLUMN chapter_chars TEXT NOT NULL DEFAULT ''"
  echo "    added"
fi

# the owner-only push channel (readers.is_owner / push_subs.key in
# schema.sql): both columns have to exist before the worker that reads them
# serves, which is why they are added here, ahead of the deploy below
echo "==> ensuring readers.is_owner column"
RCOLS=$($W d1 execute bookworm --remote --json --command "PRAGMA table_info(readers)")
if grep -q '"is_owner"' <<<"$RCOLS"; then
  echo "    (already present)"
else
  $W d1 execute bookworm --remote --command \
    "ALTER TABLE readers ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0"
  echo "    added"
fi

echo "==> ensuring push_subs.key column"
PCOLS=$($W d1 execute bookworm --remote --json --command "PRAGMA table_info(push_subs)")
if grep -q '"key"' <<<"$PCOLS"; then
  echo "    (already present)"
else
  $W d1 execute bookworm --remote --command \
    "ALTER TABLE push_subs ADD COLUMN key TEXT NOT NULL DEFAULT ''"
  echo "    added"
fi

# the guarded install's outcome columns (PM-07) — added after updater_status
# first shipped, so they need the ALTER dance like every other live-table
# column. The table itself is created by schema.sql above on a fresh install.
echo "==> ensuring updater_status install columns"
UCOLS=$($W d1 execute bookworm --remote --json --command "PRAGMA table_info(updater_status)")
for col in \
  "last_install_at INTEGER NOT NULL DEFAULT 0" \
  "last_install_version TEXT NOT NULL DEFAULT ''" \
  "last_install_result TEXT NOT NULL DEFAULT ''" \
  "last_install_detail TEXT NOT NULL DEFAULT ''"; do
  name=${col%% *}
  if grep -q "\"${name}\"" <<<"$UCOLS"; then
    echo "    (${name} already present)"
  else
    $W d1 execute bookworm --remote --command "ALTER TABLE updater_status ADD COLUMN ${col}"
    echo "    added ${name}"
  fi
done

echo "==> vendoring browser bundles (public/vendor/ is gitignored)"
node scripts/vendor.mjs

echo "==> stamping build version into app.js and worker.js"
# only when the files are clean in git, so the stamp (and nothing else) can be
# reverted on exit — local deploys with in-progress edits ship "dev". The
# worker carries the same stamp so /api/version can tell a running shell that
# a newer one exists.
if git diff --quiet -- public/app.js src/worker.js 2>/dev/null; then
  # The one formula lives in scripts/build-id.mjs (commit time, Asia/Taipei —
  # the why is there). The release manifest's `version` comes from the same
  # function, and an updater compares the two strings verbatim, so a second
  # formula here would be a fleet-wide "update available" that never clears.
  # Announcements do not notice — announceSelf keys its exactly-once record on
  # the short SHA alone (src/worker.js), never on this timestamp.
  BUILD_ID="$(node scripts/build-id.mjs)"
  sed -i.bak "s/^const BUILD = \"dev\"/const BUILD = \"${BUILD_ID}\"/" public/app.js src/worker.js
  rm -f public/app.js.bak src/worker.js.bak
  trap 'git checkout -- public/app.js src/worker.js' EXIT
  echo "    BUILD = ${BUILD_ID}"
else
  echo "    (local edits present — shipping BUILD as-is)"
fi

echo "==> deploying worker"
DEPLOY_OUT=$($W deploy | tee /dev/stderr)
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' <<<"$DEPLOY_OUT" | head -1)

echo "==> pushing ADMIN_TOKEN secret"
printf '%s' "$ADMIN_TOKEN" | $W secret put ADMIN_TOKEN

# The second Worker (docs/pull-mode-updates.md, PM-04): cron-only, no fetch
# handler, binds the same D1. It is deployed here so the two-Worker topology
# exists on every instance from the first deploy. UPDATER=pnpm exec wrangler
# --config wrangler.updater.jsonc targets it for both deploy and secrets.
UPDATER="$W --config wrangler.updater.jsonc"
echo "==> deploying bookworm-updater"
$UPDATER deploy >/dev/null
# UPSTREAM_URL is the updater's whole configuration for now (the Cloudflare
# API token that rewrites the reader arrives with the install path, PM-05).
# Without it the updater's cron records "UPSTREAM_URL 未設定" and does
# nothing — the same graceful-off shape as VAPID below, so a deploy that has
# not been told where upstream is stays inert rather than failing.
if [[ -n "${UPSTREAM_URL:-}" ]]; then
  echo "==> pushing UPSTREAM_URL secret to bookworm-updater"
  printf '%s' "$UPSTREAM_URL" | $UPDATER secret put UPSTREAM_URL
else
  echo "    (UPSTREAM_URL not set — the updater checks nothing until it is)"
fi

# The Cloudflare API token that rewrites the reader (PM-05's install path) —
# on the UPDATER, never the reader (R1), and gated behind its own env var so
# it is not armed until the safety net exists. install() is built and proven
# but nothing calls it yet: the cron only checks. Arming it (setting this
# secret AND turning on the policy-driven install) waits for PM-07's health
# check and rollback and PM-15's policy — a Worker-rewrite token that could
# auto-install with no rollback is exactly the risk the split defends against,
# so the token stays out until the thing that catches a bad release is in.
if [[ -n "${UPDATER_CF_API_TOKEN:-}" ]]; then
  echo "==> pushing CF_API_TOKEN secret to bookworm-updater"
  printf '%s' "$UPDATER_CF_API_TOKEN" | $UPDATER secret put CF_API_TOKEN
else
  echo "    (UPDATER_CF_API_TOKEN not set — the install path stays unarmed until PM-07/PM-15)"
fi

# optional: Web Push (新書通知) — without the key the feature just reports
# "push not configured" and everything else works
if [[ -n "${VAPID_PRIVATE_JWK:-}" ]]; then
  echo "==> pushing VAPID_PRIVATE_JWK secret"
  printf '%s' "$VAPID_PRIVATE_JWK" | $W secret put VAPID_PRIVATE_JWK
  # not secret, but it travels with the key and belongs to whoever runs this
  # install — push services contact this address about our traffic
  if [[ -n "${VAPID_SUBJECT:-}" ]]; then
    echo "==> pushing VAPID_SUBJECT secret"
    printf '%s' "$VAPID_SUBJECT" | $W secret put VAPID_SUBJECT
  fi
else
  echo "    (VAPID_PRIVATE_JWK not set — push notifications stay disabled)"
fi

if [[ -n "$URL" ]]; then
  # /api/books sits behind the reader-key gate now; the probe uses the admin
  # Bearer, which also proves the ADMIN_TOKEN secret actually landed
  echo "==> smoke probe: $URL/api/books"
  curl -fsS -H "authorization: Bearer $ADMIN_TOKEN" "$URL/api/books" && echo

  # 新版本已上線 is the worker's own business: its cron (announceSelf in
  # src/worker.js) rings within a minute of the new version serving, exactly
  # once per commit. The old POST from here raced the edge's version
  # propagation and needed a ?build= handshake plus a 30 s retry; a version
  # announcing itself cannot be stale, so there is nothing left to call.
  echo
  echo "✓ deployed: $URL"
  echo "  publish a book:  node scripts/publish-book.mjs out/<slug> --url $URL --token \$ADMIN_TOKEN"
  # In Actions, the run log is not where someone who just forked this will
  # look — the summary is the first thing on the page.
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### ✓ deployed"
      echo
      echo "- Your reading server: <$URL>"
      echo "- Upload a book: <$URL/admin> (log in with your \`ADMIN_TOKEN\`)"
      echo "- Reading needs a key: mint one under 讀者鑰匙 on <$URL/admin> and open its link on your device"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
else
  echo "warning: could not parse worker URL from deploy output; probe skipped" >&2
fi
