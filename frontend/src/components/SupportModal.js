import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import Modal from './Modal';
import { submitSupportTicket } from '../api/support';
import { useAuth } from '../contexts/AuthContext';
import './SupportModal.css';

const CATEGORY_VALUES = ['bug', 'help', 'feature', 'other'];

function SupportModal({ onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({ category: 'bug', subject: '', message: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (e) => {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.subject.trim()) return setError(t('support.subjectRequired'));
    if (!form.message.trim()) return setError(t('support.messageRequired'));

    setSubmitting(true);
    setError(null);
    try {
      const res = await submitSupportTicket(apiFetch, form);
      const data = await res.json();
      if (!res.ok) return setError(data.error || t('support.submitFailed'));
      setSuccess(true);
    } catch {
      setError(t('common.networkError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <Modal title={t('support.sentTitle')} onClose={onClose}>
        <div className="support-modal-success">
          <p>{t('support.sentBody')}</p>
          <p>
            <Trans i18nKey="support.sentTrack" components={{ strong: <strong /> }} />
          </p>
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('support.contactTitle', 'Contact Support')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="support-modal-form">
        <label>
          {t('support.categoryLabel', 'Category')}
          <select name="category" value={form.category} onChange={handleChange}>
            {CATEGORY_VALUES.map(v => (
              <option key={v} value={v}>{t(`support.category.${v}`)}</option>
            ))}
          </select>
        </label>

        <label>
          {t('support.subject')}
          <input
            type="text"
            name="subject"
            value={form.subject}
            onChange={handleChange}
            placeholder={t('support.subjectPlaceholder')}
            maxLength={200}
          />
        </label>

        <label>
          {t('support.message')}
          <textarea
            name="message"
            value={form.message}
            onChange={handleChange}
            placeholder={t('support.messagePlaceholder')}
            rows={6}
            maxLength={5000}
          />
          <span className="char-count">{form.message.length}/5000</span>
        </label>

        {error && <p className="support-modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? t('support.sending') : t('support.sendTicket')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default SupportModal;
