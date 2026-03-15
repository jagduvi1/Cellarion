import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { validateImport, confirmImport } from '../api/bottles';
import { searchWines } from '../api/wines';
import { parseAndMap, parseJSON } from '../utils/importMappers';
import {
  listImportSessions,
  createImportSession,
  getImportSession,
  updateImportSession,
  deleteImportSession
} from '../api/importSessions';
import Modal from '../components/Modal';
import './ImportBottles.css';

const STEPS = ['upload', 'review', 'importing', 'done'];

const FORMAT_LABELS = {
  cellarion: 'Cellarion',
  vivino: 'Vivino',
  cellartracker: 'CellarTracker',
  generic: 'CSV'
};

const STATUS_LABELS = {
  exact: 'Matched',
  fuzzy: 'Review',
  ai_match: 'AI Match',
  no_match: 'No Match',
  error: 'Error',
  skipped: 'Skipped'
};

const STATUS_CLASSES = {
  exact: 'status-exact',
  fuzzy: 'status-fuzzy',
  ai_match: 'status-ai',
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
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.roles?.includes('admin');

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
  const [validationProgress, setValidationProgress] = useState({ done: 0, total: 0 });
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
  const [rowImporting, setRowImporting] = useState(null); // index of row being individually imported
  const [retryingRow, setRetryingRow] = useState(null);  // index of row running AI retry
  const [aiSearchingRow, setAiSearchingRow] = useState(null); // index of fuzzy row doing forced AI search

  // Session persistence
  const [sessionId, setSessionId] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle'|'unsaved'|'saving'|'saved'|'error'
  const [draftSessions, setDraftSessions] = useState([]); // existing drafts to offer resume
  const [refreshedItems, setRefreshedItems] = useState({}); // { [index]: match } – newly matched on resume
  const saveTimerRef = useRef(null);
  // Ref so the debounced callback always reads current values without needing them in deps
  const saveDataRef = useRef({});

  // Contact email (loaded from public settings)
  const [contactEmail, setContactEmail] = useState(null);
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.contactEmail) setContactEmail(d.contactEmail); })
      .catch(() => {});
  }, []);

  // Check for existing draft sessions when the page loads
  useEffect(() => {
    listImportSessions(apiFetch, cellarId)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.sessions?.length > 0) setDraftSessions(d.sessions); })
      .catch(() => {});
  }, [apiFetch, cellarId]);

  // Keep saveDataRef current so the debounced save always uses latest values
  saveDataRef.current = {
    apiFetch, cellarId, fileName, detectedFormat,
    results, selections, manualWines, sessionId
  };

  // Auto-save whenever selections or manualWines change while in review step
  useEffect(() => {
    if (step !== 'review' || results.length === 0) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('unsaved');

    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      const {
        apiFetch: af, cellarId: cid, fileName: fn, detectedFormat: df,
        results: rs, selections: sels, manualWines: mw, sessionId: sid
      } = saveDataRef.current;

      try {
        if (!sid) {
          // First save for this review session — create a new session
          const res = await createImportSession(af, {
            cellarId: cid, fileName: fn, detectedFormat: df,
            results: rs, selections: sels, manualWines: mw
          });
          const data = await res.json();
          if (res.ok) {
            setSessionId(data.sessionId);
            setSaveStatus('saved');
            setDraftSessions([]); // hide resume banner once we have a live session
          } else {
            setSaveStatus('error');
          }
        } else {
          // Subsequent saves — just update selections/manualWines
          const res = await updateImportSession(af, sid, { selections: sels, manualWines: mw });
          setSaveStatus(res.ok ? 'saved' : 'error');
        }
      } catch {
        setSaveStatus('error');
      }
    }, 1500);

    return () => clearTimeout(saveTimerRef.current);
  }, [step, selections, manualWines]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute summary from a results array (used after resume + refresh)
  const computeSummary = (rs) => ({
    total: rs.length,
    exact: rs.filter(r => r.status === 'exact').length,
    fuzzy: rs.filter(r => r.status === 'fuzzy').length,
    aiMatch: rs.filter(r => r.status === 'ai_match').length,
    noMatch: rs.filter(r => r.status === 'no_match').length,
    errors: rs.filter(r => r.status === 'error').length
  });

  // Resume a saved draft session
  const handleResumeSession = async (session) => {
    try {
      const res = await getImportSession(apiFetch, session._id);
      if (!res.ok) return;
      const { session: s, refreshed } = await res.json();

      // Apply refreshed matches (items that were 'request' but now have an exact wine)
      let updatedResults = s.results || [];
      const updatedSelections = { ...(s.selections || {}) };

      if (Object.keys(refreshed).length > 0) {
        updatedResults = updatedResults.map(r => {
          const match = refreshed[r.index];
          if (!match) return r;
          // Prepend the new match so it appears first
          return {
            ...r,
            status: 'exact',
            matches: [
              { wineId: match.wineId, name: match.name, producer: match.producer,
                country: match.country, region: match.region, appellation: match.appellation,
                type: match.type, score: match.score },
              ...r.matches
            ]
          };
        });
        // Update selections to use the new wineId
        Object.entries(refreshed).forEach(([idx, match]) => {
          updatedSelections[Number(idx)] = match.wineId;
        });
        setRefreshedItems(refreshed);
      }

      setResults(updatedResults);
      setSelections(updatedSelections);
      setManualWines(s.manualWines || {});
      setFileName(s.fileName || '');
      setDetectedFormat(s.detectedFormat || null);
      setSummary(computeSummary(updatedResults));
      setSessionId(s._id);
      setDraftSessions([]);
      setStep('review');
    } catch {
      // If load fails, just stay on upload step
    }
  };

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

  const VALIDATE_BATCH_SIZE = 25;

  const handleValidate = async () => {
    setValidating(true);
    setError(null);

    const total = parsedItems.length;
    setValidationProgress({ done: 0, total });

    const allResults = [];
    let combinedSummary = null;

    try {
      for (let offset = 0; offset < total; offset += VALIDATE_BATCH_SIZE) {
        // Re-index each batch so indices match their position in parsedItems
        const batch = parsedItems.slice(offset, offset + VALIDATE_BATCH_SIZE);

        const res = await validateImport(apiFetch, { cellarId, items: batch });
        const data = await res.json();

        if (!res.ok) {
          setError(data.error || 'Validation failed');
          setValidating(false);
          return;
        }

        // Shift batch-local indices back to global indices
        const shifted = data.results.map(r => ({ ...r, index: r.index + offset }));
        allResults.push(...shifted);

        // Merge summaries
        if (!combinedSummary) {
          combinedSummary = { ...data.summary };
        } else {
          for (const key of Object.keys(data.summary)) {
            combinedSummary[key] = (combinedSummary[key] || 0) + (data.summary[key] || 0);
          }
        }

        setValidationProgress({ done: Math.min(offset + VALIDATE_BATCH_SIZE, total), total });
      }

      setResults(allResults);
      setSummary(combinedSummary);

      // Auto-select exact, fuzzy, and AI-identified matches
      const autoSelections = {};
      allResults.forEach((r) => {
        if ((r.status === 'exact' || r.status === 'fuzzy' || r.status === 'ai_match') && r.matches.length > 0) {
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

  // ── Per-row AI retry ─────────────────────────────────────────────────────

  const handleRetryAI = async (rowIndex) => {
    const r = results.find(res => res.index === rowIndex);
    if (!r) return;
    setRetryingRow(rowIndex);
    try {
      const res = await validateImport(apiFetch, { cellarId, items: [r.item] });
      const data = await res.json();
      if (!res.ok || !data.results?.[0]) return;
      const updated = { ...data.results[0], index: rowIndex };
      setResults(prev => prev.map(x => x.index === rowIndex ? updated : x));
      if (updated.status === 'ai_match' && updated.matches.length > 0) {
        setSelections(prev => ({ ...prev, [rowIndex]: updated.matches[0].wineId }));
      }
    } catch {
      // Non-fatal
    } finally {
      setRetryingRow(null);
    }
  };

  // ── Per-row forced AI search (for fuzzy rows) ────────────────────────────
  // Skips DB matching entirely and asks AI to identify the wine.

  const handleAiSearch = async (rowIndex) => {
    const r = results.find(res => res.index === rowIndex);
    if (!r) return;
    setAiSearchingRow(rowIndex);
    try {
      const res = await validateImport(apiFetch, {
        cellarId,
        items: [{ ...r.item, forceAi: true }],
      });
      const data = await res.json();
      if (!res.ok || !data.results?.[0]) return;
      const updated = { ...data.results[0], index: rowIndex };
      setResults(prev => prev.map(x => x.index === rowIndex ? updated : x));
      if ((updated.status === 'ai_match' || updated.status === 'exact' || updated.status === 'fuzzy') && updated.matches.length > 0) {
        setSelections(prev => ({ ...prev, [rowIndex]: updated.matches[0].wineId }));
      } else {
        // AI couldn't identify — clear the old fuzzy selection
        setSelections(prev => { const next = { ...prev }; delete next[rowIndex]; return next; });
      }
    } catch {
      // Non-fatal
    } finally {
      setAiSearchingRow(null);
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
      if ((r.status === 'exact' || r.status === 'fuzzy') && r.matches.length > 0) {
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

  // Build the payload object for a single result row
  const buildImportItem = (r) => {
    const sel = selections[r.index];
    return {
      wineDefinition: sel !== 'request' ? sel : undefined,
      requestWine: sel === 'request' ? true : undefined,
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
      dateAdded: r.item.dateAdded || r.item.purchaseDate,
      rackName: r.item.rackName,
      rackPosition: r.item.rackPosition,
      addToHistory: r.item.addToHistory,
      consumedReason: r.item.consumedReason,
      consumedAt: r.item.consumedAt,
      consumedRating: r.item.consumedRating,
      consumedRatingScale: r.item.consumedRatingScale,
      consumedNote: r.item.consumedNote,
    };
  };

  // Rows eligible for bulk import: has a real selection, not skipped, not already imported
  const isImportableRow = (r) => {
    const sel = selections[r.index];
    return sel && sel !== 'skip' && sel !== 'imported';
  };

  const getImportableCount = () => results.filter(isImportableRow).length;

  // Import a single row immediately; marks it 'imported' so it's excluded from the bulk action
  const handleImportRow = async (r) => {
    if (rowImporting !== null || importing) return;
    setRowImporting(r.index);
    try {
      const res = await confirmImport(apiFetch, { cellarId, items: [buildImportItem(r)] });
      const data = await res.json();
      if (res.ok && data.created > 0) {
        // Mark as imported — auto-save will persist this to the session
        setSelections(prev => ({ ...prev, [r.index]: 'imported' }));
      } else {
        setError((data.errors?.[0]?.reason) || data.error || 'Import failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setRowImporting(null);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    setStep('importing');

    // Build items for confirm endpoint — skip already-imported rows
    const items = results
      .filter(isImportableRow)
      .map(buildImportItem);

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
      // Clean up the saved session after a successful import
      if (sessionId) {
        deleteImportSession(apiFetch, sessionId).catch(() => {});
        setSessionId(null);
      }
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
      {draftSessions.length > 0 && (
        <div className="session-resume-banner">
          <div className="session-resume-info">
            <strong>You have a saved import in progress</strong>
            <span className="session-resume-meta">
              {draftSessions[0].fileName && `${draftSessions[0].fileName} · `}
              Last saved {new Date(draftSessions[0].updatedAt).toLocaleString()}
            </span>
          </div>
          <div className="session-resume-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleResumeSession(draftSessions[0])}
            >
              Resume
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setDraftSessions([])}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
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
          accept=".csv,.tsv,.txt,.json,text/csv,text/plain,text/tab-separated-values,application/json,application/vnd.ms-excel"
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

          {validating ? (
            <div className="validate-progress">
              <div className="progress-spinner" />
              <p className="validate-progress-label">
                Matching wines… {validationProgress.done} / {validationProgress.total}
              </p>
              <div className="validate-progress-track">
                <div
                  className="validate-progress-fill"
                  style={{ width: validationProgress.total > 0 ? `${Math.round(validationProgress.done / validationProgress.total * 100)}%` : '0%' }}
                />
              </div>
              <p className="progress-hint">AI is identifying unknown wines — this may take a moment for large collections</p>
            </div>
          ) : (
            <button
              className="btn btn-primary btn-validate"
              onClick={handleValidate}
            >
              {`Match ${parsedItems.length} bottle${parsedItems.length !== 1 ? 's' : ''} against wine library`}
            </button>
          )}
        </div>
      )}
    </div>
  );

  // Sort priority: unresolved no-match → unresolved fuzzy → unresolved exact →
  // error → resolved (matched/requested) → skipped → imported.
  // Within each group: alphabetical by producer then wine name.
  const sortResults = (rs) => {
    const priority = (r) => {
      const sel = selections[r.index];
      if (sel === 'imported') return 6;
      if (sel === 'skip') return 5;
      if (sel === 'request') return 4;
      if (sel) return 3; // has a wineId selection
      if (r.status === 'error') return 2;
      if (r.status === 'fuzzy') return 1;
      return 0; // no_match without selection — most urgent
    };
    return [...rs].sort((a, b) => {
      const pd = priority(a) - priority(b);
      if (pd !== 0) return pd;
      const nameA = `${a.item.producer || ''} ${a.item.wineName || ''}`.toLowerCase();
      const nameB = `${b.item.producer || ''} ${b.item.wineName || ''}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });
  };

  const renderReviewStep = () => {
    const importable = getImportableCount();
    const importedCount = results.filter(r => selections[r.index] === 'imported').length;
    const unresolved = results.filter(r => !selections[r.index] && r.status !== 'error').length;
    const sortedResults = sortResults(results);

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
          {(summary?.aiMatch || 0) > 0 && (
            <div className="summary-stat">
              <span className="summary-number summary-ai">{summary.aiMatch}</span>
              <span className="summary-label">AI Added</span>
            </div>
          )}
          <div className="summary-stat">
            <span className="summary-number summary-nomatch">{summary?.noMatch || 0}</span>
            <span className="summary-label">No Match</span>
          </div>
          <div className="summary-stat">
            <span className="summary-number summary-importable">{importable}</span>
            <span className="summary-label">Ready</span>
          </div>
          {importedCount > 0 && (
            <div className="summary-stat">
              <span className="summary-number summary-imported">{importedCount}</span>
              <span className="summary-label">Imported</span>
            </div>
          )}
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
            onClick={() => {
              setStep('upload');
              setResults([]);
              setSummary(null);
              setSelections({});
              setManualWines({});
              setSessionId(null);
              setSaveStatus('idle');
              setRefreshedItems({});
            }}
          >
            Back to upload
          </button>
          <span className={`save-status save-status-${saveStatus}`}>
            {saveStatus === 'saving' && 'Saving\u2026'}
            {saveStatus === 'saved' && 'Progress saved'}
            {saveStatus === 'unsaved' && 'Unsaved changes'}
            {saveStatus === 'error' && 'Save failed'}
          </span>
        </div>

        {/* Notify user about wines matched since last save */}
        {Object.keys(refreshedItems).length > 0 && (
          <div className="session-refresh-notice">
            <strong>
              {Object.keys(refreshedItems).length} wine{Object.keys(refreshedItems).length !== 1 ? 's' : ''} added to the library
            </strong>
            {' '}since your last save — selections updated automatically.
            <button
              className="session-refresh-dismiss"
              onClick={() => setRefreshedItems({})}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        )}

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
              {sortedResults.map((r) => {
                const sel = selections[r.index];
                const isSkipped = sel === 'skip';
                const isRequested = sel === 'request';
                const isImported = sel === 'imported';
                const hasReadySel = sel && !isSkipped && !isRequested && !isImported;
                const matchedWine = hasReadySel
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
                const isThisRowImporting = rowImporting === r.index;

                return (
                  <tr
                    key={r.index}
                    className={`review-row ${isSkipped ? 'row-skipped' : ''} ${isRequested ? 'row-requested' : ''} ${isImported ? 'row-imported' : ''} ${STATUS_CLASSES[r.status]}`}
                  >
                    <td className="col-status">
                      <span className={`status-badge ${isImported ? 'status-imported' : STATUS_CLASSES[r.status]}`}>
                        {isImported ? 'Imported' : isSkipped ? 'Skipped' : isRequested ? 'Requested' : STATUS_LABELS[r.status]}
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
                      {isImported ? (
                        <span className="match-imported">Added to cellar</span>
                      ) : isSkipped ? (
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
                          {r.status === 'ai_match' && (
                            <span className="match-ai-badge">AI</span>
                          )}
                          {selectedWine.score != null && r.status !== 'ai_match' && (
                            <span className="match-score">{Math.round(selectedWine.score * 100)}% match</span>
                          )}
                        </div>
                      ) : r.status === 'error' ? (
                        <span className="match-error">{r.error}</span>
                      ) : (
                        <>
                          <span className="match-pending">No match found</span>
                          {r.aiDebug && (
                            <details className={`ai-info-details${r.aiDebug.aiStatus === 'failed' || r.aiDebug.aiStatus === 'create_failed' ? ' ai-info-warn' : ''}`}>
                              <summary>
                                {r.aiDebug.aiStatus === 'failed' ? 'AI lookup failed' :
                                 r.aiDebug.aiStatus === 'create_failed' ? 'AI found a match but couldn\'t save it' :
                                 'Why no match?'}
                              </summary>
                              <p>
                                {r.aiDebug.aiExplanation ||
                                 (r.aiDebug.aiStatus === 'failed'
                                   ? 'The AI lookup encountered a temporary issue. Request the wine to be added manually.'
                                   : r.aiDebug.aiStatus === 'create_failed'
                                   ? 'The AI identified this wine but encountered an error saving it. Try requesting it manually.'
                                   : 'AI searched but could not identify this wine. Request it to be added to the registry.')}
                              </p>
                            </details>
                          )}
                        </>
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
                      {isImported ? null : (
                        <div className="action-buttons">
                          {r.matches.length > 0 && r.status === 'fuzzy' && !isSkipped && !isRequested && (
                            <button
                              className="btn btn-secondary btn-xs"
                              onClick={() => setExpandedRow(isExpanded ? null : r.index)}
                            >
                              {isExpanded ? 'Hide' : r.matches.length > 1 ? `${r.matches.length} options` : 'Change'}
                            </button>
                          )}
                          {r.matches.length > 1 && r.status !== 'fuzzy' && !isSkipped && !isRequested && (
                            <button
                              className="btn btn-secondary btn-xs"
                              onClick={() => setExpandedRow(isExpanded ? null : r.index)}
                            >
                              {isExpanded ? 'Hide' : `${r.matches.length} options`}
                            </button>
                          )}
                          {r.status === 'fuzzy' && !isSkipped && !isRequested && (
                            <button
                              className="btn btn-secondary btn-xs"
                              onClick={() => handleAiSearch(r.index)}
                              disabled={aiSearchingRow === r.index}
                            >
                              {aiSearchingRow === r.index ? 'Searching…' : 'Try AI'}
                            </button>
                          )}
                          {(r.status === 'no_match' || r.status === 'fuzzy') && !isSkipped && !isRequested && (
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
                      )}

                      {/* Expanded candidate list */}
                      {!isImported && isExpanded && r.matches.length > 0 && (
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
        <Link to={`/cellars/${cellarId}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back to Cellar
        </Link>
        <h1>Import Bottles</h1>
      </div>

      {contactEmail && (
        <div className="import-beta-notice">
          This feature is in beta. If you run into any issues, contact us at{' '}
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
        </div>
      )}

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
            {searchResults.length > 0 && (
              <div className="search-modal-footer">
                <p className="search-none-right">None of these look right?</p>
                <button
                  className="btn btn-secondary btn-sm btn-request"
                  onClick={() => {
                    requestWine(searchModal.index);
                    setSearchModal(null);
                  }}
                >
                  Request this wine
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ImportBottles;
