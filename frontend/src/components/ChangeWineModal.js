import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { changeBottleWine } from '../api/bottles';
import WineSearchPicker from './WineSearchPicker';
import Modal from './Modal';

/**
 * "Change wine": the bottle was saved under the wrong registry wine (a red
 * filed under the estate's white, a near-twin picked from the search). Pick
 * the right wine and the bottle moves there, keeping its dates, price, notes,
 * rating, rack slot and history. `lotCount` = the other bottles of the same
 * wine and vintage in the user's own cellars; they can move along in the
 * same step. Calls onChanged({ alsoMoved }) on success.
 */
export default function ChangeWineModal({ bottleId, currentLabel, lotCount = 0, onClose, onChanged }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [wine, setWine] = useState(null);
  const [applyToLot, setApplyToLot] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleChange = async () => {
    if (!wine || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await changeBottleWine(apiFetch, bottleId, wine._id, { applyToLot: applyToLot && lotCount > 0 });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('changeWine.error'));
      onChanged({ alsoMoved: data.alsoMoved || 0, wine });
    } catch (e) {
      setError(e.message || t('changeWine.error'));
      setSubmitting(false);
    }
  };

  return (
    <Modal title={t('changeWine.title')} onClose={onClose} showClose trapFocus>
      {currentLabel && (
        <p className="change-wine-current">
          {t('changeWine.current')} <strong>{currentLabel}</strong>
        </p>
      )}
      <p>{t('changeWine.intro')}</p>

      <div className="change-wine-picker">
        <WineSearchPicker selected={wine} onSelect={setWine} placeholder={t('changeWine.searchPlaceholder')} />
      </div>

      {lotCount > 0 && (
        <label className="change-wine-lot">
          <input type="checkbox" checked={applyToLot} onChange={(e) => setApplyToLot(e.target.checked)} disabled={submitting} />
          {' '}{t('changeWine.alsoLot', { count: lotCount })}
        </label>
      )}

      <p className="change-wine-hint">{t('changeWine.keeps')}</p>

      {error && <p className="error-message" role="alert">{error}</p>}

      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleChange} disabled={submitting || !wine}>
          {submitting ? t('common.saving', 'Saving…') : t('changeWine.confirm')}
        </button>
      </div>
    </Modal>
  );
}
