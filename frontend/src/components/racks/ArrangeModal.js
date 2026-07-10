import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { buildArrangePlan } from '../../utils/rackArrange';

/**
 * "Organize this rack" — pick a strategy, preview which bottles change
 * place, then apply the plan step by step through the atomic move/swap
 * endpoint. The database is updated first; the change list stays on screen
 * afterwards as the user's guide for physically rearranging the bottles.
 */
export default function ArrangeModal({ rack, maxPosition, onMoveStep, onClose }) {
  const { t } = useTranslation();
  const [strategy, setStrategy] = useState('maturity');
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const entries = useMemo(() => (rack.slots || []).filter(s => s.bottle), [rack.slots]);
  // Plan is frozen once we start applying — rack.slots mutates underneath us
  // as each move's response lands, and re-deriving mid-apply would corrupt
  // the remaining steps.
  const [frozenPlan, setFrozenPlan] = useState(null);
  const livePlan = useMemo(
    () => buildArrangePlan(entries, maxPosition, rack.disabledPositions, strategy),
    [entries, maxPosition, rack.disabledPositions, strategy]
  );
  const plan = frozenPlan || livePlan;

  const STRATEGIES = [
    { id: 'maturity', label: t('arrange.strategyMaturity', 'Drink window (recommended)'), desc: t('arrange.strategyMaturityDesc', 'Bottles to drink soonest go to the first slots.') },
    { id: 'type', label: t('arrange.strategyType', 'Wine type'), desc: t('arrange.strategyTypeDesc', 'Group reds, whites, rosés, sparkling…') },
    { id: 'vintage', label: t('arrange.strategyVintage', 'Vintage'), desc: t('arrange.strategyVintageDesc', 'Oldest vintages first.') },
  ];

  const handleApply = async () => {
    const applied = plan;
    setFrozenPlan(applied);
    setApplying(true);
    setError(null);
    for (let i = 0; i < applied.steps.length; i++) {
      setProgress(i + 1);
      const ok = await onMoveStep(applied.steps[i].from, applied.steps[i].to);
      if (!ok) {
        setError(t('arrange.applyError', 'A move failed — the rack may have changed. Close and try again.'));
        setApplying(false);
        return;
      }
    }
    setApplying(false);
    setDone(true);
  };

  const close = () => {
    if (applying) return; // no half-applied confusion — let the loop finish
    onClose();
  };

  return (
    <Modal title={t('arrange.title', 'Organize this rack')} onClose={close} wide showClose={!applying}>
      {!done && (
        <>
          <div className="arrange-strategies">
            {STRATEGIES.map(s => (
              <label key={s.id} className={`arrange-strategy ${strategy === s.id ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="arrange-strategy"
                  value={s.id}
                  checked={strategy === s.id}
                  onChange={() => setStrategy(s.id)}
                  disabled={applying}
                />
                <span>
                  <strong>{s.label}</strong>
                  <small>{s.desc}</small>
                </span>
              </label>
            ))}
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
                    {plan.changes.map(c => (
                      <tr key={c.to}>
                        <td className="arrange-pos">{c.to}</td>
                        <td>
                          {c.bottle?.wineDefinition?.name || t('common.unknown', 'Unknown')}
                          {c.bottle?.vintage ? ` (${c.bottle.vintage})` : ''}
                        </td>
                        <td className="arrange-pos arrange-pos--from">{c.from}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {error && <div className="alert alert-error">{error}</div>}

          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={close} disabled={applying}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleApply}
              disabled={applying || plan.steps.length === 0}
            >
              {applying
                ? t('arrange.applying', 'Moving… {{done}}/{{total}}', { done: progress, total: plan.steps.length })
                : t('arrange.applyBtn', 'Apply ({{count}} moves)', { count: plan.steps.length })}
            </button>
          </div>
        </>
      )}

      {done && (
        <>
          <p className="arrange-done">
            {t('arrange.doneText', 'Done — the rack is reorganized in Cellarion. Now move the bottles in your physical rack to match; use this list as your guide:')}
          </p>
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
                {plan.changes.map(c => (
                  <tr key={c.to}>
                    <td className="arrange-pos">{c.to}</td>
                    <td>
                      {c.bottle?.wineDefinition?.name || t('common.unknown', 'Unknown')}
                      {c.bottle?.vintage ? ` (${c.bottle.vintage})` : ''}
                    </td>
                    <td className="arrange-pos arrange-pos--from">{c.from}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="arrange-tip">
            {t('arrange.bookTip', 'Tip: the Cellar Book gives you a printable map of the new layout.')}
          </p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={onClose}>
              {t('common.close', 'Close')}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
