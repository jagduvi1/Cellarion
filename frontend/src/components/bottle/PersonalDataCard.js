import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import {
  getPersonalData, addPersonalData, updatePersonalDataEntry,
  deletePersonalDataEntry, getPersonalDataKeys,
} from '../../api/personalData';
import './PersonalDataCard.css';

/**
 * Personal typed key/value data on this bottle and its wine (issue #986).
 * "Personal" = not published to the shared registry — entries ARE visible to
 * everyone who can see the bottle, attributed to their author. This is a
 * CONTENT card, not a bottle action, so it lives once in the page body.
 *
 * The type lives on the KEY (text/integer/decimal/boolean/date/enum, unit on
 * numeric keys), so the value input adapts to the chosen key and the backend
 * validates every value against the key's stored type.
 */

const TYPES = ['text', 'integer', 'decimal', 'boolean', 'date', 'enum'];

const emptyForm = {
  level: 'bottle',
  keyName: '',
  keyType: 'text',
  unit: '',
  enumOptions: '',
  value: '',
};

function PersonalDataCard({ apiFetch, bottleId, currentUserId }) {
  const { t } = useTranslation();
  const [data, setData] = useState({ bottleEntries: [], wineEntries: [] });
  const [keys, setKeys] = useState([]);
  const [modal, setModal] = useState(null); // { mode: 'add' } | { mode: 'edit', entry }
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getPersonalData(apiFetch, bottleId);
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      setData({ bottleEntries: body.bottleEntries || [], wineEntries: body.wineEntries || [] });
    } catch {
      // Non-critical card — the bottle page works without it.
    }
  }, [apiFetch, bottleId]);

  useEffect(() => {
    if (bottleId) load();
  }, [bottleId, load]);

  // The typed key name matched against the user's own vocabulary — a match
  // locks the type to the key's stored one (a key keeps one type).
  const matchedKey = keys.find(
    (k) => k.name.toLowerCase() === form.keyName.trim().toLowerCase()
  );
  const effectiveType = matchedKey ? matchedKey.type : form.keyType;

  const openAdd = async () => {
    setForm(emptyForm);
    setError(null);
    setModal({ mode: 'add' });
    try {
      const res = await getPersonalDataKeys(apiFetch);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        setKeys(body.keys || []);
      }
    } catch { /* type-ahead is a convenience, not a requirement */ }
  };

  const openEdit = (entry) => {
    setForm({
      ...emptyForm,
      level: entry.level,
      keyName: entry.key.name,
      keyType: entry.key.type,
      value: entry.key.type === 'boolean' ? String(entry.value) : String(entry.value),
    });
    setError(null);
    setModal({ mode: 'edit', entry });
  };

  const closeModal = () => { if (!busy) setModal(null); };

  const formValue = () => {
    if (effectiveType === 'boolean') return form.value === 'true';
    if (effectiveType === 'integer' || effectiveType === 'decimal') {
      // Send the raw string — the backend casts (and accepts the comma form).
      return form.value.trim();
    }
    return form.value.trim();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let res;
      if (modal.mode === 'edit') {
        res = await updatePersonalDataEntry(apiFetch, modal.entry._id, formValue());
      } else {
        const payload = { level: form.level, value: formValue() };
        if (matchedKey) {
          payload.keyId = matchedKey._id;
        } else {
          payload.newKey = {
            name: form.keyName.trim(),
            type: form.keyType,
            ...(form.unit.trim() ? { unit: form.unit.trim() } : {}),
            ...(form.keyType === 'enum'
              ? { enumOptions: form.enumOptions.split(',').map((o) => o.trim()).filter(Boolean) }
              : {}),
          };
        }
        res = await addPersonalData(apiFetch, bottleId, payload);
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setModal(null);
        await load();
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry) => {
    if (deleteBusy) return;
    setDeleteBusy(entry._id);
    try {
      const res = await deletePersonalDataEntry(apiFetch, entry._id);
      if (res.ok) await load();
    } catch { /* leave the entry visible; user can retry */ } finally {
      setDeleteBusy(null);
    }
  };

  const formatValue = (entry) => {
    const { type, unit } = entry.key;
    if (type === 'boolean') {
      return entry.value ? t('personalData.yes', 'Yes') : t('personalData.no', 'No');
    }
    const s = String(entry.value);
    return unit ? `${s} ${unit}` : s;
  };

  const authorName = (entry) =>
    entry.author?.displayName || entry.author?.username || t('personalData.someone', 'a cellar member');

  const isOwn = (entry) => String(entry.author?._id) === String(currentUserId);

  // Chosen values (enum) and yes/no read best as pills; free numbers, dates
  // and text as plain strong values with their unit.
  const isPillValue = (entry) => entry.key.type === 'enum' || entry.key.type === 'boolean';

  const renderEntries = (entries) => (
    <div className="pd-entries">
      {entries.map((entry) => (
        <div key={entry._id} className="pd-entry">
          <span className="pd-entry-key">{entry.key.name}</span>
          <span className="pd-entry-main">
            <span className={isPillValue(entry) ? 'pd-value-pill' : 'pd-entry-value'}>
              {formatValue(entry)}
            </span>
            {!isOwn(entry) && (
              <span className="pd-entry-author">
                {t('personalData.by', 'by {{name}}', { name: authorName(entry) })}
              </span>
            )}
          </span>
          {isOwn(entry) && (
            <span className="pd-entry-actions">
              <button type="button" className="btn btn-small" onClick={() => openEdit(entry)}>
                {t('common.edit', 'Edit')}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => remove(entry)}
                disabled={deleteBusy === entry._id}
              >
                {t('common.delete', 'Delete')}
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );

  const sectionTitleStyle = {
    margin: '0.6rem 0 0.2rem', fontSize: '0.8rem', fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--color-text-muted)',
  };

  const hasEntries = data.bottleEntries.length > 0 || data.wineEntries.length > 0;

  return (
    <div className="card pd-card" style={{ padding: '1rem 1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>
          {t('personalData.title', 'Your wine data')}
        </h2>
        <button type="button" className="btn btn-small" style={{ marginLeft: 'auto' }} onClick={openAdd}>
          {t('personalData.add', '+ Add')}
        </button>
      </div>
      <p style={{ margin: '0.25rem 0 0.4rem', color: 'var(--color-text-muted)', fontSize: '0.82rem' }}>
        {t('personalData.intro', 'Anything the record doesn’t cover — ABV, provenance, cork condition. Visible to everyone who shares this cellar, never published to the shared registry.')}
      </p>

      {!hasEntries && (
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
          {t('personalData.empty', 'Nothing recorded yet.')}
        </p>
      )}

      {data.bottleEntries.length > 0 && (
        <>
          <h3 style={sectionTitleStyle}>{t('personalData.bottleSection', 'This bottle')}</h3>
          {renderEntries(data.bottleEntries)}
        </>
      )}
      {data.wineEntries.length > 0 && (
        <>
          <h3 style={sectionTitleStyle}>{t('personalData.wineSection', 'This wine (all bottles of it)')}</h3>
          {renderEntries(data.wineEntries)}
        </>
      )}

      {modal && (
        <Modal
          title={modal.mode === 'edit'
            ? t('personalData.editTitle', 'Edit entry')
            : t('personalData.addTitle', 'Add wine data')}
          onClose={closeModal}
        >
          <form onSubmit={submit} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}

            {modal.mode === 'add' && (
              <>
                <div className="form-group">
                  <label htmlFor="pd-level">{t('personalData.level', 'Applies to')}</label>
                  <select
                    id="pd-level"
                    className="pd-select"
                    value={form.level}
                    onChange={(e) => setForm({ ...form, level: e.target.value })}
                  >
                    <option value="bottle">{t('personalData.levelBottle', 'This bottle only')}</option>
                    <option value="wine">{t('personalData.levelWine', 'Every bottle of this wine')}</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="pd-key-name">{t('personalData.key', 'What is it?')}</label>
                  <input
                    id="pd-key-name"
                    type="text"
                    list="pd-key-suggestions"
                    value={form.keyName}
                    onChange={(e) => setForm({ ...form, keyName: e.target.value })}
                    placeholder={t('personalData.keyPlaceholder', 'e.g. ABV, Provenance, Cork condition')}
                    maxLength={60}
                    required
                  />
                  <datalist id="pd-key-suggestions">
                    {keys.map((k) => <option key={k._id} value={k.name} />)}
                  </datalist>

                  {/* Saved keys as one-tap chips — the datalist alone is invisible
                      until you type, which made reuse look broken (Johan, 08-17):
                      a value list created on one wine seemed to vanish on the next. */}
                  {keys.length > 0 && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <span className="pd-chips-label">
                        {t('personalData.yourKeys', 'Your saved keys:')}
                      </span>
                      <div className="pd-chips">
                        {keys.map((k) => {
                          const selected = matchedKey && matchedKey._id === k._id;
                          return (
                            <button
                              key={k._id}
                              type="button"
                              className={`pd-chip${selected ? ' pd-chip--selected' : ''}`}
                              onClick={() => setForm({ ...form, keyName: k.name, value: '' })}
                              title={k.type + (k.unit ? ` (${k.unit})` : '')}
                            >
                              {k.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {matchedKey && (
                    <p className="pd-key-note">
                      {t('personalData.existingKey', 'Existing key — type: {{type}}', { type: matchedKey.type })}
                      {matchedKey.unit ? ` (${matchedKey.unit})` : ''}
                    </p>
                  )}
                </div>

                {!matchedKey && form.keyName.trim() && (
                  <>
                    <div className="form-group">
                      <label htmlFor="pd-key-type">{t('personalData.type', 'Value type')}</label>
                      <select
                        id="pd-key-type"
                        className="pd-select"
                        value={form.keyType}
                        onChange={(e) => setForm({ ...form, keyType: e.target.value, value: '' })}
                      >
                        {TYPES.map((ty) => (
                          <option key={ty} value={ty}>
                            {t(`personalData.type_${ty}`, ty)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {(form.keyType === 'integer' || form.keyType === 'decimal') && (
                      <div className="form-group">
                        <label htmlFor="pd-unit">{t('personalData.unit', 'Unit (optional)')}</label>
                        <input
                          id="pd-unit"
                          type="text"
                          value={form.unit}
                          onChange={(e) => setForm({ ...form, unit: e.target.value })}
                          placeholder={t('personalData.unitPlaceholder', 'e.g. %, °C, kr')}
                          maxLength={20}
                        />
                      </div>
                    )}
                    {form.keyType === 'enum' && (
                      <div className="form-group">
                        <label htmlFor="pd-enum-options">{t('personalData.enumOptions', 'Allowed values (comma-separated)')}</label>
                        <input
                          id="pd-enum-options"
                          type="text"
                          value={form.enumOptions}
                          onChange={(e) => setForm({ ...form, enumOptions: e.target.value })}
                          placeholder={t('personalData.enumPlaceholder', 'e.g. cork, screwcap, crown')}
                          required
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <div className="form-group">
              {/* Explicit htmlFor/id: the unit suffix lives beside the input,
                  and a wrapping label would fold it into the accessible name. */}
              <label htmlFor="pd-value-input">
                {t('personalData.value', 'Value')}
              </label>
              {effectiveType === 'boolean' ? (
                <select
                  id="pd-value-input"
                  className="pd-select"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  required
                >
                  <option value="">{t('personalData.choose', 'Choose…')}</option>
                  <option value="true">{t('personalData.yes', 'Yes')}</option>
                  <option value="false">{t('personalData.no', 'No')}</option>
                </select>
              ) : effectiveType === 'enum' ? (
                (() => {
                  const options = matchedKey?.enumOptions
                    || (modal.mode === 'edit' ? modal.entry.key.enumOptions : null)
                    || form.enumOptions.split(',').map((o) => o.trim()).filter(Boolean);
                  return (
                    <select
                      id="pd-value-input"
                      className="pd-select"
                      value={form.value}
                      onChange={(e) => setForm({ ...form, value: e.target.value })}
                      required
                    >
                      <option value="">{t('personalData.choose', 'Choose…')}</option>
                      {options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  );
                })()
              ) : (
                <span className="pd-value-row">
                  <input
                    id="pd-value-input"
                    type={effectiveType === 'date' ? 'date'
                      : (effectiveType === 'integer' || effectiveType === 'decimal') ? 'number' : 'text'}
                    step={effectiveType === 'decimal' ? 'any' : undefined}
                    value={form.value}
                    onChange={(e) => setForm({ ...form, value: e.target.value })}
                    maxLength={effectiveType === 'text' ? 500 : undefined}
                    required
                  />
                  {(matchedKey?.unit || (modal.mode === 'edit' && modal.entry.key.unit) || form.unit.trim()) && (
                    <span className="pd-unit">
                      {matchedKey?.unit || (modal.mode === 'edit' ? modal.entry.key.unit : form.unit.trim())}
                    </span>
                  )}
                </span>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="btn" onClick={closeModal} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default PersonalDataCard;
