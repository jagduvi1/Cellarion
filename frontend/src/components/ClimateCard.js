import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import { getCellarClimate, updateCellarClimateConfig } from '../api/climate';
import './ClimateCard.css';

// Chart modal pulls in recharts — load it only when opened.
const ClimateHistoryModal = lazy(() => import('./ClimateHistoryModal'));

const REFRESH_MS = 60 * 1000;

// Current cellar climate (CellarDetail → Overview tab). Renders NOTHING when
// the cellar has no climate devices, so non-climate users never see it.
// Values come from the device last-value cache (no readings query); the card
// refreshes once a minute while mounted.
function ClimateCard({ cellarId }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [data, setData] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await getCellarClimate(apiFetch, cellarId);
      if (!res.ok) return;
      setData(await res.json());
    } catch {}
  }, [apiFetch, cellarId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!data || data.devices.length === 0) return null;

  const { config, isOwner, devices } = data;
  const inRange = (ch) => {
    if (ch.lastValue === null || ch.lastValue === undefined) return true;
    return ch.type === 'temperature'
      ? ch.lastValue >= config.tempMin && ch.lastValue <= config.tempMax
      : ch.lastValue >= config.rhMin && ch.lastValue <= config.rhMax;
  };
  const fmtValue = (ch) =>
    ch.type === 'temperature' ? `${ch.lastValue.toFixed(1)} °C` : `${Math.round(ch.lastValue)} %`;
  const agoLabel = (d) => {
    const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
    if (min < 60) return `${min} min`;
    if (min < 48 * 60) return `${Math.round(min / 60)} h`;
    return `${Math.round(min / 1440)} d`;
  };
  // Channel labels for the history modal's series names.
  const channelLabels = {};
  for (const dev of devices) {
    for (const ch of dev.channels) {
      if (ch.label) channelLabels[`${dev.id}:${ch.key}:${ch.type}`] = ch.label;
    }
  }

  return (
    <div className="card climate-card">
      <div className="climate-card-header">
        <h3 className="climate-card-title">{t('climate.title')}</h3>
        <div className="climate-card-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowHistory(true)}>
            {t('climate.historyBtn')}
          </button>
          {isOwner && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setShowConfig(true)}>
              {t('climate.settingsBtn')}
            </button>
          )}
        </div>
      </div>

      {devices.map(dev => (
        <div key={dev.id} className="climate-device">
          <div className="climate-device-head">
            <span className="climate-device-name">{dev.name}</span>
            {dev.online ? (
              <span className="climate-badge climate-badge--online">{t('climate.online')}</span>
            ) : (
              <span className="climate-badge climate-badge--offline">
                {t('climate.offline')}
                {dev.lastSeenAt && ` · ${t('climate.lastSeen', { time: agoLabel(dev.lastSeenAt) })}`}
              </span>
            )}
          </div>
          <div className="climate-chips">
            {dev.channels.filter(ch => ch.lastValue !== null && ch.lastValue !== undefined).map(ch => (
              <div
                key={`${ch.key}-${ch.type}`}
                className={`climate-chip${inRange(ch) ? '' : ' climate-chip--alert'}${dev.online ? '' : ' climate-chip--stale'}`}
                title={`${ch.label || ch.key} · ${t(`climate.${ch.type}`)}`}
              >
                <span className="climate-chip-icon" aria-hidden="true">{ch.type === 'temperature' ? '🌡️' : '💧'}</span>
                <span className="climate-chip-value">{fmtValue(ch)}</span>
                <span className="climate-chip-label">{ch.label || ch.key}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {showHistory && (
        <Suspense fallback={null}>
          <ClimateHistoryModal
            cellarId={cellarId}
            config={config}
            channelLabels={channelLabels}
            onClose={() => setShowHistory(false)}
          />
        </Suspense>
      )}

      {showConfig && (
        <ClimateConfigModal
          apiFetch={apiFetch}
          cellarId={cellarId}
          config={config}
          onClose={() => setShowConfig(false)}
          onSaved={() => { setShowConfig(false); load(); }}
        />
      )}
    </div>
  );
}

// Threshold + alert settings (cellar owner only). Small controlled form over
// PUT /api/climate/cellars/:id/config.
function ClimateConfigModal({ apiFetch, cellarId, config, onClose, onSaved }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    tempMin: config.tempMin,
    tempMax: config.tempMax,
    rhMin: config.rhMin,
    rhMax: config.rhMax,
    offlineAfterMin: config.offlineAfterMin,
    alertsEnabled: config.alertsEnabled,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await updateCellarClimateConfig(apiFetch, cellarId, {
        tempMin: Number(form.tempMin),
        tempMax: Number(form.tempMax),
        rhMin: Number(form.rhMin),
        rhMax: Number(form.rhMax),
        offlineAfterMin: Number(form.offlineAfterMin),
        alertsEnabled: !!form.alertsEnabled,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t('climate.errorGeneric'));
      } else {
        onSaved();
      }
    } catch {
      setError(t('climate.errorGeneric'));
    } finally {
      setSaving(false);
    }
  };

  const numberField = (key, labelKey, min, max, step = 1) => (
    <div className="form-group climate-config-field">
      <label htmlFor={`climate-cfg-${key}`}>{t(labelKey)}</label>
      <input
        id={`climate-cfg-${key}`}
        type="number"
        className="input"
        min={min}
        max={max}
        step={step}
        value={form[key]}
        onChange={e => setField(key, e.target.value)}
        required
      />
    </div>
  );

  return (
    <Modal title={t('climate.configTitle')} onClose={saving ? undefined : onClose} showClose={!saving}>
      <form onSubmit={handleSave}>
        <div className="climate-config-grid">
          {numberField('tempMin', 'climate.tempMin', -30, 60, 0.5)}
          {numberField('tempMax', 'climate.tempMax', -30, 60, 0.5)}
          {numberField('rhMin', 'climate.rhMin', 0, 100)}
          {numberField('rhMax', 'climate.rhMax', 0, 100)}
          {numberField('offlineAfterMin', 'climate.offlineAfterMin', 15, 1440)}
        </div>
        <div className="form-group">
          <label className="climate-config-toggle">
            <input
              type="checkbox"
              checked={!!form.alertsEnabled}
              onChange={e => setField('alertsEnabled', e.target.checked)}
            />
            {' '}{t('climate.alertsEnabled')}
          </label>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('climate.savingBtn') : t('climate.saveBtn')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default ClimateCard;
