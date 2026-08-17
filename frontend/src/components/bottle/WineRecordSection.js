import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { createWineProposal, getMyWineProposals } from '../../api/wineProposals';
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
    </div>
  );
}

export default WineRecordSection;
