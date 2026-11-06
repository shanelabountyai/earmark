#!/usr/bin/env bash
# Spike S4 (kickoff M9): set_config leak (S4a), owner-migrates / app_rw-reads (S4b), round-trip cost (S4c).
#   local:  spikes/s4/run.sh            (fresh saas_foundation_s4 DB, local app_rw role from .env.test)
#   neon:   S4_TARGET=neon S4_ENV=<file> spikes/s4/run.sh
#           <file> holds OWNER_DIRECT_URL, OWNER_URL (pooled) and APP_URL (app_rw, pooled). Never printed.
# Pass: every line PASS; S4C prints p50/p95 (integer microseconds).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
TARGET="${S4_TARGET:-local}"
if [ "$TARGET" = local ]; then
  DB=saas_foundation_s4; PGU="${PGUSER:-$USER}"
  dropdb --if-exists "$DB"; createdb "$DB"
  OWNER_DIRECT_URL="postgresql://$PGU@localhost:5432/$DB"; OWNER_URL="$OWNER_DIRECT_URL"
  # app_rw already exists locally (its password lives in .env.test); reuse it against the spike DB.
  APP_URL="$(grep '^DATABASE_URL_APP_RW=' .env.test | cut -d= -f2- | sed -E "s#/[a-z0-9_]+(\?|$)#/$DB\1#")"
else
  # shellcheck disable=SC1090
  set -a; . "$S4_ENV"; set +a
  export ALLOW_CLOUD_DB=1
fi
DATABASE_URL="$OWNER_DIRECT_URL" npx prisma migrate deploy >/dev/null
psql -q "$OWNER_DIRECT_URL" -f spikes/s4/policy.sql
OWNER_URL="$OWNER_URL" APP_URL="$APP_URL" S4_TARGET="$TARGET" npx tsx spikes/s4/s4.ts
