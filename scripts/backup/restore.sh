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
#                     as <file>.pre-restore). Every target is listed and a
#                     second confirmation is required. Use it when rebuilding
#                     a machine.
#   RESTORE_UMAMI=1   also reload the Umami analytics database (needs
#                     UMAMI_DB_CONTAINER in backup.env and a running container).
#
# For a FULL move to a new machine see docs/backup.md → "Moving everything to
# a new VM": you need the config files BEFORE the containers exist, so that
# runbook restores in a different order than this script.
#
# A snapshot is DATA, not code, and it is treated with the same suspicion as
# an upload (audit 2026-09-02 X01-4): the backup stages /app/uploads wholesale,
# a directory the backend process writes to, so nothing found under it may be
# mistaken for the database dump or the configuration tree. Every artefact is
# addressed at its known place under the single staging directory, never
# searched for; and a configuration file is written back only to a path that
# a rebuild legitimately needs, never to anything that grants access.
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
[ "${RESTORE_CONFIG:-0}" = 1 ] && echo "RESTORE_CONFIG=1: configuration files will be listed, then written back after a second confirmation."
[ "${RESTORE_UMAMI:-0}" = 1 ] && echo "RESTORE_UMAMI=1: the Umami database will be reloaded."
read -rp "Type 'restore' to proceed: " confirm
[ "$confirm" = "restore" ] || { echo "Aborted."; exit 1; }

DEST="$(mktemp -d)"
chmod 700 "$DEST"
trap 'rm -rf "$DEST"' EXIT

echo "[restore] fetching snapshot $SNAPSHOT…"
restic restore "$SNAPSHOT" --target "$DEST"

# backup.sh stages everything under ONE mktemp directory and backs that up by
# its ABSOLUTE path, and restic recreates that path under --target — so the
# staging directory lands at $DEST/tmp/tmp.XXXXXX, not at the top of $DEST
# (post-ship audit 2026-09-03: the top-level lookup this replaces found only
# "$DEST/tmp", and every restore aborted at the archive check). Locate the
# staging directory by the one file every snapshot carries, the Mongo archive,
# and refuse anything but exactly one hit rather than guess.
mapfile -t HITS < <(find "$DEST" -type f -path "*/mongo/$MONGO_DB.archive.gz")
if [ "${#HITS[@]}" -ne 1 ]; then
  echo "[restore] expected exactly one Mongo archive in the snapshot, found ${#HITS[@]} — refusing" >&2
  exit 1
fi
STAGE="$(dirname "$(dirname "${HITS[0]}")")"

ARCHIVE="$STAGE/mongo/$MONGO_DB.archive.gz"
UPLOADS_DIR="$STAGE/uploads"
CONFIG_DIR="$STAGE/config"
UMAMI_DUMP="$STAGE/umami/umami.sql.gz"
MANIFEST="$STAGE/MANIFEST.txt"
[ -f "$ARCHIVE" ] || { echo "[restore] mongo archive not found at its expected place in the snapshot" >&2; exit 1; }

if [ -f "$MANIFEST" ]; then
  echo "[restore] snapshot manifest:"
  # cat -v: the manifest is data from the snapshot and is shown on a terminal.
  head -20 "$MANIFEST" | cat -v | sed 's/^/    /'
fi

echo "[restore] restoring MongoDB (drop + reload)…"
docker exec -i "$MONGO_CONTAINER" mongorestore --archive --gzip --drop < "$ARCHIVE"

if [ -d "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
  echo "[restore] restoring uploaded images…"
  docker cp "$UPLOADS_DIR/." "$BACKEND_CONTAINER:/app/uploads/"
fi

# A configuration file may only go back to a place a rebuild needs. Anything
# that would grant access on its own — SSH keys, cron, sudo, shell start-up
# files, anything under /etc beyond the backup units — is refused outright,
# whatever the snapshot says.
config_target_allowed() {
  local t="$1"
  case "$t" in
    */.ssh/*|*/authorized_keys|/etc/cron*|/etc/sudoers*|/etc/passwd|/etc/shadow|/etc/group|*/.bashrc|*/.bash_profile|*/.profile|*/.zshrc|*/.bash_login|*/.bash_logout|/etc/profile*|/etc/environment|/root/*|/usr/*|/bin/*|/sbin/*|/lib*|/var/lib/*|/boot/*)
      return 1 ;;
  esac
  case "$t" in
    "$HOME"/*|/etc/systemd/system/cellarion-*|/opt/*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -d "$CONFIG_DIR" ]; then
  mapfile -t CONFIG_FILES < <(find "$CONFIG_DIR" -type f | LC_ALL=C sort)
  n="${#CONFIG_FILES[@]}"
  if [ "${RESTORE_CONFIG:-0}" = 1 ]; then
    echo "[restore] the snapshot carries $n configuration file(s). Targets:"
    allowed=(); refused=()
    for f in "${CONFIG_FILES[@]}"; do
      target="${f#"$CONFIG_DIR"}"
      # No traversal or control characters in a target, ever.
      case "$target" in *..*|*$'\n'*|*$'\r'*) refused+=("$target"); continue ;; esac
      if config_target_allowed "$target"; then allowed+=("$target"); else refused+=("$target"); fi
    done
    for t in "${allowed[@]}"; do printf '    write   %s\n' "$t" | cat -v; done
    for t in "${refused[@]}"; do printf '    REFUSE  %s\n' "$t" | cat -v; done
    if [ "${#allowed[@]}" -eq 0 ]; then
      echo "[restore] nothing allowed to write — skipping configuration."
    else
      read -rp "Type 'write config' to write the ${#allowed[@]} allowed file(s) above: " confirm2
      if [ "$confirm2" = "write config" ]; then
        for t in "${allowed[@]}"; do
          mkdir -p "$(dirname "$t")"
          [ -e "$t" ] && cp -p "$t" "$t.pre-restore"
          cp -p "$CONFIG_DIR$t" "$t"
        done
        echo "[restore] wrote ${#allowed[@]} configuration file(s); existing files kept as .pre-restore."
      else
        echo "[restore] configuration NOT written."
      fi
    fi
  else
    echo "[restore] snapshot carries $n configuration file(s) (not written; set RESTORE_CONFIG=1 to restore them):"
    for f in "${CONFIG_FILES[@]}"; do printf '    %s\n' "${f#"$CONFIG_DIR"}" | cat -v; done | head -40
  fi
fi

if [ -f "$UMAMI_DUMP" ] && [ "${RESTORE_UMAMI:-0}" = 1 ]; then
  [ -n "$UMAMI_DB_CONTAINER" ] || { echo "[restore] RESTORE_UMAMI=1 but UMAMI_DB_CONTAINER is not set" >&2; exit 1; }
  echo "[restore] reloading Umami database into $UMAMI_DB_CONTAINER…"
  gunzip -c "$UMAMI_DUMP" | docker exec -i "$UMAMI_DB_CONTAINER" sh -c 'psql -q -U "$POSTGRES_USER" "$POSTGRES_DB"'
fi

echo "[restore] done."
echo "Next: Meilisearch and Qdrant rebuild from Mongo — restart the backend"
echo "(docker compose restart backend) so search/AI indexes re-sync."
