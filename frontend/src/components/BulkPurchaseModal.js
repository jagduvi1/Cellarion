import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkUpdateBottles } from '../api/bottles';
import { CURRENCIES } from '../config/currencies';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

/**
 * Bulk "Purchase details": one date, shop, link and price written to every
 * selected bottle — the other half of the delivery case (support ticket
 * 6a9949e3: a case from one merchant on one day should not be twelve edits).
 * Only the fields the user fills in are sent; whatever is left blank stays as
 * it is on each bottle.
 */
export default function BulkPurchaseModal({ bottleIds, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const count = bottleIds.length;
  const [form, setForm] = useState({
    purchaseDate: '', purchaseLocation: '', purchaseUrl: '', price: '',
    currency: user?.preferences?.currency || 'USD',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Build the payload from the filled-in fields only.
  const fields = {};
  if (form.purchaseDate) fields.purchaseDate = form.purchaseDate;
  if (form.purchaseLocation.trim()) fields.purchaseLocation = form.purchaseLocation.trim();
  if (form.purchaseUrl.trim()) fields.purchaseUrl = form.purchaseUrl.trim();
  if (form.price !== '') { fields.price = Number(form.price); fields.currency = form.currency; }
  const nothingToSend = Object.keys(fields).length === 0;

  const submit = async (e) => {
    e.preventDefault();
    if (nothingToSend || submitting) return;
    if (fields.price !== undefined && (!Number.isFinite(fields.price) || fields.price < 0)) {
      setError(t('bulk.priceInvalid'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await bulkUpdateBottles(apiFetch, bottleIds, fields);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('bulk.failed'));
      setResult({ done: data.done ?? 0, skipped: (data.skipped || []).length });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
      setSubmitting(false);
    }
  };

  if (result) {
    return <BulkOutcome title={t('bulk.purchaseDoneTitle')} done={result.done} skipped={result.skipped} onClose={onDone} />;
  }

  return (
    <Modal title={t('bulk.purchaseTitle', { count })} onClose={onClose} showClose trapFocus>
      <p>{t('bulk.purchaseIntro')}</p>
      <form onSubmit={submit} className="bulk-form">
        <label className="form-group">
          <span>{t('addBottle.purchaseDate')}</span>
          <input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} disabled={submitting} />
        </label>
        <label className="form-group">
          <span>{t('addBottle.purchaseLocation')}</span>
          <input type="text" value={form.purchaseLocation} onChange={set('purchaseLocation')} maxLength={500}
            placeholder={t('addBottle.purchaseLocationPlaceholder')} disabled={submitting} />
        </label>
        <label className="form-group">
          <span>{t('addBottle.purchaseUrl')}</span>
          <input type="url" value={form.purchaseUrl} onChange={set('purchaseUrl')} maxLength={2048}
            placeholder="https://" disabled={submitting} />
        </label>
        <div className="form-group bulk-price-row">
          <label>
            <span>{t('bulk.pricePerBottle')}</span>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={form.price} onChange={set('price')} disabled={submitting} />
          </label>
          <label>
            <span>{t('common.currency', 'Currency')}</span>
            <select value={form.currency} onChange={set('currency')} disabled={submitting}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || nothingToSend}>
            {submitting ? t('common.saving') : t('bulk.purchaseSubmit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
