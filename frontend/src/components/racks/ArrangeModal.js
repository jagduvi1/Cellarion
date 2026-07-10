import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import {
  buildArrangePlan,
  buildFillOrder,
  FILL_CORNERS,
  buildArrangeRecord,
  buildUndoSteps,
  canUndoArrange,
  saveArrangeRecord,
  loadArrangeRecord,
  clearArrangeRecord,
  loadArrangeCorner,
  saveArrangeCorner,
} from '../../utils/rackArrange';

/**
 * "Organize this rack" — pick a strategy and fill corner, preview which
 * bottles change place, then apply the plan step by step through the atomic
 * move/swap endpoint. The database is updated first; the change list is the
 * user's guide for physically rearranging the bottles, so the applied plan
 * is persisted per rack (localStorage, 7 days) and restored when the modal
 * reopens — closing it, even accidentally, loses nothing. An applied plan
 * can be undone by replaying its steps in reverse, as long as the rack still
 * holds exactly the layout the plan produced.
 */
export default function ArrangeModal({ rack, maxPosition, onMoveStep, onClose }) {
  const { t } = useTranslation();
  const [record, setRecord] = useState(() => loadArrangeRecord(rack._id));
  // 'pick' = strategy + preview | 'applied' = guide list + undo | 'undone'
  const [view, setView] = useState(record ? 'applied' : 'pick');
  const [freshlyApplied, setFreshlyApplied] = useState(false);
  const [strategy, setStrategy] = useState('maturity');
  const [corner, setCorner] = useState(() => loadArrangeCorner(rack._id));
  const [busy, setBusy] = useState(null); // 'apply' | 'undo' | null
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);

  const entries = useMemo(() => (rack.slots || []).filter(s => s.bottle), [rack.slots]);
  const fillOrder = useMemo(() => buildFillOrder(rack, corner), [rack, corner]);
  // Plan is frozen once we start applying — rack.slots mutates underneath us
  // as each move's response lands, and re-deriving mid-apply would corrupt
  // the remaining steps.
  const [frozenPlan, setFrozenPlan] = useState(null);
  const livePlan = useMemo(
    () => buildArrangePlan(entries, maxPosition, rack.disabledPositions, strategy, fillOrder),
    [entries, maxPosition, rack.disabledPositions, strategy, fillOrder]
  );
  const plan = frozenPlan || livePlan;

  const canUndo = useMemo(
    () => !!record && canUndoArrange(record, rack.slots),
    [record, rack.slots]
  );

  const STRATEGIES = [
    { id: 'maturity', label: t('arrange.strategyMaturity', 'Drink window (recommended)'), desc: t('arrange.strategyMaturityDesc', 'Bottles to drink soonest go to the first slots.') },
    { id: 'type', label: t('arrange.strategyType', 'Wine type'), desc: t('arrange.strategyTypeDesc', 'Group reds, whites, rosés, sparkling…') },
    { id: 'vintage', label: t('arrange.strategyVintage', 'Vintage'), desc: t('arrange.strategyVintageDesc', 'Oldest vintages first.') },
  ];

  const CORNER_LABELS = {
    'top-left': t('arrange.cornerTopLeft', 'Top left'),
    'top-right': t('arrange.cornerTopRight', 'Top right'),
    'bottom-left': t('arrange.cornerBottomLeft', 'Bottom left'),
    'bottom-right': t('arrange.cornerBottomRight', 'Bottom right'),
  };

  const pickCorner = (c) => {
    setCorner(c);
    saveArrangeCorner(rack._id, c);
  };

  const handleApply = async () => {
    const applied = plan;
    // Snapshot the pre-apply layout now — building the record after the loop
    // would read the already-mutated rack.
    const rec = buildArrangeRecord(entries, applied, strategy);
    setFrozenPlan(applied);
    setBusy('apply');
    setError(null);
    setProgress({ done: 0, total: applied.steps.length });
    for (let i = 0; i < applied.steps.length; i++) {
      setProgress({ done: i + 1, total: applied.steps.length });
      const ok = await onMoveStep(applied.steps[i].from, applied.steps[i].to);
      if (!ok) {
        setError(t('arrange.applyError', 'A move failed — the rack may have changed. Close and try again.'));
        setBusy(null);
        return;
      }
    }
    saveArrangeRecord(rack._id, rec);
    setRecord(rec);
    setFreshlyApplied(true);
    setFrozenPlan(null);
    setBusy(null);
    setView('applied');
  };

  const handleUndo = async () => {
    const steps = buildUndoSteps(record.steps);
    setBusy('undo');
    setError(null);
    setProgress({ done: 0, total: steps.length });
    for (let i = 0; i < steps.length; i++) {
      setProgress({ done: i + 1, total: steps.length });
      const ok = await onMoveStep(steps[i].from, steps[i].to);
      if (!ok) {
        setError(t('arrange.undoError', 'A move failed while undoing — the rack may have changed. Close and check the rack.'));
        setBusy(null);
        return;
      }
    }
    clearArrangeRecord(rack._id);
    setRecord(null);
    setBusy(null);
    setView('undone');
  };

  const close = () => {
    if (busy) return; // no half-applied confusion — let the loop finish
    onClose();
  };

  const changesTable = (changes) => (
    <div className="arrange-list">
      <table>
        <thead>
          <tr>
            <th>{t('arrange.colTo', 'To')}</th>
            <th>{t('arrange.colWine', 'Wine')}</th>
            <th>{t('arrange.colFrom', 'From')}</th>
          </tr>
        </thead>
        <tbody>
          {changes.map(c => (
            <tr key={c.to}>
              <td className="arrange-pos">{c.to}</td>
              <td>
                {c.name || t('common.unknown', 'Unknown')}
                {c.vintage ? ` (${c.vintage})` : ''}
              </td>
              <td className="arrange-pos arrange-pos--from">{c.from}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Modal title={t('arrange.title', 'Organize this rack')} onClose={close} wide showClose={!busy}>
      {view === 'pick' && (
        <>
          {record && (
            <button type="button" className="arrange-back-link" onClick={() => setView('applied')} disabled={!!busy}>
              {t('arrange.backToLast', '← Back to last organization')}
            </button>
          )}

          <div className="arrange-strategies">
            {STRATEGIES.map(s => (
              <label key={s.id} className={`arrange-strategy ${strategy === s.id ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="arrange-strategy"
                  value={s.id}
                  checked={strategy === s.id}
                  onChange={() => setStrategy(s.id)}
                  disabled={!!busy}
                />
                <span>
                  <strong>{s.label}</strong>
                  <small>{s.desc}</small>
                </span>
              </label>
            ))}
          </div>

          <div className="arrange-corner">
            <span className="arrange-corner-label">{t('arrange.fillFrom', 'First slot at')}</span>
            <div className="arrange-corner-options" role="radiogroup" aria-label={t('arrange.fillFrom', 'First slot at')}>
              {FILL_CORNERS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`arrange-corner-btn ${corner === c ? 'active' : ''}`}
                  onClick={() => pickCorner(c)}
                  disabled={!!busy}
                  aria-pressed={corner === c}
                >
                  {CORNER_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {plan.changes.length === 0 ? (
            <p className="arrange-empty">{t('arrange.alreadyOrganized', 'This rack is already organized this way — nothing to move.')}</p>
          ) : (
            <>
              <p className="arrange-summary">
                {t('arrange.summary', '{{count}} bottles change place ({{moves}} moves):', {
                  count: plan.changes.length,
                  moves: plan.steps.length,
                })}
              </p>
              {changesTable(plan.changes.map(c => ({
                to: c.to,
                from: c.from,
                name: c.bottle?.wineDefinition?.name || '',
                vintage: c.bottle?.vintage || '',
              })))}
            </>
          )}

          {error && <div className="alert alert-error">{error}</div>}

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={close} disabled={!!busy}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleApply}
              disabled={!!busy || plan.steps.length === 0}
            >
              {busy === 'apply'
                ? t('arrange.applying', 'Moving… {{done}}/{{total}}', progress)
                : t('arrange.applyBtn', 'Apply ({{count}} moves)', { count: plan.steps.length })}
            </button>
          </div>
        </>
      )}

      {view === 'applied' && record && (
        <>
          <p className="arrange-done">
            {freshlyApplied
              ? t('arrange.doneText', 'Done — the rack is reorganized in Cellarion. Now move the bottles in your physical rack to match; use this list as your guide:')
              : t('arrange.lastPlanIntro', 'Your last organization of this rack, applied {{when}} — use this list as your guide:', {
                  when: new Date(record.appliedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
                })}
          </p>
          {changesTable(record.changes)}
          <p className="arrange-tip">
            {t('arrange.bookTip', 'Tip: the Cellar Book gives you a printable map of the new layout.')}
          </p>

          {!canUndo && busy !== 'undo' && (
            <p className="arrange-tip">
              {t('arrange.undoUnavailable', 'The rack has changed since — this organization can no longer be undone.')}
            </p>
          )}

          {error && <div className="alert alert-error">{error}</div>}

          <div className="modal-actions">
            {(canUndo || busy === 'undo') && (
              <button className="btn btn-secondary" onClick={handleUndo} disabled={!!busy}>
                {busy === 'undo'
                  ? t('arrange.undoing', 'Undoing… {{done}}/{{total}}', progress)
                  : t('arrange.undoBtn', 'Undo ({{count}} moves)', { count: record.steps.length })}
              </button>
            )}
            <button className="btn btn-secondary" onClick={() => { setView('pick'); setFreshlyApplied(false); }} disabled={!!busy}>
              {t('arrange.newPlanBtn', 'New organization…')}
            </button>
            <button className="btn btn-primary" onClick={close} disabled={!!busy}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </>
      )}

      {view === 'undone' && (
        <>
          <p className="arrange-done">
            {t('arrange.undoneText', 'Undone — the bottles are back where they were before the organization. Remember to restore the physical rack too if you had already moved them.')}
          </p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={close}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
