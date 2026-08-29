import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { searchWines, resolveWine, identifyWineByText } from '../api/wines';
import useLabelScanner from '../hooks/useLabelScanner';
import { CURRENCIES } from '../config/currencies';
import { BOTTLE_SIZES, bottleSizeLabel } from '../config/bottleSizes';
import { validatePriceSanity } from '../utils/priceValidation';
import { validateDrinkWindowFields, DRINK_YEAR_MIN, DRINK_YEAR_MAX } from '../utils/drinkStatus';
import ImageUpload from '../components/ImageUpload';
import ImageGallery from '../components/ImageGallery';
import RatingInput from '../components/RatingInput';
import WineImage from '../components/WineImage';
import SimilarWinesModal from '../components/SimilarWinesModal';
import { WINE_TYPES } from '../config/wineTypes';
import './AddBottle.css';

function AddBottle() {
  const { t } = useTranslation();
  const { id: cellarId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1 = select wine, 2 = enter details
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [showTextSearch, setShowTextSearch] = useState(false);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiSearchError, setAiSearchError] = useState(null);
  // identify-text is read-only: it reports what the AI recognised and what the
  // registry already holds, and creates nothing. `aiIdentified` is UNSAVED data
  // (plain strings, no _id); only `aiMatch` and `aiCandidates[].wine` are real
  // registry documents. Accepting an unsaved suggestion goes through
  // resolveWine (also read-only); the wine is only minted when the BOTTLE is
  // committed (POST /api/bottles with `newWine`) — an abandoned form leaves
  // no orphan registry row.
  const [aiIdentified, setAiIdentified] = useState(null);
  const [aiMatch, setAiMatch] = useState(null);
  const [aiCandidates, setAiCandidates] = useState([]);
  const [selectedWine, setSelectedWine] = useState(null);
  // The not-yet-registered wine riding along to the bottle submit. When set,
  // `selectedWine` is a display-only stub WITHOUT `_id`; the first POST
  // /api/bottles carries this payload as `newWine` and mints exactly one wine,
  // whose id the remaining bottles of the batch then reference.
  const [pendingNewWine, setPendingNewWine] = useState(null);
  const [numBottles, setNumBottles] = useState(1);
  const [bottleData, setBottleData] = useState({
    vintage: '',
    price: '',
    currency: user?.preferences?.currency || 'USD',
    bottleSize: '750ml',
    purchaseDate: '',
    purchaseLocation: '',
    purchaseUrl: '',
    notes: '',
    occasion: '',
    drinkFrom: '',
    drinkTo: '',
    rating: '',
    ratingScale: user?.preferences?.ratingScale || '5',
    dateAdded: ''
  });
  const [addToHistory, setAddToHistory] = useState(false);
  const [historyData, setHistoryData] = useState({
    consumedAt: '',
    consumedReason: 'drank',
    consumedNote: '',
    consumedRating: '',
    consumedRatingScale: user?.preferences?.ratingScale || '5'
  });
  const [uploadedImages, setUploadedImages] = useState([]);
  // How many public photos the registry holds, KEYED BY WINE ID. A single
  // counter was wrong twice over: a passive reset effect runs a render late, so
  // the first commit after a wine switch painted the previous wine's answer
  // ("we already have a photo" for a wine that has none), and an out-of-order
  // response could overwrite the current wine's count with a stale one. Keying
  // makes both unrepresentable. Absent key = not fetched yet.
  const [wineImageCounts, setWineImageCounts] = useState({});
  const [showDetails, setShowDetails] = useState(false);

  // Whether the user has worked the toggle themselves. Auto-expanding is a
  // suggestion, not a policy — once someone closes the panel deliberately,
  // re-opening it under them is worse than leaving the fields hidden.
  const detailsTouchedRef = useRef(false);

  // Adding several bottles at once is precisely when missing these fields hurts:
  // the alternative is opening every bottle afterwards and typing the same note
  // again. A support ticket arrived describing exactly that, from someone who
  // never found the panel — so for a multi-bottle add we open it for them.
  useEffect(() => {
    if (numBottles > 1 && !detailsTouchedRef.current) setShowDetails(true);
  }, [numBottles]);
  const [saving, setSaving] = useState(false);
  // Bottles already created by earlier attempts of the current submission —
  // when POST k of N fails, a retry only creates the remaining N−k instead of
  // duplicating the whole batch. Reset whenever a new wine is selected.
  const createdBottlesRef = useRef([]);
  const imagesLinkedRef = useRef(false);

  // ── Scan result state ──
  const [scanResult, setScanResult] = useState(null);  // { extracted, match, labelImage, scanImageId }
  const [labelImage, setLabelImage] = useState(null);  // bg-removed data URL for display
  // Id of the stored ORIGINAL scan frame (never rendered — it rides the commit
  // so the minted wine keeps the label a curator may need to read).
  const [scanImageId, setScanImageId] = useState(null);
  // ── Back-label rescue ──
  // Offered ONLY when the front pass came back incomplete (`extracted.partial`)
  // or unreadable (a 422, which still hands back a scanImageId). Optional and
  // dismissible: skipping it must behave exactly as it did before this existed,
  // and the form stays fully editable throughout.
  const [backOffer, setBackOffer] = useState(false);
  const [backScanImageId, setBackScanImageId] = useState(null);
  // The cross-field rule id when the scanned producer looks like a place or
  // label text (v1.111.0); the ref holds the exact prefilled string so the
  // back-label rescue can replace it if — and only if — the user left it alone.
  const [producerSuspect, setProducerSuspect] = useState(null);
  const suspectProducerValueRef = useRef(null);
  // What the two labels disagreed about. Shown as a non-blocking note and
  // threaded to the commit as curation evidence.
  const [scanConflicts, setScanConflicts] = useState([]);
  const [showManualForm, setShowManualForm] = useState(false);
  const [pendingWineData, setPendingWineData] = useState(null);
  const [findingWine, setFindingWine] = useState(false);

  // ── Soft-zone "did you mean?" state ──
  // When the backend's find-or-create finds similar (but not auto-matching)
  // wines, it returns candidates instead of creating. We hold the user's
  // pending wineData so we can re-fire with confirmCreate: true if the
  // user picks "No, create new wine".
  const [softCandidates, setSoftCandidates] = useState(null);
  const [softPending, setSoftPending] = useState(null); // { wineData, carriedVintage }

  // ── Label-scan camera (shared hook) ──
  const handleScanSuccess = useCallback((data) => {
    setScanResult(data);
    setLabelImage(data.labelImage || null);
    // The server kept the original frame; carry its id through the flow so the
    // commit can stamp it on the wine. If the extraction was wrong, that photo
    // is what lets a curator fix the registry entry later.
    setScanImageId(data.scanImageId || null);
    // A HALF-READ label (one of name/producer empty) is a 200 now, not an
    // error: the back label is offered as an optional way to fill the rest.
    const partial = data.extracted?.partial === true;
    setBackOffer(partial);
    setBackScanImageId(null);
    setScanConflicts([]);
    // A SUSPECT producer (the box holds a place or label text, not a winery —
    // v1.111.0) is why this scan is partial even though every field is filled.
    // The flag drives a visible note, and the ref remembers the exact string
    // so a back-scan producer may REPLACE it — but only while the user hasn't
    // edited the box (their typing always outranks both labels).
    setProducerSuspect(data.extracted?.producer_suspect || null);
    suspectProducerValueRef.current = data.extracted?.producer_suspect
      ? (data.extracted.producer || '') : null;
    if (partial) {
      // Straight to the EDITABLE form, prefilled — never the read-only card
      // (release-audit M-1): the card renders a blank title and its confirm
      // button can only 400 on the missing name/country. The form's own
      // validation speaks the user's language, producer stays optional, and
      // the back-label offer sits right above it.
      const e = data.extracted || {};
      setPendingWineData({
        name: e.name || '',
        producer: e.producer || '',
        country: e.country || '',
        region: e.region || '',
        appellation: e.appellation || '',
        // Not a form field — rides invisibly into the commit payload so a
        // scanned classification line ("Grand Cru Classé en 1855") lands in
        // the registry's classification field instead of polluting the name.
        classification: e.classification || '',
        type: e.type || '',
        grapes: (e.grapes || []).join(', '),
      });
      setShowManualForm(true);
    } else {
      setShowManualForm(false);
      setPendingWineData(null);
    }
  }, []);

  const handleScanError = useCallback((msg, body) => {
    setError(msg);
    // An unreadable label still hands back the stored frame. Keep its id and
    // offer the back label: the user is about to type the wine by hand, that
    // manual entry mints a pending-identity row, and the photo is the only
    // thing a curator will have to work from.
    if (body?.scanImageId) {
      setScanImageId(body.scanImageId);
      setBackOffer(true);
    }
  }, []);

  /**
   * Merge a back-label reading into the form WITHOUT ever overwriting the user.
   *
   * The scan runs while the form is live, so anything they typed in the
   * meantime is a deliberate correction and outranks both labels. The server's
   * merge already settled front-vs-back (front wins, disagreements recorded);
   * this only fills what is still blank on screen.
   */
  const handleBackScanSuccess = useCallback((data) => {
    const merged = data.merged || {};
    setBackScanImageId(data.backScanImageId || null);
    setScanConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
    setBackOffer(false);
    setError(null);

    // The read-only scan card holds no user input — it shows the merged
    // identity and the re-run registry match wholesale.
    setScanResult(prev => (prev
      ? { ...prev, extracted: merged, match: data.match || null }
      : { extracted: merged, match: data.match || null, labelImage: null, scanImageId: null }));

    setPendingWineData(prev => {
      const fromMerged = {
        name: merged.name || '',
        producer: merged.producer || '',
        country: merged.country || '',
        region: merged.region || '',
        appellation: merged.appellation || '',
        classification: merged.classification || '',
        type: merged.type || '',
        grapes: (merged.grapes || []).join(', '),
      };
      // Nothing typed yet (the front scan 422'd and the user had not opened the
      // form) — seed it, so the rescue lands somewhere visible.
      if (!prev) return fromMerged;
      const next = { ...prev };
      for (const key of Object.keys(fromMerged)) {
        const typed = typeof prev[key] === 'string' ? prev[key].trim() : prev[key];
        if (!typed && fromMerged[key]) next[key] = fromMerged[key];
      }
      // A SUSPECT front producer is the one prefill the back label may
      // REPLACE (audit M-1: fill-blanks-only left the flagged string in the
      // box and made the rescue inert) — but only while the box still holds
      // the exact prefilled string; any edit by the user outranks both labels.
      if (suspectProducerValueRef.current
          && next.producer === suspectProducerValueRef.current
          && fromMerged.producer
          && fromMerged.producer !== next.producer) {
        next.producer = fromMerged.producer;
      }
      return next;
    });
    // The merge re-evaluates suspicion server-side; adopt its verdict.
    setProducerSuspect(merged.producer_suspect || null);
    suspectProducerValueRef.current = merged.producer_suspect ? (merged.producer || '') : null;
    setShowManualForm(prev => prev || !scanResult);
  }, [scanResult]);

  const {
    labelCam, labelScanning, labelFacing, setLabelFacing,
    labelVideoRef, labelCanvasRef,
    startCamera: startLabelCamera, startBackCamera: startBackLabelCamera,
    stopCamera: stopLabelCamera, capturePhoto: captureLabelPhoto
  } = useLabelScanner(apiFetch, {
    onScanSuccess: handleScanSuccess,
    onScanError: handleScanError,
    onBackScanSuccess: handleBackScanSuccess,
  });

  const startBackScan = useCallback(() => {
    startBackLabelCamera({
      frontExtracted: scanResult?.extracted || {},
      frontScanImageId: scanImageId,
    });
  }, [startBackLabelCamera, scanResult, scanImageId]);

  // Apply a resolved wine (from find-or-create OR from a soft-zone pick) and
  // advance to the bottle-details step. Centralised so all entry paths share
  // the same teardown.
  const clearAi = useCallback(() => {
    setAiIdentified(null);
    setAiMatch(null);
    setAiCandidates([]);
  }, []);

  const applyResolvedWine = useCallback((wine, carriedVintage) => {
    createdBottlesRef.current = [];
    imagesLinkedRef.current = false;
    setSelectedWine(wine);
    setPendingNewWine(null);
    setBottleData(prev => ({ ...prev, vintage: carriedVintage || '' }));
    setScanResult(null);
    setLabelImage(null);
    // The wine is already identified in the registry — its label scans have no
    // curation value, so they are dropped here and swept after 30 days. The
    // recorded front/back disagreement goes with them: it only ever explained
    // an identity nobody now has to fix.
    setScanImageId(null);
    setBackScanImageId(null);
    setScanConflicts([]);
    setBackOffer(false);
    setShowManualForm(false);
    setPendingWineData(null);
    setSoftCandidates(null);
    setSoftPending(null);
    clearAi();
    setStep(2);
  }, [clearAi]);

  // Advance to step 2 WITHOUT any registry write: the confirmed wine fields
  // ride along and are minted by POST /api/bottles when the user commits the
  // bottle (see submitBottles). selectedWine becomes a display-only stub.
  const applyPendingNewWine = useCallback((wineData, carriedVintage) => {
    createdBottlesRef.current = [];
    imagesLinkedRef.current = false;
    setPendingNewWine(wineData);
    setSelectedWine({ name: wineData.name, producer: wineData.producer, type: wineData.type });
    setBottleData(prev => ({ ...prev, vintage: carriedVintage || '' }));
    setScanResult(null);
    setLabelImage(null);
    // The scan ids and conflicts survive into step 2 — this is the path that
    // ends in a pendingIdentity mint, which is exactly who the evidence is for.
    setBackOffer(false);
    setShowManualForm(false);
    setPendingWineData(null);
    setSoftCandidates(null);
    setSoftPending(null);
    clearAi();
    setStep(2);
  }, [clearAi]);

  // Resolve confirmed wine data against the registry (READ-ONLY — nothing is
  // created in step 1 any more), handling the three response shapes: matched
  // wine, soft-zone candidates, or no match (→ the data rides to the commit).
  const resolveSelectedWine = useCallback(async (wineData, carriedVintage, opts = {}) => {
    setError(null);
    setFindingWine(true);
    try {
      const res = await resolveWine(apiFetch, wineData);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('addBottle.scanFailedToSaveWine'));
        return;
      }
      // queryLabel: quote what the USER typed in the modal, not the AI's
      // cleaned-up name, so the comparison reads the way they think of it.
      // A scan passes its own label — the search box may still hold whatever
      // was typed before the camera was opened.
      const queryLabel = opts.queryLabel || search.trim() || wineData.name;
      if (data.candidates && data.candidates.length > 0) {
        setSoftCandidates(data.candidates);
        setSoftPending({ wineData, carriedVintage, queryLabel });
        return;
      }
      if (data.wine) {
        applyResolvedWine(data.wine, carriedVintage);
        return;
      }
      // noMatch — but the label scan may have found a registry row this
      // resolve did not (the scan matcher looks from 0.75, the resolver's
      // "did you mean?" floor is 0.85). Ask instead of minting a duplicate.
      // The scan's match NEVER links by itself: it is one more candidate the
      // user picks, exactly like the resolver's own (issue #1134).
      if (opts.fallback?.wine) {
        setSoftCandidates([{ wine: opts.fallback.wine, score: opts.fallback.confidence || 0 }]);
        setSoftPending({ wineData, carriedVintage, queryLabel });
        return;
      }
      // Not in the registry. Nothing was minted — the fields carry forward
      // and POST /api/bottles creates the wine WITH the first bottle.
      applyPendingNewWine(wineData, carriedVintage);
    } catch {
      setError(t('addBottle.scanFailedToSaveWine'));
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, t, applyResolvedWine, applyPendingNewWine, search]);

  // Confirm scan result — resolve the wine and go to bottle details. The
  // label image is NOT part of the wine payload (the old find-or-create route
  // ignored it, and it must not bloat the bottle commit): bottle photos go
  // through the separate /api/images upload + link-to-bottle flow.
  //
  // Resolve on WHAT THE LABEL SAID — never on the matched row (issue #1134).
  // This used to substitute `match.wine`'s name/producer/appellation wholesale
  // whenever the scan matcher returned anything at all, which it does from
  // 0.75. The card above still showed `extracted.name`, so a wine filed under
  // its neighbour looked completely correct: a Mosel estate's Spätlese Alte
  // Reben, Auslese and Spätlese Feinherb all committed to the Feinherb row and
  // nothing on screen said so. Handing the scanned identity to the resolver
  // puts the decision back on the one ladder that has a visible answer for
  // every band — link at >=0.95, ASK between 0.85 and 0.95, and the scan's own
  // match offered below that (see resolveSelectedWine).
  const handleConfirmScan = useCallback(async () => {
    const { extracted, match } = scanResult;
    await resolveSelectedWine(
      {
        name: extracted.name,
        producer: extracted.producer,
        country: extracted.country || '',
        region: extracted.region || '',
        appellation: extracted.appellation || '',
        classification: extracted.classification || '',
        type: extracted.type || '',
        grapes: extracted.grapes || []
      },
      extracted.vintage,
      { fallback: match, queryLabel: extracted.name }
    );
  }, [scanResult, resolveSelectedWine]);

  // Switch to the editable manual form (user says "not the right wine")
  const handleNotRightWine = useCallback(() => {
    const { extracted } = scanResult;
    setPendingWineData({
      name: extracted.name || '',
      producer: extracted.producer || '',
      country: extracted.country || '',
      region: extracted.region || '',
      appellation: extracted.appellation || '',
      classification: extracted.classification || '',
      type: extracted.type || '',
      grapes: (extracted.grapes || []).join(', ')
    });
    setShowManualForm(true);
  }, [scanResult]);

  // Confirm from the manual edit form.
  // Producer is deliberately NOT required: an unreadable label used to be a
  // dead end here, and the whole point of the pending-identity flow is that the
  // bottle saves anyway. A producerless payload simply can't score a registry
  // match (producer is 45% of the dedup composite), so the resolve returns
  // noMatch and the commit mints a wine a curator completes.
  const handleConfirmManualWine = useCallback(async () => {
    if (!pendingWineData?.name?.trim() || !pendingWineData?.country?.trim()) {
      setError(t('addBottle.scanNameCountryRequired'));
      return;
    }
    const grapes = pendingWineData.grapes
      ? pendingWineData.grapes.split(',').map(g => g.trim()).filter(Boolean)
      : [];
    await resolveSelectedWine(
      { ...pendingWineData, grapes },
      scanResult?.extracted?.vintage
    );
  }, [pendingWineData, scanResult, t, resolveSelectedWine]);

  // Reset — back to search
  const handleScanReset = useCallback(() => {
    setScanResult(null);
    setLabelImage(null);
    setScanImageId(null);
    setBackScanImageId(null);
    setScanConflicts([]);
    setProducerSuspect(null);
    suspectProducerValueRef.current = null;
    setBackOffer(false);
    setShowManualForm(false);
    setPendingWineData(null);
    setError(null);
    clearAi();
  }, [clearAi]);

  // Explicit search (Enter key or button). Registry search ONLY — no AI.
  //
  // This used to fire identifyWineByText in parallel on every search, which
  // both spent AI budget per keystroke-batch and (before identify-text became
  // read-only) minted a registry wine for every guess, whether or not the user
  // took it. AI is now something the user asks for via the "Can't find your
  // wine?" row below, which also means the fast library results paint
  // immediately instead of waiting behind a slower AI call.
  const handleSearch = useCallback(() => {
    if (!search.trim()) { setWines([]); return; }
    const query = search.trim();
    setLoading(true);
    setAiSearchError(null);
    clearAi();

    searchWines(apiFetch, `search=${encodeURIComponent(query)}&limit=10`)
      .then(res => res.json())
      .then(data => { if (data.wines) setWines(data.wines); })
      .catch(err => console.error('Search failed:', err))
      .finally(() => setLoading(false));
  }, [search, apiFetch, clearAi]);

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleAiIdentify = async () => {
    if (!search.trim()) return;
    setAiSearching(true);
    setAiSearchError(null);
    clearAi();
    try {
      const res = await identifyWineByText(apiFetch, search.trim());
      const data = await res.json();
      if (!res.ok) { setAiSearchError(data.error || t('addBottle.identifyFailed')); return; }
      // Branch on `identified`, never on a wine: "the model recognised it but
      // the registry doesn't have it" is a SUCCESS, and is the common case.
      if (!data.identified) { setAiSearchError(t('addBottle.aiCouldNotIdentify')); return; }
      setAiIdentified(data.identified);
      setAiMatch(data.match?.wine || null);
      setAiCandidates(data.candidates || []);
    } catch {
      setAiSearchError(t('addBottle.identifyNetworkError'));
    } finally {
      setAiSearching(false);
    }
  };

  // Seed the (existing) manual edit form from the AI suggestion — used both by
  // "Not the right wine" and as the escape hatch when the model gave no country,
  // which find-or-create would reject.
  const editAiSuggestion = () => {
    if (!aiIdentified) return;
    setPendingWineData({
      name: aiIdentified.name || '',
      producer: aiIdentified.producer || '',
      country: aiIdentified.country || '',
      region: aiIdentified.region || '',
      appellation: aiIdentified.appellation || '',
      type: aiIdentified.type || '',
      grapes: (aiIdentified.grapes || []).join(', '),
      source: 'ai',
    });
    setShowManualForm(true);
  };

  const handleAcceptAiResult = () => {
    // Already in the registry — a pure selection, nothing is written.
    if (aiMatch) { handleSelectWine(aiMatch); return; }
    if (!aiIdentified) return;
    // No country means the eventual commit would 400; send the user to the
    // edit form to supply it rather than surfacing a server error.
    if (!aiIdentified.country) { editAiSuggestion(); return; }
    // Forward EVERY field, appellation included: it feeds normalizedKey, so
    // dropping it would both mint an appellation-less row and make the
    // resolve-time match score differently from the identify-time probe.
    // `source: 'ai'` rides with the payload to the commit, where it stamps
    // createdVia:'ai' (the resolve endpoint ignores it).
    resolveSelectedWine({
      name: aiIdentified.name,
      producer: aiIdentified.producer,
      country: aiIdentified.country,
      region: aiIdentified.region || '',
      appellation: aiIdentified.appellation || '',
      type: aiIdentified.type || '',
      grapes: aiIdentified.grapes || [],
      source: 'ai',
    });
  };

  const handleSelectWine = (wine) => {
    createdBottlesRef.current = [];
    imagesLinkedRef.current = false;
    setSelectedWine(wine);
    setPendingNewWine(null);
    setStep(2);
  };

  // The registry wine this scan matched, when it matched one. The scan card
  // used to read `match` only inside handleConfirmScan, so a matched scan and
  // an unmatched one looked identical and our existing photo was never shown —
  // the user re-photographed a wine we already had a picture of. Showing it
  // next to their own shot also makes a WRONG match obvious while they are
  // still holding the bottle, which is the cheapest correction signal we get.
  const scanMatchedWine = scanResult?.match?.wine || null;

  // A pending new wine has no _id, so there is no gallery to fetch — it is
  // definitionally photo-less and the encouraging copy applies straight away.
  const selectedWineId = selectedWine?._id || null;
  const wineImageCount = selectedWineId ? wineImageCounts[selectedWineId] : undefined;
  const registryHasPhotos = wineImageCount > 0;
  const photoPromptReady = !selectedWineId || wineImageCount !== undefined;

  // One row renderer for both the registry-search list and the AI near-match
  // list, so the two can never drift. Takes a SAVED wine only.
  const renderWineRow = (wine) => (
    <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectWine(wine); } }}>
      <WineImage image={wine.image} alt={wine.name} className="wine-row-image" wrapClass="wine-row-img-wrap" credit={wine.imageCredit} creditClass="wine-row-credit" wineType={wine.type} placeholder="wine-row-placeholder" />
      <div className="wine-info">
        <h3>{wine.name}</h3>
        <p className="producer">{wine.producer}</p>
        <div className="wine-meta">
          <span>{wine.country?.name}</span>
          {wine.region && <span>• {wine.region.name}</span>}
          <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
        </div>
        {wine.grapes?.length > 0 && (
          <p className="wine-grapes">{wine.grapes.map(g => g.displayName || g.name).join(', ')}</p>
        )}
      </div>
      <button className="btn btn-primary btn-small">{t('addBottle.selectBtn')}</button>
    </div>
  );

  // Link the uploaded images to the first created bottle. Called on full
  // success and after a partial failure, so bottles that were created keep
  // their images even when the batch didn't finish.
  const linkUploadedImages = () => {
    const first = createdBottlesRef.current[0];
    if (imagesLinkedRef.current || uploadedImages.length === 0 || !first) return;
    imagesLinkedRef.current = true;
    apiFetch('/api/images/link-to-bottle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bottleId: first._id,
        imageIds: uploadedImages.map(img => img._id)
      })
    }).catch(err => {
      imagesLinkedRef.current = false; // let a retry attempt the link again
      console.error('Failed to link images:', err);
    });
  };

  // Create the bottle records that are still missing. wineRef is EITHER
  // { wineId } (an existing registry wine) or { newWinePayload } — in the
  // latter case only the FIRST POST carries `newWine`: the backend mints (or
  // resolves) the wine inside that bottle create, and every later bottle of
  // the batch reuses the returned id. An N-bottle add therefore mints exactly
  // ONE wine, and a batch abandoned before this point mints nothing.
  // Callable from the form submit AND from the soft-zone modal (the rare
  // commit-time race below), so a modal answer finishes the add in one step.
  const submitBottles = async ({ wineId, newWinePayload }) => {
    // In-flight guard: the N sequential POSTs below leave a wide window
    // where a second submit (double-click, Enter+click) would duplicate
    // every bottle.
    if (saving) return;
    setSaving(true);
    setError(null);

    // A partial failure leaves invisible bottles behind — tell the user
    // exactly what happened and what a retry will do.
    const partialError = (msg, done) => done > 0
      ? t('addBottle.partialAdded', { msg, count: done, total: numBottles, remaining: numBottles - done })
      : msg;

    try {
      const base = {
        cellar: cellarId,
        ...bottleData,
        price: bottleData.price ? parseFloat(bottleData.price) : undefined,
        occasion: bottleData.occasion || undefined,
        drinkFrom: bottleData.drinkFrom ? parseInt(bottleData.drinkFrom, 10) : undefined,
        drinkTo: bottleData.drinkTo ? parseInt(bottleData.drinkTo, 10) : undefined,
        rating: bottleData.rating ? parseFloat(bottleData.rating) : undefined,
        ratingScale: bottleData.ratingScale || '5',
        dateAdded: bottleData.dateAdded || undefined,
        addToHistory: addToHistory || undefined,
        ...(addToHistory ? {
          consumedAt: historyData.consumedAt || undefined,
          consumedReason: historyData.consumedReason,
          consumedNote: historyData.consumedNote || undefined,
          consumedRating: historyData.consumedRating ? parseFloat(historyData.consumedRating) : undefined,
          consumedRatingScale: historyData.consumedRatingScale || '5'
        } : {})
      };

      // createdBottlesRef carries the bottles a previous, partially-failed
      // attempt already created, so a retry never duplicates them — and if
      // that first attempt already minted the wine, its id is reused here
      // rather than sending `newWine` again.
      const createdBottles = createdBottlesRef.current;
      let wineRefId = wineId
        || createdBottles[0]?.wineDefinition?._id
        || (typeof createdBottles[0]?.wineDefinition === 'string' ? createdBottles[0].wineDefinition : undefined);

      for (let i = createdBottles.length; i < numBottles; i++) {
        const payload = wineRefId
          ? { ...base, wineDefinition: wineRefId }
          // The scan evidence rides here, at the ONE place a newWine payload is
          // sent, so every entry path (scan confirm, manual form, soft-zone
          // "create new") carries it without each remembering to. All three
          // parts travel together: the front frame, the optional back frame,
          // and what the two labels disagreed about.
          : { ...base, newWine: {
            ...newWinePayload,
            ...(scanImageId ? { scanImageId } : {}),
            ...(backScanImageId ? { scanImageBackId: backScanImageId } : {}),
            ...(scanConflicts.length > 0 ? { scanConflicts } : {}),
          } };
        const res = await apiFetch('/api/bottles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok && data.candidates && data.candidates.length > 0) {
          // Commit-time soft zone: a very similar wine entered the registry
          // between the step-1 resolve and this submit. NOTHING was created —
          // re-open the "did you mean?" modal; its answer resumes this batch.
          setSoftCandidates(data.candidates);
          setSoftPending({ forCommit: true, queryLabel: newWinePayload?.name });
          return;
        }
        if (!res.ok) {
          setError(partialError(data.error || t('addBottle.addFailed'), createdBottles.length));
          // Release-audit MEDIUM: a mint-gate 400 ("Riquewihr is a village,
          // not a producer") lands here AFTER the wine form is gone. When the
          // failed POST carried newWine and nothing was created yet, reopen
          // step 1's manual form seeded with the typed fields so the user
          // fixes the named field instead of retyping the wine from scratch.
          if (newWinePayload && createdBottles.length === 0) {
            setPendingWineData({ ...newWinePayload, grapes: (newWinePayload.grapes || []).join(', ') });
            setShowManualForm(true);
            setStep(1);
          }
          // The alert renders at the top of a long form — without the scroll
          // a failed submit reads as "the button did nothing" (audit LOW).
          window.scrollTo(0, 0);
          linkUploadedImages();
          return;
        }
        createdBottles.push(data.bottle);
        if (!wineRefId) {
          // First bottle of a newWine batch — every remaining bottle
          // references the wine this create just minted/resolved.
          wineRefId = data.bottle?.wineDefinition?._id || data.bottle?.wineDefinition;
        }
      }

      // Link uploaded images to the first bottle
      linkUploadedImages();
      navigate(`/cellars/${cellarId}`);
    } catch (err) {
      setError(partialError(t('common.networkError'), createdBottlesRef.current.length));
      linkUploadedImages();
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    // Client-side validation for the personal drink window + occasion —
    // mirrors the backend rules (integer years 1900–2200, from ≤ to, ≤500 chars).
    const windowError = validateDrinkWindowFields(bottleData, t);
    if (windowError) { setError(windowError); return; }

    await submitBottles(pendingNewWine
      ? { newWinePayload: pendingNewWine }
      : { wineId: selectedWine._id });
  };

  // Adding bottles is not available in the demo (backend enforces via
  // requireNonDemo on POST /api/bottles). Show a friendly sign-up nudge instead
  // of the form if a demo visitor navigates here directly. The persistent
  // DemoBanner already carries the "create your own cellar" CTA.
  if (user?.isDemo) {
    return (
      <div className="add-bottle-page">
        <div className="card add-bottle-demo-block">
          <h2>{t('demo.noAddTitle')}</h2>
          <p>{t('demo.noAddBody')}</p>
          <Link to={`/cellars/${cellarId}`} className="btn btn-primary">{t('demo.backToCellar')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="add-bottle-page">
      {/* Label-scan camera modal */}
      {labelCam.open && (
        <div className="camera-modal">
          <div className="camera-container">
            {labelCam.error ? (
              <div className="camera-error-overlay">
                <p>{labelCam.error}</p>
                <button type="button" className="btn btn-secondary" onClick={stopLabelCamera}>Close</button>
              </div>
            ) : (
              <>
                <video ref={labelVideoRef} autoPlay playsInline muted className="camera-video" />
                {labelScanning ? (
                  <div className="label-scan-overlay">
                    <div className="label-scan-spinner" />
                    <span>{t('addBottle.scanReading')}</span>
                  </div>
                ) : (
                  <>
                    <div className="camera-overlay">
                      <div className="label-guide-frame" />
                      <p className="overlay-hint">{t('addBottle.scanHint')}</p>
                    </div>
                    <div className="camera-controls">
                      <button type="button" className="camera-btn camera-btn-close" onClick={stopLabelCamera} aria-label="Close camera">✕</button>
                      <button type="button" className="camera-btn camera-btn-capture" onClick={captureLabelPhoto} aria-label="Scan label">
                        <span className="capture-ring" aria-hidden="true"></span>
                      </button>
                      <button type="button" className="camera-btn camera-btn-switch" onClick={() => setLabelFacing(f => f === 'environment' ? 'user' : 'environment')} aria-label="Switch camera">⟲</button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <canvas ref={labelCanvasRef} style={{ display: 'none' }} />
        </div>
      )}

      <div className="add-bottle-header">
        <Link to={`/cellars/${cellarId}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          {t('addBottle.backToCellar')}
        </Link>
        <h1>{t('addBottle.title')}</h1>
      </div>

      <div className="steps-indicator">
        <div className={`step ${step >= 1 ? 'active' : ''}`}>
          <div className="step-number">1</div>
          <span>{t('addBottle.stepSelectWine')}</span>
        </div>
        <div className="step-divider"></div>
        <div className={`step ${step >= 2 ? 'active' : ''}`}>
          <div className="step-number">2</div>
          <span>{t('addBottle.stepBottleDetails')}</span>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {step === 1 && (
        <div className="card">
          {/* ── Back-label rescue ─────────────────────────────────────────
              Appears ONLY after a front scan that read half a label or none
              of it. Optional in the strongest sense: "Skip" dismisses it,
              every field below stays editable while it is on screen, and
              ignoring it leaves the flow exactly as it was. ── */}
          {backOffer && !labelCam.open && (
            <div className="scan-back-prompt">
              <p className="scan-back-prompt-text">{t('addBottle.backScanPrompt')}</p>
              <div className="scan-back-prompt-actions">
                <button type="button" className="btn btn-secondary" onClick={startBackScan}>
                  {t('addBottle.backScanCta')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setBackOffer(false)}>
                  {t('addBottle.backScanSkip')}
                </button>
              </div>
            </div>
          )}

          {/* Non-blocking: the front value was kept, and saying so is what
              stops a user re-typing a field that is already right. */}
          {scanConflicts.length > 0 && (
            <p className="scan-back-conflicts">
              {t('addBottle.backScanConflicts', {
                fields: scanConflicts.map(c => c.field).join(', '),
              })}
            </p>
          )}

          {/* WHY this scan is partial when every box is filled (audit M-2):
              the producer looks like label text, not a winery. Says which box
              to check; never blocks anything. */}
          {producerSuspect && (
            <p className="scan-back-conflicts">
              {t('addBottle.producerSuspectNote')}
            </p>
          )}

          {/* ── Scan result: unified wine card ──────────────────────────── */}
          {scanResult && !showManualForm && (
            <div className="scan-wine-card">
              <div className={`scan-wine-image-wrap${scanMatchedWine?.image ? ' scan-wine-image-wrap--compare' : ''}`}>
                <figure className="scan-wine-shot">
                  {/* Wrapped so both shots have an identically sized slot: a
                      failed image is hidden by WineImage's onError, and without
                      a fixed box its column would collapse and knock the two
                      captions off one baseline. */}
                  <div className="scan-wine-shot-img-wrap">
                    {labelImage
                      ? <img src={labelImage} alt={scanResult.extracted.name} className="scan-wine-label-img" />
                      : <div className={`wine-row-placeholder scan-wine-placeholder ${scanResult.extracted.type || 'unknown'}`} />
                    }
                  </div>
                  {scanMatchedWine?.image && (
                    <figcaption className="scan-wine-shot-caption">{t('addBottle.scanYourPhoto')}</figcaption>
                  )}
                </figure>
                {scanMatchedWine?.image && (
                  <figure className="scan-wine-shot">
                    <WineImage
                      image={scanMatchedWine.image}
                      alt={scanMatchedWine.name}
                      className="scan-wine-label-img"
                      wrapClass="scan-wine-shot-img-wrap"
                      credit={scanMatchedWine.imageCredit}
                      creditClass="wine-row-credit"
                      wineType={scanMatchedWine.type}
                      placeholder="wine-row-placeholder scan-wine-placeholder"
                    />
                    <figcaption className="scan-wine-shot-caption">{t('addBottle.scanRegistryPhoto')}</figcaption>
                  </figure>
                )}
              </div>
              <div className="scan-wine-body">
                {/* NAMES the matched row (issue #1134). It used to read only
                    "Already in the registry" while the card showed the scanned
                    name — so a wine about to be filed under its neighbour in
                    the same range looked perfect. The registry-photo compare
                    beside it is the other half of the answer, and small
                    estates have no photo, which left this badge as the only
                    signal there was a match at all. */}
                {scanMatchedWine && (
                  <div className="ai-result-badge scan-wine-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 8 0"/><path d="M17 12H7"/></svg>
                    {t('addBottle.scanRegistryMatch', {
                      name: scanMatchedWine.name,
                      percent: Math.round((scanResult.match?.confidence || 0) * 100),
                    })}
                  </div>
                )}
                <h2 className="scan-wine-name">{scanResult.extracted.name}</h2>
                <p className="scan-wine-producer">{scanResult.extracted.producer}</p>
                {scanResult.extracted.confidence != null && (
                  <div style={{ marginBottom: '0.5rem' }}>
                    <span className="scan-confidence">
                      {Math.round(scanResult.extracted.confidence * 100)}% confident
                    </span>
                  </div>
                )}
                <div className="wine-meta" style={{ marginBottom: '0.5rem' }}>
                  {scanResult.extracted.country && <span>{scanResult.extracted.country}</span>}
                  {scanResult.extracted.region && <span>• {scanResult.extracted.region}</span>}
                  {scanResult.extracted.appellation && <span>• {scanResult.extracted.appellation}</span>}
                  <span className={`wine-type-pill ${scanResult.extracted.type || 'unknown'}`}>
                    {scanResult.extracted.type || t('common.unknown')}
                  </span>
                </div>
                {scanResult.extracted.grapes?.length > 0 && (
                  <p className="wine-grapes">{scanResult.extracted.grapes.join(', ')}</p>
                )}
                {scanResult.extracted.vintage && (
                  <p className="scan-vintage-note">
                    {t('addBottle.scanVintageDetected', { year: scanResult.extracted.vintage })}
                  </p>
                )}
                <div className="scan-wine-actions">
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={handleConfirmScan}
                    disabled={findingWine}
                  >
                    {findingWine ? t('addBottle.scanSaving') : t('addBottle.scanConfirmWine')}
                  </button>
                  <button type="button" className="btn-not-right" onClick={handleNotRightWine}>
                    {t('addBottle.scanNotRight')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Scan result: manual edit form (user said "not the right wine") ── */}
          {/* Manual edit form. No longer gated on scanResult: the AI-suggestion
              card reuses it for "Not the right wine" and for supplying a
              country the model didn't give. */}
          {showManualForm && pendingWineData && (
            <div className="scan-result-panel">
              {labelImage && (
                <div className="scan-manual-image-wrap">
                  <img src={labelImage} alt="" className="scan-manual-label-img" />
                </div>
              )}
              <div className="grid-2">
                <div className="form-group">
                  <label>{t('addBottle.scanWineName')} *</label>
                  <input type="text" value={pendingWineData.name}
                    onChange={e => setPendingWineData(p => ({ ...p, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  {/* No `*` and no `required`: an unreadable producer must not
                      block the add. The bottle saves; the wine goes to the
                      sommelier queue and comes back completed. */}
                  <label>{t('addBottle.scanProducer')}</label>
                  <input type="text" value={pendingWineData.producer}
                    placeholder={t('addBottle.scanProducerOptionalPlaceholder')}
                    onChange={e => setPendingWineData(p => ({ ...p, producer: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanCountry')} *</label>
                  <input type="text" value={pendingWineData.country}
                    onChange={e => setPendingWineData(p => ({ ...p, country: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanRegion')}</label>
                  <input type="text" value={pendingWineData.region}
                    onChange={e => setPendingWineData(p => ({ ...p, region: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanAppellation')}</label>
                  <input type="text" value={pendingWineData.appellation}
                    onChange={e => setPendingWineData(p => ({ ...p, appellation: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanType')}</label>
                  <select value={pendingWineData.type}
                    onChange={e => setPendingWineData(p => ({ ...p, type: e.target.value }))}>
                    {/* Unknown is a real answer: the scan and the AI now return
                        null rather than defaulting to red (ticket 6a85ad44), so
                        the form must be able to carry that through instead of
                        making the user pick a colour to get past it. */}
                    <option value="">{t('common.unknown')}</option>
                    {WINE_TYPES.map(wt => <option key={wt} value={wt}>{wt}</option>)}
                  </select>
                </div>
                <div className="form-group form-group-full">
                  <label>{t('addBottle.scanGrapes')}</label>
                  <input type="text" value={pendingWineData.grapes}
                    onChange={e => setPendingWineData(p => ({ ...p, grapes: e.target.value }))}
                    placeholder={t('addBottle.scanGrapesPlaceholder')} />
                </div>
              </div>
              <div className="scan-result-actions">
                <button type="button" className="btn btn-success" onClick={handleConfirmManualWine} disabled={findingWine}>
                  {findingWine ? t('addBottle.scanSaving') : t('addBottle.scanConfirmWine')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={handleScanReset}>
                  {t('addBottle.scanSearchManually')}
                </button>
              </div>
            </div>
          )}

          {/* ── Camera-first prompt ──────────────────────────────────────── */}
          {!scanResult && !showTextSearch && !showManualForm && !labelCam.open && (
            <div className="wine-select-default">
              <div className="camera-prompt-card">
                <svg className="camera-prompt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <h2>{t('addBottle.scanPromptTitle', 'Scan the wine label')}</h2>
                <p className="camera-prompt-hint">
                  {t('addBottle.scanPromptHint', 'Take a photo of the label — we\'ll identify the wine and add it to the registry if it doesn\'t exist yet.')}
                </p>
                <button type="button" className="btn btn-primary" onClick={startLabelCamera}>
                  {t('addBottle.startCamera', 'Start Camera')}
                </button>
              </div>
              <button type="button" className="wine-select-manual-link" onClick={() => setShowTextSearch(true)}>
                {t('addBottle.searchManuallyInstead', 'No camera? Search manually instead →')}
              </button>
            </div>
          )}

          {/* ── Manual text search ───────────────────────────────────────── */}
          {!scanResult && showTextSearch && !showManualForm && (
            <>
              <div className="wine-select-manual-header">
                <h2>{t('addBottle.searchForWine')}</h2>
                <button type="button" className="btn-link-muted" onClick={() => { setShowTextSearch(false); setSearch(''); setWines([]); setAiSearchError(null); }}>
                  ← {t('addBottle.useCameraInstead', 'Use camera instead')}
                </button>
              </div>
              <p className="wine-search-hint">
                {t('addBottle.searchHint', 'Be as specific as possible — include the wine name and producer. We\'ll search our library first; if nothing matches, you can ask AI to identify it.')}
              </p>
              <div className="search-section">
                <div className="search-input-wrapper">
                  <input
                    type="text"
                    placeholder={t('addBottle.searchPlaceholder')}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setWines([]); setAiSearchError(null); setError(null); clearAi(); }}
                    onKeyDown={handleSearchKeyDown}
                    className="search-input-large"
                    autoFocus
                  />
                  <button type="button" className="btn btn-secondary search-submit-btn" onClick={handleSearch} disabled={loading}>
                    {loading ? '…' : t('addBottle.searchBtn', 'Search')}
                  </button>
                </div>
              </div>

              {loading && <p>{t('addBottle.searching')}</p>}

              {/* ── AI result card. Shape-aware: `card` is EITHER a saved
                   registry wine (populated country/region/grape refs) OR the
                   AI's unsaved suggestion (plain strings). Reading .name off a
                   string would render blanks, so normalise both here. ── */}
              {(aiMatch || aiIdentified) && !aiSearching && (() => {
                const card = aiMatch || aiIdentified;
                const isRegistryWine = Boolean(aiMatch);
                const countryName = typeof card.country === 'string' ? card.country : card.country?.name;
                const regionName = typeof card.region === 'string' ? card.region : card.region?.name;
                const grapeNames = (card.grapes || [])
                  .map(g => (typeof g === 'string' ? g : g?.name))
                  .filter(Boolean);
                return (
                  <div className="ai-result-card">
                    <div className="ai-result-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 8 0"/><path d="M17 12H7"/></svg>
                      {isRegistryWine ? t('addBottle.aiFoundWine') : t('addBottle.aiIdentifiedTitle')}
                    </div>
                    <p className="wine-search-hint">
                      {isRegistryWine ? t('addBottle.aiMatchHint') : t('addBottle.aiIdentifiedHint')}
                    </p>
                    <div className="ai-result-wine">
                      <WineImage image={card.image} alt={card.name} className="wine-row-image" wrapClass="wine-row-img-wrap" credit={card.imageCredit} creditClass="wine-row-credit" wineType={card.type} placeholder="wine-row-placeholder" />
                      <div className="wine-info">
                        <h3>{card.name}</h3>
                        <p className="producer">{card.producer}</p>
                        <div className="wine-meta">
                          {countryName && <span>{countryName}</span>}
                          {regionName && <span>• {regionName}</span>}
                          {card.appellation && <span>• {card.appellation}</span>}
                          <span className={`wine-type-pill ${card.type || 'unknown'}`}>{card.type || t('common.unknown')}</span>
                        </div>
                        {grapeNames.length > 0 && (
                          <p className="wine-grapes">{grapeNames.join(', ')}</p>
                        )}
                        {!isRegistryWine && card.confidence != null && (
                          <span className="scan-confidence">{t('addBottle.aiConfidence', { percent: Math.round(card.confidence * 100) })}</span>
                        )}
                      </div>
                    </div>
                    <div className="ai-result-actions">
                      {/* Busy state is load-bearing: this is now an async
                          registry write, and a double-tap could otherwise
                          create two rows. */}
                      <button
                        type="button"
                        className={`btn ${aiCandidates.length > 0 ? 'btn-secondary' : 'btn-success'}`}
                        onClick={handleAcceptAiResult}
                        disabled={findingWine}
                      >
                        {findingWine
                          ? t('addBottle.scanSaving')
                          : (isRegistryWine ? t('addBottle.aiUseThisWine') : t('addBottle.aiAddAndUse'))}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={isRegistryWine ? clearAi : editAiSuggestion} disabled={findingWine}>
                        {t('addBottle.scanNotRight')}
                      </button>
                      <Link to="/wine-requests" className="btn btn-ghost">
                        {t('addBottle.requestWineInstead')}
                      </Link>
                    </div>
                  </div>
                );
              })()}

              {/* ── Near-matches already in the registry. Picking one is a pure
                   read — this is what stops a near-duplicate being minted. ── */}
              {aiCandidates.length > 0 && !aiSearching && (
                <div className="wines-list">
                  <h3 className="wine-select-subheading">{t('addBottle.aiSimilarTitle')}</h3>
                  {aiCandidates.map(c => renderWineRow(c.wine))}
                </div>
              )}

              {/* ── Search results list. Never hidden by the AI card any more:
                   hiding it is how the AI's guess used to beat the correct
                   registry row. Rows already shown above are filtered out. ── */}
              {!aiSearching && wines.length > 0 && (
                <div className="wines-list">
                  {wines
                    .filter(w => String(w._id) !== String(aiMatch?._id)
                      && !aiCandidates.some(c => String(c.wine?._id) === String(w._id)))
                    .map(wine => renderWineRow(wine))}
                </div>
              )}

              {/* ── "Can't find your wine?" row — the AI entry point ── */}
              {!loading && search.trim() && !aiIdentified && !aiMatch && !aiSearching && (
                <div className="ai-search-row" onClick={!aiSearching ? handleAiIdentify : undefined} role="button" tabIndex={0} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !aiSearching) { e.preventDefault(); handleAiIdentify(); } }}>
                  <div className="ai-search-row-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      <path d="M11 8a3 3 0 0 1 3 3" opacity="0.5"/>
                    </svg>
                  </div>
                  <div className="ai-search-row-body">
                    <span className="ai-search-row-title">{t('addBottle.cantFindAiTitle')}</span>
                    <span className="ai-search-row-hint">{t('addBottle.cantFindAiHint')}</span>
                  </div>
                  <svg className="ai-search-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
              )}

              {/* ── AI searching spinner ── */}
              {aiSearching && (
                <div className="ai-searching-state">
                  <div className="ai-searching-spinner" />
                  <p>{t('addBottle.aiSearching')}</p>
                </div>
              )}

              {/* ── AI error with request fallback ── */}
              {aiSearchError && !aiSearching && (
                <div className="ai-error-state">
                  <p className="error-text">{aiSearchError}</p>
                  <Link to="/wine-requests" className="btn btn-secondary btn-small">
                    {t('addBottle.submitWineRequest')}
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && selectedWine && (
        <div className="card">
          {/* Selected wine — compact summary bar */}
          <div className="selected-wine-bar">
            {/* Via WineImage, not a bare <img>: a stored value that is a bare
                filename or an /api/… path against a cross-origin API_URL needs
                getWineImageUrl to resolve, and a raw src silently hid itself
                on error instead. Every other wine thumbnail goes through this. */}
            <WineImage
              image={selectedWine.image}
              alt={selectedWine.name}
              className="selected-wine-bar-img"
            />
            <div className="selected-wine-bar-info">
              <strong className="selected-wine-bar-name">{selectedWine.name}</strong>
              <span className="selected-wine-bar-producer">{selectedWine.producer}</span>
            </div>
            <button type="button" onClick={() => setStep(1)} className="btn btn-ghost btn-small">
              {t('addBottle.changeWine')}
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {/* ── Core fields ── */}
            <div className="grid-2" style={{ marginTop: '1.25rem' }}>
              <div className="form-group">
                <label>{t('common.vintage')} *</label>
                <input
                  type="text"
                  value={bottleData.vintage}
                  onChange={(e) => setBottleData({ ...bottleData, vintage: e.target.value })}
                  placeholder={t('addBottle.vintagePlaceholder')}
                  pattern="^(?:[Nn][Vv]|[Uu]nknown|(?:19|20)\d{2})$"
                  title={t('addBottle.vintagePattern')}
                  maxLength={7}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.numberOfBottles')}</label>
                <input
                  type="number"
                  value={numBottles}
                  onChange={(e) => setNumBottles(Math.max(1, parseInt(e.target.value) || 1))}
                  onFocus={(e) => e.target.select()}
                  min="1"
                  required
                />
              </div>

              <div className="form-group">
                <label>{t('common.price')}</label>
                <input
                  type="number"
                  step="0.01"
                  value={bottleData.price}
                  onChange={(e) => setBottleData({ ...bottleData, price: e.target.value })}
                  placeholder="0.00"
                />
                {(() => {
                  const warns = validatePriceSanity({
                    price: parseFloat(bottleData.price),
                    currency: bottleData.currency || 'USD',
                  });
                  if (warns.length === 0) return null;
                  return (
                    <ul className="price-warnings">
                      {warns.map(w => (
                        <li key={w.code} className={`price-warning price-warning--${w.severity}`}>
                          {t(`addBottle.priceWarning.${w.code}`, w.context)}
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </div>

              <div className="form-group">
                <label>{t('common.currency')}</label>
                <select
                  value={bottleData.currency}
                  onChange={(e) => setBottleData({ ...bottleData, currency: e.target.value })}
                >
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label>{t('addBottle.bottleSize')}</label>
                <select
                  value={bottleData.bottleSize}
                  onChange={(e) => setBottleData({ ...bottleData, bottleSize: e.target.value })}
                >
                  {BOTTLE_SIZES.map((s) => (
                    <option key={s.code} value={s.code}>{bottleSizeLabel(s.code, t)}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>{t('addBottle.ratingLabel')}</label>
                <RatingInput
                  value={bottleData.rating}
                  scale={bottleData.ratingScale}
                  onChange={v => setBottleData({ ...bottleData, rating: v ?? '' })}
                  onScaleChange={s => setBottleData({ ...bottleData, ratingScale: s, rating: '' })}
                  allowScaleOverride
                />
              </div>
            </div>

            {/* ── Bottle photo — compact section ── */}
            <div className="photo-section">
              <div className="photo-section-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="photo-section-icon">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <span className="photo-section-title">{t('addBottle.bottlePhotos')}</span>
              </div>
              {/* What the registry already holds for this wine. Shown BEFORE the
                  uploader so a user who would have re-photographed a wine we can
                  already illustrate can see that first. The prompt is softened,
                  never removed: ~89% of the registry's official images started
                  as a user's bottle photo, and most wines still have none. */}
              {selectedWineId && (
                // The wrapper's margin is applied only when something rendered:
                // ImageGallery returns null while loading and when empty, and
                // most wines have no photo, so an unconditional class left a
                // gap in the common case. Keyed so a wine switch remounts.
                <div className={registryHasPhotos ? 'photo-existing' : undefined}>
                  <ImageGallery
                    key={selectedWineId}
                    wineDefinitionId={selectedWineId}
                    size="small"
                    onLoaded={(count) => setWineImageCounts(prev => ({ ...prev, [selectedWineId]: count }))}
                  />
                </div>
              )}
              {photoPromptReady && (
                <p className="photo-section-lead">
                  {registryHasPhotos ? t('addBottle.photosExisting') : t('addBottle.photosNone')}
                </p>
              )}
              <ImageUpload
                wineDefinitionId={selectedWine?._id}
                onUploadComplete={(img) => setUploadedImages(prev => [...prev, img])}
              />
              <p className="photo-section-notice">{t('addBottle.photosNotice')}</p>
            </div>

            {/* ── More details toggle ── */}
            <button
              type="button"
              className={`details-toggle ${showDetails ? 'details-toggle--open' : ''}`}
              onClick={() => { detailsTouchedRef.current = true; setShowDetails(v => !v); }}
            >
              <span>{showDetails ? t('addBottle.hideDetails') : t('addBottle.showDetails')}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="details-toggle-chevron">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* ── Collapsible: purchase info, notes, drink window ── */}
            {showDetails && (
              <div className="details-panel">
                {/* Both the reporter of the support ticket and the maintainer
                    independently assumed a note would land on only one of the
                    bottles. It goes on all of them — but nothing said so, and a
                    field people believe won't work is a field they don't use. */}
                {numBottles > 1 && (
                  <p className="details-applies-all">
                    {t('addBottle.detailsApplyToAll', { count: numBottles })}
                  </p>
                )}
                <div className="grid-2">
                  <div className="form-group">
                    <label>{t('addBottle.purchaseDate')}</label>
                    <input
                      type="date"
                      value={bottleData.purchaseDate}
                      onChange={(e) => setBottleData({ ...bottleData, purchaseDate: e.target.value })}
                    />
                  </div>

                  <div className="form-group">
                    <label>{t('addBottle.purchaseLocation')}</label>
                    <input
                      type="text"
                      value={bottleData.purchaseLocation}
                      onChange={(e) => setBottleData({ ...bottleData, purchaseLocation: e.target.value })}
                      placeholder={t('addBottle.purchaseLocationPlaceholder')}
                    />
                  </div>

                  <div className="form-group form-group-full">
                    <label>{t('addBottle.purchaseUrl')}</label>
                    <input
                      type="url"
                      value={bottleData.purchaseUrl}
                      onChange={(e) => setBottleData({ ...bottleData, purchaseUrl: e.target.value })}
                      placeholder="https://..."
                    />
                  </div>

                  <div className="form-group form-group-full">
                    <label>{t('addBottle.dateAdded')}</label>
                    <input
                      type="date"
                      value={bottleData.dateAdded}
                      onChange={(e) => setBottleData({ ...bottleData, dateAdded: e.target.value })}
                    />
                    <p className="help-text">{t('addBottle.dateAddedHint')}</p>
                  </div>
                </div>

                <div className="form-group">
                  <label>{t('common.notes')}</label>
                  <textarea
                    value={bottleData.notes}
                    onChange={(e) => setBottleData({ ...bottleData, notes: e.target.value })}
                    placeholder={t('addBottle.notesPlaceholder')}
                    rows="3"
                  />
                </div>

                <div className="form-group">
                  <label>{t('addBottle.occasion')}</label>
                  <input
                    type="text"
                    value={bottleData.occasion}
                    onChange={(e) => setBottleData({ ...bottleData, occasion: e.target.value })}
                    placeholder={t('addBottle.occasionPlaceholder')}
                    maxLength={500}
                  />
                  <p className="help-text">{t('addBottle.occasionHint')}</p>
                </div>

                {/* ── Personal drink window ── */}
                <div className="form-group">
                  <label>{t('addBottle.drinkWindow')}</label>
                  <div className="grid-2">
                    <div className="form-group">
                      <label>{t('addBottle.drinkFrom')}</label>
                      <input
                        type="number"
                        value={bottleData.drinkFrom}
                        onChange={(e) => setBottleData({ ...bottleData, drinkFrom: e.target.value })}
                        placeholder={t('addBottle.drinkFromPlaceholder')}
                        min={DRINK_YEAR_MIN}
                        max={DRINK_YEAR_MAX}
                        step="1"
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('addBottle.drinkTo')}</label>
                      <input
                        type="number"
                        value={bottleData.drinkTo}
                        onChange={(e) => setBottleData({ ...bottleData, drinkTo: e.target.value })}
                        placeholder={t('addBottle.drinkToPlaceholder')}
                        min={DRINK_YEAR_MIN}
                        max={DRINK_YEAR_MAX}
                        step="1"
                      />
                    </div>
                  </div>
                  <p className="help-text">{t('addBottle.drinkWindowHint')}</p>
                </div>

                {/* ── Add to History ── */}
                <div className="add-to-history-section">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={addToHistory}
                      onChange={(e) => setAddToHistory(e.target.checked)}
                    />
                    <span>{t('addBottle.addToHistory')}</span>
                  </label>
                  <p className="help-text">{t('addBottle.addToHistoryHint')}</p>
  
                  {addToHistory && (
                    <div className="history-fields">
                      <div className="grid-2">
                        <div className="form-group">
                          <label>{t('addBottle.consumedReason')}</label>
                          <select
                            value={historyData.consumedReason}
                            onChange={(e) => setHistoryData({ ...historyData, consumedReason: e.target.value })}
                          >
                            <option value="drank">{t('history.reasonDrank')}</option>
                            <option value="gifted">{t('history.reasonGifted')}</option>
                            <option value="sold">{t('history.reasonSold')}</option>
                            <option value="other">{t('history.reasonOther')}</option>
                          </select>
                        </div>
  
                        <div className="form-group">
                          <label>{t('addBottle.consumedDate')}</label>
                          <input
                            type="date"
                            value={historyData.consumedAt}
                            onChange={(e) => setHistoryData({ ...historyData, consumedAt: e.target.value })}
                          />
                        </div>
  
                        <div className="form-group">
                          <label>{t('addBottle.consumedRating')}</label>
                          <RatingInput
                            value={historyData.consumedRating}
                            scale={historyData.consumedRatingScale}
                            onChange={v => setHistoryData({ ...historyData, consumedRating: v ?? '' })}
                            onScaleChange={s => setHistoryData({ ...historyData, consumedRatingScale: s, consumedRating: '' })}
                            allowScaleOverride
                          />
                        </div>
                      </div>
  
                      <div className="form-group">
                        <label>{t('addBottle.consumedNote')}</label>
                        <textarea
                          value={historyData.consumedNote}
                          onChange={(e) => setHistoryData({ ...historyData, consumedNote: e.target.value })}
                          placeholder={t('addBottle.consumedNotePlaceholder')}
                          rows="3"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="form-actions">
              <button type="submit" className="btn btn-success" disabled={saving}>
                {saving ? t('common.saving', 'Saving…') : addToHistory ? t('addBottle.addToHistoryBtn') : t('addBottle.addBottleBtn')}
              </button>
              <button
                type="button"
                onClick={() => navigate(`/cellars/${cellarId}`)}
                className="btn btn-secondary"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Soft-zone "did you mean?" — two phases, one dialog:
          - step 1 (resolve): picking uses the existing wine; "create new"
            writes NOTHING — it carries the fields (+ confirmCreate) to step 2,
            and the commit skips this question having already asked it.
          - commit (rare race — a similar wine appeared after the resolve):
            the answer resumes the interrupted batch immediately, so the
            user's steps stay the same. */}
      {softCandidates && (
        <SimilarWinesModal
          candidates={softCandidates}
          queryName={softPending?.queryLabel || softPending?.wineData?.name}
          busy={findingWine || saving}
          onPick={(wine) => {
            if (softPending?.forCommit) {
              setSoftCandidates(null);
              setSoftPending(null);
              setSelectedWine(wine);
              setPendingNewWine(null);
              submitBottles({ wineId: wine._id });
            } else {
              applyResolvedWine(wine, softPending?.carriedVintage);
            }
          }}
          onCreateNew={() => {
            if (!softPending) return;
            if (softPending.forCommit) {
              const confirmed = { ...pendingNewWine, confirmCreate: true };
              setSoftCandidates(null);
              setSoftPending(null);
              setPendingNewWine(confirmed);
              submitBottles({ newWinePayload: confirmed });
            } else {
              applyPendingNewWine(
                { ...softPending.wineData, confirmCreate: true },
                softPending.carriedVintage
              );
            }
          }}
          onCancel={() => { setSoftCandidates(null); setSoftPending(null); }}
        />
      )}
    </div>
  );
}

export default AddBottle;
