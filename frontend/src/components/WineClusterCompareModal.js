import { useState, useEffect, useMemo } from 'react';
import Modal from './Modal';
import WineImage from './WineImage';
import { adminGetWine, adminSaveWine, adminMergeCluster } from '../api/admin';
import './WineModalThumbs.css';

/**
 * "Golden record" cluster merge.
 *
 * Transposed diff table: fields are ROWS, the cluster's wines are COLUMNS, plus
 * a "result" column. The admin composes the surviving wine by picking the best
 * value per field (click a cell), picks which photo survives, and sees an
 * "after merge" preview. Differing cells are flagged; rows where every wine
 * agrees are dimmed so attention goes to the real conflicts.
 *
 * On commit: the composed values are saved onto the keeper (PUT), then the
 * other wines are absorbed into it via the atomic, field-aware merge endpoint
 * (which also applies the chosen surviving image).
 */
const wid = (w) => String(w._id);
const countryId = (w) => w?.country?._id || w?.country || null;
const regionId = (w) => w?.region?._id || w?.region || null;
const grapeIds = (w) => (w?.grapes || []).map(g => g._id || g);

const FIELDS = [
  { key: 'name',        label: 'Name',        show: w => w.name || '—' },
  { key: 'producer',    label: 'Producer',    show: w => w.producer || '—' },
  { key: 'type',        label: 'Type',        show: w => w.type || 'red' },
  { key: 'appellation', label: 'Appellation', show: w => w.appellation || '—' },
  { key: 'country',     label: 'Country',     show: w => w.country?.name || '—' },
  { key: 'region',      label: 'Region',      show: w => w.region?.name || '—' },
  { key: 'grapes',      label: 'Grapes',      show: w => (w.grapes || []).map(g => g.name || g).join(', ') || '—' },
];

