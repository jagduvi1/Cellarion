import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './SommMaturity.css';

const CURRENT_YEAR = new Date().getFullYear();

// Compute current maturity phase from 6-field profile
function getMaturityPhase(p) {
  if (!p || p.status !== 'reviewed') return null;
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = p;
  if (!earlyFrom) return null;

  if (CURRENT_YEAR < earlyFrom)                              return { cls: 'not-ready', label: `Not yet mature — from ${earlyFrom}` };
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
  const { token } = useAuth();
  const [profiles, setProfiles] = useState([]);
  const [tab, setTab] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/somm/maturity?status=${tab}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) setProfiles(data.profiles);
      else setError(data.error || 'Failed to load profiles');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [token, tab]);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const handleSaved  = (updated) => setProfiles(prev => prev.filter(p => p._id !== updated._id));
  const handleReset  = (updated) => setProfiles(prev => prev.filter(p => p._id !== updated._id));

  return (
    <div className="somm-page">
      <div className="page-header">
        <h1>Maturity Queue</h1>
        <p className="somm-subtitle">
          Set aging windows for wine vintages so users can see peak drinking status.
        </p>
      </div>

      <div className="somm-tabs">
        <button className={`somm-tab ${tab === 'pending'  ? 'active' : ''}`} onClick={() => setTab('pending')}>
          Pending review
        </button>
        <button className={`somm-tab ${tab === 'reviewed' ? 'active' : ''}`} onClick={() => setTab('reviewed')}>
          Reviewed
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading profiles…</div>
      ) : profiles.length === 0 ? (
        <div className="somm-empty">
          {tab === 'pending' ? 'No vintages awaiting review. Great work!' : 'No reviewed profiles yet.'}
        </div>
      ) : (
        <div className="somm-list">
          {profiles.map(profile => (
            <ProfileCard
              key={profile._id}
              profile={profile}
              token={token}
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
function ProfileCard({ profile, token, isPending, onSaved, onReset }) {
  const wine       = profile.wineDefinition;
  const vintageInt = parseInt(profile.vintage);

  const [expanded,  setExpanded]  = useState(isPending);
  const [saving,    setSaving]    = useState(false);
  const [resetting, setResetting] = useState(false);
  const [err,       setErr]       = useState(null);

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

      const res = await fetch(`/api/somm/maturity/${profile._id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    if (!window.confirm('Reset this profile back to pending?')) return;
    setResetting(true);
    try {
      const res = await fetch(`/api/somm/maturity/${profile._id}/reset`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) onReset(data.profile);
      else alert(data.error || 'Failed to reset');
    } catch {
      alert('Network error');
    } finally {
      setResetting(false);
    }
  };

  const phase = getMaturityPhase(profile);

  return (
    <div className={`somm-card ${expanded ? 'expanded' : ''}`}>
      {/* ── Card header (click to expand) ── */}
      <div className="somm-card-header" onClick={() => setExpanded(o => !o)}>
        <div className="somm-card-identity">
          {wine?.image ? (
            <img src={wine.image} alt={wine?.name} className="somm-wine-thumb"
              onError={e => { e.target.style.display = 'none'; }} />
          ) : (
            <div className={`somm-wine-thumb-placeholder ${wine?.type || 'red'}`} />
          )}
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
              {profile.status === 'pending' ? 'Pending' : 'Reviewed'}
            </span>
          )}
          <span className="somm-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Inline form ── */}
      {expanded && (
        <form className="somm-form" onSubmit={handleSave}>
          {err && <div className="alert alert-error">{err}</div>}

          <p className="somm-form-hint">
            Enter calendar years for each drinking phase. Leave a phase blank if it doesn't apply.
            {!isNaN(vintageInt) && ` (Vintage: ${vintageInt})`}
          </p>

          {/* ── Phase rows ── */}
          <div className="somm-phases">

            {/* Phase 1 — Early drinking */}
            <div className="somm-phase-row">
              <div className="somm-phase-label somm-phase-label--early">
                <span className="somm-phase-name">Early drinking</span>
                <span className="somm-phase-yrs">
                  {yearsFromVintage(vintageInt, form.earlyFrom, form.earlyUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>From</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 2) : 'Year'}
                    value={form.earlyFrom} onChange={set('earlyFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>Until</label>
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
                <span className="somm-phase-name">Optimal maturity ⭐</span>
                <span className="somm-phase-yrs">
                  {yearsFromVintage(vintageInt, form.peakFrom, form.peakUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>From</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 6) : 'Year'}
                    value={form.peakFrom} onChange={set('peakFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>Until</label>
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
                <span className="somm-phase-name">Late maturity</span>
                <span className="somm-phase-yrs">
                  {yearsFromVintage(vintageInt, form.lateFrom, form.lateUntil)}
                </span>
              </div>
              <div className="somm-phase-inputs">
                <div className="somm-range-field">
                  <label>From</label>
                  <input
                    type="number" min="1900" max="2200"
                    placeholder={!isNaN(vintageInt) ? String(vintageInt + 16) : 'Year'}
                    value={form.lateFrom} onChange={set('lateFrom')}
                  />
                </div>
                <span className="somm-range-dash">—</span>
                <div className="somm-range-field">
                  <label>Until</label>
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
            <label>Sommelier notes <span className="somm-year-hint">(optional)</span></label>
            <textarea
              rows={3}
              placeholder="Tasting notes, aging potential, drinking recommendations…"
              value={form.sommNotes}
              onChange={set('sommNotes')}
            />
          </div>

          {profile.setBy && (
            <p className="somm-set-by">
              Last reviewed by <strong>{profile.setBy.username}</strong>
              {profile.setAt && ` on ${new Date(profile.setAt).toLocaleDateString()}`}
            </p>
          )}

          <div className="somm-form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Mark as reviewed'}
            </button>
            {!isPending && (
              <button type="button" className="btn btn-secondary" onClick={handleReset} disabled={resetting}>
                {resetting ? 'Resetting…' : 'Reset to pending'}
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

// ── Live preview component ────────────────────────────────────────────────────
function MaturityPreview({ form, vintageInt }) {
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
      <span className="somm-preview-label">Status today ({CURRENT_YEAR}):</span>
      <span className={`maturity-badge maturity-badge--${phase.cls}`}>{phase.label}</span>
    </div>
  );
}

export default SommMaturity;
