import { useState, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { adminImportWines } from '../../api/admin';
import { num } from './helpers';

export default function TabImport() {
  const { apiFetch } = useAuth();
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const inputRef = useRef();

  const handleFile = (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) {
      setError('Only CSV files are accepted.');
      return;
    }
    setFile(f);
    setResult(null);
    setError(null);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const onImport = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setShowErrors(false);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await adminImportWines(apiFetch, body);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Import failed.');
      } else {
        setResult(data.stats);
      }
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  const onReset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    setShowErrors(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <>
      {/* Drop zone */}
      {!result && (
        <div
          className="sa-panel"
          style={{
            border: dragging ? '2px dashed var(--sa-accent)' : '1px solid var(--sa-border)',
            cursor: file ? 'default' : 'pointer',
            textAlign: 'center',
            padding: '2rem',
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !file && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
          {file ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <span style={{ fontSize: 14 }}>{file.name}</span>
              <span style={{ color: 'var(--sa-text-dim)', fontSize: 11 }}>{(file.size / 1024).toFixed(1)} KB</span>
              <button className="sa-btn" onClick={(e) => { e.stopPropagation(); onReset(); }}>Remove</button>
            </div>
          ) : (
            <div style={{ color: 'var(--sa-text-dim)' }}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>Drop a CSV file here, or click to browse</div>
              <div style={{ fontSize: 10 }}>Max 100 MB</div>
            </div>
          )}
        </div>
      )}

      {/* Format reference */}
      {!result && (
        <details className="sa-panel" style={{ marginTop: 8, padding: '8px 12px', fontSize: 11 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--sa-text-dim)' }}>Supported CSV formats</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
            <div>
              <strong>LWIN format</strong> (semicolon-delimited)
              <div className="mono" style={{ fontSize: 10, marginTop: 4, color: 'var(--sa-text-dim)' }}>
                LWIN;STATUS;DISPLAY_NAME;PRODUCER_TITLE;PRODUCER_NAME;WINE;COUNTRY;REGION;...
              </div>
              <div style={{ marginTop: 4, color: 'var(--sa-text-dim)' }}>All Live and Delisted wines are imported. Non-wine items are skipped.</div>
            </div>
            <div>
              <strong>Simple format</strong> (comma-delimited)
              <div className="mono" style={{ fontSize: 10, marginTop: 4, color: 'var(--sa-text-dim)' }}>
                Producer,Wine,Country,Region,Appellation,WineType,Classification,LWIN7
              </div>
              <div style={{ marginTop: 4, color: 'var(--sa-text-dim)' }}>Producer, Wine, and Country are required.</div>
            </div>
          </div>
        </details>
      )}

      {error && <div className="sa-error" style={{ marginTop: 8 }}>Error: {error}</div>}

      {/* Import button */}
      {!result && (
        <div style={{ marginTop: 8 }}>
          <button
            className="sa-btn"
            onClick={onImport}
            disabled={!file || loading}
          >
            {loading ? 'Importing...' : 'Import'}
          </button>
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          <div className="sa-error" style={{ background: 'rgba(96,165,250,0.1)', color: 'var(--sa-blue)', borderColor: 'var(--sa-blue)', marginBottom: 8 }}>
            Search index is being updated in the background. New wines will appear in search within a minute.
          </div>

          <div className="sa-grid-3" style={{ marginBottom: 12 }}>
            <div className="sa-panel" style={{ textAlign: 'center', padding: 12 }}>
              <div className="sa-big-number">{num(result.total)}</div>
              <div className="sa-big-label">Processed</div>
            </div>
            <div className="sa-panel" style={{ textAlign: 'center', padding: 12 }}>
              <div className="sa-big-number" style={{ color: 'var(--sa-accent)' }}>{num(result.created)}</div>
              <div className="sa-big-label">Created</div>
            </div>
            <div className="sa-panel" style={{ textAlign: 'center', padding: 12 }}>
              <div className="sa-big-number" style={{ color: 'var(--sa-blue)' }}>{num(result.updated)}</div>
              <div className="sa-big-label">Updated</div>
            </div>
            <div className="sa-panel" style={{ textAlign: 'center', padding: 12 }}>
              <div className="sa-big-number" style={{ color: 'var(--sa-gold)' }}>{num(result.skipped)}</div>
              <div className="sa-big-label">Skipped</div>
            </div>
            {result.errors?.length > 0 && (
              <div className="sa-panel" style={{ textAlign: 'center', padding: 12 }}>
                <div className="sa-big-number" style={{ color: 'var(--sa-danger)' }}>{num(result.errors.length)}</div>
                <div className="sa-big-label">Errors</div>
              </div>
            )}
          </div>

          {result.skipped > 0 && result.skippedReasons && (
            <div className="sa-panel" style={{ padding: 12, marginBottom: 8 }}>
              <div className="sa-panel-header" style={{ marginBottom: 6 }}>
                <span className="sa-panel-title">Skipped breakdown</span>
              </div>
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <tbody>
                    {result.skippedReasons.notWine > 0 && (
                      <tr><td>Non-wine items (spirits, beer, sake...)</td><td className="mono">{num(result.skippedReasons.notWine)}</td></tr>
                    )}
                    {result.skippedReasons.missingFields > 0 && (
                      <tr><td>Missing producer, name or country</td><td className="mono">{num(result.skippedReasons.missingFields)}</td></tr>
                    )}
                    {result.skippedReasons.other > 0 && (
                      <tr><td>Other errors</td><td className="mono">{num(result.skippedReasons.other)}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.errors?.length > 0 && (
            <div className="sa-panel" style={{ padding: 12, marginBottom: 8 }}>
              <button className="sa-btn" onClick={() => setShowErrors(v => !v)} style={{ marginBottom: showErrors ? 8 : 0 }}>
                {showErrors ? 'Hide errors' : `Show ${result.errors.length} error(s)`}
              </button>
              {showErrors && (
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead><tr><th>Row</th><th>Reason</th></tr></thead>
                    <tbody>
                      {result.errors.map((e, i) => (
                        <tr key={i}><td className="mono">{e.row}</td><td>{e.reason}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <button className="sa-btn" onClick={onReset}>Import another file</button>
        </>
      )}
    </>
  );
}
