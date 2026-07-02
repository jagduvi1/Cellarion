import { useState, useEffect, useCallback } from 'react';
import Modal from './Modal';
import WineImage from './WineImage';
import WineClusterCompareModal from './WineClusterCompareModal';
import { adminGetWineDuplicateClusters, adminMergeWine, adminDismissDuplicateCluster, adminUndismissDuplicateCluster } from '../api/admin';
import './WineModalThumbs.css';

/**
 * Registry-wide duplicate scanner for admin users. Shows clusters of
 * WineDefinitions that look like they're the same wine. Each cluster is
 * resolved with a "keep this one" pick → all other wines in the cluster
 * are merged into it (bottles reassigned, source wine deleted).
 *
 * Props:
 *   apiFetch  — from useAuth()
 *   onClose() — close the modal
 *   onMerged() — called after any successful merge so the parent can refresh
 *                its wine list count
 */
function WineDuplicatesModal({ apiFetch, onClose, onMerged }) {
  const [clusters, setClusters] = useState(null); // null = not yet scanned
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [minScore, setMinScore] = useState(0.6);
  const [meta, setMeta] = useState(null);
  const [compareCluster, setCompareCluster] = useState(null);
  const [pendingUndo, setPendingUndo] = useState(null); // last "not duplicates" action, for one-level undo

  const scan = useCallback(async (score = minScore) => {
    setScanning(true);
    setError(null);
    setPendingUndo(null);
    try {
      const res = await adminGetWineDuplicateClusters(apiFetch, { minScore: score, limit: 50 });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Scan failed');
        return;
      }
      setClusters(data.clusters || []);
      setMeta({
        scannedCount: data.scannedCount,
        producerGroupCount: data.producerGroupCount,
        totalClusters: data.totalClusters,
      });
    } catch {
      setError('Network error');
    } finally {
      setScanning(false);
    }
  }, [apiFetch, minScore]);

  // Auto-scan on open
  useEffect(() => { scan(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // After a successful merge, drop the source from its cluster. If the
  // cluster collapses to one wine, drop the whole cluster.
  const handleMerged = (sourceId) => {
    setClusters(prev => prev
      .map(c => ({ ...c, wines: c.wines.filter(w => String(w._id) !== sourceId) }))
      .filter(c => c.wines.length >= 2));
    onMerged?.();
  };

  // The compare modal merges N-1 wines into the keeper in one go and returns
  // the full list of cluster wine ids — only the keeper survives.
  const handleClusterMerged = (allClusterIds) => {
    const idSet = new Set(allClusterIds.map(String));
    setClusters(prev => prev.filter(c => !c.wines.some(w => idSet.has(String(w._id)))));
    onMerged?.();
  };

  // Stable identity for a cluster (its set of wine ids) — used to add/remove it
  // from the list without relying on array index or object reference.
  const clusterKey = (c) => c.wines.map(w => String(w._id)).sort().join(',');

  // "Not duplicates": persist the decision, drop the cluster, offer one undo.
  const handleDismiss = async (cluster) => {
    const wineIds = cluster.wines.map(w => String(w._id));
    setError(null);
    setClusters(prev => prev.filter(c => clusterKey(c) !== clusterKey(cluster))); // optimistic
    try {
      const res = await adminDismissDuplicateCluster(apiFetch, wineIds);
      if (!res.ok) throw new Error();
      setPendingUndo({ cluster, wineIds });
      setMeta(m => m ? { ...m, totalClusters: Math.max(0, (m.totalClusters || 0) - 1) } : m);
    } catch {
      setClusters(prev => [cluster, ...prev]); // restore on failure
      setError('Failed to mark as not duplicates');
    }
  };

  const handleUndo = async () => {
    if (!pendingUndo) return;
    const { cluster, wineIds } = pendingUndo;
    setPendingUndo(null);
    setClusters(prev => [cluster, ...prev]);
    setMeta(m => m ? { ...m, totalClusters: (m.totalClusters || 0) + 1 } : m);
    try { await adminUndismissDuplicateCluster(apiFetch, wineIds); } catch { /* re-scan reflects truth */ }
  };

  return (
    <Modal title="Scan registry for duplicate wines" onClose={onClose} showClose wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.9rem' }}>
          Min similarity:{' '}
          <input
            type="range"
            min="0.5" max="0.85" step="0.05"
            value={minScore}
            onChange={e => setMinScore(parseFloat(e.target.value))}
            style={{ verticalAlign: 'middle' }}
          />{' '}
          <strong>{Math.round(minScore * 100)}%</strong>
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => scan(minScore)} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Re-scan'}
        </button>
        {meta && !scanning && (
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #666)' }}>
            Scanned {meta.scannedCount} wines across {meta.producerGroupCount} producers · {meta.totalClusters} cluster{meta.totalClusters === 1 ? '' : 's'} found
          </span>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {pendingUndo && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '0.5rem 0.75rem', marginBottom: 12, borderRadius: 6,
          background: 'var(--bg-secondary, #f4f4f4)', border: '1px solid var(--border, #e5e5e5)',
          fontSize: '0.85rem',
        }}>
          <span>
            Marked <strong>{pendingUndo.cluster.wines[0]?.producer}</strong> as not duplicates — it won’t reappear in future scans.
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleUndo}
            style={{ padding: '0.25rem 0.65rem', fontSize: '0.8rem', flexShrink: 0 }}
          >
            Undo
          </button>
        </div>
      )}

      {scanning && !clusters && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
          Scanning registry… this can take a few seconds.
        </div>
      )}

      {!scanning && clusters?.length === 0 && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #888)' }}>
          No duplicate clusters at this threshold.
        </div>
      )}

      {clusters?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: 520, overflowY: 'auto' }}>
          {clusters.map((cluster) => (
            // Keyed by cluster identity, NOT index: clusters are removed on
            // merge/dismiss, and an index key would let the next cluster
            // inherit this card's state (targetId!) — enabling a merge into
            // a wine from a different cluster.
            <ClusterCard
              key={clusterKey(cluster)}
              cluster={cluster}
              apiFetch={apiFetch}
              onMerged={handleMerged}
              onOpenCompare={() => setCompareCluster(cluster)}
              onDismiss={() => handleDismiss(cluster)}
            />
          ))}
        </div>
      )}

      {compareCluster && (
        <WineClusterCompareModal
          cluster={compareCluster}
          apiFetch={apiFetch}
          onClose={() => setCompareCluster(null)}
          onMerged={handleClusterMerged}
        />
      )}
    </Modal>
  );
}

