import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { adminGetWineReports, adminResolveWineReport, adminDismissWineReport } from '../api/admin';
import './AdminWineReports.css';

const REASON_LABELS = {
  wrong_info: 'Wrong Info',
  duplicate: 'Duplicate',
  inappropriate: 'Inappropriate',
  other: 'Other',
};

const STATUS_LABELS = { pending: 'Pending', resolved: 'Resolved', dismissed: 'Dismissed' };
const STATUS_OPTIONS = ['', 'pending', 'resolved', 'dismissed'];

function AdminWineReports() {
  const { apiFetch } = useAuth();
  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const LIMIT = 20;

  useEffect(() => {
    fetchReports();
  }, [statusFilter, page, apiFetch]);

  const fetchReports = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (statusFilter) params.set('status', statusFilter);
      const res = await adminGetWineReports(apiFetch, params.toString());
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to load reports');
      setReports(data.reports || []);
      setTotal(data.total || 0);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  };

  const openReport = (report) => {
    setSelected(report);
    setAdminNotes(report.adminNotes || '');
    setError(null);
    setSuccess(null);
  };

  const handleAction = async (action) => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const fn = action === 'resolve' ? adminResolveWineReport : adminDismissWineReport;
      const res = await fn(apiFetch, selected._id, { adminNotes });
      const data = await res.json();
      if (!res.ok) return setError(data.error || `Failed to ${action} report`);
      setSuccess(`Report ${action === 'resolve' ? 'resolved' : 'dismissed'}.`);
      setSelected(data.report);
      fetchReports();
    } catch {
      setError('Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="admin-wine-reports">
      <h1>Wine Reports</h1>

      <div className="awr-filters">
        <div className="awr-tabs">
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              className={statusFilter === s ? 'active' : ''}
              onClick={() => { setStatusFilter(s); setPage(1); setSelected(null); }}
            >
              {s ? STATUS_LABELS[s] : 'All'}
            </button>
          ))}
        </div>
        <span className="awr-count">{total} report{total !== 1 ? 's' : ''}</span>
      </div>

      <div className="awr-layout">
        <div className="awr-list">
          {loading && <p className="awr-msg">Loading…</p>}
          {!loading && reports.length === 0 && (
            <p className="awr-msg">No reports found.</p>
          )}
          {reports.map(report => (
            <div
              key={report._id}
              className={`awr-item ${selected?._id === report._id ? 'selected' : ''}`}
              onClick={() => openReport(report)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && openReport(report)}
            >
              <div className="awr-item-top">
                <span className={`awr-badge reason-${report.reason}`}>
                  {REASON_LABELS[report.reason]}
                </span>
                <span className={`awr-badge status-${report.status}`}>
                  {STATUS_LABELS[report.status]}
                </span>
              </div>
              <div className="awr-item-wine">
                {report.wineDefinition?.name}
                {report.wineDefinition?.producer ? ` — ${report.wineDefinition.producer}` : ''}
              </div>
              <div className="awr-item-meta">
                <span>{report.user?.username}</span>
                <span>{new Date(report.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}

          {totalPages > 1 && (
            <div className="awr-pagination">
              <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
              <span>{page} / {totalPages}</span>
              <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </div>

        <div className="awr-detail">
          {!selected ? (
            <p className="awr-placeholder">Select a report to review</p>
          ) : (
            <>
              <div className="awr-detail-header">
                <h2>
                  {selected.wineDefinition?.name}
                  {selected.wineDefinition?.producer ? ` — ${selected.wineDefinition.producer}` : ''}
                </h2>
                <div className="awr-detail-badges">
                  <span className={`awr-badge reason-${selected.reason}`}>
                    {REASON_LABELS[selected.reason]}
                  </span>
                  <span className={`awr-badge status-${selected.status}`}>
                    {STATUS_LABELS[selected.status]}
                  </span>
                </div>
              </div>

              <div className="awr-detail-meta">
                <span>Reported by: <strong>{selected.user?.username}</strong> ({selected.user?.email})</span>
                <span>{new Date(selected.createdAt).toLocaleDateString()}</span>
              </div>

              {selected.wineDefinition && (
                <div className="awr-wine-info">
                  <h4>Wine details</h4>
                  <p>
                    <strong>Type:</strong> {selected.wineDefinition.type}<br />
                    {selected.wineDefinition.country && (
                      <><strong>Country:</strong> {selected.wineDefinition.country}<br /></>
                    )}
                  </p>
                </div>
              )}

              {selected.details && (
                <div className="awr-user-details">
                  <h4>User details</h4>
                  <p>{selected.details}</p>
                </div>
              )}

              {selected.duplicateOf && (
                <div className="awr-duplicate-ref">
                  <h4>Reported as duplicate of</h4>
                  <p>
                    {selected.duplicateOf.name}
                    {selected.duplicateOf.producer ? ` — ${selected.duplicateOf.producer}` : ''}
                  </p>
                </div>
              )}

              {selected.status === 'pending' && (
                <div className="awr-actions">
                  <h4>Admin notes <span className="optional">(optional)</span></h4>
                  <textarea
                    value={adminNotes}
                    onChange={e => { setAdminNotes(e.target.value); setError(null); setSuccess(null); }}
                    rows={4}
                    placeholder="Notes for internal tracking (not shown to user)…"
                    maxLength={2000}
                  />
                  <div className="awr-action-buttons">
                    <button
                      className="btn-primary"
                      onClick={() => handleAction('resolve')}
                      disabled={submitting}
                    >
                      {submitting ? '…' : 'Mark Resolved'}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => handleAction('dismiss')}
                      disabled={submitting}
                    >
                      {submitting ? '…' : 'Dismiss'}
                    </button>
                  </div>
                  {error && <p className="awr-error">{error}</p>}
                  {success && <p className="awr-success">{success}</p>}
                </div>
              )}

              {selected.status !== 'pending' && (
                <div className="awr-resolved-info">
                  <h4>Admin notes</h4>
                  <p>{selected.adminNotes || '—'}</p>
                  {selected.resolvedBy && (
                    <p className="awr-resolved-by">
                      {STATUS_LABELS[selected.status]} by {selected.resolvedBy.username}
                      {selected.resolvedAt ? ` on ${new Date(selected.resolvedAt).toLocaleDateString()}` : ''}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminWineReports;
