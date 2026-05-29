import { useState, useEffect, useCallback } from 'react';
import Modal from './Modal';
import WineImage from './WineImage';
import GrapePicker from './GrapePicker';
import {
  adminGetWine, adminSaveWine, adminMergeWine, adminGetGrapes,
} from '../api/admin';
import { WINE_TYPES } from '../config/wineTypes';
import './WineModalThumbs.css';

/**
 * Side-by-side comparison of every wine in a duplicate cluster, with inline
 * editing of the simple fields (name, producer, type, appellation, grapes).
 *
 * Country/region aren't editable here — if those genuinely differ across the
 * cluster, the wines probably shouldn't be merged at all. Image is shown
 * read-only (it survives via the merge endpoint's image-consolidation logic).
 *
 * Workflow:
 *   1. Tidy up data on whichever wines need it (Save per column).
 *   2. Pick the keeper.
 *   3. "Merge others into KEEP" — calls the merge endpoint for each non-keeper.
 */
function WineClusterCompareModal({ cluster, apiFetch, onClose, onMerged }) {
  const [wines, setWines] = useState(null);
  const [edits, setEdits] = useState({});      // { wineId: { name, producer, type, appellation, grapes: [id] } }
  const [saving, setSaving] = useState({});    // { wineId: bool }
  const [savedMsg, setSavedMsg] = useState({});// { wineId: 'Saved' | error string }
  const [grapesList, setGrapesList] = useState([]);
  const [keeperId, setKeeperId] = useState(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Hydrate each cluster wine to its full form (grapes populated, etc).
        // The cluster summary from /duplicate-clusters only carries a thin
        // projection — we need the rest for the editable form.
        const [fullWines, grapesRes] = await Promise.all([
          Promise.all(cluster.wines.map(w =>
            adminGetWine(apiFetch, String(w._id))
              .then(r => r.json())
              .then(d => ({ ...(d.wine || d), bottleCount: w.bottleCount }))
          )),
          adminGetGrapes(apiFetch).then(r => r.json()),
        ]);
        if (cancelled) return;

        setWines(fullWines);
        setGrapesList(Array.isArray(grapesRes) ? grapesRes : (grapesRes.grapes || []));

        const initEdits = {};
        for (const w of fullWines) {
          initEdits[String(w._id)] = {
            name: w.name || '',
            producer: w.producer || '',
            appellation: w.appellation || '',
            type: w.type || 'red',
            grapes: (w.grapes || []).map(g => g._id || g),
          };
        }
        setEdits(initEdits);

        const sorted = [...fullWines].sort((a, b) => (b.bottleCount || 0) - (a.bottleCount || 0));
        setKeeperId(String(sorted[0]._id));
      } catch (err) {
        if (!cancelled) setError('Failed to load wine details');
      }
    })();
    return () => { cancelled = true; };
  }, [cluster, apiFetch]);

  const updateEdit = (wineId, patch) => {
    setEdits(prev => ({ ...prev, [wineId]: { ...prev[wineId], ...patch } }));
    setSavedMsg(prev => ({ ...prev, [wineId]: null }));
  };

  const isDirty = useCallback((wineId) => {
    const wine = wines?.find(w => String(w._id) === wineId);
    if (!wine || !edits[wineId]) return false;
    const e = edits[wineId];
    if ((wine.name || '') !== e.name) return true;
    if ((wine.producer || '') !== e.producer) return true;
    if ((wine.appellation || '') !== e.appellation) return true;
    if ((wine.type || 'red') !== e.type) return true;
    const orig = (wine.grapes || []).map(g => String(g._id || g)).sort().join(',');
    const next = (e.grapes || []).map(String).sort().join(',');
    return orig !== next;
  }, [wines, edits]);

  const saveOne = async (wineId) => {
    setSaving(s => ({ ...s, [wineId]: true }));
    setSavedMsg(prev => ({ ...prev, [wineId]: null }));
    try {
      const res = await adminSaveWine(apiFetch, edits[wineId], wineId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSavedMsg(prev => ({ ...prev, [wineId]: data.error || `Save failed (${res.status})` }));
        return;
      }
      const updated = data.wine || data;
      setWines(ws => ws.map(w => String(w._id) === wineId ? { ...updated, bottleCount: w.bottleCount } : w));
      setSavedMsg(prev => ({ ...prev, [wineId]: 'Saved' }));
    } catch {
      setSavedMsg(prev => ({ ...prev, [wineId]: 'Network error' }));
    } finally {
      setSaving(s => ({ ...s, [wineId]: false }));
    }
  };

  const mergeOthersIntoKeeper = async () => {
    if (!keeperId) return;
    setMerging(true);
    setError(null);
    try {
      const sources = wines.filter(w => String(w._id) !== keeperId);
      for (const source of sources) {
        const res = await adminMergeWine(apiFetch, String(source._id), keeperId);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(`Merge of "${source.name}" failed: ${data.error || res.status}`);
          setMerging(false);
          return;
        }
      }
      onMerged?.(cluster.wines.map(w => String(w._id)));
      onClose();
    } catch {
      setError('Network error during merge');
      setMerging(false);
    }
  };

  if (error && !wines) {
    return (
      <Modal title="Compare cluster" onClose={onClose} showClose wide>
        <div className="alert alert-error">{error}</div>
      </Modal>
    );
  }

  if (!wines) {
    return (
      <Modal title="Compare cluster" onClose={onClose} showClose wide>
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
          Loading…
        </div>
      </Modal>
    );
  }

  const someDirty = wines.some(w => isDirty(String(w._id)));

  return (
    <Modal title={`Compare ${wines.length} wines`} onClose={onClose} showClose wide>
      <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: 'var(--text-secondary, #666)' }}>
        Edit any field where one entry has cleaner data, save that wine, then pick the keeper and merge.
        Country/region aren't editable here — if they really differ these probably aren't duplicates.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
        {wines.map(wine => {
          const id = String(wine._id);
          const e = edits[id] || {};
          const isKeeper = id === keeperId;
          const dirty = isDirty(id);
          return (
            <div
              key={id}
              style={{
                minWidth: 280,
                flex: '1 1 280px',
                border: isKeeper ? '2px solid var(--accent, #4a7c4a)' : '1px solid var(--border, #e5e5e5)',
                background: isKeeper ? 'var(--bg-success-faint, #f0f7f0)' : 'var(--bg-secondary, #fafafa)',
                borderRadius: 6,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                  <input
                    type="radio"
                    name="cluster-keeper"
                    checked={isKeeper}
                    onChange={() => setKeeperId(id)}
                    disabled={merging}
                  />
                  {isKeeper ? 'KEEP THIS' : 'Keep this'}
                </label>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #888)' }}>
                  {wine.bottleCount || 0} bottle{(wine.bottleCount || 0) === 1 ? '' : 's'}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
                <WineImage
                  image={wine.image}
                  alt={wine.name}
                  wineType={wine.type}
                  className="compare-wine-thumb"
                  placeholder="compare-wine-placeholder"
                />
              </div>

              <Field label="Name">
                <input type="text" value={e.name} onChange={ev => updateEdit(id, { name: ev.target.value })} />
              </Field>
              <Field label="Producer">
                <input type="text" value={e.producer} onChange={ev => updateEdit(id, { producer: ev.target.value })} />
              </Field>
              <Field label="Type">
                <select value={e.type} onChange={ev => updateEdit(id, { type: ev.target.value })}>
                  {WINE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Appellation">
                <input type="text" value={e.appellation} onChange={ev => updateEdit(id, { appellation: ev.target.value })} />
              </Field>
              <Field label="Country">
                <ReadOnly value={wine.country?.name || '—'} />
              </Field>
              <Field label="Region">
                <ReadOnly value={wine.region?.name || '—'} />
              </Field>
              <Field label={`Grapes${e.grapes.length ? ` (${e.grapes.length})` : ''}`}>
                <GrapePicker
                  grapes={grapesList}
                  selected={e.grapes}
                  onChange={(ids) => updateEdit(id, { grapes: ids })}
                />
              </Field>

              <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!dirty || saving[id] || merging}
                  onClick={() => saveOne(id)}
                  style={{ flex: 1 }}
                >
                  {saving[id] ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
                </button>
              </div>
              {savedMsg[id] && (
                <div style={{ fontSize: '0.75rem', color: savedMsg[id] === 'Saved' ? 'var(--accent, #4a7c4a)' : 'var(--danger, #c0392b)' }}>
                  {savedMsg[id]}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #666)' }}>
          {someDirty && '⚠ Save your edits before merging.'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" disabled={merging} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!keeperId || merging || someDirty || wines.length < 2}
            onClick={mergeOthersIntoKeeper}
            title={someDirty ? 'Save edits first' : 'Merge all other wines into the keeper'}
          >
            {merging ? 'Merging…' : `Merge ${wines.length - 1} into KEEP`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: '0.75rem', color: 'var(--text-secondary, #666)' }}>
      {label}
      {children}
    </label>
  );
}

function ReadOnly({ value }) {
  return (
    <div style={{
      fontSize: '0.85rem',
      color: 'var(--text-primary, #222)',
      padding: '4px 6px',
      background: 'var(--bg, #fff)',
      border: '1px dashed var(--border, #ddd)',
      borderRadius: 3,
    }}>{value}</div>
  );
}

export default WineClusterCompareModal;
