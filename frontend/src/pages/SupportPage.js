import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getMySupportTickets, getMyWineReports } from '../api/support';
import SupportModal from '../components/SupportModal';
import './SupportPage.css';

const CATEGORY_LABELS = {
  bug: 'Bug Report',
  help: 'Help / Question',
  feature: 'Feature Request',
  other: 'Other',
};

const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  closed: 'Closed',
};

const REASON_LABELS = {
  wrong_info: 'Wrong Information',
  duplicate: 'Duplicate Entry',
  inappropriate: 'Inappropriate Content',
  other: 'Other',
};

const REPORT_STATUS_LABELS = {
  pending: 'Pending',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

function SupportPage() {
  const { apiFetch } = useAuth();
  const [tab, setTab] = useState('tickets');
  const [tickets, setTickets] = useState([]);
  const [wineReports, setWineReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    fetchData();
  }, [apiFetch]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ticketRes, reportRes] = await Promise.all([
        getMySupportTickets(apiFetch),
        getMyWineReports(apiFetch),
      ]);
      const ticketData = await ticketRes.json();
      const reportData = await reportRes.json();
      if (ticketRes.ok) setTickets(ticketData.tickets || []);
      if (reportRes.ok) setWineReports(reportData.reports || []);
    } catch {
      setError('Failed to load support history.');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id) => setExpanded(exp => exp === id ? null : id);

  return (
    <div className="support-page">
      <div className="support-page-header">
        <h1>Support</h1>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          + New Support Ticket
        </button>
      </div>

      <div className="support-tabs">
        <button
          className={tab === 'tickets' ? 'active' : ''}
          onClick={() => setTab('tickets')}
        >
          My Tickets ({tickets.length})
        </button>
        <button
          className={tab === 'reports' ? 'active' : ''}
          onClick={() => setTab('reports')}
        >
          My Wine Reports ({wineReports.length})
        </button>
      </div>

      {loading && <p className="support-loading">Loading…</p>}
      {error && <p className="support-error">{error}</p>}

      {!loading && tab === 'tickets' && (
        <div className="support-list">
          {tickets.length === 0 ? (
            <p className="support-empty">No support tickets yet. Use the button above to get help.</p>
          ) : (
            tickets.map(ticket => (
              <div key={ticket._id} className="support-card">
                <div
                  className="support-card-header"
                  onClick={() => toggleExpand(ticket._id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && toggleExpand(ticket._id)}
                >
                  <div className="support-card-meta">
                    <span className={`support-badge status-${ticket.status}`}>
                      {STATUS_LABELS[ticket.status]}
                    </span>
                    <span className="support-badge category">{CATEGORY_LABELS[ticket.category]}</span>
                    <strong className="support-subject">{ticket.subject}</strong>
                  </div>
                  <span className="support-date">
                    {new Date(ticket.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {expanded === ticket._id && (
                  <div className="support-card-body">
                    <div className="support-message">
                      <h4>Your message</h4>
                      <p>{ticket.message}</p>
                    </div>
                    {ticket.adminResponse && (
                      <div className="support-response">
                        <h4>Admin response</h4>
                        <p>{ticket.adminResponse}</p>
                        <span className="support-response-date">
                          {ticket.respondedAt
                            ? new Date(ticket.respondedAt).toLocaleDateString()
                            : ''}
                        </span>
                      </div>
                    )}
                    {!ticket.adminResponse && (
                      <p className="support-awaiting">Awaiting admin response…</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {!loading && tab === 'reports' && (
        <div className="support-list">
          {wineReports.length === 0 ? (
            <p className="support-empty">No wine reports yet. Use the "Report" button on any wine to flag an issue.</p>
          ) : (
            wineReports.map(report => (
              <div key={report._id} className="support-card">
                <div
                  className="support-card-header"
                  onClick={() => toggleExpand(report._id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && toggleExpand(report._id)}
                >
                  <div className="support-card-meta">
                    <span className={`support-badge status-${report.status}`}>
                      {REPORT_STATUS_LABELS[report.status]}
                    </span>
                    <span className="support-badge category">{REASON_LABELS[report.reason]}</span>
                    <strong className="support-subject">
                      {report.wineDefinition?.name}
                      {report.wineDefinition?.producer ? ` — ${report.wineDefinition.producer}` : ''}
                    </strong>
                  </div>
                  <span className="support-date">
                    {new Date(report.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {expanded === report._id && (
                  <div className="support-card-body">
                    {report.details && (
                      <div className="support-message">
                        <h4>Your details</h4>
                        <p>{report.details}</p>
                      </div>
                    )}
                    {report.adminNotes && (
                      <div className="support-response">
                        <h4>Admin notes</h4>
                        <p>{report.adminNotes}</p>
                      </div>
                    )}
                    {report.status === 'pending' && !report.adminNotes && (
                      <p className="support-awaiting">Under review…</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {showModal && (
        <SupportModal
          onClose={() => {
            setShowModal(false);
            fetchData();
          }}
        />
      )}
    </div>
  );
}

export default SupportPage;
