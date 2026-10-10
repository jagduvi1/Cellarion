import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { submitSupportTicket } from '../api/support';
import { betaFeatureText } from '../config/betaFeatures';
import Modal from './Modal';

const MAX = 5000;

/**
 * "Give feedback" on a feature in early access: a short message that goes
 * to the Cellarion team as a support ticket in the beta category, tagged with
 * the feature (the server names the subject), so it lands in the queue the
 * team already answers from and the answer comes back like any ticket's.
 */
export default function BetaFeedbackModal({ feature, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const fieldId = useId();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const { name } = betaFeatureText(t, feature);

  const submit = async (e) => {
    e.preventDefault();
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await submitSupportTicket(apiFetch, { category: 'beta', feature, message: message.trim() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || t('earlyAccess.feedbackFailed', 'Could not send your feedback. Please try again.')); return; }
      setSent(true);
    } catch {
      setError(t('earlyAccess.feedbackFailed', 'Could not send your feedback. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <Modal title={t('earlyAccess.feedbackSentTitle', 'Thank you')} onClose={onClose} showClose trapFocus>
        <p>{t('earlyAccess.feedbackSent', 'Your feedback is with the Cellarion team. The answer comes like a support reply: in the app under Support, and by email unless you turned those off.')}</p>
        <div className="modal-actions">
          <Link to="/support" className="btn btn-secondary" onClick={onClose}>{t('earlyAccess.openSupport', 'Open Support')}</Link>
          <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.close', 'Close')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('earlyAccess.feedbackTitle', 'Feedback: {{name}}', { name })} onClose={onClose} showClose trapFocus>
      <form onSubmit={submit} className="beta-feedback-form">
        <label htmlFor={fieldId}>
          {t('earlyAccess.feedbackLabel', 'What works, what does not, what you miss')}
        </label>
        <textarea
          id={fieldId}
          rows={6}
          maxLength={MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={sending}
        />
        <p className="beta-feedback-hint">
          {t('earlyAccess.feedbackHint', 'It goes to the Cellarion team as a support ticket about this feature.')}
        </p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={sending || !message.trim()}>
            {sending ? t('earlyAccess.feedbackSending', 'Sending…') : t('earlyAccess.feedbackSend', 'Send feedback')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
