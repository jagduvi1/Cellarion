import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import { PLANS } from '../config/plans';
import { SCALE_META, VALID_SCALES } from '../utils/ratingUtils';
import './Settings.css';

function Settings() {
  const { t, i18n } = useTranslation();
  const { user, updatePreferences } = useAuth();
  const [currency, setCurrency] = useState(user?.preferences?.currency || 'USD');
  const [language, setLanguage] = useState(user?.preferences?.language || i18n.language?.split('-')[0] || 'en');
  const [ratingScale, setRatingScale] = useState(user?.preferences?.ratingScale || '5');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await updatePreferences({ currency, language, ratingScale });
    setSaving(false);
    if (result.success) {
      i18n.changeLanguage(language);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      setError(result.error);
    }
  };

  const planKey = user?.plan || 'free';
  const planExpiresAt = user?.planExpiresAt || null;
  const planLabel = PLANS[planKey]?.label || planKey;
  const planExpired = planExpiresAt && Date.now() > new Date(planExpiresAt).getTime();

  function formatExpiry(expiresAt) {
    if (!expiresAt) return t('settings.plan.noExpiry');
    if (Date.now() > new Date(expiresAt).getTime()) return t('plans.expired');
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  return (
    <div className="settings-page">
      <h1>{t('settings.title')}</h1>

      {/* ── Your Plan card ── */}
      <div className="card settings-card settings-plan-card">
        <h2 className="settings-section-title">{t('settings.plan.title')}</h2>
        <div className="settings-plan-row">
          <span className={`settings-plan-badge settings-plan-badge--${planKey}`}>{planLabel}</span>
          <span className="settings-plan-desc">{PLANS[planKey]?.description}</span>
        </div>
        <p className="settings-hint">
          {planExpired
            ? <span className="settings-plan-expired">{t('plans.expired')}</span>
            : <>{t('settings.plan.expires')} <strong>{formatExpiry(planExpiresAt)}</strong></>
          }
        </p>
        <Link to="/plans" className="btn btn-secondary settings-plan-link">
          {t('settings.plan.comparePlans')}
        </Link>
      </div>

      <div className="card settings-card">
        <h2 className="settings-section-title">{t('settings.displayPreferences')}</h2>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label htmlFor="currency-select">{t('settings.defaultCurrency')}</label>
            <p className="settings-hint">
              {t('settings.currencyHint')}
            </p>
            <select
              id="currency-select"
              className="input settings-select"
              value={currency}
              onChange={e => setCurrency(e.target.value)}
            >
              {CURRENCIES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="language-select">{t('settings.language')}</label>
            <p className="settings-hint">
              {t('settings.languageHint')}
            </p>
            <select
              id="language-select"
              className="input settings-select"
              value={language}
              onChange={e => setLanguage(e.target.value)}
            >
              <option value="en">{t('settings.languageEn')}</option>
              <option value="sv">{t('settings.languageSv')}</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="rating-scale-select">{t('settings.defaultRatingScale', 'Default Rating Scale')}</label>
            <p className="settings-hint">
              {t('settings.ratingScaleHint', 'Choose which rating scale to use by default when adding ratings. You can always override per bottle.')}
            </p>
            <select
              id="rating-scale-select"
              className="input settings-select"
              value={ratingScale}
              onChange={e => setRatingScale(e.target.value)}
            >
              {VALID_SCALES.map(s => (
                <option key={s} value={s}>
                  {SCALE_META[s].label} ({SCALE_META[s].min}–{SCALE_META[s].max}{SCALE_META[s].suffix})
                </option>
              ))}
            </select>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('settings.savingBtn') : t('settings.saveBtn')}
            </button>
            {saved && <span className="settings-saved">{t('settings.savedMsg')}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

export default Settings;
