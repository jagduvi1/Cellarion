#!/usr/bin/env bash
#
# Restore Cellarion's MongoDB + uploaded images from a restic snapshot.
# DESTRUCTIVE: replaces the current database (mongorestore --drop) and copies
# the snapshot's images back into the backend container.
#
# Usage:  ./restore.sh [snapshotID|latest]
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
SNAPSHOT="${1:-latest}"

echo "About to RESTORE snapshot '$SNAPSHOT' from $RESTIC_REPOSITORY."
echo "This DROPS and reloads the '$MONGO_DB' database and overwrites uploaded images."
read -rp "Type 'restore' to proceed: " confirm
[ "$confirm" = "restore" ] || { echo "Aborted."; exit 1; }

DEST="$(mktemp -d)"
trap 'rm -rf "$DEST"' EXIT

echo "[restore] fetching snapshot $SNAPSHOT…"
restic restore "$SNAPSHOT" --target "$DEST"

ARCHIVE="$(find "$DEST" -name "$MONGO_DB.archive.gz" | head -1)"
UPLOADS_DIR="$(find "$DEST" -type d -name uploads | head -1)"
[ -n "$ARCHIVE" ] || { echo "[restore] mongo archive not found in snapshot" >&2; exit 1; }

echo "[restore] restoring MongoDB (drop + reload)…"
docker exec -i "$MONGO_CONTAINER" mongorestore --archive --gzip --drop < "$ARCHIVE"

if [ -n "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
  echo "[restore] restoring uploaded images…"
  docker cp "$UPLOADS_DIR/." "$BACKEND_CONTAINER:/app/uploads/"
fi

echo "[restore] done."
echo "Next: Meilisearch and Qdrant rebuild from Mongo — restart the backend"
echo "(docker compose restart backend) so search/AI indexes re-sync."
