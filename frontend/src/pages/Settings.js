import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import './Settings.css';

function Settings() {
  const { t, i18n } = useTranslation();
  const { user, updatePreferences } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isWelcome = searchParams.get('welcome') === '1';

  const [currency, setCurrency] = useState(user?.preferences?.currency || 'USD');
  const [language, setLanguage] = useState(user?.preferences?.language || i18n.language?.split('-')[0] || 'en');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await updatePreferences({ currency, language });
    setSaving(false);
    if (result.success) {
      i18n.changeLanguage(language);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      if (isWelcome) navigate('/settings', { replace: true });
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="settings-page">
      <h1>{t('settings.title')}</h1>

      {isWelcome && (
        <div className="alert alert-info settings-welcome">
          <strong>Welcome to Cellarion!</strong> Set your preferred currency and language before you start.
          <button
            className="settings-welcome-dismiss"
            onClick={() => navigate('/settings', { replace: true })}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

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
