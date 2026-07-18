import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import SetPasswordNotice from './SetPasswordNotice';
import { listClimateDevices, createClimateDevice, updateClimateDevice, deleteClimateDevice } from '../api/climate';
import { listCellars } from '../api/cellars';

// Climate sensor devices (Settings card) — see docs/climate-monitoring.md.
// Creating a device mints its climate-scoped API token (password-confirmed,
// plaintext shown once), mirroring ApiTokensSection. Devices are assigned to
// a cellar; channels appear automatically when the device first posts and can
// be labeled / calibration-adjusted here.
function ClimateDevicesSection() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();

  const [devices, setDevices] = useState([]);
  const [maxDevices, setMaxDevices] = useState(5);
  const [cellars, setCellars] = useState([]);
  const [listError, setListError] = useState(null);

  // Create flow
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [cellarId, setCellarId] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [newToken, setNewToken] = useState(null); // plaintext — shown exactly once
  const [copied, setCopied] = useState(false);

  // Edit flow
  const [editTarget, setEditTarget] = useState(null);
  const [editName, setEditName] = useState('');
  const [editCellarId, setEditCellarId] = useState('');
  const [editChannels, setEditChannels] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState(null);

  // Delete flow
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listClimateDevices(apiFetch);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setDevices(data.devices || []);
      setMaxDevices(data.maxDevices || 5);
      setListError(null);
    } catch {
      setListError(t('settings.climateDevices.errorLoad'));
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  // The cellar list only populates the dropdown inside the create/edit modals,
  // which most Settings visitors never open — fetch it on first modal open, not
  // on every Settings mount.
  const cellarsLoaded = useRef(false);
  const ensureCellars = useCallback(() => {
    if (cellarsLoaded.current) return;
    cellarsLoaded.current = true;
    listCellars(apiFetch)
      .then(r => r.json())
      .then(d => setCellars(d.cellars || []))
      .catch(() => { cellarsLoaded.current = false; });
  }, [apiFetch]);

  const closeCreate = () => {
    setShowCreate(false);
    setName('');
    setCellarId('');
    setPassword('');
    setCreateError(null);
    setNewToken(null);
    setCopied(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createClimateDevice(apiFetch, { name: name.trim(), cellarId, password });
      if (res.status === 403) {
        setCreateError(t('settings.climateDevices.errorWrongPassword'));
      } else if (res.status === 429) {
        setCreateError(t('settings.climateDevices.errorRateLimited'));
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCreateError(data.error || t('settings.climateDevices.errorGeneric'));
      } else {
        const data = await res.json();
        setNewToken(data.token);
        setPassword('');
        await load();
      }
    } catch {
      setCreateError(t('settings.climateDevices.errorGeneric'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const openEdit = (device) => {
    ensureCellars();
    setEditTarget(device);
    setEditName(device.name);
    setEditCellarId(device.cellar?.id || '');
    setEditChannels(device.channels.map(c => ({ ...c })));
    setEditError(null);
  };

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editTarget) return;
    setSaving(true);
    setEditError(null);
    try {
      const res = await updateClimateDevice(apiFetch, editTarget.id, {
        name: editName.trim(),
        cellarId: editCellarId || null,
        channels: editChannels.map(c => ({
          key: c.key,
          type: c.type,
          label: c.label,
          calibrationOffset: Number(c.calibrationOffset) || 0,
        })),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEditError(data.error || t('settings.climateDevices.errorGeneric'));
      } else {
        setEditTarget(null);
        await load();
      }
    } catch {
      setEditError(t('settings.climateDevices.errorGeneric'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await deleteClimateDevice(apiFetch, deleteTarget.id);
      if (!res.ok) throw new Error();
      setDeleteTarget(null);
      await load();
    } catch {
      setListError(t('settings.climateDevices.errorGeneric'));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const setChannelField = (index, field, value) => {
    setEditChannels(prev => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  };

  const formatDate = (d) => (d ? new Date(d).toLocaleString() : null);
  const cellarSelect = (value, onChange, id) => (
    <select id={id} className="input" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{t('settings.climateDevices.noCellar')}</option>
      {cellars.map(c => <option key={c._id} value={c._id}>{c.name}</option>)}
    </select>
  );

  return (
    <div className="card settings-card">
      <h2 className="settings-section-title">{t('settings.climateDevices.title')}</h2>
      <p className="settings-hint">{t('settings.climateDevices.hint')}</p>

      {listError && <div className="alert alert-error">{listError}</div>}

      {devices.length === 0 ? (
        <p className="settings-hint">{t('settings.climateDevices.empty')}</p>
      ) : (
        <ul className="api-token-list">
          {devices.map(dev => (
            <li key={dev.id} className="api-token-row">
              <div className="api-token-info">
                <strong>{dev.name}</strong>
                <span className="api-token-meta">
                  {dev.cellar?.name || t('settings.climateDevices.noCellar')}
                  {' · '}
                  {dev.lastSeenAt
                    ? `${t('settings.climateDevices.lastSeen')} ${formatDate(dev.lastSeenAt)}`
                    : t('settings.climateDevices.neverSeen')}
                  {dev.channels.length > 0 && ` · ${dev.channels.map(c => c.label || c.key).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`}
                </span>
              </div>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => openEdit(dev)}>
                {t('settings.climateDevices.editBtn')}
              </button>
              <button type="button" className="btn btn-danger btn-small" onClick={() => setDeleteTarget(dev)}>
                {t('settings.climateDevices.deleteBtn')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => { ensureCellars(); setShowCreate(true); }}
          disabled={devices.length >= maxDevices}
        >
          {t('settings.climateDevices.addBtn')}
        </button>
      </div>

      {showCreate && (
        <Modal title={t('settings.climateDevices.createTitle')} onClose={creating ? undefined : closeCreate} showClose={!creating}>
          {newToken ? (
            <>
              <p>{t('settings.climateDevices.createdShowOnce')}</p>
              <code className="api-token-plain">{newToken}</code>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={handleCopy}>
                  {copied ? t('settings.climateDevices.copiedBtn') : t('settings.climateDevices.copyBtn')}
                </button>
                <button type="button" className="btn btn-primary" onClick={closeCreate}>
                  {t('settings.climateDevices.doneBtn')}
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={handleCreate}>
              <div className="form-group">
                <label htmlFor="climate-device-name">{t('settings.climateDevices.nameLabel')}</label>
                <input
                  id="climate-device-name"
                  type="text"
                  className="input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('settings.climateDevices.namePlaceholder')}
                  maxLength={100}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="climate-device-cellar">{t('settings.climateDevices.cellarLabel')}</label>
                {cellarSelect(cellarId, setCellarId, 'climate-device-cellar')}
              </div>
              {user?.hasPassword === false ? (
                // SSO-only account: nothing to confirm with — offer the email
                // set-password flow instead of a field they can't fill.
                <SetPasswordNotice />
              ) : (
                <div className="form-group">
                  <label htmlFor="climate-device-password">{t('settings.climateDevices.passwordLabel')}</label>
                  <input
                    id="climate-device-password"
                    type="password"
                    className="input"
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                  <p className="settings-hint">{t('settings.climateDevices.passwordHint')}</p>
                </div>
              )}

              {createError && <div className="alert alert-error">{createError}</div>}

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={closeCreate} disabled={creating}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating || user?.hasPassword === false}>
                  {creating ? t('settings.climateDevices.creatingBtn') : t('settings.climateDevices.createConfirmBtn')}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {editTarget && (
        <Modal title={t('settings.climateDevices.editTitle')} onClose={saving ? undefined : () => setEditTarget(null)} showClose={!saving}>
          <form onSubmit={handleSaveEdit}>
            <div className="form-group">
              <label htmlFor="climate-edit-name">{t('settings.climateDevices.nameLabel')}</label>
              <input
                id="climate-edit-name"
                type="text"
                className="input"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="climate-edit-cellar">{t('settings.climateDevices.cellarLabel')}</label>
              {cellarSelect(editCellarId, setEditCellarId, 'climate-edit-cellar')}
            </div>
            <div className="form-group">
              <span className="api-token-scopes-label">{t('settings.climateDevices.channelsLabel')}</span>
              {editChannels.length === 0 ? (
                <p className="settings-hint">{t('settings.climateDevices.noChannels')}</p>
              ) : (
                editChannels.map((c, i) => (
                  <div key={`${c.key}-${c.type}`} className="climate-channel-edit-row">
                    <span className="api-token-meta">{c.key} · {t(`climate.${c.type}`)}</span>
                    <input
                      type="text"
                      className="input"
                      value={c.label}
                      placeholder={t('settings.climateDevices.channelLabelPlaceholder')}
                      maxLength={100}
                      onChange={e => setChannelField(i, 'label', e.target.value)}
                    />
                    <label className="climate-channel-offset">
                      {t('settings.climateDevices.offsetLabel')}
                      <input
                        type="number"
                        className="input"
                        step="0.1"
                        min="-10"
                        max="10"
                        value={c.calibrationOffset}
                        onChange={e => setChannelField(i, 'calibrationOffset', e.target.value)}
                      />
                    </label>
                  </div>
                ))
              )}
            </div>

            {editError && <div className="alert alert-error">{editError}</div>}

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditTarget(null)} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t('settings.climateDevices.savingBtn') : t('settings.climateDevices.saveBtn')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteTarget && (
        <Modal title={t('settings.climateDevices.deleteTitle')} onClose={deleting ? undefined : () => setDeleteTarget(null)}>
          <p>{t('settings.climateDevices.deleteConfirm', { name: deleteTarget.name })}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? t('settings.climateDevices.deletingBtn') : t('settings.climateDevices.deleteBtn')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ClimateDevicesSection;
