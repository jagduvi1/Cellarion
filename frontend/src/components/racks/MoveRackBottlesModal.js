import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import BetaBadge from '../BetaBadge';
import { getTotalSlots, getModularTotalSlots } from '../../utils/rackLayouts';

// Slots a rack can still take: its capacity, less disabled and taken slots
// (the same capacity the rack tabs count with).
export function freeSlotsOf(rack) {
  const total = rack.isModular && rack.modules?.length > 0
    ? getModularTotalSlots(rack.modules)
    : getTotalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);
  return Math.max(0, total - (rack.disabledPositions?.length || 0) - (rack.slots?.length || 0));
}

/**
 * Early access ('rackMoveBottles'): move every bottle of a rack into another
 * rack of the same cellar in one go (forum feedback 2026-10-12: a rack
 * rebuilt as a wine cabinet meant moving every bottle across by hand).
 *
 * The bottles keep their order and fill the chosen rack's free slots from the
 * first one; when it has less room, the first ones by position move and the
 * rest stay. The server does the move (POST /api/racks/:id/move-bottles) —
 * `onMove(toRackId)` resolves { ok, data } | { ok: false, error } — and
 * `onShowRack(rackId)` opens the rack they went to.
 */
export default function MoveRackBottlesModal({ rack, racks, onMove, onShowRack, onClose }) {
  const { t } = useTranslation();
  const count = rack.slots?.length || 0;
  const others = racks.filter((r) => r._id !== rack._id).map((r) => ({ rack: r, free: freeSlotsOf(r) }));
  const firstWithRoom = others.find((o) => o.free > 0);
  const [toId, setToId] = useState(firstWithRoom ? firstWithRoom.rack._id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { moved, left }

  const chosen = others.find((o) => o.rack._id === toId) || null;
  const willMove = chosen ? Math.min(count, chosen.free) : 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!chosen || willMove === 0 || busy) return;
    setBusy(true);
    setError('');
    // Captured now: the page reloads its racks after the move, and the result
    // screen must still name the racks as they were when the user chose.
    const to = { id: chosen.rack._id, name: chosen.rack.name };
    const from = rack.name;
    const out = await onMove(to.id);
    setBusy(false);
    if (!out?.ok) { setError(out?.error || t('racks.moveBottles.failed', "Couldn't move the bottles. Please try again.")); return; }
    setResult({ moved: out.data?.moved ?? willMove, left: out.data?.left ?? 0, to, from });
  };

  if (result) {
    return (
      <Modal title={t('racks.moveBottles.doneTitle', 'Bottles moved')} onClose={onClose} showClose trapFocus>
        <p className="move-bottle-success" role="status">
          {t('racks.moveBottles.doneInfo', { count: result.moved, to: result.to.name, defaultValue: 'Moved {{count}} bottles to {{to}}.' })}
        </p>
        {result.left > 0 && (
          <p className="move-bottle-skipped">
            {t('racks.moveBottles.doneLeft', { count: result.left, from: result.from, defaultValue: '{{count}} bottles stayed in {{from}}: there was no more room.' })}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('bulk.close', 'Done')}</button>
          <button type="button" className="btn btn-primary" onClick={() => onShowRack(result.to.id)}>
            {t('racks.moveBottles.showRack', { name: result.to.name, defaultValue: 'Show {{name}}' })}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('racks.moveBottles.title', 'Move bottles to another rack')} onClose={onClose} showClose trapFocus>
      <BetaBadge feature="rackMoveBottles" note={t('racks.moveBottles.betaNote', 'Moving a whole rack at once is in early access.')} />
      {others.length === 0 ? (
        <p>{t('racks.moveBottles.noOtherRack', 'This cellar has no other rack yet. Create the rack the bottles should go to, for example a wine cabinet, then come back here.')}</p>
      ) : (
        <form onSubmit={submit} className="move-rack-form">
          <p>{t('racks.moveBottles.intro', { count, from: rack.name, defaultValue: 'The {{count}} bottles in {{from}} move to the rack you choose. They keep their order and fill its free slots from the first one.' })}</p>
          <fieldset className="move-rack-choices">
            <legend>{t('racks.moveBottles.toLabel', 'Move them to')}</legend>
            {others.map(({ rack: r, free }) => (
              <label key={r._id} className={`move-rack-choice${free === 0 ? ' is-full' : ''}`}>
                <input
                  type="radio"
                  name="move-rack-target"
                  value={r._id}
                  checked={toId === r._id}
                  onChange={() => setToId(r._id)}
                  disabled={free === 0 || busy}
                />
                <span className="move-rack-choice-name">{r.group ? `${r.group} · ${r.name}` : r.name}</span>
                <span className="move-rack-choice-free">
                  {free === 0
                    ? t('racks.moveBottles.full', 'Full')
                    : t('racks.moveBottles.freeSlots', { count: free, defaultValue: '{{count}} free slots' })}
                </span>
              </label>
            ))}
          </fieldset>
          {chosen && willMove < count && (
            <p className="move-rack-short" role="status">
              {t('racks.moveBottles.notAllFit', { fit: willMove, count, left: count - willMove, from: rack.name, defaultValue: 'Only {{fit}} of the {{count}} fit. The first {{fit}} by position move; the other {{left}} stay in {{from}}.' })}
            </p>
          )}
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={!chosen || willMove === 0 || busy}>
              {busy
                ? t('racks.moveBottles.moving', 'Moving…')
                : t('racks.moveBottles.submit', { count: willMove, defaultValue: 'Move {{count}} bottles' })}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
