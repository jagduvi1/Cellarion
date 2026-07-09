import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { validateImport, confirmImport } from '../api/bottles';
import { searchWines } from '../api/wines';
import { getRacks } from '../api/racks';
import { parseAndMap, parseJSON, summariseRacks, getDefaultRackConfig, getDefaultAnchor, decodeImportBuffer } from '../utils/importMappers';
import { describePriceWarning } from '../utils/priceValidation';
import { summariseImportOutcome, buildImportReportCsv } from '../utils/importReport';
import { getTotalSlots } from '../utils/rackLayouts';
import { TYPE_DIMENSIONS } from '../components/racks/RackTypeSelector';
import AnchorPicker from './import/AnchorPicker';
import CurrencyPicker from './import/CurrencyPicker';
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

const FORMAT_LABEL_KEYS = {
  cellarion: 'importBottles.formats.cellarion',
  vivino: 'importBottles.formats.vivino',
  cellartracker: 'importBottles.formats.cellartracker',
  'oeno-export': 'importBottles.formats.oenoExport',
  generic: 'importBottles.formats.generic'
};

const STATUS_LABEL_KEYS = {
  exact: 'importBottles.status.exact',
  fuzzy: 'importBottles.status.fuzzy',
  ai_match: 'importBottles.status.aiMatch',
  no_match: 'importBottles.status.noMatch',
  error: 'importBottles.status.error',
  skipped: 'importBottles.status.skipped'
};

const STATUS_CLASSES = {
  exact: 'status-exact',
  fuzzy: 'status-fuzzy',
  ai_match: 'status-ai',
  no_match: 'status-nomatch',
  error: 'status-error',
  skipped: 'status-skipped'
};

// Human-readable labels for the encodings decodeImportBuffer can detect
const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252'
};

