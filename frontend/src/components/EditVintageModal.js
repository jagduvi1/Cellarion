import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { bulkUpdateBottles } from '../api/bottles';
import { DRINK_YEAR_MIN, DRINK_YEAR_MAX, validateDrinkWindowFields } from '../utils/drinkStatus';
import Modal from './Modal';
import BulkOutcome from './BulkOutcome';

const YEAR_FIELDS = ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil'];
const YEAR_LABELS = { drinkFrom: 'addBottle.drinkFrom', drinkTo: 'addBottle.drinkTo', peakFrom: 'addBottle.peakFrom', peakUntil: 'addBottle.peakUntil' };
const NOTES_MAX = 5000;

const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * "Edit vintage" on the vintage page (early access): the drink window, the
 * peak and the note a wine and vintage share, written to every bottle of it
 * in this cellar in one request (POST /api/bottles/bulk). There is no
 * separate vintage record — the values live on the bottles, where the bottle
 * page and every other screen read them — so turning early access off loses
 * nothing.
 *
 * Each field opens with the value all the bottles share. A field the bottles
 * disagree on opens empty and says so; it is only written when filled in,
 * and only the fields the user changed are sent, so a bottle's own note or
 * window is never overwritten by accident. A bottle whose own years clash
 * with the new ones is skipped and counted, as in the bulk drink window.
 */
export default function EditVintageModal({ bottles, title, onClose, onDone }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const notesId = useId();
  const count = bottles.length;

  // What the bottles share per field: the common value, or `differs`.
  const start = useMemo(() => {
    const out = {};
    for (const f of [...YEAR_FIELDS, 'notes']) {
      const values = new Set(bottles.map((b) => (filled(b[f]) ? String(b[f]).trim() : '')));
      out[f] = values.size === 1
        ? { value: [...values][0], differs: false }
        : { value: '', differs: true };
    }
    return out;
  }, [bottles]);

  const [form, setForm] = useState(() => Object.fromEntries(Object.entries(start).map(([k, v]) => [k, v.value])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    // Only what changed: an untouched field — above all one the bottles
    // disagree on — stays as it is on every bottle.
    const fields = {};
    for (const k of YEAR_FIELDS) {
      const v = form[k].trim();
      if (v === start[k].value) continue;
      if (v === '' && start[k].differs) continue;
      fields[k] = v === '' ? null : parseInt(v, 10);
    }
    const note = form.notes;
    if (note.trim() !== start.notes.value && !(note.trim() === '' && start.notes.differs)) {
      fields.notes = note.trim();
    }
    if (Object.keys(fields).length === 0) { onClose(); return; }
    const windowError = validateDrinkWindowFields(form, t);
    if (windowError) { setError(windowError); return; }

    setSaving(true);
    setError('');
    try {
      const res = await bulkUpdateBottles(apiFetch, bottles.map((b) => b._id), fields);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('bulk.failed'));
      setResult({ done: data.done ?? 0, skipped: (data.skipped || []).length });
    } catch (err) {
      setError(err.message || t('bulk.failed'));
      setSaving(false);
    }
  };

  if (result) {
    return (
      <BulkOutcome
        title={t('editVintage.doneTitle', 'Vintage saved')}
        done={result.done}
        skipped={result.skipped}
        skippedKey="bulk.windowSkippedInfo"
        onClose={onDone}
      />
    );
  }

  const differsHint = t('editVintage.differs', 'Differs between the bottles: left as it is unless you fill it in');

  return (
    <Modal title={t('editVintage.title', 'Edit vintage')} onClose={onClose} showClose trapFocus>
      {title && <p className="modal-wine-name">{title}</p>}
      <p>{t('editVintage.intro', { count })}</p>
      <form onSubmit={submit} className="bulk-form">
        <span className="bd-section-label">{t('cellarVintage.yourWindow', 'Your drink window')}</span>
        <div className="bulk-year-grid">
          {YEAR_FIELDS.map((k) => (
            <label className="form-group" key={k}>
              <span>{t(YEAR_LABELS[k])}</span>
              <input
                type="number" inputMode="numeric" min={DRINK_YEAR_MIN} max={DRINK_YEAR_MAX} step="1"
                value={form[k]} onChange={set(k)} disabled={saving}
                placeholder={start[k].differs ? t('editVintage.differsShort', 'Differs') : ''}
                title={start[k].differs ? differsHint : undefined}
              />
            </label>
          ))}
        </div>
        <div className="form-group">
          <label htmlFor={notesId}>{t('common.notes')}</label>
          <textarea
            id={notesId} rows={4} maxLength={NOTES_MAX} value={form.notes} onChange={set('notes')} disabled={saving}
            placeholder={start.notes.differs ? differsHint : ''}
          />
          {start.notes.differs && <p className="settings-hint">{differsHint}</p>}
        </div>
        <p className="settings-hint">
          {t('editVintage.ownDataHint', 'Critic scores, lot number and your other own data: under "Your wine data" on this page.')}
        </p>

        {error && <p className="error-message" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('editVintage.submit', 'Save for the vintage')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
