import { bytes, fmtDate, ago, StatusDot, useApi } from './helpers';

/**
 * Backup health. Reads the status report written by the backup job
 * (scripts/backup/backup.sh) — the app never touches the backup repo itself.
 * Shows a clear OK / STALE / FAILED state plus snapshot count, latest snapshot,
 * and repo size so an operator can confirm backups exist and are fresh.
 */
export default function TabBackups() {
  const { data, loading, error, reload } = useApi('/api/superadmin/backups');

  if (loading) return <div className="sa-loading">Loading backup status…</div>;
  if (error) return <div className="sa-error">Error: {error}</div>;
  if (!data) return null;

  if (!data.configured) {
    return (
      <div className="sa-section">
        <StatusDot status="warn" />{' '}
        No backup has reported yet. Set up the backup job (see <code>docs/backup.md</code>);
        once it runs, its status appears here.
      </div>
    );
  }

  const failed = data.status === 'failed';
  const health = failed ? 'error' : data.stale ? 'warn' : 'ok';
  const headline = failed ? 'Last backup FAILED' : data.stale ? 'Backup is STALE — no recent successful run' : 'Backups healthy';

  const rows = [
    ['Last run', `${fmtDate(data.lastRunAt)} (${ago(data.lastRunAt)})`],
    ['Result', data.status || '—'],
    ['Snapshots stored', data.snapshotCount != null ? data.snapshotCount : '—'],
    ['Latest snapshot', fmtDate(data.latestSnapshotTime)],
    ['Repository size', data.repoSizeBytes != null ? bytes(data.repoSizeBytes) : '—'],
    ['Repository', data.repo || '—'],
    ['Host', data.host || '—'],
    ['Duration', data.durationSec != null ? `${data.durationSec}s` : '—'],
  ];

  return (
    <>
      <div className="sa-section" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <StatusDot status={health} /> {headline}
      </div>

      {failed && data.error && <div className="sa-error" style={{ marginBottom: 12 }}>{data.error}</div>}
      {(failed || data.stale) && (
        <div className="sa-error" style={{ marginBottom: 12 }}>
          ⚠ Check the backup job and its alert (healthchecks.io) — backups may not be current.
        </div>
      )}

      <table className="sa-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td style={{ fontWeight: 600, paddingRight: 16 }}>{k}</td><td>{v}</td></tr>
          ))}
        </tbody>
      </table>

      <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #888)', marginTop: 12 }}>
        Reported by the backup job — the app reads this status only and never accesses the backup repository.
      </p>
      <button className="sa-btn" onClick={reload} style={{ marginTop: 8 }}>Refresh</button>
    </>
  );
}