function WineClusterCompareModal({ cluster, apiFetch, onClose, onMerged }) {
  const [wines, setWines] = useState(null);
  const [keeperId, setKeeperId] = useState(null);
  const [picks, setPicks] = useState({});       // { [fieldKey | 'image']: wineId }
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fullWines = await Promise.all(cluster.wines.map(w =>
          adminGetWine(apiFetch, String(w._id))
            .then(r => r.json())
            .then(d => ({ ...(d.wine || d), bottleCount: w.bottleCount || 0 }))
        ));
        if (cancelled) return;
        setWines(fullWines);
        // Keeper defaults to the most-used (canonical) entry.
        const keeper = [...fullWines].sort((a, b) => (b.bottleCount || 0) - (a.bottleCount || 0))[0];
        const kid = wid(keeper);
        setKeeperId(kid);
        // Every field defaults to the keeper's value; the admin overrides per
        // field where a duplicate has cleaner data. Image defaults to the first
        // wine that actually has one (preferring the keeper).
        const imgWine = (keeper.image ? keeper : fullWines.find(w => w.image)) || keeper;
        const init = { image: wid(imgWine) };
        for (const f of FIELDS) init[f.key] = kid;
        setPicks(init);
      } catch {
        if (!cancelled) setError('Failed to load wine details');
      }
    })();
    return () => { cancelled = true; };
  }, [cluster, apiFetch]);

  const byId = useMemo(() => {
    const m = {};
    (wines || []).forEach(w => { m[wid(w)] = w; });
    return m;
  }, [wines]);

  const pickWine = (fieldKey, wineId) => {
    setPicks(p => ({ ...p, [fieldKey]: wineId }));
    setConfirming(false);
  };

  const keeper = keeperId ? byId[keeperId] : null;
  const totalBottles = (wines || []).reduce((sum, w) => sum + (w.bottleCount || 0), 0);

  const doMerge = async () => {
    if (!keeper) return;
    setMerging(true);
    setError(null);
    try {
      const pick = (key) => byId[picks[key]] || keeper;
      const composed = {
        name: pick('name').name,
        producer: pick('producer').producer,
        type: pick('type').type || 'red',
        appellation: pick('appellation').appellation || '',
        country: countryId(pick('country')) || countryId(keeper),
        region: regionId(pick('region')),
        grapes: grapeIds(pick('grapes')),
      };
      const saveRes = await adminSaveWine(apiFetch, composed, keeperId);
      const saveData = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) { setError(saveData.error || `Failed to update the keeper (${saveRes.status})`); setMerging(false); return; }

      const sourceIds = wines.filter(w => wid(w) !== keeperId).map(wid);
      const mergeRes = await adminMergeCluster(apiFetch, { keeperId, sourceIds, imageFromWineId: picks.image });
      const mergeData = await mergeRes.json().catch(() => ({}));
      if (!mergeRes.ok) { setError(mergeData.error || `Merge failed (${mergeRes.status})`); setMerging(false); return; }

      onMerged?.(cluster.wines.map(w => String(w._id)), { keeperId, ...mergeData });
      onClose();
    } catch {
      setError('Network error during merge');
      setMerging(false);
    }
  };

  if (error && !wines) {
    return <Modal title="Compare & merge" onClose={onClose} showClose wide><div className="alert alert-error">{error}</div></Modal>;
  }
  if (!wines) {
    return (
      <Modal title="Compare & merge" onClose={onClose} showClose wide>
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>Loading…</div>
      </Modal>
    );
  }

  const C = { border: '1px solid var(--border, #e5e5e5)', pad: '7px 10px' };
  const accent = 'var(--accent, #4a7c4a)';
  const warnBg = 'var(--bg-warning-faint, #fdf6e3)';

  return (
    <Modal title={`Compare & merge — ${wines.length} wines`} onClose={onClose} showClose
           boxStyle={{ maxWidth: 'min(96vw, 1100px)', width: 'min(96vw, 1100px)' }}>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary, #666)' }}>
        Pick the keeper, then click the best value for each field to compose the surviving wine.
        <strong> Conflicting values are highlighted</strong>; fields everyone agrees on are dimmed.
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left', minWidth: 90 }}>Field</th>
              {wines.map(w => {
                const id = wid(w);
                const isKeeper = id === keeperId;
                return (
                  <th key={id} style={{ ...thStyle, background: isKeeper ? 'var(--bg-success-faint, #f0f7f0)' : undefined, borderBottom: isKeeper ? `2px solid ${accent}` : thStyle.borderBottom }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="radio" name="keeper" checked={isKeeper} disabled={merging} onChange={() => { setKeeperId(id); setConfirming(false); }} />
                      <span style={{ fontWeight: isKeeper ? 700 : 500, color: isKeeper ? accent : 'inherit' }}>{isKeeper ? 'KEEP' : 'keep'}</span>
                      <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-secondary, #888)' }}>{w.bottleCount || 0} btl</span>
                    </label>
                  </th>
                );
              })}
              <th style={{ ...thStyle, minWidth: 150, color: accent }}>Result</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(f => {
              const vals = wines.map(f.show);
              const allSame = vals.every(v => v === vals[0]);
              const pickedId = picks[f.key];
              const pickedVal = f.show(byId[pickedId] || keeper);
              return (
                <tr key={f.key} style={{ opacity: allSame ? 0.55 : 1 }}>
                  <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--text-secondary, #555)' }}>{f.label}{!allSame && <span title="values differ" style={{ color: 'var(--warning, #b8860b)' }}> ⚠</span>}</td>
                  {wines.map((w, i) => {
                    const id = wid(w);
                    const isPicked = id === pickedId;
                    const differs = !allSame && vals[i] !== pickedVal;
                    return (
                      <td key={id} style={{ ...tdStyle, padding: 0 }}>
                        <button
                          type="button"
                          onClick={() => pickWine(f.key, id)}
                          disabled={merging}
                          title={isPicked ? 'Winning value' : 'Use this value'}
                          style={{
                            width: '100%', height: '100%', textAlign: 'left', cursor: 'pointer',
                            padding: C.pad, border: 'none', font: 'inherit',
                            background: isPicked ? 'var(--bg-success-faint, #eef6ee)' : (differs ? warnBg : 'transparent'),
                            boxShadow: isPicked ? `inset 3px 0 0 ${accent}` : 'none',
                            color: 'inherit',
                          }}
                        >
                          {isPicked ? '● ' : ''}{vals[i]}
                        </button>
                      </td>
                    );
                  })}
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{pickedVal}</td>
                </tr>
              );
            })}

            {/* Image row */}
            <tr>
              <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--text-secondary, #555)' }}>Photo</td>
              {wines.map(w => {
                const id = wid(w);
                const isPicked = picks.image === id;
                return (
                  <td key={id} style={{ ...tdStyle, textAlign: 'center', padding: 4 }}>
                    <button type="button" onClick={() => pickWine('image', id)} disabled={merging}
                      title={w.image ? (isPicked ? 'Surviving photo' : 'Keep this photo') : 'No photo'}
                      style={{ border: isPicked ? `2px solid ${accent}` : '2px solid transparent', borderRadius: 6, padding: 2, background: 'none', cursor: w.image ? 'pointer' : 'default' }}>
                      <WineImage image={w.image} alt={w.name} wineType={w.type} className="compare-wine-thumb" placeholder="compare-wine-placeholder" />
                    </button>
                  </td>
                );
              })}
              <td style={{ ...tdStyle, textAlign: 'center' }}>
                <WineImage image={(byId[picks.image] || {}).image} alt="result" wineType={keeper?.type} className="compare-wine-thumb" placeholder="compare-wine-placeholder" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* After-merge preview + actions */}
      <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-secondary, #fafafa)', borderRadius: 6, fontSize: '0.85rem' }}>
        <strong>After merge:</strong>{' '}
        “{f0(byId[picks.name], 'name', keeper)}” — {f0(byId[picks.producer], 'producer', keeper)}
        {f0(byId[picks.appellation], 'appellation', keeper) ? `, ${f0(byId[picks.appellation], 'appellation', keeper)}` : ''}
        {`, ${grapeIds(byId[picks.grapes] || keeper).length} grape(s)`}
        {`, ${totalBottles} bottle(s)`}
        {`, ${(byId[picks.image] || {}).image ? '1 photo' : 'no photo'}`}.
      </div>

      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {confirming ? (
          <>
            <span style={{ marginRight: 'auto', fontSize: '0.85rem', color: 'var(--danger, #c0392b)' }}>
              Delete {wines.length - 1} wine{wines.length - 1 === 1 ? '' : 's'} and move {totalBottles} bottle(s) into “{keeper?.name}”. This can’t be undone.
            </span>
            <button type="button" className="btn" disabled={merging} onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={merging} onClick={doMerge}>
              {merging ? 'Merging…' : 'Confirm merge'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={merging} onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={merging || wines.length < 2 || !keeperId} onClick={() => setConfirming(true)}>
              Merge {wines.length - 1} into keeper
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// value of field `key` from a wine, falling back to the keeper
function f0(wine, key, keeper) {
  const w = wine || keeper || {};
  return (w[key] || '').toString();
}

const thStyle = { border: '1px solid var(--border, #e5e5e5)', padding: '7px 10px', textAlign: 'center', background: 'var(--bg-secondary, #f7f7f7)', position: 'sticky', top: 0, verticalAlign: 'bottom' };
const tdStyle = { border: '1px solid var(--border, #e5e5e5)', padding: '7px 10px', verticalAlign: 'middle' };

export default WineClusterCompareModal;
