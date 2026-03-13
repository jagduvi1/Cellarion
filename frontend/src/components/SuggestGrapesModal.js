import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

export function SuggestGrapesModal({ wine, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [grapes, setGrapes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const suggestedGrapes = grapes.split(',').map(g => g.trim()).filter(Boolean);
    if (!suggestedGrapes.length) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/wine-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'grape_suggestion',
          linkedWineDefinition: wine._id,
          suggestedGrapes
        })
      });
      const data = await res.json();
      if (res.ok) setSubmitted(true);
      else setError(data.error || t('common.error', 'An error occurred'));
    } catch {
      setError(t('common.networkError', 'Network error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        {submitted ? (
          <>
            <h2>{t('bottleDetail.suggestGrapesThankYou', 'Thanks for contributing!')}</h2>
            <p className="modal-wine-name">{wine?.name}</p>
            <p style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)', marginBottom: '1.25rem' }}>
              {t('bottleDetail.suggestGrapesConfirm', 'Your suggestion has been submitted for review. Our team will add the verified varieties to the wine registry.')}
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose}>{t('common.close', 'Close')}</button>
            </div>
          </>
        ) : (
          <>
            <h2>{t('bottleDetail.suggestGrapesTitle', 'Suggest Grape Varieties')}</h2>
            <p className="modal-wine-name">{wine?.name}</p>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t('bottleDetail.suggestGrapesLabel', 'Grape varieties')}</label>
                <input
                  type="text"
                  value={grapes}
                  onChange={e => setGrapes(e.target.value)}
                  placeholder={t('bottleDetail.suggestGrapesPlaceholder', 'e.g. Cabernet Sauvignon, Merlot')}
                  autoFocus
                />
                <small className="form-hint">{t('bottleDetail.suggestGrapesHint', 'Separate multiple varieties with commas')}</small>
              </div>
              {error && <div className="alert alert-error">{error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={submitting || !grapes.trim()}>
                  {submitting ? t('common.saving') : t('bottleDetail.suggestGrapesSubmit', 'Submit suggestion')}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
