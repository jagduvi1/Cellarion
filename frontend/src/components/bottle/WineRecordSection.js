import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import TypedValueInput from '../TypedValueInput';
import { createWineProposal, getMyWineProposals } from '../../api/wineProposals';
import { getWinePublicData, suggestWineValue, proposeRegistryKey } from '../../api/registryData';
import './WineRecordSection.css';

/**
 * The full public record of a wine, blanks included (#985 Slice A).
 * A visible gap is what invites a contribution — blank fields render as
 * "not recorded", and every identity field carries a "suggest a fix" action
 * that files into the admin-reviewed WineCorrectionProposal queue. Nothing a
 * user does here writes to the registry; approval stays a human act.
 */

// The six admin-reviewed identity fields (must match wineProposalOps.FIELDS).
const SUGGESTABLE = ['producer', 'name', 'appellation', 'region', 'country', 'classification'];

function WineRecordSection({ wine, canSuggest, apiFetch }) {
  const { t } = useTranslation();
  const [mine, setMine] = useState([]);
  const [modal, setModal] = useState(null); // { field }
  const [proposed, setProposed] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sentField, setSentField] = useState(null);
  // Public key vocabulary + values (#985 Slice B)
  const [publicFields, setPublicFields] = useState([]);
  const [valueModal, setValueModal] = useState(null); // { field } from publicFields
  const [valueInput, setValueInput] = useState('');
  const [valueReason, setValueReason] = useState('');
  const [keyModal, setKeyModal] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: '', type: 'text', unit: '', enumOptions: '', rationale: '' });

  const loadPublicData = useCallback(async () => {
    try {
      const res = await getWinePublicData(apiFetch, wine._id);
      if (!res.ok) return;
      const body = await res.json().catch(() => ({}));
      setPublicFields(body.fields || []);
    } catch { /* non-critical — the record renders without it */ }
  }, [apiFetch, wine?._id]);

  useEffect(() => {
    if (wine?._id) loadPublicData();
  }, [wine?._id, loadPublicData]);

  useEffect(() => {
    if (!wine?._id || !canSuggest) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await getMyWineProposals(apiFetch, wine._id);
        if (!res.ok) return;
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setMine(body.proposals || []);
      } catch { /* non-critical — the record renders without it */ }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, wine?._id, canSuggest]);

  if (!wine) return null;

  const values = {
    producer: wine.producer || null,
    name: wine.name || null,
    country: wine.country?.name || null,
    region: wine.region?.name || null,
    appellation: wine.appellation || null,
    classification: wine.classification || null,
  };

  const pendingFields = new Set(
    mine.filter((p) => p.status === 'pending')
      .flatMap((p) => Object.keys(p.proposedFields || {}))
  );

  const openSuggest = (field) => {
    setModal({ field });
    setProposed('');
    setReason('');
    setEvidenceUrl('');
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createWineProposal(apiFetch, {
        wineId: wine._id,
        fields: { [modal.field]: proposed.trim() },
        reason: reason.trim(),
        ...(evidenceUrl.trim() ? { evidenceUrl: evidenceUrl.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setSentField(modal.field);
        setMine((prev) => [{ status: 'pending', proposedFields: { [modal.field]: proposed.trim() } }, ...prev]);
        setModal(null);
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const fieldLabel = (f) => t(`wineRecord.field_${f}`, f.charAt(0).toUpperCase() + f.slice(1));

  const formatPublicValue = (field) => {
    if (field.value === null || field.value === undefined) return null;
    if (field.key.type === 'boolean') {
      return field.value ? t('personalData.yes', 'Yes') : t('personalData.no', 'No');
    }
    const s = String(field.value);
    return field.key.unit ? `${s} ${field.key.unit}` : s;
  };

  const submitValue = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const raw = valueModal.field.key.type === 'boolean' ? valueInput === 'true' : valueInput.trim();
      const res = await suggestWineValue(apiFetch, wine._id, {
        keyId: valueModal.field.key._id,
        value: raw,
        ...(valueReason.trim() ? { reason: valueReason.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setValueModal(null);
        await loadPublicData();
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const submitKey = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await proposeRegistryKey(apiFetch, {
        name: keyForm.name.trim(),
        type: keyForm.type,
        ...(keyForm.unit.trim() ? { unit: keyForm.unit.trim() } : {}),
        ...(keyForm.type === 'enum'
          ? { enumOptions: keyForm.enumOptions.split(',').map((o) => o.trim()).filter(Boolean) }
          : {}),
        rationale: keyForm.rationale.trim(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setKeyModal(false);
        setSentField('newKey');
      } else {
        setError(body.error || t('common.networkError', 'Network error. Please try again.'));
      }
    } catch {
      setError(t('common.networkError', 'Network error. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bd-section">
      <span className="bd-section-label">{t('wineRecord.title', 'Wine record')}</span>
      <p className="wr-intro">
        {t('wineRecord.intro', 'The shared registry’s record of this wine. Spot something wrong or missing? Suggest a fix — a curator reviews every suggestion before it goes live.')}
      </p>
      <div className="wr-grid">
        {SUGGESTABLE.map((f) => (
          <div key={f} className="wr-row">
            <span className="wr-key">{fieldLabel(f)}</span>
            <span className={values[f] ? 'wr-value' : 'wr-value wr-value--blank'}>
              {values[f] || t('wineRecord.notRecorded', 'not recorded')}
            </span>
            {canSuggest && (
              pendingFields.has(f) ? (
                <span className="wr-pending" title={t('wineRecord.pendingTitle', 'Your suggestion is awaiting curator review')}>
                  {t('wineRecord.pending', 'suggestion pending')}
                </span>
              ) : (
                <button
                  type="button"
                  className="wr-suggest-btn"
                  onClick={() => openSuggest(f)}
                  aria-label={t('wineRecord.suggestFor', 'Suggest a fix for {{field}}', { field: fieldLabel(f) })}
                >
                  {t('wineRecord.suggest', 'Suggest a fix')}
                </button>
              )
            )}
          </div>
        ))}
      </div>
      {/* ── Public data fields (#985 Slice B): the accepted vocabulary with
          published values; blanks invite value suggestions ── */}
      {(publicFields.length > 0 || canSuggest) && (
        <>
          <span className="bd-section-label" style={{ marginTop: '0.8rem' }}>
            {t('wineRecord.publicData', 'More data')}
          </span>
          <div className="wr-grid">
            {publicFields.map((field) => {
              const shown = formatPublicValue(field);
              return (
                <div key={field.key._id} className="wr-row">
                  <span className="wr-key">{field.key.name}</span>
                  <span className={shown ? 'wr-value' : 'wr-value wr-value--blank'}>
                    {shown || t('wineRecord.notRecorded', 'not recorded')}
                    {shown && field.contributedBy && (
                      <span className="wr-contributor"> {t('wineRecord.contributedBy', 'by {{name}}', { name: field.contributedBy })}</span>
                    )}
                  </span>
                  {canSuggest && (
                    field.mySuggestion ? (
                      <span className="wr-pending" title={t('wineRecord.pendingTitle', 'Your suggestion is awaiting curator review')}>
                        {t('wineRecord.pending', 'suggestion pending')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="wr-suggest-btn"
                        onClick={() => { setValueModal({ field }); setValueInput(''); setValueReason(''); setError(null); }}
                        aria-label={t('wineRecord.suggestValueFor', 'Suggest a value for {{field}}', { field: field.key.name })}
                      >
                        {shown ? t('wineRecord.suggest', 'Suggest a fix') : t('wineRecord.suggestValue', 'Add value')}
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
          {canSuggest && (
            <button
              type="button"
              className="wr-suggest-btn wr-propose-key"
              onClick={() => { setKeyModal(true); setKeyForm({ name: '', type: 'text', unit: '', enumOptions: '', rationale: '' }); setError(null); }}
            >
              {t('wineRecord.proposeKey', '+ Propose a new data field')}
            </button>
          )}
        </>
      )}

      {sentField && (
        <p role="status" className="wr-thanks">
          {t('wineRecord.thanks', 'Thank you — your suggestion is in the review queue. You’ll see the outcome here.')}
        </p>
      )}

      {modal && (
        <Modal title={t('wineRecord.modalTitle', 'Suggest a fix: {{field}}', { field: fieldLabel(modal.field) })} onClose={() => !busy && setModal(null)}>
          <form onSubmit={submit} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            <div className="form-group">
              <label>{t('wineRecord.current', 'Currently recorded')}</label>
              <div className="wr-current">{values[modal.field] || t('wineRecord.notRecorded', 'not recorded')}</div>
            </div>
            <div className="form-group">
              <label htmlFor="wr-proposed">{t('wineRecord.proposed', 'Should be')}</label>
              <input
                id="wr-proposed"
                type="text"
                value={proposed}
                onChange={(e) => setProposed(e.target.value)}
                maxLength={200}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="wr-reason">{t('wineRecord.reason', 'How do you know?')}</label>
              <textarea
                id="wr-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('wineRecord.reasonPlaceholder', 'e.g. It’s printed on the label of my bottle / the producer’s site says…')}
                minLength={10}
                maxLength={1000}
                rows={3}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="wr-evidence">{t('wineRecord.evidence', 'Link that backs it up (optional, speeds up review)')}</label>
              <input
                id="wr-evidence"
                type="url"
                value={evidenceUrl}
                onChange={(e) => setEvidenceUrl(e.target.value)}
                placeholder="https://…"
                maxLength={500}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setModal(null)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !proposed.trim() || reason.trim().length < 10}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.send', 'Send suggestion')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {valueModal && (
        <Modal
          title={t('wineRecord.valueModalTitle', 'Suggest a value: {{field}}', { field: valueModal.field.key.name })}
          onClose={() => !busy && setValueModal(null)}
        >
          <form onSubmit={submitValue} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            <div className="form-group">
              <label htmlFor="wr-public-value">{t('personalData.value', 'Value')}</label>
              <TypedValueInput
                id="wr-public-value"
                keyDef={valueModal.field.key}
                value={valueInput}
                onChange={setValueInput}
              />
            </div>
            <div className="form-group">
              <label htmlFor="wr-value-reason">{t('wineRecord.valueReason', 'How do you know? (optional)')}</label>
              <input
                id="wr-value-reason"
                type="text"
                value={valueReason}
                onChange={(e) => setValueReason(e.target.value)}
                placeholder={t('wineRecord.reasonPlaceholder', 'e.g. It’s printed on the label of my bottle / the producer’s site says…')}
                maxLength={1000}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setValueModal(null)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !valueInput}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.send', 'Send suggestion')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {keyModal && (
        <Modal title={t('wineRecord.keyModalTitle', 'Propose a new data field')} onClose={() => !busy && setKeyModal(false)}>
          <form onSubmit={submitKey} className="pd-form">
            {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}
            <p style={{ margin: '0 0 0.6rem', fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
              {t('wineRecord.keyModalIntro', 'A new field becomes available on every wine once an admin accepts it. One field, one meaning — check the list above first.')}
            </p>
            <div className="form-group">
              <label htmlFor="wr-key-name">{t('wineRecord.keyName', 'Field name')}</label>
              <input
                id="wr-key-name"
                type="text"
                value={keyForm.name}
                onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })}
                placeholder={t('wineRecord.keyNamePlaceholder', 'e.g. ABV')}
                maxLength={60}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="wr-key-type">{t('personalData.type', 'Value type')}</label>
              <select
                id="wr-key-type"
                className="pd-select"
                value={keyForm.type}
                onChange={(e) => setKeyForm({ ...keyForm, type: e.target.value })}
              >
                {['text', 'integer', 'decimal', 'boolean', 'date', 'enum'].map((ty) => (
                  <option key={ty} value={ty}>{t(`personalData.type_${ty}`, ty)}</option>
                ))}
              </select>
            </div>
            {(keyForm.type === 'integer' || keyForm.type === 'decimal') && (
              <div className="form-group">
                <label htmlFor="wr-key-unit">{t('personalData.unit', 'Unit (optional)')}</label>
                <input
                  id="wr-key-unit"
                  type="text"
                  value={keyForm.unit}
                  onChange={(e) => setKeyForm({ ...keyForm, unit: e.target.value })}
                  placeholder={t('personalData.unitPlaceholder', 'e.g. %, °C, kr')}
                  maxLength={20}
                />
              </div>
            )}
            {keyForm.type === 'enum' && (
              <div className="form-group">
                <label htmlFor="wr-key-options">{t('personalData.enumOptions', 'Allowed values (comma-separated)')}</label>
                <input
                  id="wr-key-options"
                  type="text"
                  value={keyForm.enumOptions}
                  onChange={(e) => setKeyForm({ ...keyForm, enumOptions: e.target.value })}
                  placeholder={t('personalData.enumPlaceholder', 'e.g. cork, screwcap, crown')}
                  required
                />
              </div>
            )}
            <div className="form-group">
              <label htmlFor="wr-key-rationale">{t('wineRecord.keyRationale', 'Why should every wine have this field?')}</label>
              <textarea
                id="wr-key-rationale"
                value={keyForm.rationale}
                onChange={(e) => setKeyForm({ ...keyForm, rationale: e.target.value })}
                minLength={10}
                maxLength={1000}
                rows={3}
                required
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setKeyModal(false)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !keyForm.name.trim() || keyForm.rationale.trim().length < 10}>
                {busy ? t('wineRecord.sending', 'Sending…') : t('wineRecord.proposeKeySend', 'Propose field')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default WineRecordSection;
