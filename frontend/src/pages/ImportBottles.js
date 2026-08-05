import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { validateImport, confirmImport } from '../api/bottles';
import { getAiBudgetStatus, requestAiBudgetIncrease } from '../api/aiBudget';
import { searchWines } from '../api/wines';
import { getRacks } from '../api/racks';
import { parseAndMap, parseJSON, summariseRacks, getDefaultRackConfig, getDefaultAnchor, decodeImportBuffer } from '../utils/importMappers';
import { buildImportItem as buildImportItemPayload } from '../utils/importPayload';
import { prepareImportItems } from '../utils/importPrepare';
import { describePriceWarning } from '../utils/priceValidation';
import { summariseImportOutcome, buildImportReportCsv } from '../utils/importReport';
import {
  rowsNeedingAiRetry,
  reconcileRetrySelections,
  mergeRetryResults,
  mergeValidateSummaries,
  autoSelectionsFor,
  canResumeValidation,
  restoreSessionMeta,
  nextAiBudgetRequestState,
  isAiBudgetRequestPending
} from '../utils/importReview';
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

// Mirrors backend config/constants MAX_IMPORT_SIZE: /confirm hard-rejects
// bigger batches in one request, while /validate runs in 25-row slices and
// happily validates any size — so without an upfront warning a larger file
// only fails at the very last click, after all the review work.
const MAX_IMPORT_ROWS = 2000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  ai_new: 'importBottles.status.aiNew',
  no_match: 'importBottles.status.noMatch',
  error: 'importBottles.status.error',
  skipped: 'importBottles.status.skipped'
};

