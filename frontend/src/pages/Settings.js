import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import './Settings.css';

function Settings() {
  const { user, updatePreferences } = useAuth();
  const [currency, setCurrency] = useState(user?.preferences?.currency || 'USD');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const result = await updatePreferences({ currency });
    setSaving(false);
    if (result.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <div className="card settings-card">
        <h2 className="settings-section-title">Display Preferences</h2>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label htmlFor="currency-select">Default Currency</label>
            <p className="settings-hint">
              Used as the default in bottle forms and price fields.
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

          {error && <div className="alert alert-error">{error}</div>}

          <div className="settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="settings-saved">Saved</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

export default Settings;
