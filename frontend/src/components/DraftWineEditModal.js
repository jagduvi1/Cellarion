import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { updateWineDraft } from '../api/wineDrafts';

const TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

/**
 * Edit a PRIVATE DRAFT wine in place — no correction queue, nothing is shared
 * yet. Sends only the fields that changed; the server resolves country,
 * region and grape names against the taxonomy and says which name it could
 * not place.
 *
 * Props:
 *   apiFetch   — from useAuth()
 *   wine       — the draft (populated country/region/grapes as {name})
 *   onClose()
 *   onSaved(draft) — the server's draft summary after the save
 */
function DraftWineEditModal({ apiFetch, wine, onClose, onSaved }) {
  const { t } = useTranslation();
  const nameOf = (x) => (x && typeof x === 'object' ? x.name : (typeof x === 'string' ? x : '')) || '';
  const initial = {
    name: wine?.name || '',
    producer: wine?.producer || '',
    appellation: wine?.appellation || '',
    classification: wine?.classification || '',
    type: wine?.type || 'red',
    countryName: nameOf(wine?.country),
    regionName: nameOf(wine?.region),
    grapeNames: Array.isArray(wine?.grapes) ? wine.grapes.map(nameOf).filter(Boolean).join(', ') : '',
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of ['name', 'producer', 'appellation', 'classification', 'type', 'countryName', 'regionName']) {
      if (form[k] !== initial[k]) patch[k] = form[k];
    }
    if (form.grapeNames !== initial.grapeNames) {
      patch.grapeNames = form.grapeNames.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (Object.keys(patch).length === 0) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await updateWineDraft(apiFetch, wine._id, patch);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || t('common.error', 'Something went wrong')); return; }
      onSaved?.(data.draft);
    } catch {
      setError(t('common.networkError', 'Network error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('draftWine.editTitle', 'Edit draft wine')} onClose={onClose} showClose wide>
      <form onSubmit={submit} className="draft-edit-form">
        <p className="draft-edit-hint">{t('draftWine.editHint', 'Only you can see this wine. Every field can be changed freely until you publish it.')}</p>
        <div className="grid-2">
          <div className="form-group">
            <label htmlFor="dw-name">{t('draftWine.fieldName', 'Wine name')} *</label>
            <input id="dw-name" type="text" value={form.name} onChange={set('name')} maxLength={200} required />
          </div>
          <div className="form-group">
            <label htmlFor="dw-producer">{t('draftWine.fieldProducer', 'Producer')}</label>
            <input id="dw-producer" type="text" value={form.producer} onChange={set('producer')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="dw-country">{t('draftWine.fieldCountry', 'Country')}</label>
            <input id="dw-country" type="text" value={form.countryName} onChange={set('countryName')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="dw-region">{t('draftWine.fieldRegion', 'Region')}</label>
            <input id="dw-region" type="text" value={form.regionName} onChange={set('regionName')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="dw-appellation">{t('draftWine.fieldAppellation', 'Appellation')}</label>
            <input id="dw-appellation" type="text" value={form.appellation} onChange={set('appellation')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="dw-classification">{t('draftWine.fieldClassification', 'Classification')}</label>
            <input id="dw-classification" type="text" value={form.classification} onChange={set('classification')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="dw-type">{t('draftWine.fieldType', 'Type')}</label>
            <select id="dw-type" value={form.type} onChange={set('type')}>
              {TYPES.map((v) => <option key={v} value={v}>{t(`statistics.typeLabels.${v}`, v)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="dw-grapes">{t('draftWine.fieldGrapes', 'Grapes (comma-separated)')}</label>
            <input id="dw-grapes" type="text" value={form.grapeNames} onChange={set('grapeNames')} placeholder={t('draftWine.fieldGrapesPlaceholder', 'e.g. Merlot, Cabernet Franc')} />
          </div>
        </div>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>{t('common.cancel', 'Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default DraftWineEditModal;
