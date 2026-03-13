import { bytes, num, useApi } from './helpers';

export default function TabDatabase() {
  const { data, loading, error, reload } = useApi('/api/superadmin/mongodb');

  if (loading) return <div className="sa-loading">Reading MongoDB stats...</div>;
  if (error) return <div className="sa-error">Error: {error}</div>;
  if (!data) return null;

  return (
    <>
      <div className="sa-grid-2" style={{ marginBottom: 16 }}>
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Database: {data.database}</span>
            <button className="sa-btn" onClick={reload}>Refresh</button>
          </div>
          <div className="sa-panel-body">
            <div className="sa-kv">
              <div className="sa-kv-row">
                <span className="sa-kv-key">Total documents</span>
                <span className="sa-kv-val accent">{num(data.objects)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Collections</span>
                <span className="sa-kv-val">{num(data.collections)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Data size</span>
                <span className="sa-kv-val">{bytes(data.dataSize)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Storage size</span>
                <span className="sa-kv-val">{bytes(data.storageSize)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Index size</span>
                <span className="sa-kv-val">{bytes(data.indexSize)}</span>
              </div>
              <div className="sa-kv-row">
                <span className="sa-kv-key">Avg object size</span>
                <span className="sa-kv-val">{bytes(data.avgObjSize)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Storage breakdown bar */}
        <div className="sa-panel">
          <div className="sa-panel-header"><span className="sa-panel-title">Storage Breakdown</span></div>
          <div className="sa-panel-body">
            {data.collectionStats?.slice(0, 8).map(col => {
              const pct = data.storageSize > 0 ? Math.round((col.storageSize / data.storageSize) * 100) : 0;
              return (
                <div key={col.name} style={{ marginBottom: 10 }}>
                  <div className="sa-bar-label">
                    <span>{col.name}</span>
                    <span>{num(col.count)} docs · {bytes(col.storageSize)} ({pct}%)</span>
                  </div>
                  <div className="sa-bar-track">
                    <div className="sa-bar-fill" style={{ width: `${pct}%`, background: 'var(--sa-accent2)' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Per-collection table */}
      <div className="sa-panel">
        <div className="sa-panel-header"><span className="sa-panel-title">Collections</span></div>
        <div className="sa-panel-body">
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Documents</th>
                  <th>Data Size</th>
                  <th>Storage Size</th>
                  <th>Avg Doc</th>
                  <th>Indexes</th>
                  <th>Index Size</th>
                </tr>
              </thead>
              <tbody>
                {(data.collectionStats || []).map(col => (
                  <tr key={col.name}>
                    <td style={{ color: 'var(--sa-accent2)' }}>{col.name}</td>
                    <td>{num(col.count)}</td>
                    <td>{bytes(col.size)}</td>
                    <td>{bytes(col.storageSize)}</td>
                    <td>{bytes(col.avgObjSize)}</td>
                    <td>{col.nindexes}</td>
                    <td>{bytes(col.totalIndexSize)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
