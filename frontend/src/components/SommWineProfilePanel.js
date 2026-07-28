import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { updateSommWineProfile } from '../api/somm';

// Mirrors PROFILE_ENUMS in backend/src/services/wineProfileOps.js — the
// validator rejects anything else, so these pickers and that list must agree.
const ENUMS = {
  body:      ['light', 'medium', 'full'],
  tannin:    ['low', 'medium', 'high'],
  acidity:   ['low', 'medium', 'high'],
  sweetness: ['dry', 'off-dry', 'sweet'],
};

const listToText = (arr) => (Array.isArray(arr) ? arr.join(', ') : '');
const textToList = (text) =>
  text.split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

/**
 * The generated tasting profile, shown inline in the maturity queue so a
 * curator can judge it against the drink window they are setting — and fix it
 * in the same pass.
 *
 * Support ticket 2026-07-28: the generator writes confident prose for wines it
 * only half-knows (a Sandeman Vintage Port came back "built for immediate
 * drinking"). Before this panel a curator who noticed simply worked around it
 * and the wrong prose stayed on the wine for every owner.
 *
 * `confidence` is displayed but deliberately NOT used to hide anything: it is
 * the model's self-rating, not a correctness score, and the row that prompted
 * this ticket rated itself 0.6.
 *
 * Props: wine (the populated wineDefinition), onSaved(aiProfile).
 */
function SommWineProfilePanel({ wine, onSaved }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const ap = wine?.aiProfile || null;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState(null);
  const [profile, setProfile] = useState(ap);

  const [form, setForm] = useState({
    body:         ap?.body || '',
    tannin:       ap?.tannin || '',
    acidity:      ap?.acidity || '',
    sweetness:    ap?.sweetness || '',
    flavors:      listToText(ap?.flavors),
    foodPairings: listToText(ap?.foodPairings),
    description:  ap?.description || '',
  });

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const isCurator = profile?.source === 'curator';

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      // Empty string means "clear this field", which the API models as null —
      // the field-level abstention the ticket asked for: a curator can drop
      // prose they don't trust without touching the descriptors that are right.
      const payload = {
        body:         form.body || null,
        tannin:       form.tannin || null,
        acidity:      form.acidity || null,
        sweetness:    form.sweetness || null,
        flavors:      textToList(form.flavors),
        foodPairings: textToList(form.foodPairings),
        description:  form.description.trim() || null,
      };
      const res = await updateSommWineProfile(apiFetch, wine._id, payload);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || t('common.actionFailed', { status: res.status }));
        return;
      }
      setProfile(data.aiProfile);
      setEditing(false);
      onSaved?.(data.aiProfile);
    } catch {
      setErr(t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  if (!profile && !editing) {
    return (
      <div className="somm-profile-panel somm-profile-panel--empty">
        <span className="somm-profile-empty-text">{t('somm.profile.none')}</span>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setEditing(true)}>
          {t('somm.profile.addBtn')}
        </button>
      </div>
    );
  }

  if (!editing) {
    const descriptors = [profile.body, profile.tannin && `${profile.tannin} tannin`, profile.acidity && `${profile.acidity} acidity`, profile.sweetness]
      .filter(Boolean).join(' · ');
    return (
      <div className="somm-profile-panel">
        <div className="somm-profile-head">
          <span className={`somm-profile-badge ${isCurator ? 'somm-profile-badge--curator' : 'somm-profile-badge--ai'}`}>
            {isCurator ? t('somm.profile.curatorVerified') : t('somm.profile.aiGenerated')}
          </span>
          {!isCurator && profile.confidence != null && (
            <span className="somm-profile-confidence" title={t('somm.profile.confidenceTitle')}>
              {t('somm.profile.confidenceLabel')} {profile.confidence.toFixed(2)}
            </span>
          )}
          <button type="button" className="btn btn-secondary btn-small somm-profile-edit-btn" onClick={() => setEditing(true)}>
            {t('somm.profile.correctBtn')}
          </button>
        </div>
        {descriptors && <p className="somm-profile-descriptors">{descriptors}</p>}
        {profile.description && <p className="somm-profile-description">{profile.description}</p>}
        {profile.flavors?.length > 0 && (
          <p className="somm-profile-line"><strong>{t('somm.profile.flavors')}:</strong> {profile.flavors.join(', ')}</p>
        )}
        {profile.foodPairings?.length > 0 && (
          <p className="somm-profile-line"><strong>{t('somm.profile.pairings')}:</strong> {profile.foodPairings.join(', ')}</p>
        )}
      </div>
    );
  }

  return (
    <div className="somm-profile-panel somm-profile-panel--editing">
      {err && <div className="alert alert-error">{err}</div>}
      <p className="somm-profile-hint">{t('somm.profile.editHint')}</p>

      <div className="somm-profile-grid">
        {Object.keys(ENUMS).map(field => (
          <label key={field} className="somm-profile-field">
            <span>{t(`somm.profile.${field}`)}</span>
            <select value={form[field]} onChange={set(field)} disabled={saving}>
              <option value="">{t('somm.profile.unset')}</option>
              {ENUMS[field].map(v => (
                <option key={v} value={v}>{t(`somm.profile.value.${v.replace('-', '')}`, v)}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <label className="somm-profile-field">
        <span>{t('somm.profile.flavors')}</span>
        <input type="text" value={form.flavors} onChange={set('flavors')} disabled={saving}
          placeholder={t('somm.profile.commaSeparated')} />
      </label>

      <label className="somm-profile-field">
        <span>{t('somm.profile.pairings')}</span>
        <input type="text" value={form.foodPairings} onChange={set('foodPairings')} disabled={saving}
          placeholder={t('somm.profile.commaSeparated')} />
      </label>

      <label className="somm-profile-field">
        <span>{t('somm.profile.description')}</span>
        <textarea rows={3} value={form.description} onChange={set('description')} disabled={saving}
          maxLength={1000} placeholder={t('somm.profile.descriptionPlaceholder')} />
      </label>

      <div className="somm-profile-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('somm.profile.saveBtn')}
        </button>
        <button type="button" className="btn btn-secondary btn-small" disabled={saving}
          onClick={() => { setEditing(false); setErr(null); }}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

export default SommWineProfilePanel;
