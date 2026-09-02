#!/usr/bin/env bash
#
# Nightly backup of Cellarion's irreplaceable data to a restic repository
# (e.g. a Hetzner Storage Box over SFTP): the MongoDB dump AND the uploaded
# images (which live on disk in /app/uploads, NOT in Mongo). restic encrypts,
# deduplicates and retains. Meilisearch/Qdrant are intentionally skipped — the
# app rebuilds them from Mongo.
#
# Usage:  ./backup.sh            (reads ./backup.env)
#         BACKUP_ENV=/path/env ./backup.sh
# Run it from cron/systemd on the VM host — see docs/backup.md.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV:-$SCRIPT_DIR/backup.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "[backup] Missing config: $ENV_FILE — copy backup.env.example and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in $ENV_FILE}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in $ENV_FILE}"
export RESTIC_REPOSITORY RESTIC_PASSWORD

MONGO_CONTAINER="${MONGO_CONTAINER:-cellarion-mongo}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-cellarion-backend}"
MONGO_DB="${MONGO_DB:-winecellar}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

log() { echo "[backup] $(date -Is) $*"; }
ping_fail() {
  [ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL%/}/fail" >/dev/null 2>&1 || true
}

# Write a one-document status report into Mongo so SuperAdmin can show backup
# health (the app reads this; it never touches the repo). Scalars only. Needs jq.
#
# The document is built with `jq` (which safely JSON-encodes every value) and
# handed to mongosh as DATA through an env var. The --eval script below is a
# CONSTANT string with no shell expansion, so no value is ever concatenated into
# a command — there is no shell/command-injection surface.
record_status() {
  local status="$1" err="${2:-}" now count latest size doc
  now="$(date -Is)"
  count="$(restic snapshots --json 2>/dev/null | jq 'length' 2>/dev/null || echo null)"
  latest="$(restic snapshots --json 2>/dev/null | jq -r 'sort_by(.time)|last|.time // empty' 2>/dev/null || echo '')"
  size="$(restic stats --json --mode raw-data 2>/dev/null | jq '.total_size // null' 2>/dev/null || echo null)"

  doc="$(jq -n \
    --arg     status            "$status" \
    --arg     lastRunAt         "$now" \
    --argjson durationSec       "${SECONDS:-0}" \
    --argjson snapshotCount     "${count:-null}" \
    --arg     latestSnapshotTime "$latest" \
    --argjson repoSizeBytes     "${size:-null}" \
    --arg     host              "$(hostname)" \
    --arg     repo              "$RESTIC_REPOSITORY" \
    --arg     error             "$err" \
    '{status:$status, lastRunAt:$lastRunAt, durationSec:$durationSec,
      snapshotCount:$snapshotCount, latestSnapshotTime:$latestSnapshotTime,
      repoSizeBytes:$repoSizeBytes, host:$host, repo:$repo,
      error:($error[0:300])}' 2>/dev/null)" \
    || { log "warning: could not build status document (is jq installed?)"; return 0; }

  STATUS_JSON="$doc" docker exec -i -e STATUS_JSON "$MONGO_CONTAINER" \
    mongosh "$MONGO_DB" --quiet --eval '
      const s = JSON.parse(process.env.STATUS_JSON);
      s._id = "latest";
      s.lastRunAt = s.lastRunAt ? new Date(s.lastRunAt) : new Date();
      s.latestSnapshotTime = s.latestSnapshotTime ? new Date(s.latestSnapshotTime) : null;
      db.backupstatuses.replaceOne({ _id: "latest" }, s, { upsert: true });
    ' >/dev/null 2>&1 || log "warning: could not record backup status to Mongo"
}

on_err() {
  trap - ERR   # prevent re-entry if a call below also fails
  record_status failed "backup.sh failed — check the backup log"
  ping_fail
}

STAGE="$(mktemp -d)"
trap 'on_err' ERR
trap 'rm -rf "$STAGE"' EXIT

log "dumping MongoDB '$MONGO_DB' from $MONGO_CONTAINER…"
mkdir -p "$STAGE/mongo" "$STAGE/uploads"
docker exec "$MONGO_CONTAINER" mongodump --db "$MONGO_DB" --archive --gzip > "$STAGE/mongo/$MONGO_DB.archive.gz"

log "copying uploaded images from $BACKEND_CONTAINER:/app/uploads…"
# Copy as plain files (not a single tarball) so restic deduplicates unchanged
# images across runs — only new/changed photos are uploaded each night.
docker cp "$BACKEND_CONTAINER:/app/uploads/." "$STAGE/uploads/"

log "ensuring restic repository exists…"
restic snapshots >/dev/null 2>&1 || restic init

log "uploading encrypted snapshot to $RESTIC_REPOSITORY…"
restic backup --tag cellarion --host cellarion "$STAGE"

# --group-by host,tags is REQUIRED here. restic's default grouping is
# "host,paths", and every run stages into a fresh mktemp -d, so each snapshot
# has a unique path and lands in its own group. The keep-N policy is then
# applied per group — "keep 1 of 1" every night — and NOTHING is ever forgotten.
# Grouping by host+tags puts all Cellarion snapshots in one group so the
# 7d/4w/6m policy actually applies. (Found 2026-09-01: 85 snapshots retained
# since June where ~14 were intended; erased users lingered in backups past
# the retention promise.)
log "pruning (keep ${KEEP_DAILY}d / ${KEEP_WEEKLY}w / ${KEEP_MONTHLY}m)…"
restic forget --tag cellarion --group-by host,tags --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune

# Optional second, off-provider copy (e.g. Backblaze B2) so a Hetzner-account
# level loss can't wipe everything. Enable by setting B2_* in backup.env.
if [ -n "${B2_RESTIC_REPOSITORY:-}" ]; then
  export B2_ACCOUNT_ID="${B2_ACCOUNT_ID:-}" B2_ACCOUNT_KEY="${B2_ACCOUNT_KEY:-}"
  log "copying snapshots to off-provider repo $B2_RESTIC_REPOSITORY…"
  restic -r "$B2_RESTIC_REPOSITORY" snapshots >/dev/null 2>&1 \
    || restic -r "$B2_RESTIC_REPOSITORY" init --copy-chunker-params --from-repo "$RESTIC_REPOSITORY"
  restic -r "$B2_RESTIC_REPOSITORY" copy --from-repo "$RESTIC_REPOSITORY" --tag cellarion
  # same grouping fix as the primary repo above — without it nothing is pruned
  restic -r "$B2_RESTIC_REPOSITORY" forget --tag cellarion --group-by host,tags --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune
fi

log "recording status for SuperAdmin…"
record_status ok

log "backup complete."
[ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL%/}" >/dev/null 2>&1 || true
