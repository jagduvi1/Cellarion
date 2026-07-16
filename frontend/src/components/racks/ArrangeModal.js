import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import {
  buildFillOrder,
  FILL_CORNERS,
  buildArrangeRecord,
  canUndoArrange,
  saveArrangeRecord,
  loadArrangeRecord,
  clearArrangeRecord,
  loadArrangeCorner,
  saveArrangeCorner,
} from '../../utils/rackArrange';

/**
 * "Organize this rack" — pick a strategy and fill corner, preview which
 * bottles change place, then apply. The plan is computed SERVER-SIDE
 * (POST /api/racks/:id/arrange/preview — the same engine the MCP auto_arrange
 * tool uses) and applied in ONE atomic request, so there are no per-slot move
 * loops and no half-applied racks. The applied plan is persisted per rack
 * (localStorage, 7 days) as the user's guide for physically re-shelving, and
 * undo calls the same apply endpoint with the layouts swapped — the server
 * refuses if the rack changed in between.
 *
 * Props:
 *  - rack:      the rack document (slots populated)
 *  - onPreview: async (strategy, positionOrder) => ({ ok, data|error })
 *  - onApply:   async (target, before) => ({ ok, error? })   — also used for undo
 *  - onClose
 */
export default function ArrangeModal({ rack, onPreview, onApply, onClose }) {
  const { t } = useTranslation();
  const [record, setRecord] = useState(() => loadArrangeRecord(rack._id));
  // 'pick' = strategy + preview | 'applied' = guide list + undo | 'undone'
  const [view, setView] = useState(record ? 'applied' : 'pick');
  const [freshlyApplied, setFreshlyApplied] = useState(false);
  const [strategy, setStrategy] = useState('maturity');
  const [corner, setCorner] = useState(() => loadArrangeCorner(rack._id));
  const [busy, setBusy] = useState(null); // 'preview' | 'apply' | 'undo' | null
  const [plan, setPlan] = useState(null); // server preview: { changes, target, before, bottlesTotal }
  const [error, setError] = useState(null);

  const fillOrder = useMemo(() => buildFillOrder(rack, corner), [rack, corner]);

  // Server-side preview whenever the inputs change (only while picking).
  useEffect(() => {
    if (view !== 'pick') return undefined;
    let cancelled = false;
    setBusy('preview');
    setError(null);
    onPreview(strategy, fillOrder).then((res) => {
      if (cancelled) return;
      if (res.ok) setPlan(res.data);
      else {
        setPlan(null);
        setError(res.error || t('arrange.previewError', 'Could not compute the plan — close and try again.'));
      }
      setBusy(null);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy, fillOrder, view]);

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
    if (!plan) return;
    setBusy('apply');
    setError(null);
    const res = await onApply(plan.target, plan.before);
    if (!res.ok) {
      setError(res.error || t('arrange.applyError', 'A move failed — the rack may have changed. Close and try again.'));
      setBusy(null);
      return;
    }
    const rec = buildArrangeRecord({ ...plan, strategy });
    saveArrangeRecord(rack._id, rec);
    setRecord(rec);
    setFreshlyApplied(true);
    setBusy(null);
    setView('applied');
  };

  const handleUndo = async () => {
    setBusy('undo');
    setError(null);
    // Undo = the same atomic apply, with the layouts swapped.
    const res = await onApply(record.before, record.after);
    if (!res.ok) {
      setError(res.error || t('arrange.undoError', 'A move failed while undoing — the rack may have changed. Close and check the rack.'));
      setBusy(null);
      return;
    }
    clearArrangeRecord(rack._id);
    setRecord(null);
    setBusy(null);
    setView('undone');
  };

  const close = () => {
    if (busy === 'apply' || busy === 'undo') return; // no mid-flight confusion
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

  const changeCount = plan?.changes?.length || 0;

  return (
    <Modal title={t('arrange.title', 'Organize this rack')} onClose={close} wide showClose={busy !== 'apply' && busy !== 'undo'}>
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
                  disabled={busy === 'apply'}
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
                  disabled={busy === 'apply'}
                  aria-pressed={corner === c}
                >
                  {CORNER_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {busy === 'preview' && (
            <p className="arrange-empty">{t('arrange.previewLoading', 'Computing the plan…')}</p>
          )}
          {busy !== 'preview' && plan && (changeCount === 0 ? (
            <p className="arrange-empty">{t('arrange.alreadyOrganized', 'This rack is already organized this way — nothing to move.')}</p>
          ) : (
            <>
              <p className="arrange-summary">
                {t('arrange.summary', '{{count}} bottles change place ({{moves}} moves):', {
                  count: changeCount,
                  moves: changeCount,
                })}
              </p>
              {changesTable(plan.changes)}
            </>
          ))}

          {error && <div className="alert alert-error">{error}</div>}

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={close} disabled={busy === 'apply'}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleApply}
              disabled={!!busy || changeCount === 0}
            >
              {busy === 'apply'
                ? t('arrange.applyingNow', 'Applying…')
                : t('arrange.applyBtn', 'Apply ({{count}} moves)', { count: changeCount })}
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
                  ? t('arrange.undoingNow', 'Undoing…')
                  : t('arrange.undoBtn', 'Undo ({{count}} moves)', { count: record.changes.length })}
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
