import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getMySupportTickets, getMyWineReports } from '../api/support';
import SupportModal from '../components/SupportModal';
import './SupportPage.css';

function SupportPage() {
  const { t } = useTranslation();
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
      setError(t('support.failedLoad'));
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id) => setExpanded(exp => exp === id ? null : id);

  return (
    <div className="support-page">
      <div className="support-header">
        <h1>{t('support.title')}</h1>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          {t('support.newTicket')}
        </button>
      </div>

      <div className="support-tabs">
        <button
          className={tab === 'tickets' ? 'active' : ''}
          onClick={() => setTab('tickets')}
        >
          {t('support.myTickets', { count: tickets.length })}
        </button>
        <button
          className={tab === 'reports' ? 'active' : ''}
          onClick={() => setTab('reports')}
        >
          {t('support.myWineReports', { count: wineReports.length })}
        </button>
      </div>

      {loading && <p className="support-loading">{t('support.loading')}</p>}
      {error && <p className="support-error">{error}</p>}

      {!loading && tab === 'tickets' && (
        <div className="support-list">
          {tickets.length === 0 ? (
            <p className="support-empty">{t('support.noTickets')}</p>
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
                      {t(`support.status.${ticket.status}`, ticket.status)}
                    </span>
                    <span className="support-badge category">{t(`support.category.${ticket.category}`, ticket.category)}</span>
                    <strong className="support-subject">{ticket.subject}</strong>
                  </div>
                  <span className="support-date">
                    {new Date(ticket.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {expanded === ticket._id && (
                  <div className="support-card-body">
                    <div className="support-message">
                      <h4>{t('support.yourMessage')}</h4>
                      <p>{ticket.message}</p>
                    </div>
                    {ticket.adminResponse && (
                      <div className="support-response">
                        <h4>{t('support.adminResponse')}</h4>
                        <p>{ticket.adminResponse}</p>
                        <span className="support-response-date">
                          {ticket.respondedAt
                            ? new Date(ticket.respondedAt).toLocaleDateString()
                            : ''}
                        </span>
                      </div>
                    )}
                    {!ticket.adminResponse && (
                      <p className="support-awaiting">{t('support.awaitingResponse')}</p>
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
            <p className="support-empty">{t('support.noReports')}</p>
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
                      {t(`support.reportStatus.${report.status}`, report.status)}
                    </span>
                    <span className="support-badge category">{t(`support.reason.${report.reason}`, report.reason)}</span>
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
                        <h4>{t('support.yourDetails')}</h4>
                        <p>{report.details}</p>
                      </div>
                    )}
                    {report.adminNotes && (
                      <div className="support-response">
                        <h4>{t('support.adminNotes')}</h4>
                        <p>{report.adminNotes}</p>
                      </div>
                    )}
                    {report.status === 'pending' && !report.adminNotes && (
                      <p className="support-awaiting">{t('support.underReview')}</p>
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
