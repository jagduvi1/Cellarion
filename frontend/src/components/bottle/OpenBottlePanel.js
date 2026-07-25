import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { pourBottle, undoPour, undoOpenBottle } from '../../api/bottles';
import {
  bottleSizeMl, remainingMl, glassesLeft, drinkByDate, daysLeft, freshnessStatus,
} from '../../utils/openBottle';
import './OpenBottlePanel.css';

/**
 * Status card for an opened (Coravin'd / preserved) bottle: remaining volume
 * as a fill bar + glasses, drink-by countdown colored by urgency, and the
 * pour / undo / finish actions. The bottle stays active and racked while
 * open; "Finish bottle" hands over to the normal consume flow.
 */
export default function OpenBottlePanel({ bottle, canEdit, onBottleChange, onFinish }) {
  const { t, i18n } = useTranslation();
  const { apiFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const sizeMl = bottleSizeMl(bottle);
  const leftMl = remainingMl(bottle);
  const glasses = glassesLeft(bottle);
  const deadline = drinkByDate(bottle);
  const days = daysLeft(bottle);
  const status = freshnessStatus(bottle) || 'ok';
  const pct = Math.round((leftMl / sizeMl) * 100);

  const call = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('common.networkError', 'Network error'));
        return;
      }
      onBottleChange({
        openedAt: data.bottle.openedAt,
        preservationMethod: data.bottle.preservationMethod,
        pours: data.bottle.pours,
      });
    } catch {
      setError(t('common.networkError', 'Network error'));
    } finally {
      setBusy(false);
    }
  };

  // Format in the language the user chose, not the one their OS happens to be
  // in — and via i18n.language rather than a per-locale ternary, which also
  // fixes the old `=== 'sv'` missing region-suffixed values like sv-SE.
  const dateFmt = (d) =>
    new Date(d).toLocaleDateString(i18n.language || undefined, {
      month: 'short', day: 'numeric',
    });

  return (
    <div className={`open-bottle-panel open-bottle-panel--${status}`}>
      <div className="obp-header">
        <span className="obp-title">
          🍷 {t('openBottle.openSince', 'Open since {{date}}', { date: dateFmt(bottle.openedAt) })}
          {' · '}
          {t(`openBottle.method.${bottle.preservationMethod}`, bottle.preservationMethod || '')}
        </span>
        <span className={`obp-deadline obp-deadline--${status}`}>
          {status === 'past'
            ? t('openBottle.pastWindow', 'Past its window — drink now')
            : t('openBottle.drinkBy', 'Drink by {{date}} ({{days}}d)', { date: dateFmt(deadline), days })}
        </span>
      </div>

      <div className="obp-fill" aria-hidden="true">
        <div className="obp-fill-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="obp-remaining">
        {t('openBottle.remaining', '≈ {{glasses}} glasses left ({{ml}} of {{size}} ml)', {
          glasses, ml: leftMl, size: sizeMl,
        })}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {canEdit && (
        <div className="obp-actions">
          <button
            className="btn btn-primary btn-small"
            disabled={busy || leftMl <= 0}
            onClick={() => call(() => pourBottle(apiFetch, bottle._id))}
          >
            {t('openBottle.pourBtn', 'Pour a glass')}
          </button>
          {(bottle.pours || []).length > 0 && (
            <button
              className="btn btn-secondary btn-small"
              disabled={busy}
              onClick={() => call(() => undoPour(apiFetch, bottle._id))}
            >
              {t('openBottle.undoPourBtn', 'Undo pour')}
            </button>
          )}
          <button className="btn btn-consume btn-small" disabled={busy} onClick={onFinish}>
            {t('openBottle.finishBtn', 'Finish bottle…')}
          </button>
          <button
            className="obp-undo-open"
            disabled={busy}
            onClick={() => call(() => undoOpenBottle(apiFetch, bottle._id))}
            title={t('openBottle.undoOpenHint', 'Removes the open state and all pours')}
          >
            {t('openBottle.undoOpenBtn', 'Opened by mistake?')}
          </button>
        </div>
      )}
    </div>
  );
}