const STATUS_CLASSES = {
  exact: 'status-exact',
  fuzzy: 'status-fuzzy',
  ai_match: 'status-ai',
  ai_new: 'status-ai',
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

// Pattern labels for CellarTracker Location/Bin auto-mapped racks
const CT_PATTERN_LABEL_KEYS = {
  'rowcol': 'importBottles.rackAutoMap.patternRowCol',
  'rowcol-depth': 'importBottles.rackAutoMap.patternRowColDepth',
  'letter-number': 'importBottles.rackAutoMap.patternLetterNumber',
  'segments': 'importBottles.rackAutoMap.patternSegments',
  'sequential': 'importBottles.rackAutoMap.patternSequential'
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
  // CellarTracker Location groups whose bins had no consistent pattern —
  // their bottles keep the location as text: [{ location, count }]
  const [ctTextFallback, setCtTextFallback] = useState([]);
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
  // Marker for a partially-completed validate run (mid-loop failure): which
  // upload it belongs to, how many rows are already committed, and the running
  // server-summary merge. Lets a retry resume at the first unvalidated batch
  // instead of re-running — and re-spending the shared daily AI budget on —
  // batches that already succeeded. Cleared when a run completes so a
  // deliberate re-Match stays a full fresh validation.
  const [validationResume, setValidationResume] = useState(null);
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
  // Rows the user reviewed but left unselected (unmatched-ignored + untouched
  // error rows). Never submitted — tracked so the done screen counts them as
  // "not imported" instead of silently dropping them from the total.
  const [unresolvedRows, setUnresolvedRows] = useState([]);
  const [aiSearchingRow, setAiSearchingRow] = useState(null); // index of fuzzy row doing forced AI search
  // CellarTracker "what transfers" disclosure panel (upload step)
  const [ctDisclosureDismissed, setCtDisclosureDismissed] = useState(false);
  // Vivino "full wine list" (scan history) detection + the user's choice of
  // what its rows become: 'history' (consumed bottles, default), 'wishlist'
  // (WishlistItems) or 'cellar' (active bottles). See isVivinoScanHistory
  // in importMappers.
  const [vivinoScanHistory, setVivinoScanHistory] = useState(false);
  const [vivinoImportMode, setVivinoImportMode] = useState('history');

  // AI daily budget (rows with aiSkipped fell back to fuzzy matching).
  // Status from GET /api/ai-budget/status: { dailyMax, usedToday, override, pendingRequest }
  const [aiBudgetStatus, setAiBudgetStatus] = useState(null);
  const [aiBudgetRequestState, setAiBudgetRequestState] = useState('idle'); // 'idle'|'submitting'|'requested'|'error'
  const [retryingAi, setRetryingAi] = useState(false);
  const [retryAiProgress, setRetryAiProgress] = useState({ done: 0, total: 0 });

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
    positionAnchor, rackConfigs, importCurrency,
    // Parse-time notices/metadata — persisted so a resumed session still shows
    // the ct-truncated banner (and the encoding/table/fallback notes) instead
    // of silently dropping the single most important "looked like it worked"
    // warning an import can have.
    importWarnings, detectedEncoding, ctTable, ctTextFallback
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
        positionAnchor: pa, rackConfigs: rc, importCurrency: ic,
        importWarnings: iw, detectedEncoding: de, ctTable: ct, ctTextFallback: cf
      } = saveDataRef.current;

      try {
        if (!sid) {
          // First save for this review session — create a new session
          const res = await createImportSession(af, {
            cellarId: cid, fileName: fn, detectedFormat: df,
            results: rs, selections: sels, manualWines: mw,
            positionAnchor: pa, rackConfigs: rc, defaultCurrency: ic,
            importWarnings: iw, detectedEncoding: de, ctTable: ct, ctTextFallback: cf
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
            positionAnchor: pa, rackConfigs: rc, defaultCurrency: ic,
            importWarnings: iw, detectedEncoding: de, ctTable: ct, ctTextFallback: cf
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
    aiNew: rs.filter(r => r.status === 'ai_new').length,
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
      // Restore parse-time notices/metadata so the ct-truncated banner and the
      // encoding/table/fallback notes reappear on resume.
      const meta = restoreSessionMeta(s);
      setImportWarnings(meta.importWarnings);
      setDetectedEncoding(meta.detectedEncoding);
      setCtTable(meta.ctTable);
      setCtTextFallback(meta.ctTextFallback);
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
        setCtTextFallback(parsed.ctRackAutoMap?.textFallback || []);
        setCtDisclosureDismissed(false); // new file → show the CT disclosure again
        setVivinoScanHistory(!!parsed.vivinoScanHistory);
        setVivinoImportMode('history'); // new file → back to the recommended default
        setFileName(file.name);

        // Build per-rack summary + seed editable config with format-aware
        // defaults. For Oeno-export, the cabinet metadata in the CSV gives
        // us the exact shape of each rack (one per cabinet-column); pass
        // that through to the picker via info.oenoRackSpec. For
        // CellarTracker, racks derived from Location/Bin pattern detection
        // carry their pattern + counts (info.ctAutoMap, shown on the card)
        // and detected geometry (info.ctRackSpec).
        const summary = summariseRacks(items);
        const initialConfigs = {};
        for (const [name, info] of Object.entries(summary)) {
          if (oenoRackSpecs && oenoRackSpecs[name]) {
            info.oenoRackSpec = oenoRackSpecs[name];
          }
          const ctAutoMap = parsed.ctRackAutoMap?.racks?.[name];
          if (ctAutoMap) {
            info.ctAutoMap = ctAutoMap;
            if (ctAutoMap.spec) info.ctRackSpec = ctAutoMap.spec;
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

  // Validate one chunk of items, riding out transient failures and rate limits
  // (HTTP 429 / 5xx) with capped exponential backoff rather than aborting the
  // whole import. Honors a Retry-After header when present. Resolves with the
  // parsed JSON on success and only throws after retries are exhausted or on a
  // non-retryable error — so a 1000+ bottle import waits through brief AI rate
  // limits and continues instead of failing mid-way. Shared by the initial
  // validate and the AI-budget retry so both get the same backoff.
  const validateBatch = useCallback(async (batchItems) => {
    const MAX_RETRIES = 5;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await validateImport(apiFetch, { cellarId, items: batchItems });
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
  }, [apiFetch, cellarId, t]);

  // Vivino scan-history mode transform — extracted to utils/importPrepare.js
  // (unit-tested there) so mode/date/rating mapping can't silently drop
  // fields between the review screen and the created bottles.
  const prepareItems = () => prepareImportItems(parsedItems, { vivinoScanHistory, vivinoImportMode });

  const handleValidate = async () => {
    setValidating(true);
    setError(null);

    const preparedItems = prepareItems();
    const total = preparedItems.length;

    // Resume a previous partially-failed run over the SAME upload + Vivino
    // mode: keep every batch it already committed (whose AI budget is spent
    // and non-refundable) and start at the first unvalidated batch.
    const resuming = canResumeValidation(validationResume, parsedItems, vivinoScanHistory, vivinoImportMode);
    const startOffset = resuming ? validationResume.doneUpTo : 0;
    // Current `results` state (not a snapshot) so per-row rewrites made in a
    // between-failure trip to the review screen survive the resume.
    let workingResults = resuming ? results : [];
    let combinedSummary = resuming ? validationResume.summary : null;
    // Auto-selections accumulate batch-by-batch. A resume seeds from the live
    // selections map so choices the user already made are preserved (rows in
    // the remaining batches are new, so no user choice can be overwritten).
    let workingSelections = resuming ? { ...selections } : {};

    setValidationProgress({ done: startOffset, total });

    try {
      for (let offset = startOffset; offset < total; offset += VALIDATE_BATCH_SIZE) {
        // Re-index each batch so indices match their position in parsedItems
        const batch = preparedItems.slice(offset, offset + VALIDATE_BATCH_SIZE);

        const data = await validateBatch(batch);

        // Shift batch-local indices back to global indices
        const shifted = data.results.map(r => ({ ...r, index: r.index + offset }));
        workingResults = [...workingResults, ...shifted];
        combinedSummary = mergeValidateSummaries(combinedSummary, data.summary);
        // Auto-select exact, fuzzy, and AI-identified matches in this batch
        workingSelections = { ...workingSelections, ...autoSelectionsFor(shifted) };

        // Commit each batch into state AS IT COMPLETES (mirroring
        // handleRetryAiLookups) so a mid-loop failure keeps everything
        // already validated — the catch below then shows the error alongside
        // the partial results instead of discarding batches 1..n-1.
        setResults(workingResults);
        setSummary(combinedSummary);
        setSelections(workingSelections);
        setValidationResume({
          parsedItems,
          vivinoScanHistory,
          vivinoImportMode,
          doneUpTo: offset + batch.length,
          summary: combinedSummary,
        });
        setValidationProgress({ done: Math.min(offset + VALIDATE_BATCH_SIZE, total), total });
      }

      // Completed — drop the resume marker so a future deliberate "Match"
      // click re-runs the full validation, exactly as before.
      setValidationResume(null);
      setStep('review');
    } catch (err) {
      const msg = err.message || t('importBottles.errors.validationNetwork');
      // Partial progress is committed — say so next to the error instead of
      // letting the user assume everything was lost.
      setError(workingResults.length > 0 ? `${msg} ${t('importBottles.validate.partialKept')}` : msg);
    } finally {
      setValidating(false);
    }
  };

  // ── AI daily budget (aiSkipped rows fell back to fuzzy matching) ─────────
  // When the shared daily AI budget ran out mid-validate, the affected rows
  // carry aiSkipped: true. The banner explains it, shows today's usage, lets
  // the user bulk-retry those rows (after the budget reset or an admin-granted
  // increase) or request a temporary higher limit from the admins.

  const aiSkippedCount = results.filter(r => r.aiSkipped).length;
  const showAiBudgetBanner = step === 'review' && (aiSkippedCount > 0 || !!summary?.aiBudgetExhausted);

  const refreshAiBudgetStatus = useCallback(() => {
    getAiBudgetStatus(apiFetch)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        setAiBudgetStatus(d);
        // Release a sticky local 'requested' once the server reports no pending
        // request, so a request an admin has already decided doesn't block the
        // user from asking again.
        setAiBudgetRequestState(prev => nextAiBudgetRequestState(prev, d));
      })
      .catch(() => {});
  }, [apiFetch]);

  useEffect(() => {
    if (showAiBudgetBanner) refreshAiBudgetStatus();
  }, [showAiBudgetBanner, refreshAiBudgetStatus]);

  // Bulk re-validate ONLY the AI-skipped / unmatched rows, in the same
  // 25-row batches as handleValidate. Runs the full validate pipeline again
  // for those rows — with budget available they now get their AI look-up.
  const handleRetryAiLookups = async () => {
    // (a) Only retry rows that still NEED an AI look-up and the user hasn't
    // already resolved — never re-spend budget on skipped / requested /
    // manually matched rows.
    const rows = rowsNeedingAiRetry(results, selections, manualWines);
    if (rows.length === 0 || retryingAi) return;

    setRetryingAi(true);
    setError(null);
    setRetryAiProgress({ done: 0, total: rows.length });

    // (b) Merge each batch into state AS IT COMPLETES so a mid-loop failure
    // can't discard batches that already succeeded, and (c) reuse
    // validateBatch's capped backoff so a 429/5xx waits instead of aborting.
    let workingResults = results;
    try {
      for (let offset = 0; offset < rows.length; offset += VALIDATE_BATCH_SIZE) {
        const batchRows = rows.slice(offset, offset + VALIDATE_BATCH_SIZE);
        const data = await validateBatch(batchRows.map(r => r.item));

        // Map batch-local indices back to the rows' original global indices
        const batchUpdates = new Map();
        for (const nr of data.results || []) {
          const orig = batchRows[nr.index];
          if (orig) batchUpdates.set(orig.index, { ...nr, index: orig.index });
        }

        workingResults = mergeRetryResults(workingResults, batchUpdates);
        setResults(workingResults);
        setSummary(computeSummary(workingResults));
        // Fill empty selections and upgrade a stale fuzzy auto-pick to the new
        // AI match, while preserving deliberate skip / request / manual choices.
        setSelections(prev => reconcileRetrySelections(prev, batchUpdates, manualWines));
        setRetryAiProgress({ done: Math.min(offset + VALIDATE_BATCH_SIZE, rows.length), total: rows.length });
      }
    } catch (err) {
      setError(err.message || t('importBottles.errors.validationNetwork'));
    } finally {
      // The budget was (partially) spent even on a mid-loop failure — refresh.
      refreshAiBudgetStatus();
      setRetryingAi(false);
    }
  };

  // Ask the admins for a temporary daily-limit increase. One pending request
  // per user — the backend answers 409 if one is already open.
  const handleRequestAiBudget = async () => {
    if (aiBudgetRequestState === 'submitting') return;
    setAiBudgetRequestState('submitting');
    const pendingRows = results.filter(r => r.aiSkipped || r.status === 'no_match').length;
    try {
      const res = await requestAiBudgetIncrease(apiFetch, {
        // Stored server-side and shown to the reviewing admin.
        reason: `Importing ${results.length} bottles — ${pendingRows} remaining without an AI look-up`,
        pendingRows,
      });
      if (res.ok || res.status === 409) {
        setAiBudgetRequestState('requested');
        setAiBudgetStatus(s => (s ? { ...s, pendingRequest: true } : s));
        return;
      }
      setAiBudgetRequestState('error');
    } catch {
      setAiBudgetRequestState('error');
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
      } else if (updated.status === 'ai_new' && updated.aiProposed) {
        // AI identified a wine the registry doesn't have — select the
        // create-on-confirm proposal.
        setSelections(prev => ({ ...prev, [rowIndex]: 'create' }));
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

  // Build the payload object for a single result row (pure mapping lives in
  // utils/importPayload.js so the review→confirm field boundary stays tested)
  const buildImportItem = (r) => buildImportItemPayload(r, selections[r.index]);

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
    // Keep all three cohorts around: the confirm response indexes into the
    // submitted array, and both the user-skipped rows AND the rows left
    // unresolved (no selection at all — ignored no-match / untouched error
    // rows) must still show up in the done-screen accounting. An import that
    // silently forgets either group would read as more successful than it was.
    const importableRows = results.filter(isImportableRow);
    const skippedAtReview = results.filter(r => selections[r.index] === 'skip');
    const unresolvedAtReview = results.filter(
      r => !isImportableRow(r) && selections[r.index] !== 'skip'
    );
    setSubmittedRows(importableRows);
    setUserSkippedRows(skippedAtReview);
    setUnresolvedRows(unresolvedAtReview);
    const items = importableRows.map(buildImportItem);

    // Mirror of the backend cap: /confirm refuses more than MAX_IMPORT_ROWS
    // in one request — fail here with guidance instead of a bare 400 after
    // the whole review.
    if (items.length > MAX_IMPORT_ROWS) {
      setError(t('importBottles.errors.tooManyRows', { count: items.length, max: MAX_IMPORT_ROWS }));
      setStep('review');
      setImporting(false);
      return;
    }

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
  const renderImportWarnings = () => (importWarnings.length > 0 || parsedItems.length > MAX_IMPORT_ROWS) && (
    <div className="import-parse-warnings">
      {parsedItems.length > MAX_IMPORT_ROWS && (
        <div className="import-parse-warning-banner import-parse-warning-strong" role="alert">
          <strong>{t('importBottles.warnings.tooManyRowsTitle', { count: parsedItems.length })}</strong>{' '}
          {t('importBottles.warnings.tooManyRows', { max: MAX_IMPORT_ROWS })}
        </div>
      )}
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
          {w.code === 'no-identity-skipped' && t('importBottles.warnings.noIdentitySkipped', { count: w.count })}
        </div>
      ))}
    </div>
  );

  // CellarTracker auto-map: pattern + placement counts shown on a rack card
  // (both the new-rack and existing-rack variants).
  const renderCtAutoMapLine = (info) => {
    const auto = info?.ctAutoMap;
    if (!auto) return null;
    return (
      <div className="rack-config-automap">
        <div className="rack-config-automap-pattern">
          {t(CT_PATTERN_LABEL_KEYS[auto.pattern] || 'importBottles.rackAutoMap.patternGeneric')}
          {' — '}
          {auto.rows && auto.cols
            ? t('importBottles.rackAutoMap.detectedDims', { rows: auto.rows, cols: auto.cols, count: auto.binCount })
            : t('importBottles.rackAutoMap.detectedSeq', { count: auto.binCount })}
        </div>
        <div className="rack-config-automap-counts">
          {t('importBottles.rackAutoMap.placed', { count: auto.placedCount })}
          {auto.unparsedCount > 0 && (
            <> · {t('importBottles.rackAutoMap.unparsed', { count: auto.unparsedCount })}</>
          )}
        </div>
      </div>
    );
  };

  // CellarTracker locations whose bins had no consistent pattern — their
  // bottles keep the "Location / Bin" text, exactly like before auto-mapping.
  const renderCtFallbackNote = () => ctTextFallback.length > 0 && (
    <p className="rack-options-hint rack-automap-fallback">
      {t('importBottles.rackAutoMap.keptAsText', {
        count: ctTextFallback.reduce((sum, f) => sum + f.count, 0),
        locations: ctTextFallback.map(f => f.location).join(', ')
      })}
    </p>
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

  // Vivino "full wine list" exports are scan HISTORY — every label the user
  // ever scanned — not a cellar inventory (fingerprint: a "Scan date"
  // column with no quantity/purchase data). Importing those as active
  // bottles silently inflates the cellar with wines drunk years ago, so the
  // destination is an explicit choice, defaulting to drinking history.
  const VIVINO_MODE_OPTIONS = [
    { mode: 'history', titleKey: 'importBottles.vivinoHistory.historyTitle', descKey: 'importBottles.vivinoHistory.historyDesc', recommended: true },
    { mode: 'wishlist', titleKey: 'importBottles.vivinoHistory.wishlistTitle', descKey: 'importBottles.vivinoHistory.wishlistDesc' },
    { mode: 'cellar', titleKey: 'importBottles.vivinoHistory.cellarTitle', descKey: 'importBottles.vivinoHistory.cellarDesc' },
  ];

  const renderVivinoHistoryChoice = () => detectedFormat === 'vivino' && vivinoScanHistory && (
    <div className="ct-disclosure-panel vivino-history-panel">
      <div className="ct-disclosure-head">
        <strong>{t('importBottles.vivinoHistory.title')}</strong>
      </div>
      <p className="vivino-history-body">{t('importBottles.vivinoHistory.body')}</p>
      <div className="vivino-history-options" role="radiogroup" aria-label={t('importBottles.vivinoHistory.title')}>
        {VIVINO_MODE_OPTIONS.map(({ mode, titleKey, descKey, recommended }) => (
          <label key={mode} className={`vivino-history-option ${vivinoImportMode === mode ? 'selected' : ''}`}>
            <input
              type="radio"
              name="vivino-import-mode"
              value={mode}
              checked={vivinoImportMode === mode}
              onChange={() => setVivinoImportMode(mode)}
            />
            <span className="vivino-history-option-text">
              <strong>
                {t(titleKey)}
                {recommended && <span className="vivino-history-recommended">{t('importBottles.vivinoHistory.recommended')}</span>}
              </strong>
              <span className="vivino-history-option-desc">{t(descKey)}</span>
            </span>
          </label>
        ))}
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
      {parsedItems.length > 0 && renderVivinoHistoryChoice()}

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
          {detectedFormat === 'cellartracker' && Object.values(rackSummary).some(i => i.ctAutoMap) && (
            <p className="rack-options-hint">
              <Trans i18nKey="importBottles.rackAutoMap.hint" components={{ 1: <strong /> }} />
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
                    {renderCtAutoMapLine(info)}
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
                  {renderCtAutoMapLine(info)}
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

          {renderCtFallbackNote()}

          <AnchorPicker value={positionAnchor} onChange={setPositionAnchor} />
        </div>
      )}

      {/* CT file where NO location qualified for auto-mapping: there are no
          rack cards, but the user should still see why nothing gets placed. */}
      {parsedItems.length > 0 && Object.keys(rackSummary).length === 0 && (
        <>{renderCtFallbackNote()}</>
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
          ) : canResumeValidation(validationResume, parsedItems, vivinoScanHistory, vivinoImportMode) ? (
            <>
              <button
                className="btn btn-primary btn-validate"
                onClick={handleValidate}
              >
                {t('importBottles.validate.resumeMatchButton', {
                  remaining: parsedItems.length - validationResume.doneUpTo,
                  total: parsedItems.length
                })}
              </button>
              <p className="progress-hint">
                {t('importBottles.validate.resumeMatchHint', { done: validationResume.doneUpTo })}
              </p>
            </>
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
          {(summary?.aiNew || 0) > 0 && (
            <div className="summary-stat">
              <span className="summary-number summary-ai">{summary.aiNew}</span>
              <span className="summary-label">{t('importBottles.review.newWines')}</span>
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

        {/* Daily AI budget banner — some rows fell back to fuzzy matching */}
        {showAiBudgetBanner && (
          <div className="import-ai-budget-banner">
            <strong>{t('importBottles.aiBudget.title')}</strong>
            {' '}{t('importBottles.aiBudget.description', { count: aiSkippedCount })}
            {aiBudgetStatus && aiBudgetStatus.dailyMax > 0 && (
              <p className="ai-budget-usage">
                {t('importBottles.aiBudget.usage', {
                  used: aiBudgetStatus.usedToday,
                  max: aiBudgetStatus.dailyMax
                })}
                {aiBudgetStatus.override && (
                  <> {t('importBottles.aiBudget.overrideActive', {
                    date: new Date(aiBudgetStatus.override.expiresAt).toLocaleDateString()
                  })}</>
                )}
              </p>
            )}
            <div className="ai-budget-actions">
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleRetryAiLookups}
                disabled={retryingAi}
              >
                {retryingAi
                  ? t('importBottles.aiBudget.retrying', { done: retryAiProgress.done, total: retryAiProgress.total })
                  : t('importBottles.aiBudget.retryButton')}
              </button>
              {isAiBudgetRequestPending(aiBudgetStatus, aiBudgetRequestState) ? (
                <span className="ai-budget-pending">{t('importBottles.aiBudget.requested')}</span>
              ) : (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleRequestAiBudget}
                  disabled={aiBudgetRequestState === 'submitting'}
                >
                  {aiBudgetRequestState === 'submitting'
                    ? t('importBottles.aiBudget.requesting')
                    : t('importBottles.aiBudget.requestButton')}
                </button>
              )}
            </div>
            {aiBudgetRequestState === 'error' && (
              <p className="ai-budget-error">{t('importBottles.aiBudget.requestError')}</p>
            )}
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
                // 'create' = AI-identified NEW wine, minted at /confirm
                const isCreate = sel === 'create' && !!r.aiProposed;
                const hasReadySel = sel && !isSkipped && !isRequested && !isCreate;
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
                } : null) || (isCreate ? {
                  name: r.aiProposed.name,
                  producer: r.aiProposed.producer,
                  country: r.aiProposed.country || '',
                  region: r.aiProposed.region || '',
                  type: r.aiProposed.type,
                  score: null,
                  willCreate: true,
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
                          {selectedWine.willCreate && (
                            <span className="match-ai-badge">{t('importBottles.review.willCreateBadge')}</span>
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
                        {(r.matches.length > 1 || (r.status === 'ai_new' && r.matches.length > 0)) && r.status !== 'fuzzy' && !isSkipped && !isRequested && (
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
                        {(r.status === 'no_match' || r.status === 'fuzzy' || r.status === 'ai_new') && !isSkipped && !isRequested && (
                          <button
                            className="btn btn-secondary btn-xs"
                            onClick={() => openSearchModal(r.index)}
                          >
                            {t('importBottles.review.searchLibrary')}
                          </button>
                        )}
                        {(r.status === 'no_match' || r.status === 'fuzzy' || r.status === 'ai_new') && !isSkipped && !isRequested && (
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
                          {/* ai_new: switching to a fuzzy candidate must stay
                              reversible — offer the create proposal as the
                              first "candidate" so the user can switch back. */}
                          {r.status === 'ai_new' && r.aiProposed && (
                            <button
                              className={`candidate-item ${sel === 'create' ? 'selected' : ''}`}
                              onClick={() => selectWine(r.index, 'create')}
                            >
                              <div className="candidate-info">
                                <strong>{r.aiProposed.producer}</strong> — {r.aiProposed.name}
                                <span className="candidate-meta">
                                  <span className="type-dot" style={{ background: TYPE_DOTS[r.aiProposed.type] || '#888' }} />
                                  {r.aiProposed.country || ''}{r.aiProposed.region ? ` · ${r.aiProposed.region}` : ''}
                                  {' · '}{t('importBottles.review.keepCreate')}
                                </span>
                              </div>
                            </button>
                          )}
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
      unresolvedRows,
      userSkippedReason: t('importBottles.done.skippedByYou'),
      unresolvedReason: t('importBottles.done.notImported'),
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
    const { created, wishlistCreated, succeeded, totalRows, skippedCount, errorCount, unplacedCount, unresolvedCount, missedCount, fullSuccess } =
      summariseImportOutcome(importResult, userSkippedRows.length, unresolvedRows.length);

    // Everything that didn't become a bottle, with per-row reasons: rows the
    // backend skipped + rows the user skipped at review + rows left unresolved
    // (no selection — ignored no-match / untouched error rows), in file order.
    const skippedDetails = [
      ...(importResult?.skipped || []).map(s => ({
        row: submittedRows[s.index], fallbackIndex: s.index, reason: s.reason,
      })),
      ...userSkippedRows.map(r => ({
        row: r, fallbackIndex: r.index, reason: t('importBottles.done.skippedByYou'),
      })),
      ...unresolvedRows.map(r => ({
        row: r, fallbackIndex: r.index,
        reason: r.status === 'error' && r.error ? r.error : t('importBottles.done.notImported'),
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
          <p className="done-subtitle">
            {/* Wishlist-only imports create no bottles — "made it into your
                cellar" would be wrong, so they get their own success note. */}
            {wishlistCreated > 0 && created === 0
              ? t('importBottles.done.allWishlistedNote', { count: wishlistCreated })
              : t('importBottles.done.allImportedNote', { count: succeeded })}
          </p>
        </>
      ) : (
        <>
          <div className="done-icon done-icon-warn">!</div>
          <h2>{t('importBottles.done.partialTitle', {
            created: succeeded.toLocaleString(),
            total: totalRows.toLocaleString()
          })}</h2>
          <p className="done-subtitle done-partial-note">
            {missedCount > 0
              ? t('importBottles.done.partialNote', { count: missedCount })
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
          {importResult.wishlistCreated > 0 && (
            <div className="done-stat">
              <span className="done-number">{importResult.wishlistCreated}</span>
              <span>{t('importBottles.done.wishlistAdded')}</span>
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
          {unresolvedCount > 0 && (
            <div className="done-stat">
              <span className="done-number done-errors">{unresolvedCount}</span>
              <span>{t('importBottles.done.notImportedStat')}</span>
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
            {importResult.unplaced.slice(0, 50).map((u, i) => {
              // u.sourceIndex is a position in the SUBMITTED array, not a file
              // row. Map it back through submittedRows so the number matches the
              // skipped/error lists and the CSV. When it can't be mapped (null
              // sourceIndex, e.g. a rack-save failure), omit the number rather
              // than print a bogus "Row 1".
              const mapped = u.sourceIndex != null ? submittedRows[u.sourceIndex] : undefined;
              const rowNum = mapped?.index != null
                ? mapped.index + 1
                : (u.sourceIndex != null ? u.sourceIndex + 1 : null);
              return (
                <li key={i}>
                  {rowNum != null ? (
                    <Trans
                      i18nKey="importBottles.done.unplacedRow"
                      values={{ row: rowNum, rack: u.rackName }}
                      components={{ 1: <strong /> }}
                    />
                  ) : (
                    <Trans
                      i18nKey="importBottles.done.unplacedRowNoNum"
                      values={{ rack: u.rackName }}
                      components={{ 1: <strong /> }}
                    />
                  )}
                  {u.requestedPosition !== null && <>{t('importBottles.done.slotSuffix', { n: u.requestedPosition })}</>}
                  : {u.reason}
                </li>
              );
            })}
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
            setUnresolvedRows([]);
            setFileName('');
            setDetectedEncoding(null);
            setCtTable(null);
            setImportWarnings([]);
            setCtTextFallback([]);
            setCtDisclosureDismissed(false);
            setAiBudgetRequestState('idle');
            setAiBudgetStatus(null);
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
        <div className="import-support-notice">
          <Trans
            i18nKey="importBottles.supportNotice"
            values={{ email: contactEmail }}
            components={{ 1: <a href={`mailto:${contactEmail}?subject=${encodeURIComponent(t('importBottles.supportEmailSubject'))}&body=${encodeURIComponent(t('importBottles.supportEmailBody'))}`}>{contactEmail}</a> }}
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
