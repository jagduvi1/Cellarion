import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Link } from 'react-router-dom';
import {
  getRegistryDataQueues, decideRegistryKey, decideRegistryValue,
} from '../api/registryData';
import './AdminRegistryData.css';

/**
 * Review the public data vocabulary (#985 Slice B): user-proposed KEYS join
 * the shared vocabulary on accept; user-suggested VALUES publish onto the
 * wine record on approve. Creating a public key is deliberately a curated
 * act — one field, one meaning, one type.
 */
function AdminRegistryData() {
  const { apiFetch } = useAuth();
  const [keys, setKeys] = useState([]);
  const [values, setValues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getRegistryDataQueues(apiFetch);
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to load queues');
      setKeys(data.keys || []);
      setValues(data.values || []);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  // opts.asWineDefault: publish a vintage-slotted suggestion as the wine-wide
  // default instead — the reviewer's call when the evidence is plainly the
  // producer's general spec and the suggester left the (safer) vintage
  // default selected.
  const decide = async (kind, id, decision, opts = {}) => {
    let rejectReason;
    if (decision === 'reject') {
      // null = Cancel; '' = OK with no text — a reason is optional, so an
      // empty OK must still send the rejection (audit: `|| undefined` made
      // the Reject button silently dead without a typed reason).
      const answer = window.prompt('Reason for rejecting (optional, shown to the proposer):');
      if (answer === null) return; // cancelled
      rejectReason = answer.trim() || undefined;
    }
    setBusy(id);
    setError(null);
    try {
      const res = kind === 'key'
        ? await decideRegistryKey(apiFetch, id, decision, rejectReason)
        : await decideRegistryValue(apiFetch, id, decision, rejectReason, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.error || 'Decision failed');
      // The server returned the decided row — drop it locally instead of
      // refetching both full queues per click (audit: O(N²) queue clearing).
      if (kind === 'key') setKeys((prev) => prev.filter((k) => k._id !== id));
      else setValues((prev) => prev.filter((v) => v._id !== id));
    } catch {
      setError('Network error.');
    } finally {
      setBusy(null);
    }
  };

  const typeLabel = (k) =>
    k.type + (k.unit ? ` (${k.unit})` : '') + (k.enumOptions?.length ? `: ${k.enumOptions.join(' / ')}` : '');

  return (
    <div className="admin-registry-data">
      <h1>Registry Data Vocabulary</h1>
      <p className="ard-intro">
        Users propose public data fields and suggest values; nothing reaches the shared record without a decision
        here. Accepting a key makes it available on <strong>every</strong> wine — one field, one meaning, one type.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {loading && <p>Loading…</p>}

      <h2>Proposed keys ({keys.length})</h2>
      {!loading && keys.length === 0 && <p className="ard-empty">No keys awaiting review.</p>}
      {keys.map((k) => (
        <div key={k._id} className="ard-card">
          <div className="ard-card-main">
            <span className="ard-name">{k.name}</span>
            <span className="ard-type">{typeLabel(k)}</span>
            <p className="ard-rationale">{k.rationale}</p>
            <span className="ard-meta">
              proposed by {k.proposedBy?.displayName || k.proposedBy?.username || 'unknown'}
              {k.proposedBy?.contribution?.tier ? ` · ${k.proposedBy.contribution.tier}` : ''}
            </span>
          </div>
          <div className="ard-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={busy === k._id}
              onClick={() => decide('key', k._id, 'accept')}>Accept</button>
            <button type="button" className="btn btn-small btn-danger" disabled={busy === k._id}
              onClick={() => decide('key', k._id, 'reject')}>Reject</button>
          </div>
        </div>
      ))}

      <h2>Suggested values ({values.length})</h2>
      {!loading && values.length === 0 && <p className="ard-empty">No values awaiting review.</p>}
      {values.map((v) => (
        <div key={v._id} className="ard-card">
          <div className="ard-card-main">
            <span className="ard-name">
              {v.key?.name}: <strong>{String(v.value)}</strong>{v.key?.unit ? ` ${v.key.unit}` : ''}
            </span>
            {/* The slot. A vintage row also shows what the wine says for
                every other year, or that it says nothing yet — the reviewer
                decides whether this first figure should seed the default. */}
            <span className="ard-slot">
              {v.vintage ? (
                <>
                  for the <strong>{v.vintage}</strong> vintage
                  {' · '}
                  {v.wineDefault !== null && v.wineDefault !== undefined
                    ? <>wine-wide today: {String(v.wineDefault)}{v.key?.unit ? ` ${v.key.unit}` : ''}</>
                    : <em>no wine-wide value yet</em>}
                </>
              ) : 'all vintages'}
            </span>
            <span className="ard-type">
              {v.wineDefinition
                ? <Link to={`/wines/${v.wineDefinition.slug || v.wineDefinition._id}`}>
                    {(v.wineDefinition.producer ? `${v.wineDefinition.producer} — ` : '') + v.wineDefinition.name}
                  </Link>
                : 'unknown wine'}
            </span>
            {v.reason && <p className="ard-rationale">“{v.reason}”</p>}
            {v.evidenceUrl && (
              <a className="ard-evidence" href={v.evidenceUrl} target="_blank" rel="noreferrer noopener">
                {v.evidenceUrl}
              </a>
            )}
            <span className="ard-meta">
              suggested by {v.suggestedBy?.displayName || v.suggestedBy?.username || 'unknown'}
              {v.suggestedBy?.contribution?.tier ? ` · ${v.suggestedBy.contribution.tier}` : ''}
            </span>
          </div>
          <div className="ard-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={busy === v._id}
              onClick={() => decide('value', v._id, 'publish')}>
              {v.vintage ? `Publish for ${v.vintage}` : 'Publish'}
            </button>
            {v.vintage && (
              <button type="button" className="btn btn-small" disabled={busy === v._id}
                title="The evidence is the producer's general spec, not a one-year figure — publish it for every vintage instead"
                onClick={() => decide('value', v._id, 'publish', { asWineDefault: true })}>
                Publish as wine default
              </button>
            )}
            <button type="button" className="btn btn-small btn-danger" disabled={busy === v._id}
              onClick={() => decide('value', v._id, 'reject')}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default AdminRegistryData;
