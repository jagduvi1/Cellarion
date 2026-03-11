import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { adminGetSupportTickets, adminRespondToTicket, adminUpdateTicketStatus } from '../api/admin';
import './AdminSupportTickets.css';

const CATEGORY_LABELS = {
  bug: 'Bug',
  help: 'Help',
  feature: 'Feature',
  other: 'Other',
};

const STATUS_OPTIONS = ['open', 'in_progress', 'closed'];
const STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', closed: 'Closed' };

const CATEGORY_COLOR = {
  bug: 'badge--bug',
  help: 'badge--help',
  feature: 'badge--feature',
  other: 'badge--other',
};

function AdminSupportTickets() {
  const { apiFetch } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('open');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [responseText, setResponseText] = useState('');
  const [responseStatus, setResponseStatus] = useState('in_progress');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const LIMIT = 20;

  useEffect(() => {
    fetchTickets();
  }, [statusFilter, page, apiFetch]);

  const fetchTickets = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page, limit: LIMIT });
      if (statusFilter) params.set('status', statusFilter);
      const res = await adminGetSupportTickets(apiFetch, params.toString());
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to load tickets');
      setTickets(data.tickets || []);
      setTotal(data.total || 0);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  };

  const openTicket = (ticket) => {
    setSelected(ticket);
    setResponseText(ticket.adminResponse || '');
    setResponseStatus(ticket.status === 'open' ? 'in_progress' : ticket.status);
    setError(null);
    setSuccess(null);
  };

  const handleRespond = async () => {
    if (!responseText.trim()) return setError('Response is required');
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminRespondToTicket(apiFetch, selected._id, {
        adminResponse: responseText,
        status: responseStatus,
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to respond');
      setSuccess('Response sent.');
      setSelected(data.ticket);
      fetchTickets();
    } catch {
      setError('Network error.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusOnly = async (ticketId, status) => {
    try {
      const res = await adminUpdateTicketStatus(apiFetch, ticketId, status);
      const data = await res.json();
      if (!res.ok) return;
      if (selected?._id === ticketId) setSelected(data.ticket);
      fetchTickets();
    } catch {
      // silent
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div className="admin-support">
      <h1>Support Tickets</h1>

      <div className="admin-support-filters">
        <div className="admin-support-tabs">
          {['', ...STATUS_OPTIONS].map(s => (
            <button
              key={s}
              className={statusFilter === s ? 'active' : ''}
              onClick={() => { setStatusFilter(s); setPage(1); setSelected(null); }}
            >
              {s ? STATUS_LABELS[s] : 'All'}
            </button>
          ))}
        </div>
        <span className="admin-support-count">{total} ticket{total !== 1 ? 's' : ''}</span>
      </div>

      <div className="admin-support-layout">
        <div className="admin-support-list">
          {loading && <p className="admin-support-loading">Loading…</p>}
          {!loading && tickets.length === 0 && (
            <p className="admin-support-empty">No tickets found.</p>
          )}
          {tickets.map(ticket => (
            <div
              key={ticket._id}
              className={`admin-support-item ${selected?._id === ticket._id ? 'selected' : ''}`}
              onClick={() => openTicket(ticket)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && openTicket(ticket)}
            >
              <div className="admin-support-item-top">
                <span className={`admin-support-badge ${CATEGORY_COLOR[ticket.category]}`}>
                  {CATEGORY_LABELS[ticket.category]}
                </span>
                <span className={`admin-support-badge status-${ticket.status}`}>
                  {STATUS_LABELS[ticket.status]}
                </span>
              </div>
              <div className="admin-support-item-subject">{ticket.subject}</div>
              <div className="admin-support-item-meta">
                <span>{ticket.user?.username || ticket.user?.email}</span>
                <span>{new Date(ticket.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}

          {totalPages > 1 && (
            <div className="admin-support-pagination">
              <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
              <span>{page} / {totalPages}</span>
              <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </div>

        <div className="admin-support-detail">
          {!selected ? (
            <p className="admin-support-placeholder">Select a ticket to view details</p>
          ) : (
            <>
              <div className="admin-support-detail-header">
                <h2>{selected.subject}</h2>
                <div className="admin-support-detail-badges">
                  <span className={`admin-support-badge ${CATEGORY_COLOR[selected.category]}`}>
                    {CATEGORY_LABELS[selected.category]}
                  </span>
                  <span className={`admin-support-badge status-${selected.status}`}>
                    {STATUS_LABELS[selected.status]}
                  </span>
                </div>
              </div>

              <div className="admin-support-detail-meta">
                <span>From: <strong>{selected.user?.username}</strong> ({selected.user?.email})</span>
                <span>{new Date(selected.createdAt).toLocaleDateString()}</span>
              </div>

              <div className="admin-support-message">
                <h4>User message</h4>
                <p>{selected.message}</p>
              </div>

              {selected.adminResponse && (
                <div className="admin-support-existing-response">
                  <h4>Previous response</h4>
                  <p>{selected.adminResponse}</p>
                </div>
              )}

              <div className="admin-support-respond">
                <h4>{selected.adminResponse ? 'Update response' : 'Reply'}</h4>
                <textarea
                  value={responseText}
                  onChange={e => { setResponseText(e.target.value); setError(null); setSuccess(null); }}
                  rows={5}
                  placeholder="Write your response to the user…"
                  maxLength={5000}
                />
                <div className="admin-support-respond-controls">
                  <select
                    value={responseStatus}
                    onChange={e => setResponseStatus(e.target.value)}
                  >
                    {STATUS_OPTIONS.map(s => (
                      <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                  <button
                    className="btn-primary"
                    onClick={handleRespond}
                    disabled={submitting}
                  >
                    {submitting ? 'Sending…' : 'Send Response'}
                  </button>
                  {selected.status !== 'closed' && (
                    <button
                      className="btn-secondary"
                      onClick={() => handleStatusOnly(selected._id, 'closed')}
                    >
                      Close ticket
                    </button>
                  )}
                </div>
                {error && <p className="admin-support-error">{error}</p>}
                {success && <p className="admin-support-success">{success}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminSupportTickets;
