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

  const decide = async (kind, id, decision) => {
    let rejectReason;
    if (decision === 'reject') {
      rejectReason = window.prompt('Reason for rejecting (shown to the proposer):') || undefined;
      if (rejectReason === undefined) return; // cancelled
    }
    setBusy(id);
    setError(null);
    try {
      const fn = kind === 'key' ? decideRegistryKey : decideRegistryValue;
      const res = await fn(apiFetch, id, decision, rejectReason);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.error || 'Decision failed');
      await load();
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
              onClick={() => decide('value', v._id, 'publish')}>Publish</button>
            <button type="button" className="btn btn-small btn-danger" disabled={busy === v._id}
              onClick={() => decide('value', v._id, 'reject')}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default AdminRegistryData;
