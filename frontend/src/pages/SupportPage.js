import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getMySupportTickets, getMyWineReports, replySupportTicket } from '../api/support';
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
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState(null);

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
      // A non-ok response set no data AND no error, so a 500 looked like the
      // normal "you have no tickets" empty state (grand-audit M20).
      if (!ticketRes.ok && !reportRes.ok) setError(t('support.failedLoad'));
    } catch {
      setError(t('support.failedLoad'));
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id) => {
    setExpanded(exp => exp === id ? null : id);
    setReplyText('');
    setReplyError(null);
  };

  const sendReply = async (ticketId) => {
    if (!replyText.trim() || replySending) return;
    setReplySending(true);
    setReplyError(null);
    try {
      const res = await replySupportTicket(apiFetch, ticketId, replyText.trim());
      const data = await res.json();
      if (!res.ok) {
        setReplyError(data.error || t('support.replyFailed'));
      } else {
        setReplyText('');
        // Refresh in place so the new entry shows in the thread immediately.
        setTickets(ts => ts.map(tk => tk._id === ticketId ? data.ticket : tk));
      }
    } catch {
      setReplyError(t('support.replyFailed'));
    } finally {
      setReplySending(false);
    }
  };

  return (
    <div className="support-page">
      <div className="support-header">
        <h1>{t('support.title')}</h1>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
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
                  aria-expanded={expanded === ticket._id}
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
                    {(ticket.replies || []).length > 0 ? (
                      // The conversation thread. New responses live here; the
                      // legacy single adminResponse block below only renders
                      // for pre-thread tickets (empty replies array).
                      (ticket.replies || []).map((reply, i) => (
                        <div key={i} className={reply.author === 'admin' ? 'support-response' : 'support-message'}>
                          <h4>{reply.author === 'admin' ? t('support.adminResponse') : t('support.yourReply')}</h4>
                          <p>{reply.message}</p>
                          <span className="support-response-date">
                            {reply.createdAt ? new Date(reply.createdAt).toLocaleDateString() : ''}
                          </span>
                        </div>
                      ))
                    ) : ticket.adminResponse ? (
                      <div className="support-response">
                        <h4>{t('support.adminResponse')}</h4>
                        <p>{ticket.adminResponse}</p>
                        <span className="support-response-date">
                          {ticket.respondedAt
                            ? new Date(ticket.respondedAt).toLocaleDateString()
                            : ''}
                        </span>
                      </div>
                    ) : (
                      <p className="support-awaiting">{t('support.awaitingResponse')}</p>
                    )}
                    {ticket.status !== 'closed' ? (
                      <div className="support-reply-form">
                        <textarea
                          value={replyText}
                          onChange={e => setReplyText(e.target.value)}
                          placeholder={t('support.replyPlaceholder')}
                          aria-label={t('support.replyPlaceholder')}
                          maxLength={5000}
                          rows={3}
                          disabled={replySending}
                        />
                        {replyError && <p className="support-error">{replyError}</p>}
                        <button
                          className="btn btn-primary"
                          onClick={() => sendReply(ticket._id)}
                          disabled={replySending || !replyText.trim()}
                        >
                          {replySending ? t('support.sendingReply') : t('support.sendReply')}
                        </button>
                      </div>
                    ) : (
                      <p className="support-awaiting">{t('support.closedNoReply')}</p>
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
                  aria-expanded={expanded === report._id}
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
                    {report.adminResponse && (
                      <div className="support-response">
                        <h4>{t('support.reportResponse')}</h4>
                        <p>{report.adminResponse}</p>
                        <span className="support-response-date">
                          {report.respondedAt
                            ? new Date(report.respondedAt).toLocaleDateString()
                            : ''}
                        </span>
                      </div>
                    )}
                    {report.status === 'pending' && (
                      <p className="support-awaiting">{t('support.underReview')}</p>
                    )}
                    {report.status !== 'pending' && !report.adminResponse && (
                      <p className="support-awaiting">{t('support.reportReviewed')}</p>
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
