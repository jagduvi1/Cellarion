import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { createBottle } from '../api/bottles';
import Modal from './Modal';

// Cap per batch — this flow tops up a bottle you already registered (a case or
// two), it is not the bulk importer. Matches the sequential-POST budget the
// Add Bottle page tolerates.
const MAX_MORE = 24;

/**
 * Add more bottles of a wine directly from a bottle you already registered —
 * the answer to the support question "I added a bottle with Qty 1, how do I
 * make it 6?" without re-searching the wine in Add Bottle (support reply
 * promised 2026-08-10).
 *
 * Creating N bottles is N sequential POSTs, exactly like the Add Bottle page's
 * own multi-bottle loop, including its partial-failure contract: on a
 * mid-batch error the created/total count is reported (reusing
 * addBottle.partialAdded) and a retry creates only the remainder — the bottles
 * already created are real, there is no rollback. New bottles arrive unplaced;
 * rack placement stays a separate step.
 *
 * Props: bottle (the populated bottle being viewed — must have a
 * wineDefinition), onClose(), onAdded(count) — fired only when the whole
 * batch succeeded.
 */
function AddMoreBottlesModal({ bottle, onClose, onAdded }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const countId = useId();
  const [count, setCount] = useState(1);
  const [copyDetails, setCopyDetails] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Bottles already created by earlier attempts of THIS batch — a retry after
  // a partial failure resumes here instead of duplicating the whole batch
  // (same contract as AddBottle's createdBottlesRef).
  const [createdSoFar, setCreatedSoFar] = useState(0);

  // Instant clamp, like AddBottle's Number-of-bottles field, plus the cap.
  const clampCount = (raw) => Math.min(MAX_MORE, Math.max(1, parseInt(raw, 10) || 1));

  // Once part of the batch exists, its parameters are frozen — a retry must
  // finish the SAME batch. Changing count or the copy toggle between attempts
  // would silently mix differently-shaped bottles into one batch.
  const locked = saving || createdSoFar > 0;

  // What a copy is made of — only fields POST /api/bottles accepts (see
  // backend bottleOps.addBottle):
  // - wine / cellar / vintage / bottleSize always travel: "more of this
  //   bottle" means the same wine, same vintage, same format, same cellar.
  // - The details checkbox carries provenance: price, currency, purchase
  //   info, notes, occasion.
  // - Never copied: rating and the personal drink window (judgements about
  //   that specific bottle, not the purchase), rack position (new bottles
  //   arrive unplaced) and the migration helpers (dateAdded / addToHistory).
  const buildPayload = () => {
    const payload = {
      cellar: bottle.cellar?._id || bottle.cellar,
      wineDefinition: bottle.wineDefinition?._id || bottle.wineDefinition,
      vintage: bottle.vintage,
      bottleSize: bottle.bottleSize || undefined,
    };
    if (copyDetails) {
      if (bottle.price != null) payload.price = bottle.price;
      if (bottle.currency) payload.currency = bottle.currency;
      if (bottle.purchaseDate) payload.purchaseDate = bottle.purchaseDate;
      if (bottle.purchaseLocation) payload.purchaseLocation = bottle.purchaseLocation;
      if (bottle.purchaseUrl) payload.purchaseUrl = bottle.purchaseUrl;
      if (bottle.notes) payload.notes = bottle.notes;
      if (bottle.occasion) payload.occasion = bottle.occasion;
    }
    return payload;
  };

  const handleSubmit = async () => {
    // In-flight guard (belt to the disabled buttons): a second submit during
    // the N sequential POSTs would duplicate bottles.
    if (saving) return;
    setSaving(true);
    setError(null);
    // AddBottle's partial-failure message, verbatim: report created/total and
    // promise that a retry adds only the remaining bottles.
    const partialError = (msg, done) => done > 0
      ? t('addBottle.partialAdded', { msg, count: done, total: count, remaining: count - done })
      : msg;
    // Local counter, not the render closure: submit is single-flight (the
    // button is disabled while saving), so createdSoFar is fresh here, and
    // `done` advances it exactly — no snapshot drift across the awaits.
    let done = createdSoFar;
    try {
      const payload = buildPayload();
      for (let i = done; i < count; i++) {
        const res = await createBottle(apiFetch, payload);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(partialError(data.error || t('addBottle.addFailed'), done));
          return;
        }
        done += 1;
        setCreatedSoFar(done);
      }
      onAdded(count);
    } catch {
      setError(partialError(t('common.networkError'), done));
    } finally {
      setSaving(false);
    }
  };

  // Interlock: while the batch runs nothing may close the modal — overlay
  // click, Escape and the ✕ all route through this guard.
  const guardedClose = () => { if (!saving) onClose(); };

  const wine = bottle.wineDefinition;
  const hintStyle = { color: 'var(--color-text-muted)', fontSize: '0.85rem' };

  return (
    <Modal title={t('bottleDetail.addMore.title', 'Add more bottles')} onClose={guardedClose} showClose trapFocus>
      <p style={{ marginTop: 0 }}>
        <strong>{wine?.name}{bottle.vintage ? ` · ${bottle.vintage}` : ''}</strong>
      </p>

      <div className="form-group">
        <label htmlFor={countId}>{t('bottleDetail.addMore.countLabel', 'How many more bottles?')}</label>
        <input
          id={countId}
          type="number"
          min="1"
          max={MAX_MORE}
          value={count}
          onChange={(e) => setCount(clampCount(e.target.value))}
          onFocus={(e) => e.target.select()}
          disabled={locked}
          required
        />
      </div>

      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={copyDetails}
            onChange={(e) => setCopyDetails(e.target.checked)}
            disabled={locked}
          />
          <span>{t('bottleDetail.addMore.copyLabel', "Copy this bottle's details")}</span>
        </label>
        <p style={{ ...hintStyle, marginBottom: 0 }}>
          {t('bottleDetail.addMore.copyHint', 'Price, purchase info, notes and occasion are copied from this bottle. Unticked, the new bottles start blank.')}
        </p>
      </div>

      <p style={hintStyle}>
        {t('bottleDetail.addMore.unplacedNote', 'The new bottles are added unplaced — placing them in a rack is a separate step, from the cellar page.')}
      </p>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button type="button" className="btn btn-success" onClick={handleSubmit} disabled={saving}>
          {saving ? t('common.saving', 'Saving…') : t('bottleDetail.addMore.submit', { count })}
        </button>
      </div>
    </Modal>
  );
}

export default AddMoreBottlesModal;
