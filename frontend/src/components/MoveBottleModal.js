import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { listCellars } from '../api/cellars';
import { moveBottle, bulkMoveBottles } from '../api/bottles';
import Modal from './Modal';

/**
 * Move an active bottle — or, with `bottleIds`, MANY at once — to another
 * cellar the user owns or edits (the server's rackOps.MOVE_MIN_ROLE). The
 * bottles' data and history are kept; they arrive unplaced in the destination
 * and belong to its owner, which the dialog says whenever the move changes
 * whose bottle it is. Calls onMoved() on success so the caller can refresh or
 * navigate.
 *
 * Bulk mode (e.g. a whole delivery moved from a storage cellar to home):
 * pass `bottleIds` instead of `bottleId`. One
 * request moves them all; bottles the server could not move (already
 * consumed, or not the user's to move) are reported, not hidden.
 */
const MOVE_ROLES = ['owner', 'editor'];

export default function MoveBottleModal({ bottleId, bottleIds, currentCellarId, wineLabel, onClose, onMoved }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const bulk = Array.isArray(bottleIds);
  const count = bulk ? bottleIds.length : 1;
  const [cellars, setCellars] = useState(null); // null while loading
  const [currentCellar, setCurrentCellar] = useState(null);
  const [target, setTarget] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [movedTo, setMovedTo] = useState(null); // dest cellar name once the move succeeds
  const [outcome, setOutcome] = useState(null); // bulk: { moved, skipped }

  useEffect(() => {
    let active = true;
    listCellars(apiFetch)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        // Cellars the user owns or edits, minus the current one and any
        // soft-deleted. Out of a cellar someone else owns, a bottle goes only
        // into the user's own cellars or another cellar of that same owner:
        // the server refuses a move between two other people's cellars.
        const all = data.cellars || [];
        const current = all.find((c) => String(c._id) === String(currentCellarId)) || null;
        const reachable = (c) => !current || current.userRole === 'owner'
          || c.userRole === 'owner' || String(c.user) === String(current.user);
        const movable = all.filter(
          (c) => MOVE_ROLES.includes(c.userRole) && c.deletedAt == null
            && String(c._id) !== String(currentCellarId) && reachable(c)
        );
        setCurrentCellar(current);
        setCellars(movable);
      })
      .catch(() => { if (active) { setCellars([]); setError(t('moveBottle.loadError')); } });
    return () => { active = false; };
  }, [apiFetch, currentCellarId, t]);

  const handleMove = async () => {
    if (!target || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = bulk
        ? await bulkMoveBottles(apiFetch, bottleIds, target)
        : await moveBottle(apiFetch, bottleId, target);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('moveBottle.moveError'));
      // Show a brief confirmation instead of jumping to the destination cellar.
      const destName = (cellars || []).find((c) => String(c._id) === String(target))?.name || '';
      if (bulk) setOutcome({ moved: data.moved ?? 0, skipped: (data.skipped || []).length });
      setMovedTo(destName);
    } catch (e) {
      setError(e.message || t('moveBottle.moveError'));
      setSubmitting(false);
    }
  };

  // Success view — confirm the move, then return to the cellar we came from.
  if (movedTo !== null) {
    return (
      <Modal title={bulk ? t('moveBottle.movedManyTitle') : t('moveBottle.movedTitle')} onClose={onMoved} showClose trapFocus>
        {bulk ? (
          <>
            <p className="move-bottle-success">{t('moveBottle.movedManyInfo', { count: outcome?.moved ?? 0, cellar: movedTo })}</p>
            {outcome?.skipped > 0 && (
              <p className="move-bottle-skipped" role="status">{t('moveBottle.skippedInfo', { count: outcome.skipped })}</p>
            )}
          </>
        ) : (
          <p className="move-bottle-success">{t('moveBottle.movedInfo', { cellar: movedTo })}</p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onMoved}>
            {t('moveBottle.backToCellar')}
          </button>
        </div>
      </Modal>
    );
  }

  // A bottle belongs to the owner of its cellar, so a move between cellars of
  // two different owners hands it over: say so before the user confirms.
  const dest = (cellars || []).find((c) => String(c._id) === String(target));
  const ownerChanges = !!dest && (currentCellar
    ? String(dest.user) !== String(currentCellar.user)
    : dest.userRole !== 'owner');
  let ownerNote = null;
  if (ownerChanges) {
    ownerNote = dest.userRole === 'owner'
      ? t('moveBottle.becomesYours', { count })
      : t('moveBottle.becomesOwners', { count });
  }

  return (
    <Modal title={bulk ? t('moveBottle.titleMany', { count }) : t('moveBottle.title')} onClose={onClose} showClose trapFocus>
      {wineLabel && <p className="move-bottle-wine"><strong>{wineLabel}</strong></p>}
      <p>{bulk ? t('moveBottle.introMany') : t('moveBottle.intro')}</p>

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
              <option key={c._id} value={c._id}>
                {c.userRole === 'owner' ? c.name : t('moveBottle.sharedOption', { name: c.name })}
              </option>
            ))}
          </select>
        </label>
      )}
      {ownerNote && <p className="move-bottle-owner-note" role="status">{ownerNote}</p>}

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
          {submitting
            ? t('moveBottle.moving')
            : bulk ? t('moveBottle.moveManyButton', { count }) : t('moveBottle.moveButton')}
        </button>
      </div>
    </Modal>
  );
}
