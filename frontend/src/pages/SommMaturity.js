import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import WineImage from '../components/WineImage';
import ConfirmModal from '../components/ConfirmModal';
import Modal from '../components/Modal';
import SommWineProfilePanel from '../components/SommWineProfilePanel';
import { deferMaturityProfile, returnMaturityProfile } from '../api/somm';
import './SommMaturity.css';

const CURRENT_YEAR = new Date().getFullYear();

// Backend sends ISO datetimes; <input type="date"> wants YYYY-MM-DD.
const toDateInput = (iso) => (iso ? String(iso).slice(0, 10) : '');
const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

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

// For NV (relative) profiles the entered numbers ARE years-after-purchase, so
// show them directly; for vintage wines, compute the span from the vintage.
function phaseYrs(isNv, vintageInt, from, until) {
  if (!isNv) return yearsFromVintage(vintageInt, from, until);
  if (from === '' || from === undefined || from === null) return '';
  const u = (until === '' || until === undefined || until === null) ? null : until;
  return u !== null ? `${from}–${u} yrs` : `${from} yrs`;
}

function SommMaturity() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  // Latest-wins guard: a slow response for the previous tab must not
  // overwrite the list for the tab the user is now viewing.
  const fetchSeq = useRef(0);

  const PAGE_SIZE = 100;

  // The queue grows one profile per wine+vintage forever, so the backend
  // paginates (limit/offset + total) — offset 0 replaces the list, higher
  // offsets append (Load more).
  const fetchProfiles = useCallback(async (offset = 0) => {
    const seq = ++fetchSeq.current;
    if (offset === 0) setLoading(true); else setLoadingMore(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/somm/maturity?status=${tab}&limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      if (seq !== fetchSeq.current) return;
      if (res.ok) {
        setProfiles(prev => (offset === 0 ? data.profiles : [...prev, ...data.profiles]));
        setTotal(data.total ?? data.profiles.length);
      } else {
        setError(data.error || 'Failed to load profiles');
      }
    } catch {
      if (seq === fetchSeq.current) setError('Network error');
    } finally {
      if (seq === fetchSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [apiFetch, tab]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  // Saving flips a pending profile to reviewed, so it leaves the Pending tab;
  // on the Reviewed tab it stays reviewed and must remain visible — update it
  // in place instead of dropping it.
  const handleSaved  = (updated) => setProfiles(prev => (
    tab === 'reviewed'
      ? prev.map(p => (p._id === updated._id ? updated : p))
      : prev.filter(p => p._id !== updated._id)
  ));
  const handleReset  = (updated) => setProfiles(prev => prev.filter(p => p._id !== updated._id));
  // Deferring drops the row from Pending; returning it drops the row from
  // Deferred. Either way the card leaves the tab it was acted on from.
  const handleMoved  = (updated) => setProfiles(prev => prev.filter(p => p._id !== updated._id));

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
        <button className={`somm-tab ${tab === 'deferred' ? 'active' : ''}`} onClick={() => setTab('deferred')}>
          {t('somm.maturity.deferredTab')}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">{t('somm.maturity.loadingProfiles')}</div>
      ) : profiles.length === 0 ? (
        <div className="somm-empty">
          {tab === 'pending' && t('somm.maturity.noPending')}
          {tab === 'reviewed' && t('somm.maturity.noReviewed')}
          {tab === 'deferred' && t('somm.maturity.noDeferred')}
        </div>
      ) : (
        <>
          <div className="somm-list">
            {profiles.map(profile => (
              <ProfileCard
                key={profile._id}
                profile={profile}
                tab={tab}
                onSaved={handleSaved}
                onReset={handleReset}
                onMoved={handleMoved}
              />
            ))}
          </div>
          {profiles.length < total && (
            <div style={{ textAlign: 'center', margin: '1rem 0' }}>
              <button
                className="btn btn-secondary"
                onClick={() => fetchProfiles(profiles.length)}
                disabled={loadingMore}
              >
                {loadingMore
                  ? t('somm.maturity.loadingProfiles')
                  : `${t('somm.maturity.loadMore', 'Load more')} (${profiles.length}/${total})`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Individual profile card with inline form ──────────────────────────────────
function ProfileCard({ profile, tab, onSaved, onReset, onMoved }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const wine       = profile.wineDefinition;
  const vintageInt = parseInt(profile.vintage);
  const isNv       = profile.vintage === 'NV';
  const isPending  = tab === 'pending';
  const isDeferredTab = tab === 'deferred';
  // A deferred row shown in Pending is one whose return date has passed — the
  // backend hands it back automatically (services/maturityOps.js).
  const returnedFromDeferral = isPending && profile.status === 'deferred';

  const [expanded,  setExpanded]  = useState(isPending);
  const [saving,    setSaving]    = useState(false);
  const [resetting, setResetting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMsg,     setAiMsg]     = useState(null);
  const [err,       setErr]       = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showDefer, setShowDefer] = useState(false);
  const [returning, setReturning] = useState(false);

  // For an NV profile not yet migrated to relative (offset) mode, start the
  // window blank so the somm enters durations fresh rather than stale years
  // that would fail the 0–100 offset validation.
  const seed = (isNv && !profile.relative) ? {} : profile;
  const [form, setForm] = useState({
    earlyFrom:  seed.earlyFrom  || '',
    earlyUntil: seed.earlyUntil || '',
    peakFrom:   seed.peakFrom   || '',
    peakUntil:  seed.peakUntil  || '',
    lateFrom:   seed.lateFrom   || '',
    lateUntil:  seed.lateUntil  || '',
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
        // Treat 0 as a real value — for NV wines an offset of 0 means "drink
        // from purchase", which is common. A plain `form[f] ? … : null` would
        // drop a numeric 0 (e.g. from an AI suggestion) to null.
        const v = form[f];
        body[f] = (v === '' || v === null || v === undefined) ? null : parseInt(v);
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

  const handleReturn = async () => {
    setReturning(true);
    setErr(null);
    try {
      const res = await returnMaturityProfile(apiFetch, profile._id);
      const data = await res.json();
      if (res.ok) onMoved(data.profile);
      else setErr(data.error || t('somm.maturity.returnError'));
    } catch {
      setErr('Network error');
    } finally {
      setReturning(false);
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

  const phase = isNv ? null : getMaturityPhase(profile);

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
          {phase && !returnedFromDeferral ? (
            <span className={`maturity-badge maturity-badge--${phase.cls}`}>{phase.label}</span>
          ) : (
            <span className={`somm-status-pill ${returnedFromDeferral ? 'pending' : profile.status}`}>
              {returnedFromDeferral && t('somm.maturity.statusReturned')}
              {!returnedFromDeferral && profile.status === 'pending'  && t('somm.maturity.statusPending')}
              {!returnedFromDeferral && profile.status === 'reviewed' && t('somm.maturity.statusReviewed')}
              {!returnedFromDeferral && profile.status === 'deferred' && t('somm.maturity.statusDeferred')}
            </span>
          )}
          <span className="somm-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Inline form ── */}
      {expanded && (
        <form className="somm-form" onSubmit={handleSave}>
          {err && <div className="alert alert-error">{err}</div>}

          {profile.status === 'deferred' && (
            <div className="somm-defer-banner">
              <div>
                <strong>
                  {returnedFromDeferral
                    ? t('somm.maturity.deferReturnedNow')
                    : (profile.deferredUntil
                      ? t('somm.maturity.deferReturnsOn', { date: formatDate(profile.deferredUntil) })
                      : t('somm.maturity.deferIndefinite'))}
                </strong>
                {profile.deferredReason && <p className="somm-defer-reason">“{profile.deferredReason}”</p>}
                {profile.deferredBy?.username && (
                  <p className="somm-defer-by">
                    {t('somm.maturity.deferredBy')} <strong>{profile.deferredBy.username}</strong>
                    {profile.deferredAt && ` · ${formatDate(profile.deferredAt)}`}
                  </p>
                )}
              </div>
              {isDeferredTab && (
                <button type="button" className="btn btn-secondary btn-small" onClick={handleReturn} disabled={returning}>
                  {returning ? t('somm.maturity.returning') : t('somm.maturity.returnToQueue')}
                </button>
              )}
            </div>
          )}

          {/* The generated tasting profile, correctable in place. A curator
              researching this wine's drink window is the person best placed to
              catch a wrong profile — before this they worked around it and the
              bad prose survived (support ticket 2026-07-28). */}
          <SommWineProfilePanel wine={wine} />

          <div className="somm-form-hint-row">
            <p className="somm-form-hint">
              {t('somm.maturity.phaseHint')}
              {isNv
                ? ` — ${t('somm.maturity.nvHint', 'non-vintage: enter years after purchase')}`
                : (!isNaN(vintageInt) ? ` (${t('somm.maturity.vintageLabel')} ${vintageInt})` : '')}
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
                  {phaseYrs(isNv, vintageInt, form.earlyFrom, form.earlyUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>{t('somm.maturity.fromLabel')}</label>
                  <input
                    type="number" min={isNv ? '0' : '1900'} max={isNv ? '100' : '2200'}
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 2) : 'Year'}
                    value={form.earlyFrom} onChange={set('earlyFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>{t('somm.maturity.untilLabel')}</label>
                  <input
                    type="number" min={isNv ? '0' : '1900'} max={isNv ? '100' : '2200'}
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
                  {phaseYrs(isNv, vintageInt, form.peakFrom, form.peakUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>{t('somm.maturity.fromLabel')}</label>
                  <input
                    type="number" min={isNv ? '0' : '1900'} max={isNv ? '100' : '2200'}
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 6) : 'Year'}
                    value={form.peakFrom} onChange={set('peakFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>{t('somm.maturity.untilLabel')}</label>
                  <input
                    type="number" min={isNv ? '0' : '1900'} max={isNv ? '100' : '2200'}
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
                  {phaseYrs(isNv, vintageInt, form.lateFrom, form.lateUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>{t('somm.maturity.fromLabel')}</label>
                  <input
                    type="number" min={isNv ? '0' : '1900'} max={isNv ? '100' : '2200'}
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 16) : 'Year'}
                    value={form.lateFrom} onChange={set('lateFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>{t('somm.maturity.untilLabel')}</label>
                  <input
                    type="number" min={isNv ? '0' : '1900'} max={isNv ? '100' : '2200'}
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 22) : 'Year'}
                    value={form.lateUntil} onChange={set('lateUntil')}
                  />
                </div>
              </div>
            </div>

          </div>{/* /.somm-phases */}

          {/* Live preview */}
          <MaturityPreview form={form} vintageInt={vintageInt} isNv={isNv} />

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
            {/* The third exit: this vintage cannot be curated because the wine
                was never released in it. Offered wherever the row is not
                already carrying a curated window. */}
            {profile.status !== 'reviewed' && (
              <button type="button" className="btn btn-secondary" onClick={() => setShowDefer(true)}>
                {profile.status === 'deferred' ? t('somm.maturity.deferEdit') : t('somm.maturity.deferAction')}
              </button>
            )}
            {tab === 'reviewed' && (
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

      {showDefer && (
        <DeferModal
          profile={profile}
          onClose={() => setShowDefer(false)}
          onDeferred={(updated) => { setShowDefer(false); onMoved(updated); }}
        />
      )}
    </div>
  );
}

// ── "Not released yet" dialog ─────────────────────────────────────────────────
// The date is prefilled from the server's own default (defaultDeferUntil on
// each row), so the rule for when a vintage plausibly exists lives in exactly
// one place — services/maturityOps.js — instead of being re-derived here.
function DeferModal({ profile, onClose, onDeferred }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [until, setUntil]     = useState(toDateInput(profile.deferredUntil || profile.defaultDeferUntil));
  const [never, setNever]     = useState(profile.status === 'deferred' && !profile.deferredUntil);
  const [reason, setReason]   = useState(profile.deferredReason || '');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const res = await deferMaturityProfile(apiFetch, profile._id, {
        deferUntil: never ? null : until,
        reason,
      });
      const data = await res.json();
      if (res.ok) onDeferred(data.profile);
      else setErr(data.error || t('somm.maturity.deferError'));
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('somm.maturity.deferTitle')} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="alert alert-error">{err}</div>}
        <p className="somm-defer-explainer">
          {t('somm.maturity.deferExplainer', { vintage: profile.vintage })}
        </p>

        <div className="form-group">
          <label htmlFor={`defer-until-${profile._id}`}>{t('somm.maturity.deferUntilLabel')}</label>
          <input
            id={`defer-until-${profile._id}`}
            type="date"
            value={until}
            disabled={never}
            onChange={(e) => setUntil(e.target.value)}
          />
          <p className="somm-year-hint">{t('somm.maturity.deferUntilHint')}</p>
        </div>

        <div className="form-group">
          <label className="somm-defer-never">
            <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
            <span>{t('somm.maturity.deferNeverLabel')}</span>
          </label>
        </div>

        <div className="form-group">
          <label htmlFor={`defer-reason-${profile._id}`}>
            {t('somm.maturity.deferReasonLabel')} <span className="somm-year-hint">{t('somm.maturity.sommNotesOptional')}</span>
          </label>
          <textarea
            id={`defer-reason-${profile._id}`}
            rows={2}
            maxLength={500}
            placeholder={t('somm.maturity.deferReasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving || (!never && !until)}>
            {saving ? t('common.saving') : t('somm.maturity.deferConfirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Live preview component ────────────────────────────────────────────────────
function MaturityPreview({ form, vintageInt, isNv }) {
  const { t } = useTranslation();
  // NV windows are per-bottle (offsets from purchase), so there's no single
  // wine-level "status today" to preview here.
  if (isNv) return null;
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
