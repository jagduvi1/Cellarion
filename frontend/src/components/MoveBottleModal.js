import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { listCellars } from '../api/cellars';
import { moveBottle } from '../api/bottles';
import Modal from './Modal';

/**
 * Move a single active bottle to another cellar the user OWNS (v1). The bottle's
 * data and history are kept; it arrives unplaced in the destination. Calls
 * onMoved(destCellarId) on success so the caller can navigate to the new home.
 */
export default function MoveBottleModal({ bottleId, currentCellarId, wineLabel, onClose, onMoved }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [cellars, setCellars] = useState(null); // null while loading
  const [target, setTarget] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [movedTo, setMovedTo] = useState(null); // dest cellar name once the move succeeds

  useEffect(() => {
    let active = true;
    listCellars(apiFetch)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        // v1: only cellars the user owns, excluding the current one and any soft-deleted.
        const owned = (data.cellars || []).filter(
          (c) => c.userRole === 'owner' && c.deletedAt == null && String(c._id) !== String(currentCellarId)
        );
        setCellars(owned);
      })
      .catch(() => { if (active) { setCellars([]); setError(t('moveBottle.loadError')); } });
    return () => { active = false; };
  }, [apiFetch, currentCellarId, t]);

  const handleMove = async () => {
    if (!target || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await moveBottle(apiFetch, bottleId, target);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('moveBottle.moveError'));
      // Show a brief confirmation instead of jumping to the destination cellar.
      const destName = (cellars || []).find((c) => String(c._id) === String(target))?.name || '';
      setMovedTo(destName);
    } catch (e) {
      setError(e.message || t('moveBottle.moveError'));
      setSubmitting(false);
    }
  };

  // Success view — confirm the move, then return to the cellar we came from.
  if (movedTo !== null) {
    return (
      <Modal title={t('moveBottle.movedTitle')} onClose={onMoved} showClose trapFocus>
        <p className="move-bottle-success">{t('moveBottle.movedInfo', { cellar: movedTo })}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onMoved}>
            {t('moveBottle.backToCellar')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('moveBottle.title')} onClose={onClose} showClose trapFocus>
      {wineLabel && <p className="move-bottle-wine"><strong>{wineLabel}</strong></p>}
      <p>{t('moveBottle.intro')}</p>

      {cellars === null ? (
        <p className="loading">{t('moveBottle.loading')}</p>
      ) : cellars.length === 0 ? (
        <p className="empty-state">{t('moveBottle.noOtherCellars')}</p>
      ) : (
        <label className="move-bottle-field">
          <span>{t('moveBottle.destinationLabel')}</span>
          <select
            className="form-select"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={submitting}
          >
            <option value="">{t('moveBottle.selectCellar')}</option>
            {cellars.map((c) => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
        </label>
      )}

      {error && <p className="error-message" role="alert">{error}</p>}

      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleMove}
          disabled={submitting || !target}
        >
          {submitting ? t('moveBottle.moving') : t('moveBottle.moveButton')}
        </button>
      </div>
    </Modal>
  );
}
