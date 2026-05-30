#!/usr/bin/env bash
#
# Weekly integrity check of the restic backup repository — catches silent
# bit-rot / corruption before you need the backups. Run by the
# cellarion-backup-check.timer (see systemd/). Pings HEALTHCHECK_CHECK_URL
# (if set) so a failed check alerts you.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV:-$SCRIPT_DIR/backup.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "[check] Missing config: $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY in $ENV_FILE}"
: "${RESTIC_PASSWORD:?set RESTIC_PASSWORD in $ENV_FILE}"
export RESTIC_REPOSITORY RESTIC_PASSWORD
HEALTHCHECK_CHECK_URL="${HEALTHCHECK_CHECK_URL:-}"

echo "[check] $(date -Is) verifying repository (metadata + 5% of data)…"
if restic check --read-data-subset=5%; then
  echo "[check] repository OK"
  [ -n "$HEALTHCHECK_CHECK_URL" ] && curl -fsS -m 10 --retry 3 "${HEALTHCHECK_CHECK_URL%/}" >/dev/null 2>&1 || true
else
  rc=$?
  echo "[check] repository check FAILED (exit $rc)" >&2
  [ -n "$HEALTHCHECK_CHECK_URL" ] && curl -fsS -m 10 --retry 3 "${HEALTHCHECK_CHECK_URL%/}/fail" >/dev/null 2>&1 || true
  exit "$rc"
fi
