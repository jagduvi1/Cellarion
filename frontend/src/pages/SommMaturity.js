import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import WineImage from '../components/WineImage';
import ConfirmModal from '../components/ConfirmModal';
import './SommMaturity.css';

const CURRENT_YEAR = new Date().getFullYear();

// Compute current maturity phase from 6-field profile
function getMaturityPhase(p) {
  if (!p || p.status !== 'reviewed') return null;
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = p;

  // Need at least one window boundary to classify
  if (!earlyFrom && !peakFrom && !peakUntil) return null;

  const firstYear = earlyFrom || peakFrom;
  if (firstYear && CURRENT_YEAR < firstYear)                 return { cls: 'not-ready', label: `Not yet mature — from ${firstYear}` };
  if (earlyUntil && CURRENT_YEAR <= earlyUntil)              return { cls: 'early',     label: 'Early drinking' };
  if (peakFrom   && CURRENT_YEAR <  peakFrom)                return { cls: 'early',     label: `Early drinking — peak from ${peakFrom}` };
  if (peakUntil  && CURRENT_YEAR <= peakUntil)               return { cls: 'peak',      label: 'Optimal maturity ⭐' };
  if (lateFrom   && CURRENT_YEAR <  lateFrom)                return { cls: 'peak',      label: `Optimal maturity — late phase from ${lateFrom}` };
  if (lateUntil  && CURRENT_YEAR <= lateUntil)               return { cls: 'late',      label: 'Late maturity' };
  if ((lateUntil && CURRENT_YEAR > lateUntil) ||
      (peakUntil && CURRENT_YEAR > peakUntil && !lateFrom))  return { cls: 'declining', label: 'Past prime' };
  if (peakFrom   && CURRENT_YEAR >= peakFrom)                return { cls: 'peak',      label: 'Optimal maturity ⭐' };
  return { cls: 'early', label: 'Early drinking' };
}

// Format a year span relative to vintage: "5–7 years" or "5 years"
function yearsFromVintage(vintageInt, from, until) {
  if (!vintageInt || !from) return '';
  const f = parseInt(from);
  const u = until ? parseInt(until) : null;
  if (isNaN(f)) return '';
  const fYrs = f - vintageInt;
  if (u && !isNaN(u)) {
    const uYrs = u - vintageInt;
    return `${fYrs}–${uYrs} yrs`;
  }
  return `${fYrs} yrs`;
}

