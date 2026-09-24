import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { listAttention, resolveAttention } from '../utils/offlineQueue';

// Refusals where "apply mine anyway" is a meaningful choice: a notes/rating
// conflict (keep mine), and a place or move into a slot that changed (the move
// still only moves MY bottle — offlineQueue keeps that check). Not a take-out
// of a slot that now holds another bottle (it would take out the wrong one),
// nor a bottle that already left the cellar (it would overwrite that record).
const isForceable = (op) => op.code === 'field_changed'
  || (op.code === 'slot_changed' && (op.kind === 'place' || op.kind === 'move'));

function describe(op, t) {
  const l = op.label || {};
  const wine = l.wine || t('offline.op.aBottle', 'a bottle');
  switch (op.kind) {
    case 'consume': return t('offline.op.consume', 'Remove {{wine}} from the cellar', { wine });
    case 'open': return t('offline.op.open', 'Open {{wine}}', { wine });
    case 'pour': return t('offline.op.pour', 'Pour a glass of {{wine}}', { wine });
    case 'edit': return t('offline.op.edit', 'Edit {{fields}} on {{wine}}', { wine, fields: (l.fields || []).join(', ') });
    case 'place': return t('offline.op.place', 'Place {{wine}} in {{rack}}, slot {{position}}', { wine, rack: l.rack, position: l.position });
    case 'clear': return t('offline.op.clear', 'Take {{wine}} out of {{rack}}, slot {{position}}', { wine, rack: l.rack, position: l.position });
    case 'move': return t('offline.op.move', 'Move {{wine}} in {{rack}} from slot {{position}} to {{toPosition}}', { wine, rack: l.rack, position: l.position, toPosition: l.toPosition });
    default: return wine;
  }
}

const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * The changes made offline that the server refused (#1355), one by one, with
 * the user's choices. Nothing refused is ever dropped without passing here.
 */
export default function OfflineAttentionModal({ userId, onClose }) {
  const { t } = useTranslation();
  const [ops, setOps] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => listAttention(userId).then(setOps), [userId]);
  useEffect(() => { load(); }, [load]);

  const act = async (op, action) => {
    setBusy(op.id);
    try { await resolveAttention(op.id, action, userId); } finally { setBusy(null); }
    const left = await listAttention(userId);
    setOps(left);
    if (!left.length) onClose();
  };

  return (
    <Modal title={t('offline.attentionTitle', 'Changes that need your attention')} onClose={onClose} showClose>
      <p>{t('offline.attentionIntro', 'These changes were made offline, but the cellar had changed by the time they reached the server.')}</p>
      {ops === null && <p>{t('common.loading', 'Loading...')}</p>}
      <ul className="offline-attention-list" style={{ listStyle: 'none', padding: 0 }}>
        {(ops || []).map((op) => (
          <li key={op.id} style={{ borderTop: '1px solid var(--color-border)', padding: '0.75rem 0' }}>
            <strong>{describe(op, t)}</strong>
            <div style={{ fontSize: '0.88rem', opacity: 0.85 }}>
              {new Date(op.createdAt).toLocaleString()} — {op.error}
            </div>
            {op.code === 'field_changed' && op.current && (
              <div style={{ fontSize: '0.88rem', marginTop: '0.35rem' }}>
                {Object.keys(op.current).map((k) => (
                  <div key={k}>
                    {k}: {t('offline.theirs', 'now')} “{show(op.current[k])}” · {t('offline.mine', 'yours')} “{show(op.body?.[k])}”
                  </div>
                ))}
              </div>
            )}
            <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: '0.5rem' }}>
              {isForceable(op) ? (
                <button type="button" className="btn btn-primary btn-small" disabled={!!busy} onClick={() => act(op, 'force')}>
                  {op.code === 'field_changed' ? t('offline.keepMine', 'Keep mine') : t('offline.applyAnyway', 'Apply anyway')}
                </button>
              ) : op.code !== 'state_changed' && (
                <button type="button" className="btn btn-secondary btn-small" disabled={!!busy} onClick={() => act(op, 'retry')}>
                  {t('offline.retry', 'Try again')}
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-small" disabled={!!busy} onClick={() => act(op, 'discard')}>
                {op.code === 'field_changed' ? t('offline.keepTheirs', 'Keep theirs') : t('offline.discard', 'Discard')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
