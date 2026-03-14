import { useState, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { adminImportWines } from '../api/admin';
import './AdminImportWines.css';

function AdminImportWines() {
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

  const onInputChange = (e) => handleFile(e.target.files[0]);

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
    } catch (err) {
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
    <div className="admin-import-page">
      <div className="page-header">
        <h1>Import Wines</h1>
        <p className="import-subtitle">
          Bulk-import wine definitions from a CSV file. Existing wines are never overwritten — only missing fields are filled in.
        </p>
      </div>

      {/* Drop zone */}
      {!result && (
        <div
          className={`drop-zone ${dragging ? 'drop-zone--over' : ''} ${file ? 'drop-zone--has-file' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !file && inputRef.current.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,text/plain,application/vnd.ms-excel"
            className="drop-zone-input"
            onChange={onInputChange}
          />
          {file ? (
            <div className="drop-zone-file">
              <span className="drop-zone-icon">📄</span>
              <span className="drop-zone-filename">{file.name}</span>
              <span className="drop-zone-size">{(file.size / 1024).toFixed(1)} KB</span>
              <button className="btn-link" onClick={(e) => { e.stopPropagation(); onReset(); }}>
                Remove
              </button>
            </div>
          ) : (
            <div className="drop-zone-prompt">
              <span className="drop-zone-icon">📂</span>
              <span>Drop a CSV file here, or <strong>click to browse</strong></span>
              <span className="drop-zone-hint">Max 100 MB</span>
            </div>
          )}
        </div>
      )}

      {/* Format reference */}
      {!result && (
        <details className="format-info">
          <summary>Supported CSV formats</summary>
          <div className="format-grid">
            <div className="format-block">
              <h4>LWIN format (semicolon-delimited)</h4>
              <code>LWIN;STATUS;DISPLAY_NAME;PRODUCER_TITLE;PRODUCER_NAME;WINE;COUNTRY;REGION;SUB_REGION;…</code>
              <p>All Live and Delisted wines are imported. Non-wine items (spirits, beer, sake) are skipped.</p>
            </div>
            <div className="format-block">
              <h4>Simple format (comma-delimited)</h4>
              <code>Producer,Wine,Country,Region,Appellation,WineType,Classification,LWIN7</code>
              <p>All rows are imported. <strong>Producer</strong>, <strong>Wine</strong>, and <strong>Country</strong> are required.</p>
            </div>
          </div>
        </details>
      )}

      {/* Error message */}
      {error && (
        <div className="import-alert import-alert--error">
          {error}
        </div>
      )}

      {/* Action buttons */}
      {!result && (
        <div className="import-actions">
          <button
            className="btn-primary"
            onClick={onImport}
            disabled={!file || loading}
          >
            {loading ? 'Importing…' : 'Import'}
          </button>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="import-results">
          <h2>Import complete</h2>
          <div className="import-alert import-alert--info">
            Search index is being updated in the background. New wines will appear in search within a minute.
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-value">{result.total.toLocaleString()}</span>
              <span className="stat-label">Processed</span>
            </div>
            <div className="stat-card stat-card--created">
              <span className="stat-value">{result.created.toLocaleString()}</span>
              <span className="stat-label">Created</span>
            </div>
            <div className="stat-card stat-card--updated">
              <span className="stat-value">{result.updated.toLocaleString()}</span>
              <span className="stat-label">Updated</span>
            </div>
            <div className="stat-card stat-card--skipped">
              <span className="stat-value">{result.skipped.toLocaleString()}</span>
              <span className="stat-label">Skipped</span>
            </div>
            {result.errors.length > 0 && (
              <div className="stat-card stat-card--errors">
                <span className="stat-value">{result.errors.length.toLocaleString()}</span>
                <span className="stat-label">Errors</span>
              </div>
            )}
          </div>

          {result.skipped > 0 && result.skippedReasons && (
            <div className="skip-breakdown">
              <h4>Skipped breakdown</h4>
              <table className="skip-table">
                <tbody>
                  {result.skippedReasons.notWine > 0 && (
                    <tr>
                      <td>Non-wine items (spirits, beer, sake…)</td>
                      <td className="skip-count">{result.skippedReasons.notWine.toLocaleString()}</td>
                    </tr>
                  )}
                  {result.skippedReasons.missingFields > 0 && (
                    <tr>
                      <td>Missing producer, name or country</td>
                      <td className="skip-count">{result.skippedReasons.missingFields.toLocaleString()}</td>
                    </tr>
                  )}
                  {result.skippedReasons.other > 0 && (
                    <tr>
                      <td>Other errors</td>
                      <td className="skip-count">{result.skippedReasons.other.toLocaleString()}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {result.errors.length > 0 && (
            <div className="import-errors">
              <button className="btn-link" onClick={() => setShowErrors(v => !v)}>
                {showErrors ? 'Hide errors' : `Show ${result.errors.length} error(s)`}
              </button>
              {showErrors && (
                <table className="error-table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((e, i) => (
                      <tr key={i}>
                        <td>{e.row}</td>
                        <td>{e.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <button className="btn-secondary" onClick={onReset}>
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminImportWines;