function SommMaturity() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [tab, setTab] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/somm/maturity?status=${tab}`);
      const data = await res.json();
      if (res.ok) setProfiles(data.profiles);
      else setError(data.error || 'Failed to load profiles');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, tab]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const handleSaved  = (updated) => setProfiles(prev => prev.filter(p => p._id !== updated._id));
  const handleReset  = (updated) => setProfiles(prev => prev.filter(p => p._id !== updated._id));

  return (
    <div className="somm-page">
      <div className="page-header">
        <h1>{t('somm.maturity.title')}</h1>
        <p className="somm-subtitle">
          {t('somm.maturity.subtitle')}
        </p>
      </div>

      <div className="somm-tabs">
        <button className={`somm-tab ${tab === 'pending'  ? 'active' : ''}`} onClick={() => setTab('pending')}>
          {t('somm.maturity.pendingTab')}
        </button>
        <button className={`somm-tab ${tab === 'reviewed' ? 'active' : ''}`} onClick={() => setTab('reviewed')}>
          {t('somm.maturity.reviewedTab')}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">{t('somm.maturity.loadingProfiles')}</div>
      ) : profiles.length === 0 ? (
        <div className="somm-empty">
          {tab === 'pending' ? t('somm.maturity.noPending') : t('somm.maturity.noReviewed')}
        </div>
      ) : (
        <div className="somm-list">
          {profiles.map(profile => (
            <ProfileCard
              key={profile._id}
              profile={profile}
              isPending={tab === 'pending'}
              onSaved={handleSaved}
              onReset={handleReset}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Individual profile card with inline form ──────────────────────────────────
function ProfileCard({ profile, isPending, onSaved, onReset }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const wine       = profile.wineDefinition;
  const vintageInt = parseInt(profile.vintage);

  const [expanded,  setExpanded]  = useState(isPending);
  const [saving,    setSaving]    = useState(false);
  const [resetting, setResetting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMsg,     setAiMsg]     = useState(null);
  const [err,       setErr]       = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const [form, setForm] = useState({
    earlyFrom:  profile.earlyFrom  || '',
    earlyUntil: profile.earlyUntil || '',
    peakFrom:   profile.peakFrom   || '',
    peakUntil:  profile.peakUntil  || '',
    lateFrom:   profile.lateFrom   || '',
    lateUntil:  profile.lateUntil  || '',
    sommNotes:  profile.sommNotes  || ''
  });

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const body = { sommNotes: form.sommNotes };
      ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'].forEach(f => {
        body[f] = form[f] ? parseInt(form[f]) : null;
      });

      const res = await apiFetch(`/api/somm/maturity/${profile._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) onSaved(data.profile);
      else setErr(data.error || 'Failed to save');
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const res = await apiFetch(`/api/somm/maturity/${profile._id}/reset`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (res.ok) onReset(data.profile);
      else setErr(data.error || 'Failed to reset');
    } catch {
      setErr('Network error');
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
  };

  const handleAiSuggest = async () => {
    setAiLoading(true);
    setAiMsg(null);
    setErr(null);
    try {
      const res = await apiFetch(`/api/somm/maturity/${profile._id}/ai-suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok && data.suggestion) {
        const s = data.suggestion;
        setForm(f => ({
          ...f,
          earlyFrom:  s.earlyFrom  ?? f.earlyFrom,
          earlyUntil: s.earlyUntil ?? f.earlyUntil,
          peakFrom:   s.peakFrom   ?? f.peakFrom,
          peakUntil:  s.peakUntil  ?? f.peakUntil,
          lateFrom:   s.lateFrom   ?? f.lateFrom,
          lateUntil:  s.lateUntil  ?? f.lateUntil,
          sommNotes:  s.sommNotes  || f.sommNotes
        }));
        setAiMsg({ ok: true, text: t('somm.maturity.aiSuggestFilled') });
      } else {
        setAiMsg({ ok: false, text: data.error || t('somm.maturity.aiSuggestError') });
      }
    } catch {
      setAiMsg({ ok: false, text: t('somm.maturity.aiSuggestError') });
    } finally {
      setAiLoading(false);
    }
  };

  const phase = getMaturityPhase(profile);

  return (
    <div className={`somm-card ${expanded ? 'expanded' : ''}`}>
      {/* ── Card header (click to expand) ── */}
      <div className="somm-card-header" role="button" tabIndex={0} onClick={() => setExpanded(o => !o)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(o => !o); } }}>
        <div className="somm-card-identity">
          <WineImage image={wine?.image} alt={wine?.name} className="somm-wine-thumb" wineType={wine?.type} placeholder="somm-wine-thumb-placeholder" />
          <div>
            <span className="somm-wine-name">{wine?.name || 'Unknown'}</span>
            <span className="somm-wine-meta">
              {wine?.producer}{wine?.country?.name && ` · ${wine.country.name}`}
            </span>
          </div>
        </div>

        <div className="somm-card-right">
          <span className="somm-vintage-pill">{profile.vintage}</span>
          {phase ? (
            <span className={`maturity-badge maturity-badge--${phase.cls}`}>{phase.label}</span>
          ) : (
            <span className={`somm-status-pill ${profile.status}`}>
              {profile.status === 'pending' ? t('somm.maturity.statusPending') : t('somm.maturity.statusReviewed')}
            </span>
          )}
          <span className="somm-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Inline form ── */}
      {expanded && (
        <form className="somm-form" onSubmit={handleSave}>
          {err && <div className="alert alert-error">{err}</div>}

          <div className="somm-form-hint-row">
            <p className="somm-form-hint">
              {t('somm.maturity.phaseHint')}
              {!isNaN(vintageInt) && ` (${t('somm.maturity.vintageLabel')} ${vintageInt})`}
            </p>
            <button
              type="button"
              className="btn btn-ai"
              onClick={handleAiSuggest}
              disabled={aiLoading}
            >
              {aiLoading ? t('somm.maturity.aiSuggesting') : t('somm.maturity.aiSuggest')}
            </button>
          </div>
          {aiMsg && (
            <div className={`somm-ai-msg ${aiMsg.ok ? 'somm-ai-msg--ok' : 'somm-ai-msg--err'}`}>
              {aiMsg.text}
            </div>
          )}

          {/* ── Phase rows ── */}
          <div className="somm-phases">

            {/* Phase 1 — Early drinking */}
            <div className="somm-phase-row">
              <div className="somm-phase-label somm-phase-label--early">
                <span className="somm-phase-name">{t('somm.maturity.phaseEarly')}</span>
                <span className="somm-phase-yrs">
                  {yearsFromVintage(vintageInt, form.earlyFrom, form.earlyUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>{t('somm.maturity.fromLabel')}</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 2) : 'Year'}
                    value={form.earlyFrom} onChange={set('earlyFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>{t('somm.maturity.untilLabel')}</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 5) : 'Year'}
                    value={form.earlyUntil} onChange={set('earlyUntil')}
                  />
                </div>
              </div>
            </div>

            {/* Phase 2 — Optimal maturity */}
            <div className="somm-phase-row">
              <div className="somm-phase-label somm-phase-label--peak">
                <span className="somm-phase-name">{t('somm.maturity.phasePeak')}</span>
                <span className="somm-phase-yrs">
                  {yearsFromVintage(vintageInt, form.peakFrom, form.peakUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>{t('somm.maturity.fromLabel')}</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 6) : 'Year'}
                    value={form.peakFrom} onChange={set('peakFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>{t('somm.maturity.untilLabel')}</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 15) : 'Year'}
                    value={form.peakUntil} onChange={set('peakUntil')}
                  />
                </div>
              </div>
            </div>

            {/* Phase 3 — Late maturity */}
            <div className="somm-phase-row">
              <div className="somm-phase-label somm-phase-label--late">
                <span className="somm-phase-name">{t('somm.maturity.phaseLate')}</span>
                <span className="somm-phase-yrs">
                  {yearsFromVintage(vintageInt, form.lateFrom, form.lateUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>{t('somm.maturity.fromLabel')}</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 16) : 'Year'}
                    value={form.lateFrom} onChange={set('lateFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>{t('somm.maturity.untilLabel')}</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 22) : 'Year'}
                    value={form.lateUntil} onChange={set('lateUntil')}
                  />
                </div>
              </div>
            </div>

          </div>{/* /.somm-phases */}

          {/* Live preview */}
          <MaturityPreview form={form} vintageInt={vintageInt} />

          <div className="form-group" style={{ marginTop: '1rem' }}>
            <label>{t('somm.maturity.sommNotes')} <span className="somm-year-hint">{t('somm.maturity.sommNotesOptional')}</span></label>
            <textarea
              rows={3}
              placeholder={t('somm.maturity.sommNotesPlaceholder')}
              value={form.sommNotes}
              onChange={set('sommNotes')}
            />
          </div>

          {profile.setBy && (
            <p className="somm-set-by">
              {t('somm.maturity.lastReviewedBy')} <strong>{profile.setBy.username}</strong>
              {profile.setAt && ` on ${new Date(profile.setAt).toLocaleDateString()}`}
            </p>
          )}

          <div className="somm-form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('common.saving') : t('somm.maturity.markReviewed')}
            </button>
            {!isPending && (
              <button type="button" className="btn btn-secondary" onClick={() => setShowResetConfirm(true)} disabled={resetting}>
                {resetting ? t('somm.maturity.resetting') : t('somm.maturity.resetPending')}
              </button>
            )}
          </div>
        </form>
      )}

      {showResetConfirm && (
        <ConfirmModal
          title={t('somm.maturity.resetPending')}
          message={t('somm.maturity.resetConfirm')}
          confirmLabel={t('somm.maturity.resetPending')}
          confirmClass="btn btn-danger btn-small"
          onConfirm={handleReset}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </div>
  );
}

// ── Live preview component ────────────────────────────────────────────────────
function MaturityPreview({ form, vintageInt }) {
  const { t } = useTranslation();
  const mock = {
    status:     'reviewed',
    earlyFrom:  form.earlyFrom  ? parseInt(form.earlyFrom)  : null,
    earlyUntil: form.earlyUntil ? parseInt(form.earlyUntil) : null,
    peakFrom:   form.peakFrom   ? parseInt(form.peakFrom)   : null,
    peakUntil:  form.peakUntil  ? parseInt(form.peakUntil)  : null,
    lateFrom:   form.lateFrom   ? parseInt(form.lateFrom)   : null,
    lateUntil:  form.lateUntil  ? parseInt(form.lateUntil)  : null,
  };

  const hasAny = Object.values(mock).some(v => v && !isNaN(v));
  if (!hasAny) return null;

  const phase = getMaturityPhase(mock);
  if (!phase) return null;

  return (
    <div className={`somm-preview somm-preview--${phase.cls}`}>
      <span className="somm-preview-label">{t('somm.maturity.statusToday', { year: CURRENT_YEAR })}</span>
      <span className={`maturity-badge maturity-badge--${phase.cls}`}>{phase.label}</span>
    </div>
  );
}

export default SommMaturity;
