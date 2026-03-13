import { bytes, num, fmtDate, StatusDot, BarFill, useApi } from './helpers';

export default function TabServices() {
  const { data, loading, error, reload } = useApi('/api/superadmin/services');
  const { data: procData, reload: reloadProc } = useApi('/api/superadmin/process');

  const handleReload = () => { reload(); reloadProc(); };

  if (loading) return <div className="sa-loading">Pinging services...</div>;
  if (error) return <div className="sa-error">Error: {error}</div>;
  if (!data) return null;

  const services = [
    {
      key: 'mongodb',
      name: 'MongoDB',
      status: data.mongodb?.status,
      detail: data.mongodb?.latencyMs != null ? `${data.mongodb.latencyMs}ms` : data.mongodb?.error,
    },
    {
      key: 'meilisearch',
      name: 'Meilisearch',
      status: data.meilisearch?.status,
      detail: data.meilisearch?.latencyMs != null ? `${data.meilisearch.latencyMs}ms` : data.meilisearch?.error,
    },
    {
      key: 'rembg',
      name: 'rembg (BG Removal)',
      status: data.rembg?.status,
      detail: data.rembg?.latencyMs != null ? `${data.rembg.latencyMs}ms` : data.rembg?.error,
    },
    {
      key: 'qdrant',
      name: 'Qdrant',
      status: data.qdrant?.status,
      detail: data.qdrant?.status === 'not_configured'
        ? 'QDRANT_URL not set'
        : data.qdrant?.latencyMs != null ? `${data.qdrant.latencyMs}ms` : data.qdrant?.error,
    },
  ];

  const meiliStats = data.meilisearchStats;

  return (
    <>
      <div className="sa-services-grid">
        {services.map(s => (
          <div key={s.key} className="sa-service">
            <StatusDot status={s.status} />
            <div>
              <div className="sa-service-name">{s.name}</div>
              <div className="sa-service-status">{s.status || '—'}</div>
              {s.detail && <div className="sa-service-latency">{s.detail}</div>}
            </div>
          </div>
        ))}

        {/* Anthropic */}
        <div className="sa-service">
          <StatusDot status={data.anthropic?.configured ? 'ok' : 'not_configured'} />
          <div>
            <div className="sa-service-name">Anthropic API</div>
            <div className="sa-service-status">{data.anthropic?.configured ? 'Configured' : 'Not configured'}</div>
            {data.anthropic?.keyPrefix && (
              <div className="sa-service-latency">{data.anthropic.keyPrefix}</div>
            )}
          </div>
        </div>

        {/* Voyage AI */}
        <div className="sa-service">
          <StatusDot status={data.voyageAI?.configured ? 'ok' : 'not_configured'} />
          <div>
            <div className="sa-service-name">Voyage AI</div>
            <div className="sa-service-status">{data.voyageAI?.configured ? 'Configured' : 'Not configured'}</div>
            {data.voyageAI?.keyPrefix && (
              <div className="sa-service-latency">{data.voyageAI.keyPrefix}</div>
            )}
          </div>
        </div>

        {/* Mailgun */}
        <div className="sa-service">
          <StatusDot status={data.mailgun?.configured ? 'ok' : 'not_configured'} />
          <div>
            <div className="sa-service-name">Mailgun</div>
            <div className="sa-service-status">{data.mailgun?.configured ? 'Configured' : 'Not configured'}</div>
            {data.mailgun?.domain && <div className="sa-service-latency">{data.mailgun.domain}</div>}
          </div>
        </div>
      </div>

      <div className="sa-grid-2">
        {/* Meilisearch index stats */}
        <div className="sa-panel">
          <div className="sa-panel-header">
            <span className="sa-panel-title">Meilisearch Indexes</span>
            <button className="sa-btn" onClick={handleReload}>Refresh</button>
          </div>
          <div className="sa-panel-body">
            {meiliStats?.indexes ? (
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead>
                    <tr><th>Index</th><th>Documents</th><th>Indexing</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(meiliStats.indexes).map(([uid, info]) => (
                      <tr key={uid}>
                        <td>{uid}</td>
                        <td>{num(info.numberOfDocuments)}</td>
                        <td>{info.isIndexing ? <span className="sa-badge warn">Yes</span> : <span className="sa-badge ok">No</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="sa-empty">No index data available</div>
            )}
            {meiliStats?.databaseSize != null && (
              <div className="sa-kv" style={{ marginTop: 10 }}>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Database size</span>
                  <span className="sa-kv-val">{bytes(meiliStats.databaseSize)}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Last update</span>
                  <span className="sa-kv-val">{fmtDate(meiliStats.lastUpdate)}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Node.js process */}
        {procData && (
          <div className="sa-panel">
            <div className="sa-panel-header"><span className="sa-panel-title">Node.js Process</span></div>
            <div className="sa-panel-body">
              <div className="sa-kv">
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Node version</span>
                  <span className="sa-kv-val accent">{procData.nodeVersion}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Uptime</span>
                  <span className="sa-kv-val">{procData.uptimeFormatted}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">PID</span>
                  <span className="sa-kv-val">{procData.pid}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Platform</span>
                  <span className="sa-kv-val">{procData.platform} / {procData.arch}</span>
                </div>
                <div className="sa-kv-row">
                  <span className="sa-kv-key">Environment</span>
                  <span className="sa-kv-val">{procData.env?.nodeEnv}</span>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="sa-bar-label">
                  <span>Heap used</span>
                  <span>{bytes(procData.memory?.heapUsedBytes)} / {bytes(procData.memory?.heapTotalBytes)} ({procData.memory?.heapUsedPct}%)</span>
                </div>
                <BarFill pct={procData.memory?.heapUsedPct} />
              </div>

              <div style={{ marginTop: 8 }}>
                <div className="sa-bar-label">
                  <span>RSS</span>
                  <span>{bytes(procData.memory?.rssBytes)}</span>
                </div>
                <div className="sa-bar-track" style={{ height: 4, background: 'var(--sa-surface2)' }}>
                  <div style={{
                    height: '100%',
                    background: 'var(--sa-accent2)',
                    width: `${Math.min((procData.memory?.rssBytes / (512 * 1024 * 1024)) * 100, 100)}%`
                  }} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