function ClusterCard({ cluster, apiFetch, onMerged, onOpenCompare, onDismiss }) {
  const [targetId, setTargetId] = useState(null);
  const [merging, setMerging] = useState(null); // sourceId being merged
  const [error, setError] = useState(null);

  // Default the target to the wine with the most bottles (heuristic: that's
  // usually the "real" entry and the others are typos that got fewer hits).
  useEffect(() => {
    if (targetId || cluster.wines.length === 0) return;
    const sorted = [...cluster.wines].sort((a, b) => (b.bottleCount || 0) - (a.bottleCount || 0));
    setTargetId(String(sorted[0]._id));
  }, [cluster, targetId]);

  const doMerge = async (sourceId) => {
    setError(null);
    setMerging(sourceId);
    try {
      const res = await adminMergeWine(apiFetch, sourceId, targetId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Merge failed (${res.status})`);
        return;
      }
      onMerged(sourceId);
    } catch {
      setError('Network error');
    } finally {
      setMerging(null);
    }
  };

  return (
    <div style={{
      border: '1px solid var(--border, #e5e5e5)',
      borderRadius: 6,
      padding: 12,
      background: 'var(--bg-secondary, #fafafa)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <strong>{cluster.wines[0]?.producer}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #888)' }}>
            {Math.round(cluster.score * 100)}% match
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onDismiss}
            disabled={!!merging}
            style={{ padding: '0.25rem 0.65rem', fontSize: '0.8rem' }}
            title="These are different wines — stop showing this cluster in future scans"
          >
            Not duplicates
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onOpenCompare}
            style={{ padding: '0.25rem 0.65rem', fontSize: '0.8rem' }}
            title="Compose the surviving wine field-by-field, then merge"
          >
            Compare &amp; merge
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 8 }}>{error}</div>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {cluster.wines.map(wine => {
          const isTarget = String(wine._id) === targetId;
          return (
            <li
              key={wine._id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0.5rem',
                borderTop: '1px solid var(--border, #eee)',
                background: isTarget ? 'var(--bg-success-faint, #f0f7f0)' : 'transparent',
              }}
            >
              <input
                type="radio"
                name={`target-${cluster.wines[0]._id}`}
                checked={isTarget}
                onChange={() => setTargetId(String(wine._id))}
                disabled={!!merging}
                title="Keep this wine"
              />
              <div style={{ width: 36, height: 48, flexShrink: 0 }}>
                <WineImage image={wine.image} alt={wine.name} wineType={wine.type} className="dup-wine-thumb" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{wine.name}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #666)' }}>
                  {wine.appellation || '—'}
                  {wine.country?.name ? ` · ${wine.country.name}` : ''}
                  {' · '}{wine.bottleCount || 0} bottle{(wine.bottleCount || 0) === 1 ? '' : 's'}
                </div>
              </div>
              {isTarget ? (
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent, #4a7c4a)' }}>
                  KEEP
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!targetId || !!merging}
                  onClick={() => doMerge(String(wine._id))}
                  style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
                >
                  {merging === String(wine._id) ? 'Merging…' : 'Merge into KEEP'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default WineDuplicatesModal;
