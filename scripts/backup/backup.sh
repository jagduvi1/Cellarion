#!/usr/bin/env bash
#
# Nightly backup of Cellarion's irreplaceable data to a restic repository
# (e.g. a Hetzner Storage Box over SFTP): the MongoDB dump AND the uploaded
# images (which live on disk in /app/uploads, NOT in Mongo). restic encrypts,
# deduplicates and retains. Meilisearch/Qdrant are intentionally skipped — the
# app rebuilds them from Mongo.
#
# Since 2026-09-02 a snapshot also carries everything needed to REBUILD THE
# STACK ON A NEW MACHINE, not just the data: the .env files, the compose files,
# the reverse-proxy and monitoring configs, the systemd units and this script's
# own backup.env (see CONFIG_PATHS / EXTRA_CONFIG_PATHS), plus an optional dump
# of the Umami analytics database and a MANIFEST.txt naming the exact image
# digests that were running. Before that, a restore gave you a database and a
# folder of photos and no way to run them.
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

# Configuration files that make a snapshot self-sufficient. Defaults cover the
# checkout this script lives in; EXTRA_CONFIG_PATHS (backup.env) adds anything
# outside it — a reverse proxy, monitoring, systemd units. Space-separated
# absolute paths; a directory is copied whole. Missing entries are logged and
# skipped, never fatal.
#
# NEVER stage the things that unlock the snapshot itself (audit 2026-09-02
# X01-1): backup.env (the passphrase and the keys that can DELETE both
# repositories), the SSH key that reaches the Storage Box, the TLS origin key.
# A snapshot that carries its own destruction keys turns a leaked passphrase
# from "read the data" into "erase every backup". Those few bootstrap secrets
# belong in a password manager off the host — you need them BEFORE you can
# open a snapshot anyway, so keeping them inside one never helped recovery.
PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
CONFIG_PATHS="${CONFIG_PATHS:-$PROJECT_DIR/.env $PROJECT_DIR/docker-compose.yml $PROJECT_DIR/docker-compose.prod.yml}"
EXTRA_CONFIG_PATHS="${EXTRA_CONFIG_PATHS:-}"
# Optional: the Postgres container behind self-hosted Umami. Blank = skip.
UMAMI_DB_CONTAINER="${UMAMI_DB_CONTAINER:-}"

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

# Configuration — stored under config/<absolute path> so a restore knows exactly
# where each file belongs on the new machine. Secrets ride along: the snapshot
# is encrypted with RESTIC_PASSWORD, which therefore now unlocks these too.
log "staging configuration files…"
mkdir -p "$STAGE/config"
staged=0
for p in $CONFIG_PATHS $EXTRA_CONFIG_PATHS; do
  # Refuse the bootstrap secrets even if someone lists them (see above).
  case "$p" in
    "$ENV_FILE"|*/backup.env|*/.ssh/*|*/acme.json|*/id_*|*.pem|*.key)
      log "config: refusing $p — bootstrap secret, keep it in a password manager, not in the snapshot"
      continue ;;
  esac
  if [ -d "$p" ]; then
    mkdir -p "$STAGE/config$(dirname "$p")"
    cp -rp "$p" "$STAGE/config$(dirname "$p")/"
    staged=$((staged + 1))
  elif [ -r "$p" ]; then
    mkdir -p "$STAGE/config$(dirname "$p")"
    cp -p "$p" "$STAGE/config$p"
    staged=$((staged + 1))
  else
    log "config: skipping $p (missing or unreadable)"
  fi
done
log "config: $staged entries staged"

# Optional Umami (analytics) database — small, and the only other state on the
# machine that is not rebuilt from Mongo.
if [ -n "$UMAMI_DB_CONTAINER" ] && docker ps --format '{{.Names}}' | grep -qx "$UMAMI_DB_CONTAINER"; then
  log "dumping Umami analytics database from $UMAMI_DB_CONTAINER…"
  mkdir -p "$STAGE/umami"
  docker exec "$UMAMI_DB_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$STAGE/umami/umami.sql.gz"
fi

# What was running when this snapshot was taken — the exact image digests let a
# rebuild pin the same versions instead of whatever :latest means that day.
log "writing manifest…"
{
  echo "host: $(hostname)"
  echo "taken: $(date -Is)"
  echo "kernel: $(uname -r)"
  echo "docker: $(docker --version 2>/dev/null)"
  echo
  echo "running containers:"
  docker ps --format '  {{.Names}}  {{.Image}}'
  echo
  echo "image digests:"
  docker images --digests --format '  {{.Repository}}:{{.Tag}}  {{.Digest}}' 2>/dev/null | grep -v '<none>' | sort -u
  echo
  echo "named volumes:"
  docker volume ls --format '  {{.Name}}' | grep -vE '^  [0-9a-f]{64}$'
} > "$STAGE/MANIFEST.txt" 2>/dev/null || log "warning: manifest incomplete"

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
  # `init --from-repo` and `copy --from-repo` open TWO repositories, and restic
  # takes the SOURCE one's passphrase from RESTIC_FROM_PASSWORD — not from
  # RESTIC_PASSWORD, which it applies to the destination. Without this it falls
  # back to prompting on stdin, and under systemd (no terminal) that reads empty
  # and dies with "an empty password is not a password". Both repositories here
  # share one passphrase. (Found 2026-09-02, the first time this branch ever ran
  # — B2 had been left unconfigured since the script was written.)
  export RESTIC_FROM_PASSWORD="$RESTIC_PASSWORD"
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