// CellarTracker table names shown next to the detected format
const CT_TABLE_LABEL_KEYS = {
  list: 'importBottles.ctTables.list',
  inventory: 'importBottles.ctTables.inventory',
  bottles: 'importBottles.ctTables.bottles',
  consumed: 'importBottles.ctTables.consumed',
  purchase: 'importBottles.ctTables.purchase',
  pending: 'importBottles.ctTables.pending'
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
  const { t } = useTranslation();
  const { id: cellarId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  // Step state
  const [step, setStep] = useState('upload');
  const [error, setError] = useState(null);

  // Upload step
  const [parsedItems, setParsedItems] = useState([]);
  const [detectedFormat, setDetectedFormat] = useState(null);
  // File encoding detected by decodeImportBuffer ('utf-8', 'windows-1252', …)
  const [detectedEncoding, setDetectedEncoding] = useState(null);
  // Which CellarTracker table the file is (list/inventory/bottles/…), if CT
  const [ctTable, setCtTable] = useState(null);
  // Non-blocking parse warnings ({ code: 'ct-truncated' | 'ct-pending-skipped', … })
  const [importWarnings, setImportWarnings] = useState([]);
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // Where bottle 1 (or row 1, col 1) sits in the source system's rack:
  // 'top-left' (default), 'top-right', 'bottom-left' (Oeno), 'bottom-right'
  const [positionAnchor, setPositionAnchor] = useState('top-left');
  // Per-rack dimension overrides: { [rackName]: { rows, cols } }
  const [rackConfigs, setRackConfigs] = useState({});
  // Rack summary built from parsed items: { [name]: { count, maxPosition, observedPositions } }
  const [rackSummary, setRackSummary] = useState({});
  // Existing racks in the target cellar (so we can show them as read-only and
  // warn the user that their picker config will be ignored for those names).
  // Shape: { [name]: { type, rows, cols, typeConfig, _id } }
  const [existingRacks, setExistingRacks] = useState({});
  // Default currency applied to imported bottles whose CSV row has no
  // currency column. Seeded from the user's profile preference, but can be
  // overridden per-import via the picker.
  const [importCurrency, setImportCurrency] = useState(user?.preferences?.currency || 'USD');

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
  // Snapshot taken at import time so the done screen / CSV report can map
  // the confirm response's submitted-array indices back to original file
  // rows, and account for rows the user skipped at review (never submitted).
  const [submittedRows, setSubmittedRows] = useState([]);
  const [userSkippedRows, setUserSkippedRows] = useState([]);
  const [aiSearchingRow, setAiSearchingRow] = useState(null); // index of fuzzy row doing forced AI search
  // CellarTracker "what transfers" disclosure panel (upload step)
  const [ctDisclosureDismissed, setCtDisclosureDismissed] = useState(false);

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

  // Load the cellar's existing racks so the import picker can show which
  // rack names collide with already-created racks (we can't reshape those
  // mid-import without risking the bottles already in them).
  useEffect(() => {
    getRacks(apiFetch, cellarId)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.racks) return;
        const byName = {};
        for (const rack of d.racks) {
          byName[rack.name] = {
            _id: rack._id,
            type: rack.type,
            rows: rack.rows,
            cols: rack.cols,
            typeConfig: rack.typeConfig,
            isModular: rack.isModular,
            modules: rack.modules
          };
        }
        setExistingRacks(byName);
      })
      .catch(() => {});
  }, [apiFetch, cellarId]);

  // Keep saveDataRef current so the debounced save always uses latest values
  saveDataRef.current = {
    apiFetch, cellarId, fileName, detectedFormat,
    results, selections, manualWines, sessionId,
    positionAnchor, rackConfigs, importCurrency
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
        results: rs, selections: sels, manualWines: mw, sessionId: sid,
        positionAnchor: pa, rackConfigs: rc, importCurrency: ic
      } = saveDataRef.current;

      try {
        if (!sid) {
          // First save for this review session — create a new session
          const res = await createImportSession(af, {
            cellarId: cid, fileName: fn, detectedFormat: df,
            results: rs, selections: sels, manualWines: mw,
            positionAnchor: pa, rackConfigs: rc, defaultCurrency: ic
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
          // Subsequent saves. Results are included because the per-row AI
          // look-up rewrites rows — without persisting them, a resumed
          // session pairs stale rows with selections that reference wines
          // missing from the stored matches ("No match found").
          const res = await updateImportSession(af, sid, {
            results: rs, selections: sels, manualWines: mw,
            positionAnchor: pa, rackConfigs: rc, defaultCurrency: ic
          });
          setSaveStatus(res.ok ? 'saved' : 'error');
        }
      } catch {
        setSaveStatus('error');
      }
    }, 1500);

    return () => clearTimeout(saveTimerRef.current);
  }, [step, selections, manualWines, positionAnchor, rackConfigs, importCurrency]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute summary from a results array (used after resume + refresh)
  const computeSummary = (rs) => ({
    total: rs.length,
    exact: rs.filter(r => r.status === 'exact').length,
    fuzzy: rs.filter(r => r.status === 'fuzzy').length,
    aiMatch: rs.filter(r => r.status === 'ai_match').length,
    noMatch: rs.filter(r => r.status === 'no_match').length,
    errors: rs.filter(r => r.status === 'error').length,
    priceWarnings: rs.filter(r => r.priceWarnings?.length).length
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
      // Restore the user's picker choices so they don't have to redo them
      if (s.positionAnchor) setPositionAnchor(s.positionAnchor);
      if (s.defaultCurrency) setImportCurrency(s.defaultCurrency);
      if (s.rackConfigs && Object.keys(s.rackConfigs).length > 0) {
        setRackConfigs(s.rackConfigs);
        // Rebuild rackSummary from the saved results so the review-step note
        // and the (re-shown) picker on jump-back have the bottle counts.
        const rs = updatedResults.map(r => r.item).filter(Boolean);
        setRackSummary(summariseRacks(rs));
      }
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
      setError(t('importBottles.errors.invalidFileType'));
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError(t('importBottles.errors.fileTooLarge'));
      return;
    }

    const isJson = ext === '.json';
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // Read raw bytes and detect the encoding ourselves — CellarTracker's
        // browser export is Windows-1252, and a hard-assumed UTF-8 read
        // silently corrupts every accented producer (Pétrus → P�trus).
        const { text, encoding } = decodeImportBuffer(e.target.result);
        const parsed = isJson
          ? parseJSON(text)
          : parseAndMap(text);
        const { items, format, oenoRackSpecs } = parsed;
        if (items.length === 0) {
          const pendingWarning = (parsed.warnings || []).find(w => w.code === 'ct-pending-skipped');
          setError(pendingWarning
            ? t('importBottles.errors.ctAllPending', { count: pendingWarning.count })
            : t('importBottles.errors.noValidItems'));
          return;
        }
        setParsedItems(items);
        setDetectedFormat(format);
        setDetectedEncoding(encoding);
        setCtTable(parsed.ctTable || null);
        setImportWarnings(parsed.warnings || []);
        setCtDisclosureDismissed(false); // new file → show the CT disclosure again
        setFileName(file.name);

        // Build per-rack summary + seed editable config with format-aware
        // defaults. For Oeno-export, the cabinet metadata in the CSV gives
        // us the exact shape of each rack (one per cabinet-column); pass
        // that through to the picker via info.oenoRackSpec.
        const summary = summariseRacks(items);
        const initialConfigs = {};
        for (const [name, info] of Object.entries(summary)) {
          if (oenoRackSpecs && oenoRackSpecs[name]) {
            info.oenoRackSpec = oenoRackSpecs[name];
          }
          initialConfigs[name] = getDefaultRackConfig(format, info);
        }
        setRackSummary(summary);
        setRackConfigs(initialConfigs);
        setPositionAnchor(getDefaultAnchor(format));
      } catch (err) {
        if (err.code === 'ct-error-page') {
          setError(t('importBottles.errors.ctErrorPage'));
        } else if (err.code === 'ct-availability') {
          setError(t('importBottles.errors.ctAvailability'));
        } else {
          setError(t('importBottles.errors.parseFailed', { message: err.message }));
        }
      }
    };
    reader.onerror = () => setError(t('importBottles.errors.readFailed'));
    reader.readAsArrayBuffer(file);
  }, [t]);

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

    // Validate one chunk, riding out transient failures and rate limits
    // (HTTP 429 / 5xx) with capped exponential backoff rather than aborting the
    // whole import. Honors a Retry-After header when present. Resolves with the
    // parsed JSON on success and only throws after retries are exhausted or on a
    // non-retryable error — so a 1000+ bottle import waits through brief AI rate
    // limits and continues instead of failing mid-way.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const validateBatch = async (batch) => {
      const MAX_RETRIES = 5;
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await validateImport(apiFetch, { cellarId, items: batch });
        } catch (netErr) {
          if (attempt >= MAX_RETRIES) throw netErr;
          await sleep(Math.min(1000 * 2 ** attempt, 15000));
          continue;
        }
        if (res.ok) return res.json();
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
          const waitMs = Number.isNaN(retryAfter) ? Math.min(1000 * 2 ** attempt, 15000) : retryAfter * 1000;
          await sleep(waitMs);
          continue;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('importBottles.errors.validationFailed', { status: res.status }));
      }
    };

    try {
      for (let offset = 0; offset < total; offset += VALIDATE_BATCH_SIZE) {
        // Re-index each batch so indices match their position in parsedItems
        const batch = parsedItems.slice(offset, offset + VALIDATE_BATCH_SIZE);

        const data = await validateBatch(batch);

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
      setError(err.message || t('importBottles.errors.validationNetwork'));
    } finally {
      setValidating(false);
    }
  };

  // ── Per-row AI look-up (for fuzzy rows) ──────────────────────────────────
  // Re-validates the row so AI identification gets another attempt (useful
  // after a transient AI failure). AI only runs when the row has both a wine
  // name and a producer — the button is hidden otherwise.

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
      // CellarTracker imports carry grape varieties and a personal drink
      // window; the backend importer consumes these when present.
      grapes: r.item.grapes,
      drinkFrom: r.item.drinkFrom ?? undefined,
      drinkTo: r.item.drinkTo ?? undefined,
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

  // Rows eligible for bulk import: has a real selection and is not skipped
  const isImportableRow = (r) => {
    const sel = selections[r.index];
    return sel && sel !== 'skip';
  };

  const getImportableCount = () => results.filter(isImportableRow).length;

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    setStep('importing');

    // Build items for confirm endpoint — skipped rows are excluded.
    // Keep both halves around: the confirm response indexes into the
    // submitted array, and user-skipped rows must still show up in the
    // done-screen accounting (an import that silently forgets them would
    // read as more successful than it was).
    const importableRows = results.filter(isImportableRow);
    const skippedAtReview = results.filter(r => selections[r.index] === 'skip');
    setSubmittedRows(importableRows);
    setUserSkippedRows(skippedAtReview);
    const items = importableRows.map(buildImportItem);

    try {
      const res = await confirmImport(apiFetch, { cellarId, items, positionAnchor, rackConfigs, defaultCurrency: importCurrency });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t('importBottles.errors.importFailed'));
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
      setError(t('importBottles.errors.importNetwork'));
      setStep('review');
    } finally {
      setImporting(false);
    }
  };

  // ── Render helpers ──────────────────────────────────────────────────────

  // Non-blocking parse warnings (shown on both upload and review steps).
  // The CT truncation warning gets elevated styling + a bold headline: a
  // 25-row page export silently missing 90% of a cellar is the single worst
  // "looked like it worked" outcome an import can have.
  const renderImportWarnings = () => importWarnings.length > 0 && (
    <div className="import-parse-warnings">
      {importWarnings.map((w, i) => (
        <div
          key={i}
          className={`import-parse-warning-banner${w.code === 'ct-truncated' ? ' import-parse-warning-strong' : ''}`}
          role={w.code === 'ct-truncated' ? 'alert' : undefined}
        >
          {w.code === 'ct-truncated' && (
            <>
              <strong>{t('importBottles.warnings.ctTruncatedTitle')}</strong>{' '}
              {t('importBottles.warnings.ctTruncated')}
            </>
          )}
          {w.code === 'ct-pending-skipped' && t('importBottles.warnings.ctPendingSkipped', {
            count: w.count,
            wines: (w.wines || []).join(', ')
          })}
        </div>
      ))}
    </div>
  );

  // "What transfers from CellarTracker" disclosure — shown once on the upload
  // step whenever a CT file is detected, before any import happens. Honest up
  // front: CT's export simply doesn't contain some things, so we can't carry
  // them, and users deserve to know that before they commit.
  const renderCtDisclosure = () => detectedFormat === 'cellartracker' && !ctDisclosureDismissed && (
    <div className="ct-disclosure-panel">
      <div className="ct-disclosure-head">
        <strong>{t('importBottles.ctDisclosure.title')}</strong>
        <button
          type="button"
          className="ct-disclosure-dismiss"
          onClick={() => setCtDisclosureDismissed(true)}
          aria-label={t('importBottles.ctDisclosure.dismiss')}
        >
          &times;
        </button>
      </div>
      <div className="ct-disclosure-cols">
        <div className="ct-disclosure-col">
          <span className="ct-disclosure-col-title ct-disclosure-yes">{t('importBottles.ctDisclosure.carriedTitle')}</span>
          <ul>
            <li>{t('importBottles.ctDisclosure.carriedBottles')}</li>
            <li>{t('importBottles.ctDisclosure.carriedRatings')}</li>
            <li>{t('importBottles.ctDisclosure.carriedPurchase')}</li>
            <li>{t('importBottles.ctDisclosure.carriedWindows')}</li>
            <li>{t('importBottles.ctDisclosure.carriedConsumed')}</li>
            <li>{t('importBottles.ctDisclosure.carriedLocations')}</li>
          </ul>
        </div>
        <div className="ct-disclosure-col">
          <span className="ct-disclosure-col-title ct-disclosure-no">{t('importBottles.ctDisclosure.notCarriedTitle')}</span>
          <ul>
            <li>{t('importBottles.ctDisclosure.notCarriedNotes')}</li>
            <li>{t('importBottles.ctDisclosure.notCarriedPhotos')}</li>
            <li>{t('importBottles.ctDisclosure.notCarriedWishlist')}</li>
          </ul>
          <p className="ct-disclosure-why">{t('importBottles.ctDisclosure.notCarriedWhy')}</p>
        </div>
      </div>
    </div>
  );

  const renderUploadStep = () => (
    <div className="import-upload">
      {/* Jumped back from review (e.g. via the anchor link) — offer a way
          back that keeps every match, skip and manual selection instead of
          forcing a full (AI-spending) re-validation. Also the only path back
          to review on a resumed session, where parsedItems is empty. */}
      {results.length > 0 && !validating && (
        <div className="session-resume-banner">
          <div className="session-resume-info">
            <strong>{t('importBottles.upload.resumeReviewTitle')}</strong>
            <span className="session-resume-meta">
              {t('importBottles.upload.resumeReviewMeta')}
            </span>
          </div>
          <div className="session-resume-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setStep('review')}
            >
              {t('importBottles.upload.returnToReview')}
            </button>
          </div>
        </div>
      )}
      {draftSessions.length > 0 && (
        <div className="session-resume-banner">
          <div className="session-resume-info">
            <strong>{t('importBottles.upload.draftTitle')}</strong>
            <span className="session-resume-meta">
              {draftSessions[0].fileName && `${draftSessions[0].fileName} · `}
              {t('importBottles.upload.lastSaved', { date: new Date(draftSessions[0].updatedAt).toLocaleString() })}
            </span>
          </div>
          <div className="session-resume-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleResumeSession(draftSessions[0])}
            >
              {t('importBottles.upload.resume')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setDraftSessions([])}
            >
              {t('importBottles.upload.dismiss')}
            </button>
          </div>
        </div>
      )}
      <div className="import-instructions">
        <h3>{t('importBottles.upload.supportedFormats')}</h3>
        <div className="format-cards">
          <div className="format-card">
            <strong>{t('importBottles.upload.cellarionTitle')}</strong>
            <p>{t('importBottles.upload.cellarionDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.vivinoTitle')}</strong>
            <p>{t('importBottles.upload.vivinoDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.cellartrackerTitle')}</strong>
            <p>{t('importBottles.upload.cellartrackerDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.oenoTitle')}</strong>
            <p>{t('importBottles.upload.oenoDesc')}</p>
          </div>
          <div className="format-card">
            <strong>{t('importBottles.upload.genericTitle')}</strong>
            <p>{t('importBottles.upload.genericDesc')}</p>
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
            <p>
              {t('importBottles.upload.detectedFormat')}{' '}
              <strong>{FORMAT_LABEL_KEYS[detectedFormat] ? t(FORMAT_LABEL_KEYS[detectedFormat]) : detectedFormat}</strong>
              {ctTable && CT_TABLE_LABEL_KEYS[ctTable] && <> · {t(CT_TABLE_LABEL_KEYS[ctTable])}</>}
            </p>
            <p>{t('importBottles.upload.bottlesFound', { count: parsedItems.length })}</p>
            {detectedEncoding && (
              <p className="import-encoding-line">
                {t('importBottles.upload.encodingLine', { encoding: ENCODING_LABELS[detectedEncoding] || detectedEncoding })}
              </p>
            )}
            <span className="drop-zone-change">{t('importBottles.upload.changeFile')}</span>
          </div>
        ) : (
          <div className="drop-zone-empty">
            <span className="drop-zone-icon">&#8686;</span>
            <p>{t('importBottles.upload.dropHere')}</p>
            <span className="drop-zone-hint">{t('importBottles.upload.dropHint')}</span>
          </div>
        )}
      </div>

      {parsedItems.length > 0 && renderImportWarnings()}
      {parsedItems.length > 0 && renderCtDisclosure()}

      {parsedItems.length > 0 && parsedItems.some(i => i.price) && (
        <CurrencyPicker
          value={importCurrency}
          onChange={setImportCurrency}
          profileCurrency={user?.preferences?.currency}
          anyRowHasCurrency={parsedItems.some(i => i.currency)}
        />
      )}

      {parsedItems.length > 0 && Object.keys(rackSummary).length > 0 && (
        <div className="import-rack-options">
          <h3>{t('importBottles.rack.title')}</h3>
          {detectedFormat === 'oeno-export' && (
            <p className="rack-options-hint">
              <Trans i18nKey="importBottles.rack.oenoHint" components={{ 1: <strong /> }} />
            </p>
          )}
          <p className="rack-options-hint">
            <Trans
              i18nKey="importBottles.rack.found"
              count={Object.keys(rackSummary).length}
              components={{ 1: <strong /> }}
            />
          </p>

          <div className="rack-config-list">
            {Object.entries(rackSummary).map(([name, info]) => {
              const existing = existingRacks[name];
              const required = Math.max(info.maxPosition || 0, info.count || 0);

              // Existing rack — read-only summary. The user's picker config
              // would be ignored on the backend (we don't reshape live racks),
              // so showing editable fields would be misleading.
              if (existing) {
                const existingCapacity = existing.isModular
                  ? null
                  : getTotalSlots(existing.type, existing.rows, existing.cols, existing.typeConfig);
                const tooSmall = existingCapacity !== null && existingCapacity < required;
                return (
                  <div key={name} className="rack-config-card rack-config-existing">
                    <div className="rack-config-card-head">
                      <strong>{name}</strong>
                      <span className="rack-config-existing-badge">{t('importBottles.rack.alreadyExists')}</span>
                      <span className="rack-config-meta">
                        {t('importBottles.rack.bottleCount', { count: info.count })}
                        {info.maxPosition > 0 && t(detectedFormat === 'oeno-export' ? 'importBottles.rack.highestShelf' : 'importBottles.rack.highestCell', { n: info.maxPosition })}
                        {info.maxPerCell > 1 && t(detectedFormat === 'oeno-export' ? 'importBottles.rack.busiestShelf' : 'importBottles.rack.busiestCell', { n: info.maxPerCell })}
                      </span>
                    </div>
                    <div className="rack-config-existing-note">
                      {t('importBottles.rack.currentLayoutPrefix')}{' '}
                      <strong>
                        {existing.isModular
                          ? t('importBottles.rack.modularLayout', { count: (existing.modules || []).length })
                          : `${existing.type} ${existing.rows}×${existing.cols}${existing.typeConfig?.bottlesPerCell > 1 ? t('importBottles.rack.perCellShort', { n: existing.typeConfig.bottlesPerCell }) : ''}`}
                      </strong>
                      {existingCapacity !== null && <>{t('importBottles.rack.slotsSuffix', { count: existingCapacity })}</>}.
                      {' '}{t('importBottles.rack.reshapeNote')}
                    </div>
                    {tooSmall && (
                      <div className="rack-config-warn rack-config-existing-warn">
                        {t('importBottles.rack.capacityBelow', { capacity: existingCapacity, required })}
                      </div>
                    )}
                    {detectedFormat === 'oeno-export' && existing.type !== 'shelf' && !existing.isModular && (
                      <div className="rack-config-warn rack-config-existing-warn">
                        <Trans
                          i18nKey="importBottles.rack.oenoTypeWarning"
                          values={{ type: existing.type }}
                          components={{ 1: <strong />, 3: <code /> }}
                        />
                      </div>
                    )}
                    <label className="rack-config-skip-toggle">
                      <input
                        type="checkbox"
                        checked={!!rackConfigs[name]?.skip}
                        onChange={(e) => setRackConfigs(prev => ({
                          ...prev,
                          [name]: { ...prev[name], skip: e.target.checked }
                        }))}
                      />
                      <span>{t('importBottles.rack.skipExisting')}</span>
                    </label>
                  </div>
                );
              }

              const cfg = rackConfigs[name] || { type: 'grid', rows: 1, cols: 1, typeConfig: {} };
              const dims = TYPE_DIMENSIONS[cfg.type] || TYPE_DIMENSIONS.grid;
              const capacity = getTotalSlots(cfg.type, cfg.rows, cfg.cols, cfg.typeConfig);
              const tooSmall = capacity < required;

              const updateCfg = (patch) => setRackConfigs(prev => ({
                ...prev,
                [name]: { ...prev[name], ...patch }
              }));
              const updateTc = (key, value) => setRackConfigs(prev => ({
                ...prev,
                [name]: {
                  ...prev[name],
                  typeConfig: { ...(prev[name]?.typeConfig || {}), [key]: value }
                }
              }));

              const isSkipped = !!cfg.skip;

              return (
                <div key={name} className={`rack-config-card ${isSkipped ? 'rack-config-skipped' : ''}`}>
                  <div className="rack-config-card-head">
                    <strong>{name}</strong>
                    <span className="rack-config-meta">
                      {t('importBottles.rack.bottleCount', { count: info.count })}
                      {info.maxPosition > 0 && t(detectedFormat === 'oeno-export' ? 'importBottles.rack.highestShelf' : 'importBottles.rack.highestCell', { n: info.maxPosition })}
                      {info.maxPerCell > 1 && t(detectedFormat === 'oeno-export' ? 'importBottles.rack.busiestShelf' : 'importBottles.rack.busiestCell', { n: info.maxPerCell })}
                    </span>
                    <label className="rack-config-skip-toggle">
                      <input
                        type="checkbox"
                        checked={isSkipped}
                        onChange={(e) => updateCfg({ skip: e.target.checked })}
                      />
                      <span>{t('importBottles.rack.skipNew')}</span>
                    </label>
                  </div>
                  {isSkipped && (
                    <div className="rack-config-skipped-note">
                      <Trans
                        i18nKey="importBottles.rack.skippedNote"
                        count={info.count}
                        values={{ name }}
                        components={{ 1: <strong /> }}
                      />
                    </div>
                  )}
                  <div className="rack-config-card-body" style={{ display: isSkipped ? 'none' : undefined }}>
                    <label className="rack-config-field">
                      <span>{t('importBottles.rack.typeLabel')}</span>
                      <select
                        value={cfg.type}
                        onChange={(e) => {
                          const newType = e.target.value;
                          const newDims = TYPE_DIMENSIONS[newType] || TYPE_DIMENSIONS.grid;
                          updateCfg({
                            type: newType,
                            rows: newDims.defaultRows,
                            cols: newDims.defaultCols
                          });
                        }}
                      >
                        <option value="grid">{t('importBottles.rack.typeGrid')}</option>
                        <option value="shelf">{t('importBottles.rack.typeShelf')}</option>
                        <option value="stack">{t('importBottles.rack.typeStack')}</option>
                        <option value="hex">{t('importBottles.rack.typeHex')}</option>
                        <option value="triangle">{t('importBottles.rack.typeTriangle')}</option>
                        <option value="x-rack">{t('importBottles.rack.typeXRack')}</option>
                        <option value="cube">{t('importBottles.rack.typeCube')}</option>
                      </select>
                    </label>

                    {dims.showRows && (
                      <label className="rack-config-field">
                        <span>{dims.rowLabel === 'racks.heightLabel' ? t('importBottles.rack.height') : t('importBottles.rack.rows')}</span>
                        <input
                          type="number" min="1" max="20"
                          value={cfg.rows}
                          onChange={(e) => updateCfg({ rows: parseInt(e.target.value, 10) || 1 })}
                        />
                      </label>
                    )}
                    {dims.showCols && (
                      <label className="rack-config-field">
                        <span>{dims.colLabel === 'racks.baseWidthLabel' ? t('importBottles.rack.baseWidth') : t('importBottles.rack.cols')}</span>
                        <input
                          type="number" min="1" max="20"
                          value={cfg.cols}
                          onChange={(e) => updateCfg({ cols: parseInt(e.target.value, 10) || 1 })}
                        />
                      </label>
                    )}
                    {dims.showBottlesPerCell && (
                      <label className="rack-config-field">
                        <span>{t('importBottles.rack.perCellLabel')}</span>
                        <input
                          type="number" min="1" max="20"
                          value={cfg.typeConfig?.bottlesPerCell || 1}
                          onChange={(e) => updateTc('bottlesPerCell', parseInt(e.target.value, 10) || 1)}
                        />
                      </label>
                    )}
                    {dims.showBackCols && (
                      <label className="rack-config-field">
                        <span>{t('importBottles.rack.backRow')}</span>
                        <input
                          type="number" min="0" max="20"
                          value={cfg.typeConfig?.backCols ?? 0}
                          onChange={(e) => updateTc('backCols', parseInt(e.target.value, 10) || 0)}
                        />
                      </label>
                    )}
                    {dims.showBottlesPerSection && (
                      <label className="rack-config-field">
                        <span>{t('importBottles.rack.perSection')}</span>
                        <input
                          type="number" min="1" max="30"
                          value={cfg.typeConfig?.bottlesPerSection || 10}
                          onChange={(e) => updateTc('bottlesPerSection', parseInt(e.target.value, 10) || 10)}
                        />
                      </label>
                    )}
                    {dims.showModule && (
                      <>
                        <label className="rack-config-field">
                          <span>{t('importBottles.rack.moduleRows')}</span>
                          <input
                            type="number" min="1" max="10"
                            value={cfg.typeConfig?.moduleRows || 2}
                            onChange={(e) => updateTc('moduleRows', parseInt(e.target.value, 10) || 2)}
                          />
                        </label>
                        <label className="rack-config-field">
                          <span>{t('importBottles.rack.moduleCols')}</span>
                          <input
                            type="number" min="1" max="10"
                            value={cfg.typeConfig?.moduleCols || 2}
                            onChange={(e) => updateTc('moduleCols', parseInt(e.target.value, 10) || 2)}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  {!isSkipped && (
                    <div className="rack-config-capacity-line">
                      {t('importBottles.rack.capacityLine', { count: capacity })}
                      {tooSmall && (
                        <span className="rack-config-warn">
                          {t('importBottles.rack.tooSmallSuffix', { count: required })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <AnchorPicker value={positionAnchor} onChange={setPositionAnchor} />
        </div>
      )}

      {parsedItems.length > 0 && (
        <div className="import-preview">
          <h3>{t('importBottles.preview.title', { shown: Math.min(parsedItems.length, 5), total: parsedItems.length })}</h3>
          <div className="preview-table-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>{t('importBottles.preview.producer')}</th>
                  <th>{t('importBottles.preview.wine')}</th>
                  <th>{t('importBottles.preview.vintage')}</th>
                  <th>{t('importBottles.preview.country')}</th>
                  <th>{t('importBottles.preview.type')}</th>
                  <th>{t('importBottles.preview.price')}</th>
                </tr>
              </thead>
              <tbody>
                {parsedItems.slice(0, 5).map((item, i) => (
                  <tr key={i}>
                    <td>{item.producer || '—'}</td>
                    <td>{item.wineName || '—'}</td>
                    <td>{item.vintage || t('importBottles.preview.nv')}</td>
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
                {t('importBottles.validate.matching', { done: validationProgress.done, total: validationProgress.total })}
              </p>
              <div className="validate-progress-track">
                <div
                  className="validate-progress-fill"
                  style={{ width: validationProgress.total > 0 ? `${Math.round(validationProgress.done / validationProgress.total * 100)}%` : '0%' }}
                />
              </div>
              <p className="progress-hint">{t('importBottles.validate.largeCollectionHint')}</p>
            </div>
          ) : (
            <button
              className="btn btn-primary btn-validate"
              onClick={handleValidate}
            >
              {t('importBottles.validate.matchButton', { count: parsedItems.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );

  // Sort priority: unresolved no-match → unresolved fuzzy → unresolved exact →
  // error → resolved (matched/requested) → skipped.
  // Within each group: alphabetical by producer then wine name.
  const sortResults = (rs) => {
    const priority = (r) => {
      const sel = selections[r.index];
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
    const unresolved = results.filter(r => !selections[r.index] && r.status !== 'error').length;
    const sortedResults = sortResults(results);

    return (
      <div className="import-review">
        {/* Summary bar */}
        <div className="review-summary">
          <div className="summary-stat">
            <span className="summary-number summary-exact">{summary?.exact || 0}</span>
            <span className="summary-label">{t('importBottles.review.matched')}</span>
          </div>
          <div className="summary-stat">
            <span className="summary-number summary-fuzzy">{summary?.fuzzy || 0}</span>
            <span className="summary-label">{t('importBottles.review.fuzzy')}</span>
          </div>
          {(summary?.aiMatch || 0) > 0 && (
            <div className="summary-stat">
              <span className="summary-number summary-ai">{summary.aiMatch}</span>
              <span className="summary-label">{t('importBottles.review.autoAdded')}</span>
            </div>
          )}
          <div className="summary-stat">
            <span className="summary-number summary-nomatch">{summary?.noMatch || 0}</span>
            <span className="summary-label">{t('importBottles.review.noMatch')}</span>
          </div>
          <div className="summary-stat">
            <span className="summary-number summary-importable">{importable}</span>
            <span className="summary-label">{t('importBottles.review.ready')}</span>
          </div>
          {(summary?.priceWarnings || 0) > 0 && (
            <div className="summary-stat">
              <span className="summary-number summary-warn">{summary.priceWarnings}</span>
              <span className="summary-label">{t('importBottles.review.priceWarnings')}</span>
            </div>
          )}
        </div>

        {/* Parse-time warnings (CT truncation / skipped pending bottles) + encoding info */}
        {renderImportWarnings()}
        {detectedEncoding && (
          <p className="import-encoding-line">
            {t('importBottles.upload.encodingLine', { encoding: ENCODING_LABELS[detectedEncoding] || detectedEncoding })}
          </p>
        )}

        {/* Price sanity banner — surfaces fat-finger / 100×-too-high / cents-as-units mistakes */}
        {(summary?.priceWarnings || 0) > 0 && (
          <div className="import-price-warning-banner">
            <strong>{t('importBottles.review.priceWarningBanner', { count: summary.priceWarnings })}</strong>
            {' '}{t('importBottles.review.priceWarningHint')}
          </div>
        )}

        {/* Bulk actions */}
        <div className="review-actions">
          <button className="btn btn-secondary btn-sm" onClick={selectAllExact}>
            {t('importBottles.review.acceptAllMatches')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={requestAllUnmatched}>
            {t('importBottles.review.requestAllUnmatched')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={skipAllUnmatched}>
            {t('importBottles.review.skipAllUnmatched')}
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
            {t('importBottles.review.backToUpload')}
          </button>
          <span className={`save-status save-status-${saveStatus}`}>
            {saveStatus === 'saving' && t('importBottles.review.saving')}
            {saveStatus === 'saved' && t('importBottles.review.saved')}
            {saveStatus === 'unsaved' && t('importBottles.review.unsaved')}
            {saveStatus === 'error' && t('importBottles.review.saveFailed')}
          </span>
        </div>

        {/* Notify user about wines matched since last save */}
        {Object.keys(refreshedItems).length > 0 && (
          <div className="session-refresh-notice">
            <Trans
              i18nKey="importBottles.review.refreshedNotice"
              count={Object.keys(refreshedItems).length}
              components={{ 1: <strong /> }}
            />
            <button
              className="session-refresh-dismiss"
              onClick={() => setRefreshedItems({})}
              aria-label={t('importBottles.review.dismiss')}
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
                <th className="col-status">{t('importBottles.review.colStatus')}</th>
                <th className="col-source">{t('importBottles.review.colSource')}</th>
                <th className="col-match">{t('importBottles.review.colMatch')}</th>
                <th className="col-details">{t('importBottles.review.colDetails')}</th>
                <th className="col-actions">{t('importBottles.review.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedResults.map((r) => {
                const sel = selections[r.index];
                const isSkipped = sel === 'skip';
                const isRequested = sel === 'request';
                const hasReadySel = sel && !isSkipped && !isRequested;
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

                return (
                  <tr
                    key={r.index}
                    className={`review-row ${isSkipped ? 'row-skipped' : ''} ${isRequested ? 'row-requested' : ''} ${STATUS_CLASSES[r.status]}`}
                  >
                    <td className="col-status">
                      <span className={`status-badge ${STATUS_CLASSES[r.status]}`}>
                        {isSkipped ? t('importBottles.status.skipped') : isRequested ? t('importBottles.status.requested') : t(STATUS_LABEL_KEYS[r.status])}
                      </span>
                    </td>
                    <td className="col-source">
                      <div className="source-info">
                        <strong>{r.item.producer}</strong>
                        <span>{r.item.wineName}</span>
                        <span className="source-meta">
                          {r.item.vintage || t('importBottles.preview.nv')}
                          {r.item.country && ` · ${r.item.country}`}
                        </span>
                      </div>
                    </td>
                    <td className="col-match">
                      {isSkipped ? (
                        <span className="match-skipped">{t('importBottles.review.willNotImport')}</span>
                      ) : isRequested ? (
                        <span className="match-requested">{t('importBottles.review.pendingAdminReview')}</span>
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
                            <span className="match-ai-badge">{t('importBottles.review.autoBadge')}</span>
                          )}
                          {selectedWine.score != null && r.status !== 'ai_match' && (
                            <span className="match-score">{t('importBottles.review.matchScore', { score: Math.round(selectedWine.score * 100) })}</span>
                          )}
                        </div>
                      ) : r.status === 'error' ? (
                        <span className="match-error">{r.error}</span>
                      ) : (
                        <>
                          <span className="match-pending">{t('importBottles.review.noMatchFound')}</span>
                          {r.aiDebug && (
                            <details className={`ai-info-details${r.aiDebug.aiStatus === 'failed' || r.aiDebug.aiStatus === 'create_failed' ? ' ai-info-warn' : ''}`}>
                              <summary>
                                {r.aiDebug.aiStatus === 'failed' ? t('importBottles.review.lookupFailed') :
                                 r.aiDebug.aiStatus === 'create_failed' ? t('importBottles.review.createFailed') :
                                 t('importBottles.review.whyNoMatch')}
                              </summary>
                              <p>
                                {r.aiDebug.aiExplanation ||
                                 (r.aiDebug.aiStatus === 'failed'
                                   ? t('importBottles.review.lookupFailedDesc')
                                   : r.aiDebug.aiStatus === 'create_failed'
                                   ? t('importBottles.review.createFailedDesc')
                                   : t('importBottles.review.couldNotIdentifyDesc'))}
                              </p>
                            </details>
                          )}
                        </>
                      )}
                    </td>
                    <td className="col-details">
                      {r.item.price && (
                        <span
                          className={`detail-tag${r.priceWarnings?.length ? ' detail-tag--warn' : ''}`}
                          title={r.priceWarnings?.length
                            ? r.priceWarnings.map(describePriceWarning).join('\n')
                            : undefined}
                        >
                          {r.priceWarnings?.length ? '⚠️ ' : ''}
                          {r.item.price} {r.item.currency}
                        </span>
                      )}
                      {r.item.rating && <span className="detail-tag">{t('importBottles.review.ratingTag', { rating: r.item.rating })}</span>}
                      {r.item.bottleSize && r.item.bottleSize !== '750ml' && (
                        <span className="detail-tag">{r.item.bottleSize}</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <div className="action-buttons">
                        {r.matches.length > 0 && r.status === 'fuzzy' && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => setExpandedRow(isExpanded ? null : r.index)}
                          >
                            {isExpanded ? t('importBottles.review.hide') : r.matches.length > 1 ? t('importBottles.review.options', { count: r.matches.length }) : t('importBottles.review.change')}
                          </button>
                        )}
                        {r.matches.length > 1 && r.status !== 'fuzzy' && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => setExpandedRow(isExpanded ? null : r.index)}
                          >
                            {isExpanded ? t('importBottles.review.hide') : t('importBottles.review.options', { count: r.matches.length })}
                          </button>
                        )}
                        {r.status === 'fuzzy' && r.item.wineName && r.item.producer && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => handleAiSearch(r.index)}
                            disabled={aiSearchingRow === r.index}
                          >
                            {aiSearchingRow === r.index ? t('importBottles.review.searching') : t('importBottles.review.lookUp')}
                          </button>
                        )}
                        {(r.status === 'no_match' || r.status === 'fuzzy') && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => openSearchModal(r.index)}
                          >
                            {t('importBottles.review.searchLibrary')}
                          </button>
                        )}
                        {(r.status === 'no_match' || r.status === 'fuzzy') && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs btn-request"
                            onClick={() => requestWine(r.index)}
                          >
                            {t('importBottles.review.requestWine')}
                          </button>
                        )}
                        {isSkipped || isRequested ? (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => unskipItem(r.index)}
                          >
                            {t('importBottles.review.undo')}
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary btn-xs btn-skip"
                            onClick={() => skipItem(r.index)}
                          >
                            {t('importBottles.review.skip')}
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
              {t('importBottles.review.unresolved', { count: unresolved })}
            </p>
          )}
          {Object.keys(rackSummary).length > 0 && (
            <p className="review-anchor-note">
              <Trans
                i18nKey="importBottles.review.anchorNote"
                values={{ anchor: t(`importBottles.anchor.${positionAnchor}`) }}
                components={{ 1: <strong />, 3: <button type="button" className="link-btn" onClick={() => setStep('upload')} /> }}
              />
            </p>
          )}
          <button
            className="btn btn-primary btn-import"
            onClick={handleImport}
            disabled={importable === 0 || importing}
          >
            {importing
              ? t('importBottles.review.importing')
              : t('importBottles.review.importButton', { count: importable })}
          </button>
        </div>
      </div>
    );
  };

  const renderImportingStep = () => (
    <div className="import-progress">
      <div className="progress-spinner" />
      <p>{t('importBottles.progress.importing')}</p>
      <p className="progress-hint">{t('importBottles.progress.hint')}</p>
    </div>
  );

  // Client-side CSV report of every row that did NOT become a placed bottle
  // (skipped / error / unplaced) plus a one-line summary — no backend call.
  const handleDownloadReport = () => {
    const csv = buildImportReportCsv({
      importResult,
      submittedRows,
      userSkippedRows,
      userSkippedReason: t('importBottles.done.skippedByYou'),
    });
    // BOM so Excel opens the UTF-8 file with accents (Pétrus) intact
    const blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cellarion-import-report.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // "Row 12 (Pétrus Pomerol): reason" — falls back to a plain row line when
  // the wine fields are unknown. `row` is a validation-result row (or
  // undefined), `fallbackIndex` the submitted-array index for safety.
  const describeReportLine = (row, fallbackIndex, reason) => {
    const rowNumber = (row?.index ?? fallbackIndex) + 1;
    const wine = row?.item ? `${row.item.producer || ''} ${row.item.wineName || ''}`.trim() : '';
    return wine
      ? t('importBottles.done.reportRow', { row: rowNumber, wine, reason })
      : t('importBottles.done.errorRow', { row: rowNumber, reason });
  };

  const renderDoneStep = () => {
    const { created, totalRows, skippedCount, errorCount, unplacedCount, fullSuccess } =
      summariseImportOutcome(importResult, userSkippedRows.length);

    // Everything that didn't become a bottle, with per-row reasons: rows the
    // backend skipped + rows the user skipped at review, in file order.
    const skippedDetails = [
      ...(importResult?.skipped || []).map(s => ({
        row: submittedRows[s.index], fallbackIndex: s.index, reason: s.reason,
      })),
      ...userSkippedRows.map(r => ({
        row: r, fallbackIndex: r.index, reason: t('importBottles.done.skippedByYou'),
      })),
    ].sort((a, b) => (a.row?.index ?? a.fallbackIndex) - (b.row?.index ?? b.fallbackIndex));

    return (
    <div className="import-done">
      {/* Honest headline: any skip, error or unplaced bottle means this was
          NOT a full success, and the headline must say so — never a green
          "Import complete!" over a partial result. */}
      {fullSuccess ? (
        <>
          <div className="done-icon">&#10003;</div>
          <h2>{t('importBottles.done.title')}</h2>
          <p className="done-subtitle">{t('importBottles.done.allImportedNote', { count: created })}</p>
        </>
      ) : (
        <>
          <div className="done-icon done-icon-warn">!</div>
          <h2>{t('importBottles.done.partialTitle', {
            created: created.toLocaleString(),
            total: totalRows.toLocaleString()
          })}</h2>
          <p className="done-subtitle done-partial-note">
            {errorCount + skippedCount > 0
              ? t('importBottles.done.partialNote', { count: errorCount + skippedCount })
              : t('importBottles.done.unplacedOnlyNote', { count: unplacedCount })}
          </p>
        </>
      )}
      {importResult && (
        <div className="done-stats">
          <div className="done-stat">
            <span className="done-number">{importResult.createdActive ?? importResult.created}</span>
            <span>{t('importBottles.done.activeBottles')}</span>
          </div>
          {importResult.createdHistory > 0 && (
            <div className="done-stat">
              <span className="done-number">{importResult.createdHistory}</span>
              <span>{t('importBottles.done.consumedHistory')}</span>
            </div>
          )}
          {skippedCount > 0 && (
            <div className="done-stat">
              <span className="done-number done-skipped">{skippedCount}</span>
              <span>{t('importBottles.done.skipped')}</span>
            </div>
          )}
          {errorCount > 0 && (
            <div className="done-stat">
              <span className="done-number done-errors">{errorCount}</span>
              <span>{t('importBottles.done.errors')}</span>
            </div>
          )}
          {importResult.racksCreated?.length > 0 && (
            <div className="done-stat">
              <span className="done-number">{importResult.racksCreated.length}</span>
              <span>{t('importBottles.done.racksCreated', { count: importResult.racksCreated.length })}</span>
            </div>
          )}
          {importResult.placed > 0 && (
            <div className="done-stat">
              <span className="done-number">{importResult.placed}</span>
              <span>{t('importBottles.done.placedInRacks')}{importResult.overflowed > 0 ? t('importBottles.done.overflowSuffix', { count: importResult.overflowed }) : ''}</span>
            </div>
          )}
          {unplacedCount > 0 && (
            <div className="done-stat">
              <span className="done-number done-errors">{unplacedCount}</span>
              <span>{t('importBottles.done.couldntPlace')}</span>
            </div>
          )}
        </div>
      )}
      {skippedDetails.length > 0 && (
        <details className="done-errors-detail">
          <summary>{t('importBottles.done.skippedSummary', { count: skippedDetails.length })}</summary>
          <ul>
            {skippedDetails.slice(0, 50).map((s, i) => (
              <li key={i}>{describeReportLine(s.row, s.fallbackIndex, s.reason)}</li>
            ))}
            {skippedDetails.length > 50 && (
              <li><em>{t('importBottles.done.andMore', { count: skippedDetails.length - 50 })}</em></li>
            )}
          </ul>
        </details>
      )}
      {importResult?.racksCreated?.length > 0 && (
        <details className="done-errors-detail">
          <summary>{t('importBottles.done.autoCreatedRacks', { count: importResult.racksCreated.length })}</summary>
          <ul>
            {importResult.racksCreated.map((r, i) => (
              <li key={i}>
                <strong>{r.name}</strong> — {r.type} {r.rows}×{r.cols}
              </li>
            ))}
          </ul>
        </details>
      )}
      {importResult?.unplaced?.length > 0 && (
        <details className="done-errors-detail">
          <summary>{t('importBottles.done.unplacedSummary', { count: importResult.unplaced.length })}</summary>
          <ul>
            {importResult.unplaced.slice(0, 50).map((u, i) => (
              <li key={i}>
                <Trans
                  i18nKey="importBottles.done.unplacedRow"
                  values={{ row: u.sourceIndex + 1, rack: u.rackName }}
                  components={{ 1: <strong /> }}
                />
                {u.requestedPosition !== null && <>{t('importBottles.done.slotSuffix', { n: u.requestedPosition })}</>}
                : {u.reason}
              </li>
            ))}
            {importResult.unplaced.length > 50 && (
              <li><em>{t('importBottles.done.andMore', { count: importResult.unplaced.length - 50 })}</em></li>
            )}
          </ul>
          <p className="done-note">
            {t('importBottles.done.unplacedNote')}
          </p>
        </details>
      )}
      {importResult?.errors.length > 0 && (
        <details className="done-errors-detail">
          <summary>{t('importBottles.done.viewErrors', { count: importResult.errors.length })}</summary>
          <ul>
            {importResult.errors.map((e, i) => (
              <li key={i}>{describeReportLine(submittedRows[e.index], e.index, e.reason)}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="done-actions">
        <Link to={`/cellars/${cellarId}`} className="btn btn-primary">
          {t('importBottles.done.goToCellar')}
        </Link>
        {!fullSuccess && importResult && (
          <button className="btn btn-secondary" onClick={handleDownloadReport}>
            {t('importBottles.done.downloadReport')}
          </button>
        )}
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
            setSubmittedRows([]);
            setUserSkippedRows([]);
            setFileName('');
            setDetectedEncoding(null);
            setCtTable(null);
            setImportWarnings([]);
            setCtDisclosureDismissed(false);
          }}
        >
          {t('importBottles.done.importMore')}
        </button>
      </div>
    </div>
    );
  };

  // ── Main render ─────────────────────────────────────────────────────────

  return (
    <div className="import-page">
      <div className="import-header">
        <Link to={`/cellars/${cellarId}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          {t('importBottles.backToCellar')}
        </Link>
        <h1>{t('importBottles.title')}</h1>
      </div>

      {contactEmail && (
        <div className="import-beta-notice">
          <Trans
            i18nKey="importBottles.betaNotice"
            values={{ email: contactEmail }}
            components={{ 1: <a href={`mailto:${contactEmail}?subject=${encodeURIComponent(t('importBottles.betaEmailSubject'))}&body=${encodeURIComponent(t('importBottles.betaEmailBody'))}`}>{contactEmail}</a> }}
          />
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
              {s === 'upload' ? t('importBottles.steps.upload') : s === 'review' ? t('importBottles.steps.review') : t('importBottles.steps.done')}
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
        <Modal title={t('importBottles.search.title')} onClose={() => setSearchModal(null)}>
          <div className="search-modal-content">
            <div className="search-modal-input">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={t('importBottles.search.placeholder')}
                autoFocus
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSearch}
                disabled={searching}
              >
                {searching ? t('importBottles.search.searching') : t('importBottles.search.button')}
              </button>
            </div>
            <div className="search-modal-results">
              {searchResults.length === 0 && !searching && (
                <p className="search-empty">{t('importBottles.search.empty')}</p>
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
                <p className="search-none-right">{t('importBottles.search.noneRight')}</p>
                <button
                  className="btn btn-secondary btn-sm btn-request"
                  onClick={() => {
                    requestWine(searchModal.index);
                    setSearchModal(null);
                  }}
                >
                  {t('importBottles.search.requestThis')}
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
