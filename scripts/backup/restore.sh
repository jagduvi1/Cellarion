#!/usr/bin/env bash
#
# Restore Cellarion's MongoDB + uploaded images from a restic snapshot.
# DESTRUCTIVE: replaces the current database (mongorestore --drop) and copies
# the snapshot's images back into the backend container.
#
# Usage:  ./restore.sh [snapshotID|latest]
#
#   RESTORE_CONFIG=1  also copy the snapshot's configuration files back to
#                     their original absolute paths (existing files are kept
#                     as <file>.pre-restore). Use this when rebuilding a machine.
#   RESTORE_UMAMI=1   also reload the Umami analytics database (needs
#                     UMAMI_DB_CONTAINER in backup.env and a running container).
#
# For a FULL move to a new machine see docs/backup.md → "Moving everything to
# a new VM": you need the config files BEFORE the containers exist, so that
# runbook restores in a different order than this script.
#
# Run a DRILL of this periodically — an untested backup is not a backup.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV:-$SCRIPT_DIR/backup.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "[restore] Missing config: $ENV_FILE" >&2
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
UMAMI_DB_CONTAINER="${UMAMI_DB_CONTAINER:-}"
SNAPSHOT="${1:-latest}"

echo "About to RESTORE snapshot '$SNAPSHOT' from $RESTIC_REPOSITORY."
echo "This DROPS and reloads the '$MONGO_DB' database and overwrites uploaded images."
[ "${RESTORE_CONFIG:-0}" = 1 ] && echo "RESTORE_CONFIG=1: configuration files will be written back to their original paths."
[ "${RESTORE_UMAMI:-0}" = 1 ] && echo "RESTORE_UMAMI=1: the Umami database will be reloaded."
read -rp "Type 'restore' to proceed: " confirm
[ "$confirm" = "restore" ] || { echo "Aborted."; exit 1; }

DEST="$(mktemp -d)"
trap 'rm -rf "$DEST"' EXIT

echo "[restore] fetching snapshot $SNAPSHOT…"
restic restore "$SNAPSHOT" --target "$DEST"

ARCHIVE="$(find "$DEST" -name "$MONGO_DB.archive.gz" | head -1)"
UPLOADS_DIR="$(find "$DEST" -type d -name uploads | head -1)"
CONFIG_DIR="$(find "$DEST" -type d -name config | head -1)"
UMAMI_DUMP="$(find "$DEST" -name umami.sql.gz | head -1)"
MANIFEST="$(find "$DEST" -name MANIFEST.txt | head -1)"
[ -n "$ARCHIVE" ] || { echo "[restore] mongo archive not found in snapshot" >&2; exit 1; }

if [ -n "$MANIFEST" ]; then
  echo "[restore] snapshot manifest:"
  sed 's/^/    /' "$MANIFEST" | head -20
fi

echo "[restore] restoring MongoDB (drop + reload)…"
docker exec -i "$MONGO_CONTAINER" mongorestore --archive --gzip --drop < "$ARCHIVE"

if [ -n "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
  echo "[restore] restoring uploaded images…"
  docker cp "$UPLOADS_DIR/." "$BACKEND_CONTAINER:/app/uploads/"
fi

if [ -n "$CONFIG_DIR" ]; then
  n="$(find "$CONFIG_DIR" -type f | wc -l)"
  if [ "${RESTORE_CONFIG:-0}" = 1 ]; then
    echo "[restore] writing $n configuration file(s) back to their original paths…"
    # config/<abs path> → <abs path>; anything already there is kept alongside.
    find "$CONFIG_DIR" -type f | while read -r f; do
      target="${f#"$CONFIG_DIR"}"
      mkdir -p "$(dirname "$target")"
      [ -e "$target" ] && cp -p "$target" "$target.pre-restore"
      cp -p "$f" "$target"
    done
  else
    echo "[restore] snapshot carries $n configuration file(s) (not written; set RESTORE_CONFIG=1 to restore them):"
    find "$CONFIG_DIR" -type f | sed "s|^$CONFIG_DIR|    |" | head -40
  fi
fi

if [ -n "$UMAMI_DUMP" ] && [ "${RESTORE_UMAMI:-0}" = 1 ]; then
  [ -n "$UMAMI_DB_CONTAINER" ] || { echo "[restore] RESTORE_UMAMI=1 but UMAMI_DB_CONTAINER is not set" >&2; exit 1; }
  echo "[restore] reloading Umami database into $UMAMI_DB_CONTAINER…"
  gunzip -c "$UMAMI_DUMP" | docker exec -i "$UMAMI_DB_CONTAINER" sh -c 'psql -q -U "$POSTGRES_USER" "$POSTGRES_DB"'
fi

echo "[restore] done."
echo "Next: Meilisearch and Qdrant rebuild from Mongo — restart the backend"
echo "(docker compose restart backend) so search/AI indexes re-sync."
