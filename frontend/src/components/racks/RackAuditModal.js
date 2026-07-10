import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { getTotalSlots, getModularTotalSlots } from '../../utils/rackLayouts';

/**
 * Audit mode — a guided physical inventory of one rack. Steps through the
 * slots in position order asking "is this what's actually there?", collects
 * mismatches, and offers to clear slots whose bottle is gone. Nothing is
 * stored server-side; the audit lives in this modal only, and fixes go
 * through the existing clear-slot endpoint.
 */
export default function RackAuditModal({ rack, canEdit, onClearSlot, onClose }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState('intro'); // intro | running | report
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState({}); // position -> 'ok' | 'issue' | 'skipped'
  const [resolved, setResolved] = useState({}); // position -> true once fixed from the report
  const [clearing, setClearing] = useState(null); // position being cleared

  const maxPosition = rack.isModular && rack.modules?.length > 0
    ? getModularTotalSlots(rack.modules)
    : getTotalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);

  // Items in position order: every filled slot, plus (optionally) every
  // enabled empty position.
  const items = useMemo(() => {
    const slotMap = new Map((rack.slots || []).filter(s => s.bottle).map(s => [s.position, s]));
    const disabled = new Set(rack.disabledPositions || []);
    const list = [];
    for (let p = 1; p <= maxPosition; p++) {
      if (disabled.has(p)) continue;
      const slot = slotMap.get(p);
      if (slot) list.push({ position: p, slot });
      else if (includeEmpty) list.push({ position: p, slot: null });
    }
    return list;
  }, [rack.slots, rack.disabledPositions, maxPosition, includeEmpty]);

  const current = items[index];

  const record = (outcome) => {
    setResults(prev => ({ ...prev, [current.position]: outcome }));
    if (index + 1 >= items.length) setPhase('report');
    else setIndex(index + 1);
  };

  const goBack = () => {
    if (index > 0) setIndex(index - 1);
  };

  const issues = items.filter(it => results[it.position] === 'issue');
  const okCount = items.filter(it => results[it.position] === 'ok').length;
  const skippedCount = items.filter(it => results[it.position] === 'skipped').length;

  const handleClear = async (position) => {
    setClearing(position);
    const ok = await onClearSlot(position);
    setClearing(null);
    if (ok) setResolved(prev => ({ ...prev, [position]: true }));
  };

  const wineLabel = (slot) => {
    const wine = slot?.bottle?.wineDefinition;
    const name = wine?.name || t('common.unknown', 'Unknown');
    return slot?.bottle?.vintage ? `${name} (${slot.bottle.vintage})` : name;
  };

  return (
    <Modal title={t('audit.title', 'Audit rack — {{name}}', { name: rack.name })} onClose={onClose} wide showClose>
      {phase === 'intro' && (
        <>
          <p className="audit-intro">
            {t('audit.introText', 'Walk to the rack and step through it slot by slot — confirm that what Cellarion thinks is there matches reality. You get a mismatch report at the end.')}
          </p>
          <label className="audit-include-empty">
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={e => { setIncludeEmpty(e.target.checked); setIndex(0); setResults({}); }}
            />
            {t('audit.includeEmpty', 'Also check empty slots (should have no bottle)')}
          </label>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
            <button className="btn btn-primary" onClick={() => setPhase('running')} disabled={items.length === 0}>
              {t('audit.startBtn', 'Start ({{count}} slots)', { count: items.length })}
            </button>
          </div>
        </>
      )}

      {phase === 'running' && current && (
        <>
          <div className="audit-progress">
            <div className="audit-progress-bar" style={{ width: `${(index / items.length) * 100}%` }} />
          </div>
          <p className="audit-step-count">{index + 1} / {items.length}</p>

          <div className="audit-card">
            <div className="audit-position">{t('audit.slotLabel', 'Slot {{position}}', { position: current.position })}</div>
            {current.slot ? (
              <>
                <div className="audit-expected">{wineLabel(current.slot)}</div>
                <div className="audit-expected-sub">
                  {current.slot.bottle?.wineDefinition?.producer || ''}
                </div>
                <p className="audit-question">{t('audit.questionFilled', 'Is this bottle in the slot?')}</p>
              </>
            ) : (
              <>
                <div className="audit-expected audit-expected--empty">{t('audit.expectedEmpty', 'Should be empty')}</div>
                <p className="audit-question">{t('audit.questionEmpty', 'Is the slot actually empty?')}</p>
              </>
            )}
          </div>

          <div className="audit-answer-row">
            <button className="btn btn-primary audit-btn-ok" onClick={() => record('ok')}>
              ✓ {t('audit.answerYes', 'Yes, correct')}
            </button>
            <button className="btn btn-danger audit-btn-issue" onClick={() => record('issue')}>
              ✗ {t('audit.answerNo', 'No — mismatch')}
            </button>
          </div>
          <div className="audit-secondary-row">
            <button className="btn btn-secondary btn-small" onClick={goBack} disabled={index === 0}>
              {t('audit.backBtn', 'Back')}
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => record('skipped')}>
              {t('audit.skipBtn', 'Skip')}
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => setPhase('report')}>
              {t('audit.finishEarly', 'Finish now')}
            </button>
          </div>
        </>
      )}

      {phase === 'report' && (
        <>
          <p className="audit-summary">
            {t('audit.summary', '{{ok}} correct · {{issues}} mismatches · {{skipped}} skipped (of {{total}})', {
              ok: okCount, issues: issues.length, skipped: skippedCount, total: items.length,
            })}
          </p>

          {issues.length === 0 ? (
            <p className="audit-clean">{t('audit.allGood', 'Everything matches — your cellar and Cellarion agree. 🎉')}</p>
          ) : (
            <div className="audit-issues">
              {issues.map(it => (
                <div key={it.position} className={`audit-issue ${resolved[it.position] ? 'resolved' : ''}`}>
                  <div className="audit-issue-info">
                    <strong>{t('audit.slotLabel', 'Slot {{position}}', { position: it.position })}</strong>
                    <span>
                      {it.slot
                        ? t('audit.issueFilled', 'Expected {{wine}} — not there or different', { wine: wineLabel(it.slot) })
                        : t('audit.issueEmpty', 'Expected empty — has a bottle. Open the slot afterwards to assign what you found.')}
                    </span>
                  </div>
                  {it.slot && canEdit && !resolved[it.position] && (
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => handleClear(it.position)}
                      disabled={clearing === it.position}
                    >
                      {clearing === it.position ? t('common.saving', 'Saving...') : t('audit.clearSlot', 'Clear slot')}
                    </button>
                  )}
                  {resolved[it.position] && <span className="audit-resolved">✓ {t('audit.cleared', 'Cleared')}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="modal-actions">
            <button className="btn btn-primary" onClick={onClose}>{t('common.close', 'Close')}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
