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
# Point wrangler.jsonc at THIS account's database. The id is committed, so a
# fresh clone carries the original author's — rewrite whatever is there, not
# just the placeholder, or every self-install would stop at the check below.
# portable in-place sed (BSD sed needs -i '', GNU sed needs -i without arg)
if ! grep -q "\"database_id\": \"${DB_ID}\"" wrangler.jsonc; then
  sed -i.bak -E "s/(\"database_id\"): *\"[^\"]*\"/\1: \"${DB_ID}\"/" wrangler.jsonc
  rm -f wrangler.jsonc.bak
  echo "    (rewrote database_id in wrangler.jsonc — commit it to keep diffs quiet)"
fi
grep -q "\"database_id\": \"${DB_ID}\"" wrangler.jsonc || {
  echo "error: wrangler.jsonc does not carry database_id ${DB_ID}" >&2
  exit 1
}
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

echo "==> vendoring browser bundles (public/vendor/ is gitignored)"
node scripts/vendor.mjs

echo "==> stamping build version into app.js and worker.js"
# only when the files are clean in git, so the stamp (and nothing else) can be
# reverted on exit — local deploys with in-progress edits ship "dev". The
# worker carries the same stamp so /api/version can tell a running shell that
# a newer one exists.
if git diff --quiet -- public/app.js src/worker.js 2>/dev/null; then
  # Asia/Taipei, with the clock: the stamp is read off the shelf by a reader
  # whose day is +8 — a bare UTC date can point at yesterday's deploy
  BUILD_ID="$(git rev-parse --short HEAD) · $(TZ=Asia/Taipei date +'%Y-%m-%d %H:%M')"
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

  # 新版本已上線: app.js's checkVersion only runs while a page is open, so an
  # installed phone nobody opened never hears about a deploy. The worker
  # announces its own stamp and keeps its own exactly-once record, so this is
  # safe to call on every deploy — a re-run or a rollback stays silent. Never
  # fatal: the deploy has already succeeded by the time we get here.
  # The stamp goes along so the worker can tell us it is the version we just
  # deployed. Cloudflare can still route this to the OLD isolate for a few
  # seconds, and that one would announce ITS build, find it already recorded,
  # and report success while the new build silently never rings — which is
  # exactly what happened on the deploy of e96279f. Retry until the answer
  # comes from the right worker.
  echo "==> announcing the build"
  # empty when the tree was dirty and nothing was stamped; the worker then
  # skips the check and answers "unstamped build" anyway
  WANT=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' \
    "${BUILD_ID:-}")
  ANNOUNCE=""
  for _ in $(seq 15); do
    ANNOUNCE=$(curl -fsS -X POST -H "authorization: Bearer $ADMIN_TOKEN" \
      "$URL/api/admin/announce-build?build=$WANT") || { ANNOUNCE=""; break; }
    grep -q '"stale worker"' <<<"$ANNOUNCE" || break
    sleep 2
  done
  if [[ -z "$ANNOUNCE" ]]; then
    echo "    (announcement failed — the deploy itself is fine)" >&2
  elif grep -q '"stale worker"' <<<"$ANNOUNCE"; then
    echo "    (still the old worker after 30 s — this build was not announced)" >&2
  else
    echo "    $ANNOUNCE"
  fi
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
