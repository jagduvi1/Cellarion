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
trap 'ping_fail' ERR

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; ping_fail' ERR
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

log "pruning (keep ${KEEP_DAILY}d / ${KEEP_WEEKLY}w / ${KEEP_MONTHLY}m)…"
restic forget --tag cellarion --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune

# Optional second, off-provider copy (e.g. Backblaze B2) so a Hetzner-account
# level loss can't wipe everything. Enable by setting B2_* in backup.env.
if [ -n "${B2_RESTIC_REPOSITORY:-}" ]; then
  export B2_ACCOUNT_ID="${B2_ACCOUNT_ID:-}" B2_ACCOUNT_KEY="${B2_ACCOUNT_KEY:-}"
  log "copying snapshots to off-provider repo $B2_RESTIC_REPOSITORY…"
  restic -r "$B2_RESTIC_REPOSITORY" snapshots >/dev/null 2>&1 \
    || restic -r "$B2_RESTIC_REPOSITORY" init --copy-chunker-params --from-repo "$RESTIC_REPOSITORY"
  restic -r "$B2_RESTIC_REPOSITORY" copy --from-repo "$RESTIC_REPOSITORY" --tag cellarion
  restic -r "$B2_RESTIC_REPOSITORY" forget --tag cellarion --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --keep-monthly "$KEEP_MONTHLY" --prune
fi

log "backup complete."
[ -n "$HEALTHCHECK_URL" ] && curl -fsS -m 10 --retry 3 "${HEALTHCHECK_URL%/}" >/dev/null 2>&1 || true
