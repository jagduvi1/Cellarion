import { useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { validateImport, confirmImport } from '../api/bottles';
import { searchWines } from '../api/wines';
import { parseAndMap, parseJSON } from '../utils/importMappers';
import Modal from '../components/Modal';
import './ImportBottles.css';

const STEPS = ['upload', 'review', 'importing', 'done'];

const FORMAT_LABELS = {
  cellarion: 'Cellarion JSON',
  vivino: 'Vivino',
  cellartracker: 'CellarTracker',
  generic: 'CSV'
};

const STATUS_LABELS = {
  exact: 'Matched',
  fuzzy: 'Review',
  no_match: 'No Match',
  error: 'Error',
  skipped: 'Skipped'
};

const STATUS_CLASSES = {
  exact: 'status-exact',
  fuzzy: 'status-fuzzy',
  no_match: 'status-nomatch',
  error: 'status-error',
  skipped: 'status-skipped'
};

const TYPE_DOTS = {
  red: '#8B2252',
  white: '#F5E6C8',
  'rosé': '#FFB6C1',
  sparkling: '#FFD700',
  dessert: '#DAA520',
  fortified: '#8B4513'
};

function ImportBottles() {
  const { id: cellarId } = useParams();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  // Step state
  const [step, setStep] = useState('upload');
  const [error, setError] = useState(null);

  // Upload step
  const [parsedItems, setParsedItems] = useState([]);
  const [detectedFormat, setDetectedFormat] = useState(null);
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);

  // Review step
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [validating, setValidating] = useState(false);
  const [selections, setSelections] = useState({}); // index -> wineId or 'skip'
  const [searchModal, setSearchModal] = useState(null); // { index } or null
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [manualWines, setManualWines] = useState({}); // index -> wine object from search

  // Import step
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // ── File handling ───────────────────────────────────────────────────────

  const processFile = useCallback((file) => {
    setError(null);

    if (!file) return;

    const validExtensions = ['.csv', '.tsv', '.txt', '.json'];
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    if (!validExtensions.includes(ext)) {
      setError('Please upload a CSV, TSV, TXT, or JSON file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError('File too large (max 10 MB)');
      return;
    }

    const isJson = ext === '.json';
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const { items, format } = isJson
          ? parseJSON(e.target.result)
          : parseAndMap(e.target.result);
        if (items.length === 0) {
          setError('No valid items found in the file.');
          return;
        }
        setParsedItems(items);
        setDetectedFormat(format);
        setFileName(file.name);
      } catch (err) {
        setError(`Failed to parse file: ${err.message}`);
      }
    };
    reader.onerror = () => setError('Failed to read file');
    reader.readAsText(file);
  }, []);

  const handleFileInput = (e) => {
    processFile(e.target.files[0]);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    processFile(e.dataTransfer.files[0]);
  };

  // ── Validation ──────────────────────────────────────────────────────────

  const handleValidate = async () => {
    setValidating(true);
    setError(null);

    try {
      const res = await validateImport(apiFetch, {
        cellarId,
        items: parsedItems
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Validation failed');
        setValidating(false);
        return;
      }

      setResults(data.results);
      setSummary(data.summary);

      // Auto-select exact matches
      const autoSelections = {};
      data.results.forEach((r) => {
        if (r.status === 'exact' && r.matches.length > 0) {
          autoSelections[r.index] = r.matches[0].wineId;
        }
      });
      setSelections(autoSelections);
      setStep('review');
    } catch (err) {
      setError('Network error during validation');
    } finally {
      setValidating(false);
    }
  };

  // ── Wine search (for no-match items) ────────────────────────────────────

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await searchWines(apiFetch, `search=${encodeURIComponent(searchQuery)}&limit=10`);
      const data = await res.json();
      if (res.ok) {
        setSearchResults(data.wines || []);
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  };

  const openSearchModal = (index) => {
    const item = results.find(r => r.index === index)?.item;
    setSearchModal({ index });
    setSearchQuery(`${item?.producer || ''} ${item?.wineName || ''}`.trim());
    setSearchResults([]);
  };

  const selectSearchResult = (wine) => {
    const sourceIndex = searchModal.index;
    setSelections(withPropagation(sourceIndex, wine._id));
    setManualWines(prev => {
      const sourceItem = results.find(r => r.index === sourceIndex)?.item;
      const key = sourceItem ? wineKey(sourceItem) : null;
      const next = { ...prev, [sourceIndex]: wine };
      if (key) {
        results.forEach(r => {
          if (r.index !== sourceIndex && wineKey(r.item) === key && !selections[r.index]) {
            next[r.index] = wine;
          }
        });
      }
      return next;
    });
    setSearchModal(null);
  };

  // ── Selection helpers ────────────────────────────────────────────────────

  // Returns a key for grouping duplicate wines: "wineName|producer" (lowercased)
  const wineKey = (item) =>
    `${(item?.wineName || '').toLowerCase()}|${(item?.producer || '').toLowerCase()}`;

  // Returns a selections updater that also propagates selValue to unselected
  // rows that have the same wine name + producer as the source row.
  const withPropagation = (sourceIndex, selValue) => (prev) => {
    const sourceItem = results.find(r => r.index === sourceIndex)?.item;
    const key = sourceItem ? wineKey(sourceItem) : null;
    const next = { ...prev, [sourceIndex]: selValue };
    if (key) {
      results.forEach(r => {
        if (r.index !== sourceIndex && wineKey(r.item) === key && !prev[r.index]) {
          next[r.index] = selValue;
        }
      });
    }
    return next;
  };

  // ── Selection handlers ──────────────────────────────────────────────────

  const selectWine = (index, wineId) => {
    setSelections(withPropagation(index, wineId));
  };

  const skipItem = (index) => {
    setSelections(withPropagation(index, 'skip'));
  };

  const unskipItem = (index) => {
    setSelections(prev => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const requestWine = (index) => {
    setSelections(withPropagation(index, 'request'));
  };

  // Bulk actions
  const selectAllExact = () => {
    const sel = { ...selections };
    results.forEach(r => {
      if (r.status === 'exact' && r.matches.length > 0) {
        sel[r.index] = r.matches[0].wineId;
      }
    });
    setSelections(sel);
  };

  const skipAllUnmatched = () => {
    const sel = { ...selections };
    results.forEach(r => {
      if (r.status === 'no_match' || r.status === 'error') {
        sel[r.index] = 'skip';
      }
    });
    setSelections(sel);
  };

  const requestAllUnmatched = () => {
    const sel = { ...selections };
    results.forEach(r => {
      if (r.status === 'no_match') {
        sel[r.index] = 'request';
      }
    });
    setSelections(sel);
  };

  // ── Import ──────────────────────────────────────────────────────────────

  const getImportableCount = () => {
    return results.filter(r => {
      const sel = selections[r.index];
      return sel && sel !== 'skip';
    }).length;
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    setStep('importing');

    // Build items for confirm endpoint
    const items = results
      .filter(r => {
        const sel = selections[r.index];
        return sel && sel !== 'skip';
      })
      .map(r => ({
        wineDefinition: selections[r.index] !== 'request' ? selections[r.index] : undefined,
        requestWine: selections[r.index] === 'request' ? true : undefined,
        wineName: r.item.wineName,
        producer: r.item.producer,
        vintage: r.item.vintage,
        price: r.item.price,
        currency: r.item.currency,
        bottleSize: r.item.bottleSize,
        purchaseDate: r.item.purchaseDate,
        purchaseLocation: r.item.purchaseLocation,
        location: r.item.location,
        notes: r.item.notes,
        rating: r.item.rating,
        ratingScale: r.item.ratingScale,
        drinkFrom: r.item.drinkFrom,
        drinkBefore: r.item.drinkBefore,
        dateAdded: r.item.dateAdded || r.item.purchaseDate,
        rackName: r.item.rackName,
        rackPosition: r.item.rackPosition,
        addToHistory: r.item.addToHistory,
        consumedReason: r.item.consumedReason,
        consumedAt: r.item.consumedAt,
        consumedRating: r.item.consumedRating,
        consumedRatingScale: r.item.consumedRatingScale,
        consumedNote: r.item.consumedNote,
      }));

    try {
      const res = await confirmImport(apiFetch, { cellarId, items });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Import failed');
        setStep('review');
        setImporting(false);
        return;
      }

      setImportResult(data);
      setStep('done');
    } catch (err) {
      setError('Network error during import');
      setStep('review');
    } finally {
      setImporting(false);
    }
  };

  // ── Render helpers ──────────────────────────────────────────────────────

  const renderUploadStep = () => (
    <div className="import-upload">
      <div className="import-instructions">
        <h3>Supported Formats</h3>
        <div className="format-cards">
          <div className="format-card">
            <strong>Cellarion JSON</strong>
            <p>Export from any cellar via &#8943; &rarr; Export Bottles (JSON)</p>
          </div>
          <div className="format-card">
            <strong>Vivino</strong>
            <p>Export your collection from Vivino app settings</p>
          </div>
          <div className="format-card">
            <strong>CellarTracker</strong>
            <p>Export from CellarTracker via My Cellar &rarr; Download</p>
          </div>
          <div className="format-card">
            <strong>Generic CSV</strong>
            <p>Any CSV with Wine, Producer, Vintage columns</p>
          </div>
        </div>
      </div>

      <div
        className={`drop-zone ${dragOver ? 'drag-over' : ''} ${parsedItems.length > 0 ? 'has-file' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('import-file-input').click()}
      >
        <input
          id="import-file-input"
          type="file"
          accept=".csv,.tsv,.txt,.json"
          onChange={handleFileInput}
          style={{ display: 'none' }}
        />
        {parsedItems.length > 0 ? (
          <div className="drop-zone-loaded">
            <span className="drop-zone-icon">&#10003;</span>
            <p><strong>{fileName}</strong></p>
            <p>Detected format: <strong>{FORMAT_LABELS[detectedFormat] || detectedFormat}</strong></p>
            <p>{parsedItems.length} bottle{parsedItems.length !== 1 ? 's' : ''} found</p>
            <span className="drop-zone-change">Click or drop to change file</span>
          </div>
        ) : (
          <div className="drop-zone-empty">
            <span className="drop-zone-icon">&#8686;</span>
            <p>Drop your file here or click to browse</p>
            <span className="drop-zone-hint">JSON, CSV, TSV, or TXT — max 10 MB</span>
          </div>
        )}
      </div>

      {parsedItems.length > 0 && (
        <div className="import-preview">
          <h3>Preview ({Math.min(parsedItems.length, 5)} of {parsedItems.length})</h3>
          <div className="preview-table-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>Producer</th>
                  <th>Wine</th>
                  <th>Vintage</th>
                  <th>Country</th>
                  <th>Type</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {parsedItems.slice(0, 5).map((item, i) => (
                  <tr key={i}>
                    <td>{item.producer || '—'}</td>
                    <td>{item.wineName || '—'}</td>
                    <td>{item.vintage || 'NV'}</td>
                    <td>{item.country || '—'}</td>
                    <td>
                      <span className="type-dot" style={{ background: TYPE_DOTS[item.type] || '#888' }} />
                      {item.type}
                    </td>
                    <td>{item.price ? `${item.price} ${item.currency || ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="btn btn-primary btn-validate"
            onClick={handleValidate}
            disabled={validating}
          >
            {validating ? 'Matching wines...' : `Match ${parsedItems.length} bottles against wine library`}
          </button>
        </div>
      )}
    </div>
  );

  const renderReviewStep = () => {
    const importable = getImportableCount();
    const unresolved = results.filter(r => !selections[r.index] && r.status !== 'error').length;

    return (
      <div className="import-review">
        {/* Summary bar */}
        <div className="review-summary">
          <div className="summary-stat">
            <span className="summary-number summary-exact">{summary?.exact || 0}</span>
            <span className="summary-label">Matched</span>
          </div>
          <div className="summary-stat">
            <span className="summary-number summary-fuzzy">{summary?.fuzzy || 0}</span>
            <span className="summary-label">Fuzzy</span>
          </div>
          <div className="summary-stat">
            <span className="summary-number summary-nomatch">{summary?.noMatch || 0}</span>
            <span className="summary-label">No Match</span>
          </div>
          <div className="summary-stat">
            <span className="summary-number summary-importable">{importable}</span>
            <span className="summary-label">Ready</span>
          </div>
        </div>

        {/* Bulk actions */}
        <div className="review-actions">
          <button className="btn btn-secondary btn-sm" onClick={selectAllExact}>
            Accept all matches
          </button>
          <button className="btn btn-secondary btn-sm" onClick={requestAllUnmatched}>
            Request all unmatched
          </button>
          <button className="btn btn-secondary btn-sm" onClick={skipAllUnmatched}>
            Skip all unmatched
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setStep('upload'); setResults([]); setSummary(null); setSelections({}); setManualWines({}); }}
          >
            Back to upload
          </button>
        </div>

        {/* Results table */}
        <div className="review-table-wrap">
          <table className="review-table">
            <thead>
              <tr>
                <th className="col-status">Status</th>
                <th className="col-source">Your File</th>
                <th className="col-match">Matched To</th>
                <th className="col-details">Details</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const sel = selections[r.index];
                const isSkipped = sel === 'skip';
                const isRequested = sel === 'request';
                const matchedWine = sel && sel !== 'skip' && sel !== 'request'
                  ? r.matches.find(m => m.wineId === sel) || null
                  : null;
                const manualWine = !matchedWine && manualWines[r.index]?._id === sel
                  ? manualWines[r.index]
                  : null;
                const selectedWine = matchedWine || (manualWine ? {
                  wineId: manualWine._id,
                  name: manualWine.name,
                  producer: manualWine.producer,
                  country: manualWine.country?.name || '',
                  region: manualWine.region?.name || '',
                  type: manualWine.type,
                  score: null,
                } : null);
                const isExpanded = expandedRow === r.index;

                return (
                  <tr
                    key={r.index}
                    className={`review-row ${isSkipped ? 'row-skipped' : ''} ${isRequested ? 'row-requested' : ''} ${STATUS_CLASSES[r.status]}`}
                  >
                    <td className="col-status">
                      <span className={`status-badge ${STATUS_CLASSES[r.status]}`}>
                        {isSkipped ? 'Skipped' : isRequested ? 'Requested' : STATUS_LABELS[r.status]}
                      </span>
                    </td>
                    <td className="col-source">
                      <div className="source-info">
                        <strong>{r.item.producer}</strong>
                        <span>{r.item.wineName}</span>
                        <span className="source-meta">
                          {r.item.vintage || 'NV'}
                          {r.item.country && ` · ${r.item.country}`}
                        </span>
                      </div>
                    </td>
                    <td className="col-match">
                      {isSkipped ? (
                        <span className="match-skipped">Will not import</span>
                      ) : isRequested ? (
                        <span className="match-requested">Imported pending admin review</span>
                      ) : selectedWine ? (
                        <div className="match-info">
                          <strong>{selectedWine.producer}</strong>
                          <span>{selectedWine.name}</span>
                          <span className="match-meta">
                            <span className="type-dot" style={{ background: TYPE_DOTS[selectedWine.type] || '#888' }} />
                            {selectedWine.country || ''}
                            {selectedWine.region ? ` · ${selectedWine.region}` : ''}
                          </span>
                          {selectedWine.score != null && (
                            <span className="match-score">{Math.round(selectedWine.score * 100)}% match</span>
                          )}
                        </div>
                      ) : r.status === 'error' ? (
                        <span className="match-error">{r.error}</span>
                      ) : (
                        <span className="match-pending">Select a match &rarr;</span>
                      )}
                    </td>
                    <td className="col-details">
                      {r.item.price && <span className="detail-tag">{r.item.price} {r.item.currency}</span>}
                      {r.item.rating && <span className="detail-tag">Rating: {r.item.rating}</span>}
                      {r.item.bottleSize && r.item.bottleSize !== '750ml' && (
                        <span className="detail-tag">{r.item.bottleSize}</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <div className="action-buttons">
                        {r.matches.length > 1 && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => setExpandedRow(isExpanded ? null : r.index)}
                          >
                            {isExpanded ? 'Hide' : `${r.matches.length} options`}
                          </button>
                        )}
                        {!isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => openSearchModal(r.index)}
                          >
                            Search
                          </button>
                        )}
                        {r.status === 'no_match' && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs btn-request"
                            onClick={() => requestWine(r.index)}
                          >
                            Request wine
                          </button>
                        )}
                        {isSkipped || isRequested ? (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => unskipItem(r.index)}
                          >
                            Undo
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary btn-xs btn-skip"
                            onClick={() => skipItem(r.index)}
                          >
                            Skip
                          </button>
                        )}
                      </div>

                      {/* Expanded candidate list */}
                      {isExpanded && r.matches.length > 0 && (
                        <div className="candidates-list">
                          {r.matches.map((m) => (
                            <button
                              key={m.wineId}
                              className={`candidate-item ${sel === m.wineId ? 'selected' : ''}`}
                              onClick={() => selectWine(r.index, m.wineId)}
                            >
                              <div className="candidate-info">
                                <strong>{m.producer}</strong> — {m.name}
                                <span className="candidate-meta">
                                  <span className="type-dot" style={{ background: TYPE_DOTS[m.type] || '#888' }} />
                                  {m.country || ''}{m.region ? ` · ${m.region}` : ''}
                                </span>
                              </div>
                              <span className="candidate-score">{Math.round(m.score * 100)}%</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Import button */}
        <div className="review-footer">
          {unresolved > 0 && (
            <p className="review-warning">
              {unresolved} item{unresolved !== 1 ? 's' : ''} still need a selection or to be skipped
            </p>
          )}
          <button
            className="btn btn-primary btn-import"
            onClick={handleImport}
            disabled={importable === 0 || importing}
          >
            {importing
              ? 'Importing...'
              : `Import ${importable} bottle${importable !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    );
  };

  const renderImportingStep = () => (
    <div className="import-progress">
      <div className="progress-spinner" />
      <p>Importing bottles into your cellar...</p>
      <p className="progress-hint">This may take a moment for large collections</p>
    </div>
  );

  const renderDoneStep = () => (
    <div className="import-done">
      <div className="done-icon">&#10003;</div>
      <h2>Import Complete</h2>
      {importResult && (
        <div className="done-stats">
          <div className="done-stat">
            <span className="done-number">{importResult.created}</span>
            <span>Bottles created</span>
          </div>
          {importResult.skipped.length > 0 && (
            <div className="done-stat">
              <span className="done-number done-skipped">{importResult.skipped.length}</span>
              <span>Skipped</span>
            </div>
          )}
          {importResult.errors.length > 0 && (
            <div className="done-stat">
              <span className="done-number done-errors">{importResult.errors.length}</span>
              <span>Errors</span>
            </div>
          )}
        </div>
      )}
      {importResult?.errors.length > 0 && (
        <details className="done-errors-detail">
          <summary>View errors ({importResult.errors.length})</summary>
          <ul>
            {importResult.errors.map((e, i) => (
              <li key={i}>Row {e.index + 1}: {e.reason}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="done-actions">
        <Link to={`/cellars/${cellarId}`} className="btn btn-primary">
          Go to Cellar
        </Link>
        <button
          className="btn btn-secondary"
          onClick={() => {
            setStep('upload');
            setParsedItems([]);
            setResults([]);
            setSummary(null);
            setSelections({});
            setManualWines({});
            setImportResult(null);
            setFileName('');
          }}
        >
          Import More
        </button>
      </div>
    </div>
  );

  // ── Main render ─────────────────────────────────────────────────────────

  return (
    <div className="import-page">
      <div className="import-header">
        <Link to={`/cellars/${cellarId}`} className="back-link">&larr; Back to Cellar</Link>
        <h1>Import Bottles</h1>
      </div>

      <div className="import-beta-notice">
        This feature is in beta. If you run into any issues, contact us at{' '}
        <a href="mailto:admin@cellarion.app">admin@cellarion.app</a>.
      </div>

      {/* Step indicator */}
      <div className="step-indicator">
        {STEPS.filter(s => s !== 'importing').map((s, i) => (
          <div
            key={s}
            className={`step-dot ${step === s || (step === 'importing' && s === 'done') ? 'active' : ''} ${
              STEPS.indexOf(step) > STEPS.indexOf(s) ? 'completed' : ''
            }`}
          >
            <span className="step-number">{i + 1}</span>
            <span className="step-label">
              {s === 'upload' ? 'Upload' : s === 'review' ? 'Review' : 'Done'}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="alert alert-error">{error}</div>
      )}

      {step === 'upload' && renderUploadStep()}
      {step === 'review' && renderReviewStep()}
      {step === 'importing' && renderImportingStep()}
      {step === 'done' && renderDoneStep()}

      {/* Wine search modal */}
      {searchModal && (
        <Modal title="Search Wine Library" onClose={() => setSearchModal(null)}>
          <div className="search-modal-content">
            <div className="search-modal-input">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search by wine name or producer..."
                autoFocus
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSearch}
                disabled={searching}
              >
                {searching ? 'Searching...' : 'Search'}
              </button>
            </div>
            <div className="search-modal-results">
              {searchResults.length === 0 && !searching && (
                <p className="search-empty">Type a search query and press Enter</p>
              )}
              {searchResults.map((wine) => (
                <button
                  key={wine._id}
                  className="search-result-item"
                  onClick={() => selectSearchResult(wine)}
                >
                  <div className="search-result-info">
                    <strong>{wine.producer}</strong>
                    <span>{wine.name}</span>
                    <span className="search-result-meta">
                      <span className="type-dot" style={{ background: TYPE_DOTS[wine.type] || '#888' }} />
                      {wine.country?.name || ''}
                      {wine.region?.name ? ` · ${wine.region.name}` : ''}
                      {wine.appellation ? ` · ${wine.appellation}` : ''}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ImportBottles;
