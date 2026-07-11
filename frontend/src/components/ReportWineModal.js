import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import Modal from './Modal';
import { submitWineReport } from '../api/support';
import { useAuth } from '../contexts/AuthContext';
import './ReportWineModal.css';

const REASON_VALUES = ['wrong_info', 'duplicate', 'wrong_price', 'wrong_tasting_profile', 'inappropriate', 'other'];

function ReportWineModal({ wine, defaultReason, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({ reason: defaultReason || 'wrong_info', details: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (e) => {
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));
    setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    setSubmitting(true);
    setError(null);
    try {
      const res = await submitWineReport(apiFetch, {
        wineDefinitionId: wine._id,
        reason: form.reason,
        details: form.details || undefined,
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error || t('reportWine.submitFailed'));
      setSuccess(true);
    } catch {
      setError(t('common.networkError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <Modal title={t('reportWine.sentTitle')} onClose={onClose}>
        <div className="report-wine-success">
          <p>{t('reportWine.sentBody')}</p>
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('reportWine.title')} onClose={onClose}>
      <p className="report-wine-subtitle">
        <Trans
          i18nKey="reportWine.reporting"
          components={{ strong: <strong /> }}
          values={{ wine: `${wine.name}${wine.producer ? ` — ${wine.producer}` : ''}` }}
        />
      </p>
      <form onSubmit={handleSubmit} className="report-wine-form">
        <label>
          {t('reportWine.reason')}
          <select name="reason" value={form.reason} onChange={handleChange}>
            {REASON_VALUES.map(v => (
              <option key={v} value={v}>{t(`reportWine.reasons.${v}`)}</option>
            ))}
          </select>
        </label>

        <label>
          {t('reportWine.details')} <span className="optional">{t('reportWine.optional')}</span>
          <textarea
            name="details"
            value={form.details}
            onChange={handleChange}
            placeholder={t('reportWine.detailsPlaceholder')}
            rows={4}
            maxLength={2000}
          />
          <span className="char-count">{form.details.length}/2000</span>
        </label>

        {error && <p className="report-wine-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-danger" disabled={submitting}>
            {submitting ? t('reportWine.submitting') : t('reportWine.submit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default ReportWineModal;
