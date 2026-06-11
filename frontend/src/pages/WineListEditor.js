import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getWineList, updateWineList, publishWineList, unpublishWineList, uploadWineListLogo, getWineListStats, previewWineListPdf, getCellarWines } from '../api/wineLists';
import { buildSections } from '../utils/wineListSections';
import WineListMenu from '../components/WineListMenu';
import './WineListEditor.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'sv', label: 'Svenska' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
];

const AUTOSAVE_DELAY = 1500;

/** Canonical key for an entry or picker item: wine + vintage + bottle size. */
const keyOf = (e) =>
  `${e.wine?._id || e.wine}|${e.vintage || 'NV'}|${e.bottleSize || '750ml'}`;

/** Suggested glass price from the list's glass pricing rule. */
const suggestGlassPrice = (listPrice, layout = {}) => {
  if (listPrice == null) return null;
  const glasses = layout.glassesPerBottle || 6;
  const markup = layout.glassMarkup || 0;
  const step = parseInt(layout.glassRounding || '1', 10) || 1;
  const raw = (listPrice / glasses) * (1 + markup / 100);
  return Math.max(step, Math.round(raw / step) * step);
};

/** The exact body PUT /api/wine-lists/:id accepts — also the autosave dirty-check unit. */
const buildPayload = (wineList) => ({
  name: wineList.name,
  structureMode: wineList.structureMode,
  language: wineList.language,
  sections: wineList.sections,
  autoGrouping: wineList.autoGrouping,
  autoGroupEntries: wineList.autoGroupEntries,
  branding: wineList.branding,
  layout: wineList.layout,
});

function WineListEditor() {
  const { t } = useTranslation();
  const { id: cellarId, listId } = useParams();
  const { apiFetch } = useAuth();

  const [wineList, setWineList] = useState(null);
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('saved'); // saved | unsaved | saving | error
  const [activeTab, setActiveTab] = useState('wines');
  const [error, setError] = useState(null);
  const [bulkPercent, setBulkPercent] = useState('');
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showQuickStart, setShowQuickStart] = useState(false);
  const [wineSearch, setWineSearch] = useState('');
  const [saveTick, setSaveTick] = useState(0);

  const lastSavedRef = useRef(null);
  const lastErrorRef = useRef(null);
  const savingRef = useRef(false);

  // Load wine list and the cellar's distinct wines
  const fetchData = useCallback(async () => {
    try {
      const [wlRes, winesRes] = await Promise.all([
        getWineList(apiFetch, listId),
        getCellarWines(apiFetch, cellarId),
      ]);
      const wlData = await wlRes.json();
      const winesData = await winesRes.json();

      if (!wlRes.ok) { setError(wlData.error || t('wineLists.saveFailed')); return; }
      if (!winesRes.ok) { setError(winesData.error || t('wineLists.saveFailed')); return; }

      // Wines already on the list but out of stock are absent from the
      // picker data — merge them in (stock 0) so their entries stay editable.
      const { resolvedWines, ...list } = wlData;
      const pickerKeys = new Set(winesData.map(keyOf));
      const extras = (resolvedWines || [])
        .filter(rw => !pickerKeys.has(rw.key))
        .map(rw => ({ wine: rw.wine, vintage: rw.vintage, bottleSize: rw.bottleSize, stock: rw.stock, avgPrice: rw.avgPrice }));

      setWineList(list);
      setWines([...winesData, ...extras]);
      lastSavedRef.current = JSON.stringify(buildPayload(list));

      // Show quick-start if this is a fresh wine list (no entries yet)
      const hasEntries = list.structureMode === 'custom'
        ? (list.sections || []).some(s => (s.entries || []).length > 0)
        : (list.autoGroupEntries || []).length > 0;
      if (!hasEntries && winesData.length > 0) {
        setShowQuickStart(true);
      }
    } catch {
      setError(t('wineLists.networkError'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, listId, cellarId, t]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // --- Autosave -------------------------------------------------------------
  const payloadJson = wineList ? JSON.stringify(buildPayload(wineList)) : null;

  const save = useCallback(async (json) => {
    if (savingRef.current) return; // in flight — the post-save tick reschedules
    savingRef.current = true;
    setSaveState('saving');
    try {
      const res = await updateWineList(apiFetch, listId, JSON.parse(json));
      if (res.ok) {
        lastSavedRef.current = json;
        lastErrorRef.current = null;
        setSaveState('saved');
      } else {
        lastErrorRef.current = json;
        setSaveState('error');
      }
    } catch {
      lastErrorRef.current = json;
      setSaveState('error');
    } finally {
      savingRef.current = false;
      setSaveTick(tick => tick + 1); // re-evaluate: state may have moved on
    }
  }, [apiFetch, listId]);

  useEffect(() => {
    if (!payloadJson || loading) return undefined;
    if (payloadJson === lastSavedRef.current) {
      if (!savingRef.current) setSaveState('saved');
      return undefined;
    }
    // A payload that just failed isn't retried until the user changes
    // something or presses Save — no hammering a broken connection.
    if (payloadJson === lastErrorRef.current) {
      setSaveState('error');
      return undefined;
    }
    setSaveState('unsaved');
    const timer = setTimeout(() => save(payloadJson), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [payloadJson, loading, saveTick, save]);

  // Warn before closing the tab with unsaved changes
  useEffect(() => {
    if (saveState === 'saved') return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  const handleSave = () => { if (payloadJson) save(payloadJson); };

  // Load stats when dashboard tab is opened
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await getWineListStats(apiFetch, listId);
      const data = await res.json();
      if (res.ok) setStats(data);
    } catch { /* ignore */ }
    finally { setStatsLoading(false); }
  }, [apiFetch, listId]);

  useEffect(() => {
    if (activeTab === 'dashboard') loadStats();
  }, [activeTab, loadStats]);

  // --- Entry helpers ---
  const makeEntry = useCallback((item, sortOrder) => ({
    wine: item.wine._id,
    vintage: item.vintage,
    bottleSize: item.bottleSize,
    listPrice: item.avgPrice != null ? Math.round(item.avgPrice) : null,
    byGlass: false,
    glassPrice: null,
    glassPriceManual: false,
    sortOrder,
  }), []);

  const getEntries = () => {
    if (wineList.structureMode === 'custom') {
      return (wineList.sections || []).flatMap(s => s.entries || []);
    }
    return wineList.autoGroupEntries || [];
  };

  const getEntry = (key) => getEntries().find(e => keyOf(e) === key);
  const isSelected = (key) => getEntries().some(e => keyOf(e) === key);

  /** Apply `mutate(entry)` to every entry, in whichever mode is active. */
  const updateEntries = (mutate) => {
    if (wineList.structureMode === 'custom') {
      const sections = (wineList.sections || []).map(s => ({
        ...s,
        entries: (s.entries || []).map(e => mutate({ ...e })),
      }));
      setWineList({ ...wineList, sections });
    } else {
      const entries = (wineList.autoGroupEntries || []).map(e => mutate({ ...e }));
      setWineList({ ...wineList, autoGroupEntries: entries });
    }
  };

  const updateEntry = (key, mutate) => {
    updateEntries(e => (keyOf(e) === key ? mutate(e) : e));
  };

  const toggleWine = (item) => {
    const key = keyOf(item);
    if (wineList.structureMode === 'custom') {
      const sections = wineList.sections?.length
        ? wineList.sections.map(s => ({ ...s, entries: [...(s.entries || [])] }))
        : [{ title: t('wineLists.tabWines'), sortOrder: 0, entries: [] }];
      let removed = false;
      for (const section of sections) {
        const idx = section.entries.findIndex(e => keyOf(e) === key);
        if (idx >= 0) { section.entries.splice(idx, 1); removed = true; break; }
      }
      if (!removed) {
        sections[0].entries.push(makeEntry(item, sections[0].entries.length));
      }
      setWineList({ ...wineList, sections });
    } else {
      const entries = [...(wineList.autoGroupEntries || [])];
      const idx = entries.findIndex(e => keyOf(e) === key);
      if (idx >= 0) entries.splice(idx, 1);
      else entries.push(makeEntry(item, entries.length));
      setWineList({ ...wineList, autoGroupEntries: entries });
    }
  };

  const selectAllWines = () => {
    const entries = wines.map((item, i) => getEntry(keyOf(item)) || makeEntry(item, i));
    if (wineList.structureMode === 'custom') {
      const sections = wineList.sections?.length ? [...wineList.sections] : [{ title: t('wineLists.tabWines'), sortOrder: 0, entries: [] }];
      const otherSectionKeys = new Set(
        sections.slice(1).flatMap(s => (s.entries || []).map(keyOf))
      );
      sections[0] = { ...sections[0], entries: entries.filter(e => !otherSectionKeys.has(keyOf(e))) };
      setWineList({ ...wineList, sections });
    } else {
      setWineList({ ...wineList, autoGroupEntries: entries });
    }
  };

  const deselectAllWines = () => {
    if (wineList.structureMode === 'custom') {
      const sections = (wineList.sections || []).map(s => ({ ...s, entries: [] }));
      setWineList({ ...wineList, sections });
    } else {
      setWineList({ ...wineList, autoGroupEntries: [] });
    }
  };

  // --- Quick start: add every distinct wine with its average price ---
  const handleQuickStart = () => {
    const entries = wines.map((item, i) => makeEntry(item, i));
    setWineList(prev => ({ ...prev, autoGroupEntries: entries, structureMode: 'auto' }));
    setShowQuickStart(false);
  };

  // --- Prices ---
  const layout = wineList?.layout || {};

  const setListPrice = (key, value) => {
    const numVal = value === '' ? null : parseFloat(value);
    updateEntry(key, e => {
      e.listPrice = numVal;
      // Suggested glass prices follow the bottle price until overridden
      if (e.byGlass && !e.glassPriceManual) {
        e.glassPrice = suggestGlassPrice(numVal, layout);
      }
      return e;
    });
  };

  const setGlassPrice = (key, value) => {
    const numVal = value === '' ? null : parseFloat(value);
    updateEntry(key, e => {
      e.glassPrice = numVal;
      e.glassPriceManual = true;
      return e;
    });
  };

  const toggleByGlass = (key) => {
    updateEntry(key, e => {
      e.byGlass = !e.byGlass;
      if (e.byGlass && !e.glassPriceManual) {
        e.glassPrice = suggestGlassPrice(e.listPrice, layout);
      }
      return e;
    });
  };

  // --- Bulk price adjustment ---
  const applyBulkPriceAdjust = () => {
    const pct = parseFloat(bulkPercent);
    if (isNaN(pct)) return;
    const multiplier = 1 + pct / 100;

    const avgPriceByKey = new Map(wines.map(w => [keyOf(w), w.avgPrice]));
    updateEntries(e => {
      const base = e.listPrice != null ? e.listPrice : (avgPriceByKey.get(keyOf(e)) ?? null);
      e.listPrice = base != null ? Math.round(base * multiplier) : null;
      if (e.byGlass) {
        e.glassPrice = e.glassPriceManual
          ? (e.glassPrice != null ? Math.round(e.glassPrice * multiplier) : e.glassPrice)
          : suggestGlassPrice(e.listPrice, layout);
      }
      return e;
    });
  };

  // --- Glass pricing rule ---
  const recalcGlassPrices = (resetManual) => {
    updateEntries(e => {
      if (!e.byGlass) return e;
      if (resetManual || !e.glassPriceManual) {
        e.glassPrice = suggestGlassPrice(e.listPrice, layout);
        if (resetManual) e.glassPriceManual = false;
      }
      return e;
    });
  };

  // --- Custom sections ---
  const addSection = () => {
    const sections = [...(wineList.sections || [])];
    sections.push({ title: t('wineLists.newSection'), sortOrder: sections.length, entries: [] });
    setWineList({ ...wineList, sections });
  };

  const updateSectionTitle = (idx, title) => {
    const sections = [...(wineList.sections || [])];
    sections[idx] = { ...sections[idx], title };
    setWineList({ ...wineList, sections });
  };

  const removeSection = (idx) => {
    const sections = [...(wineList.sections || [])];
    sections.splice(idx, 1);
    setWineList({ ...wineList, sections: sections.map((s, i) => ({ ...s, sortOrder: i })) });
  };

  const moveSection = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= (wineList.sections || []).length) return;
    const sections = [...wineList.sections];
    [sections[idx], sections[target]] = [sections[target], sections[idx]];
    setWineList({ ...wineList, sections: sections.map((s, i) => ({ ...s, sortOrder: i })) });
  };

  const moveEntryWithin = (sIdx, eIdx, dir) => {
    const target = eIdx + dir;
    const sections = (wineList.sections || []).map(s => ({ ...s, entries: [...(s.entries || [])] }));
    const entries = sections[sIdx].entries;
    if (target < 0 || target >= entries.length) return;
    [entries[eIdx], entries[target]] = [entries[target], entries[eIdx]];
    sections[sIdx].entries = entries.map((e, i) => ({ ...e, sortOrder: i }));
    setWineList({ ...wineList, sections });
  };

  const moveSectionEntry = (sectionIdx, entryIdx, targetSectionIdx) => {
    const sections = (wineList.sections || []).map(s => ({ ...s, entries: [...(s.entries || [])] }));
    const [entry] = sections[sectionIdx].entries.splice(entryIdx, 1);
    sections[targetSectionIdx].entries.push(entry);
    setWineList({ ...wineList, sections });
  };

  // --- Publish/Unpublish ---
  const handlePublish = async () => {
    try {
      const res = await publishWineList(apiFetch, listId);
      const data = await res.json();
      if (res.ok) {
        setWineList(prev => ({ ...prev, shareToken: data.shareToken, isPublished: true }));
      } else {
        alert(data.error || t('wineLists.publishFailed'));
      }
    } catch { alert(t('wineLists.networkError')); }
  };

  const handleUnpublish = async () => {
    try {
      const res = await unpublishWineList(apiFetch, listId);
      if (res.ok) {
        setWineList(prev => ({ ...prev, isPublished: false }));
      }
    } catch { alert(t('wineLists.networkError')); }
  };

  // --- Logo upload ---
  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('logo', file);
    try {
      const res = await uploadWineListLogo(apiFetch, listId, formData);
      const data = await res.json();
      if (res.ok) {
        setWineList(prev => ({
          ...prev,
          branding: { ...prev.branding, logoUrl: data.logoUrl },
        }));
      } else {
        alert(data.error || t('wineLists.uploadFailed'));
      }
    } catch { alert(t('wineLists.uploadFailed')); }
  };

  // --- Preview PDF ---
  const openPreview = async () => {
    try {
      const res = await previewWineListPdf(apiFetch, listId);
      if (!res.ok) throw new Error('Failed to generate PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch {
      alert(t('wineLists.pdfFailed'));
    }
  };

  const menuUrl = wineList?.shareToken ? `${window.location.origin}/menu/${wineList.shareToken}` : '';
  const pdfUrl = wineList?.shareToken ? `${API_BASE}/api/wine-lists/public/${wineList.shareToken}/pdf` : '';

  // --- Derived data ---
  const winesByKey = useMemo(() => new Map(wines.map(w => [keyOf(w), w])), [wines]);

  const previewSections = useMemo(() => {
    if (!wineList || activeTab !== 'preview') return [];
    return buildSections(wineList, winesByKey);
  }, [wineList, winesByKey, activeTab]);

  const filteredWines = wines.filter(item => {
    if (!wineSearch) return true;
    const wine = item.wine || {};
    const search = wineSearch.toLowerCase();
    return (
      (wine.name || '').toLowerCase().includes(search) ||
      (wine.producer || '').toLowerCase().includes(search) ||
      (wine.region?.name || '').toLowerCase().includes(search) ||
      (wine.country?.name || '').toLowerCase().includes(search) ||
      (item.vintage || '').toLowerCase().includes(search)
    );
  });

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!wineList) return <div className="alert alert-error">{t('wineLists.title')}</div>;

  const branding = wineList.branding || {};
  const selectedCount = getEntries().length;
  const tabs = [
    { id: 'wines', label: t('wineLists.tabWines') },
    { id: 'preview', label: t('wineLists.tabPreview') },
    { id: 'branding', label: t('wineLists.tabBranding') },
    { id: 'layout', label: t('wineLists.tabLayout') },
    { id: 'dashboard', label: t('wineLists.dashboard') },
    { id: 'share', label: t('wineLists.tabShare') },
  ];
  const logoSrc = branding.logoUrl ? `${API_BASE}/api/uploads/${branding.logoUrl}` : null;

  const saveLabel = {
    saved: t('wineLists.savedState'),
    unsaved: t('wineLists.unsavedChanges'),
    saving: t('wineLists.saving'),
    error: t('wineLists.autosaveFailed'),
  }[saveState];

  const renderVintageSize = (vintage, bottleSize) => {
    const v = vintage || 'NV';
    return bottleSize && bottleSize !== '750ml' ? `${v} (${bottleSize})` : v;
  };

  return (
    <div className="wle-page">
      {/* Header */}
      <div className="wle-header">
        <Link to={`/cellars/${cellarId}/wine-lists`} className="back-link">&larr; {t('wineLists.backToWineLists')}</Link>
        <div className="wle-header-row">
          <input
            className="wle-title-input"
            value={wineList.name}
            onChange={e => setWineList({ ...wineList, name: e.target.value })}
            maxLength={200}
          />
          <div className="wle-header-actions">
            <span className={`wle-save-state ${saveState}`}>{saveLabel}</span>
            <button className="btn btn-secondary" onClick={openPreview}>{t('wineLists.previewPdf')}</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saveState === 'saving' || saveState === 'saved'}>
              {saveState === 'saving' ? t('wineLists.saving') : t('wineLists.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Quick-start banner for empty lists */}
      {showQuickStart && (
        <div className="wle-quickstart">
          <div className="wle-quickstart-content">
            <strong>{t('wineLists.quickStartTitle')}</strong>
            <p>{t('wineLists.quickStartDesc', { count: wines.length })}</p>
          </div>
          <div className="wle-quickstart-actions">
            <button className="btn btn-primary" onClick={handleQuickStart}>
              {t('wineLists.quickStartAdd')}
            </button>
            <button className="btn btn-secondary" onClick={() => setShowQuickStart(false)}>
              {t('wineLists.quickStartManual')}
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="wle-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`wle-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'wines' && selectedCount > 0 && (
              <span className="wle-tab-count">{selectedCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Wines tab ── */}
      {activeTab === 'wines' && (
        <div className="wle-section">
          {/* Structure mode toggle */}
          <div className="wle-mode-toggle">
            <label>
              <input
                type="radio"
                name="structureMode"
                value="auto"
                checked={wineList.structureMode === 'auto'}
                onChange={() => setWineList({ ...wineList, structureMode: 'auto' })}
              />
              {t('wineLists.autoGroup')}
            </label>
            <label>
              <input
                type="radio"
                name="structureMode"
                value="custom"
                checked={wineList.structureMode === 'custom'}
                onChange={() => setWineList({ ...wineList, structureMode: 'custom' })}
              />
              {t('wineLists.customSections')}
            </label>
          </div>

          {/* Auto-grouping options */}
          {wineList.structureMode === 'auto' && (
            <div className="wle-auto-options">
              <div className="form-group">
                <label>{t('wineLists.groupBy')}</label>
                <select
                  value={wineList.autoGrouping?.groupBy || 'type'}
                  onChange={e => setWineList({
                    ...wineList,
                    autoGrouping: { ...wineList.autoGrouping, groupBy: e.target.value }
                  })}
                  className="filter-select"
                >
                  <option value="type">{t('wineLists.groupByType')}</option>
                  <option value="country">{t('wineLists.groupByCountry')}</option>
                  <option value="region">{t('wineLists.groupByRegion')}</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('wineLists.sortWithinGroup')}</label>
                <select
                  value={wineList.autoGrouping?.withinGroup || 'country-region-name'}
                  onChange={e => setWineList({
                    ...wineList,
                    autoGrouping: { ...wineList.autoGrouping, withinGroup: e.target.value }
                  })}
                  className="filter-select"
                >
                  <option value="country-region-name">{t('wineLists.sortCountryRegionName')}</option>
                  <option value="name">{t('wineLists.sortName')}</option>
                  <option value="price-asc">{t('wineLists.sortPriceAsc')}</option>
                  <option value="price-desc">{t('wineLists.sortPriceDesc')}</option>
                  <option value="vintage">{t('wineLists.sortVintage')}</option>
                </select>
              </div>
            </div>
          )}

          {/* Custom sections management */}
          {wineList.structureMode === 'custom' && (
            <div className="wle-custom-sections">
              {(wineList.sections || []).map((section, sIdx) => (
                <div key={sIdx} className="wle-section-block">
                  <div className="wle-section-header">
                    <div className="wle-reorder">
                      <button className="wle-reorder-btn" title={t('wineLists.moveUp')} disabled={sIdx === 0} onClick={() => moveSection(sIdx, -1)}>▲</button>
                      <button className="wle-reorder-btn" title={t('wineLists.moveDown')} disabled={sIdx === wineList.sections.length - 1} onClick={() => moveSection(sIdx, 1)}>▼</button>
                    </div>
                    <input
                      className="wle-section-title-input"
                      value={section.title}
                      onChange={e => updateSectionTitle(sIdx, e.target.value)}
                      placeholder={t('wineLists.sectionTitlePlaceholder')}
                    />
                    <button className="btn btn-small btn-danger" onClick={() => removeSection(sIdx)}>{t('wineLists.removeSection')}</button>
                  </div>
                  {(section.entries || []).length === 0 && (
                    <p className="text-muted-sm">{t('wineLists.noWinesInSection')}</p>
                  )}
                  {(section.entries || []).map((entry, eIdx) => {
                    const item = winesByKey.get(keyOf(entry));
                    const wine = item?.wine || {};
                    return (
                      <div key={keyOf(entry)} className="wle-entry-row">
                        <div className="wle-reorder">
                          <button className="wle-reorder-btn" title={t('wineLists.moveUp')} disabled={eIdx === 0} onClick={() => moveEntryWithin(sIdx, eIdx, -1)}>▲</button>
                          <button className="wle-reorder-btn" title={t('wineLists.moveDown')} disabled={eIdx === section.entries.length - 1} onClick={() => moveEntryWithin(sIdx, eIdx, 1)}>▼</button>
                        </div>
                        <span className="wle-entry-name">
                          {wine.name || 'Unknown'} {renderVintageSize(entry.vintage, entry.bottleSize)}
                          {wine.producer && <span className="text-muted-sm"> — {wine.producer}</span>}
                        </span>
                        {wineList.sections.length > 1 && (
                          <select
                            className="wle-move-select"
                            value={sIdx}
                            onChange={e => moveSectionEntry(sIdx, eIdx, parseInt(e.target.value))}
                          >
                            {wineList.sections.map((s, i) => (
                              <option key={i} value={i}>{s.title || `${i + 1}`}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              <button className="btn btn-secondary" onClick={addSection}>{t('wineLists.addSection')}</button>
            </div>
          )}

          {/* Bulk actions */}
          <div className="wle-bulk-actions">
            {getEntries().length > 0 && (
              <div className="wle-bulk-pricing">
                <span>{t('wineLists.adjustPrices')}</span>
                <input
                  type="number"
                  value={bulkPercent}
                  onChange={e => setBulkPercent(e.target.value)}
                  placeholder="e.g. 10"
                />
                <span>%</span>
                <button className="btn btn-small btn-secondary" onClick={applyBulkPriceAdjust}>
                  {t('wineLists.apply')}
                </button>
              </div>
            )}
            <div className="wle-select-actions">
              <button className="btn btn-small btn-secondary" onClick={selectAllWines}>{t('wineLists.selectAll')}</button>
              {selectedCount > 0 && (
                <button className="btn btn-small btn-secondary" onClick={deselectAllWines}>{t('wineLists.deselectAll')}</button>
              )}
            </div>
          </div>

          {/* Wine search */}
          <div className="wle-bottle-search">
            <input
              type="text"
              placeholder={t('wineLists.searchWines')}
              value={wineSearch}
              onChange={e => setWineSearch(e.target.value)}
              className="search-input"
            />
            <span className="text-muted-sm">{selectedCount} {t('wineLists.of')} {wines.length} {t('wineLists.selected')}</span>
          </div>

          {/* Wine selection list */}
          <div className="wle-bottle-list">
            {filteredWines.map(item => {
              const key = keyOf(item);
              const wine = item.wine || {};
              const selected = isSelected(key);
              const entry = selected ? getEntry(key) : null;
              return (
                <div key={key} className={`wle-bottle-row ${selected ? 'selected' : ''}`}>
                  <label className="wle-bottle-check">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleWine(item)}
                    />
                    <span className="wle-bottle-info">
                      <strong>{wine.name || 'Unknown'}</strong> {renderVintageSize(item.vintage, item.bottleSize)}
                      <span className={`wle-stock-badge ${item.stock === 0 ? 'out' : ''}`}>
                        {item.stock === 0 ? t('wineLists.outOfStock') : `× ${item.stock}`}
                      </span>
                      <span className="text-muted-sm">
                        {[wine.producer, wine.region?.name, wine.country?.name].filter(Boolean).join(' — ')}
                      </span>
                    </span>
                  </label>
                  {selected && entry && (
                    <div className="wle-price-inputs">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder={t('wineLists.bottlePrice')}
                        value={entry.listPrice ?? ''}
                        onChange={e => setListPrice(key, e.target.value)}
                        className="wle-price-input"
                      />
                      <label className="wle-glass-toggle" title={t('wineLists.glassToggleTitle')}>
                        <input
                          type="checkbox"
                          checked={entry.byGlass || false}
                          onChange={() => toggleByGlass(key)}
                        />
                        <span aria-hidden="true">🍷</span> {t('wineLists.glassToggle')}
                      </label>
                      {entry.byGlass && (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          placeholder={t('wineLists.glassPrice')}
                          value={entry.glassPrice ?? ''}
                          onChange={e => setGlassPrice(key, e.target.value)}
                          className={`wle-price-input ${entry.glassPriceManual ? '' : 'wle-price-suggested'}`}
                          title={entry.glassPriceManual ? t('wineLists.glassManualTitle') : t('wineLists.glassSuggestedTitle')}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {filteredWines.length === 0 && wines.length > 0 && (
              <p className="empty-state">{t('wineLists.noWinesMatch')}</p>
            )}
            {wines.length === 0 && (
              <p className="empty-state">{t('wineLists.noActiveBottles')}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Preview tab — live, reflects unsaved changes ── */}
      {activeTab === 'preview' && (
        <div className="wle-section wle-preview-wrap">
          {previewSections.length > 0 ? (
            <div className="wle-preview-frame">
              <WineListMenu
                branding={branding}
                layout={layout}
                language={wineList.language || 'en'}
                sections={previewSections}
                logoSrc={logoSrc}
              />
            </div>
          ) : (
            <p className="empty-state">{t('wineLists.previewEmpty')}</p>
          )}
        </div>
      )}

      {/* ── Branding tab ── */}
      {activeTab === 'branding' && (
        <div className="wle-section">
          <div className="form-group">
            <label>{t('wineLists.restaurantName')}</label>
            <input
              value={branding.restaurantName || ''}
              onChange={e => setWineList({
                ...wineList,
                branding: { ...branding, restaurantName: e.target.value }
              })}
              maxLength={200}
              placeholder="e.g. Chez Laurent"
            />
          </div>
          <div className="form-group">
            <label>{t('wineLists.tagline')}</label>
            <input
              value={branding.tagline || ''}
              onChange={e => setWineList({
                ...wineList,
                branding: { ...branding, tagline: e.target.value }
              })}
              maxLength={300}
              placeholder="e.g. Fine dining since 1987"
            />
          </div>
          <div className="form-group">
            <label>{t('wineLists.footerText')}</label>
            <input
              value={branding.footerText || ''}
              onChange={e => setWineList({
                ...wineList,
                branding: { ...branding, footerText: e.target.value }
              })}
              maxLength={500}
              placeholder="e.g. Prices include VAT. Vintage subject to change."
            />
          </div>
          <div className="form-group">
            <label>{t('wineLists.logo')}</label>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleLogoUpload} />
            {branding.logoUrl && (
              <img
                src={logoSrc}
                alt="Logo"
                className="wle-logo-preview"
              />
            )}
          </div>
        </div>
      )}

      {/* ── Layout tab ── */}
      {activeTab === 'layout' && (
        <div className="wle-section">
          <div className="wle-layout-grid">
            <div className="form-group">
              <label>{t('wineLists.style')}</label>
              <select
                value={layout.colorScheme || 'classic'}
                onChange={e => setWineList({
                  ...wineList,
                  layout: { ...layout, colorScheme: e.target.value }
                })}
                className="filter-select"
              >
                <option value="classic">Classic</option>
                <option value="modern">Modern</option>
                <option value="elegant">Elegant</option>
                <option value="minimal">Minimal</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('wineLists.font')}</label>
              <select
                value={layout.fontFamily || 'serif'}
                onChange={e => setWineList({
                  ...wineList,
                  layout: { ...layout, fontFamily: e.target.value }
                })}
                className="filter-select"
              >
                <option value="serif">Serif</option>
                <option value="sans-serif">Sans-serif</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('wineLists.language')}</label>
              <select
                value={wineList.language || 'en'}
                onChange={e => setWineList({ ...wineList, language: e.target.value })}
                className="filter-select"
              >
                {LANGUAGE_OPTIONS.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>{t('wineLists.pageSize')}</label>
              <select
                value={layout.pageSize || 'A4'}
                onChange={e => setWineList({
                  ...wineList,
                  layout: { ...layout, pageSize: e.target.value }
                })}
                className="filter-select"
              >
                <option value="A4">A4</option>
                <option value="letter">Letter (US)</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('wineLists.currencySymbol')}</label>
              <input
                value={layout.currencySymbol || '$'}
                onChange={e => setWineList({
                  ...wineList,
                  layout: { ...layout, currencySymbol: e.target.value }
                })}
                maxLength={5}
                style={{ width: '80px' }}
              />
            </div>
          </div>

          <label className="wle-checkbox">
            <input
              type="checkbox"
              checked={layout.hideOutOfStock || false}
              onChange={e => setWineList({
                ...wineList,
                layout: { ...layout, hideOutOfStock: e.target.checked }
              })}
            />
            {t('wineLists.hideOutOfStock')}
          </label>
          <label className="wle-checkbox">
            <input
              type="checkbox"
              checked={layout.glassSectionFirst || false}
              onChange={e => setWineList({
                ...wineList,
                layout: { ...layout, glassSectionFirst: e.target.checked }
              })}
            />
            {t('wineLists.glassSectionFirst')}
          </label>

          <div className="wle-glass-calc">
            <h4>{t('wineLists.glassPricingRule')}</h4>
            <p className="text-muted-sm">{t('wineLists.glassPricingDesc')}</p>
            <div className="wle-glass-calc-fields">
              <div className="form-group">
                <label>{t('wineLists.glassesPerBottle')}</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={layout.glassesPerBottle || 6}
                  onChange={e => setWineList({
                    ...wineList,
                    layout: { ...layout, glassesPerBottle: parseInt(e.target.value) || 6 }
                  })}
                  style={{ width: '80px' }}
                />
              </div>
              <div className="form-group">
                <label>{t('wineLists.glassMarkup')}</label>
                <input
                  type="number"
                  value={layout.glassMarkup || 0}
                  onChange={e => setWineList({
                    ...wineList,
                    layout: { ...layout, glassMarkup: parseFloat(e.target.value) || 0 }
                  })}
                  style={{ width: '80px' }}
                />
              </div>
              <div className="form-group">
                <label>{t('wineLists.roundToNearest')}</label>
                <select
                  value={layout.glassRounding || '1'}
                  onChange={e => setWineList({
                    ...wineList,
                    layout: { ...layout, glassRounding: e.target.value }
                  })}
                  className="filter-select"
                  style={{ width: '80px' }}
                >
                  <option value="1">1</option>
                  <option value="5">5</option>
                  <option value="10">10</option>
                </select>
              </div>
            </div>
            <div className="wle-glass-calc-actions">
              <button className="btn btn-small btn-secondary" onClick={() => recalcGlassPrices(false)}>
                {t('wineLists.recalcSuggested')}
              </button>
              <button className="btn btn-small btn-secondary" onClick={() => recalcGlassPrices(true)}>
                {t('wineLists.resetToRule')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dashboard tab (stock + margin) ── */}
      {activeTab === 'dashboard' && (
        <div className="wle-section">
          {statsLoading && <div className="loading">Loading stats...</div>}
          {stats && (
            <>
              <div className="wle-stats-summary">
                <div className="stat-card">
                  <h2>{stats.summary.totalWines}</h2>
                  <p>{t('wineLists.winesOnList')}</p>
                </div>
                <div className="stat-card">
                  <h2>{stats.summary.totalBottlesInStock}</h2>
                  <p>{t('wineLists.bottlesInStock')}</p>
                </div>
                <div className="stat-card">
                  <h2>{layout.currencySymbol || '$'}{stats.summary.potentialRevenue.toLocaleString()}</h2>
                  <p>{t('wineLists.potentialRevenue')}</p>
                </div>
                <div className="stat-card">
                  <h2>{stats.summary.overallMarginPercent != null ? `${stats.summary.overallMarginPercent}%` : '—'}</h2>
                  <p>{t('wineLists.overallMargin')}</p>
                </div>
              </div>

              <table className="wle-stats-table">
                <thead>
                  <tr>
                    <th>{t('wineLists.wine')}</th>
                    <th>{t('wineLists.vintage')}</th>
                    <th>{t('wineLists.stock')}</th>
                    <th>{t('wineLists.cost')}</th>
                    <th>{t('wineLists.listPrice')}</th>
                    <th>{t('wineLists.glass')}</th>
                    <th>{t('wineLists.margin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.entries.map((entry) => (
                    <tr key={entry.key}>
                      <td>
                        <strong>{entry.wineName}</strong>
                        {entry.producer && <span className="text-muted-sm"> — {entry.producer}</span>}
                      </td>
                      <td>{renderVintageSize(entry.vintage, entry.bottleSize)}</td>
                      <td className={entry.stockCount === 0 ? 'wle-stock-zero' : ''}>
                        {entry.stockCount}
                      </td>
                      <td>{entry.purchasePrice != null ? `${layout.currencySymbol || '$'}${entry.purchasePrice}` : '—'}</td>
                      <td>{entry.listPrice != null ? `${layout.currencySymbol || '$'}${entry.listPrice}` : '—'}</td>
                      <td>{entry.glassPrice != null ? `${layout.currencySymbol || '$'}${entry.glassPrice}` : '—'}</td>
                      <td className={entry.marginPercent != null ? (entry.marginPercent >= 0 ? 'wle-margin-pos' : 'wle-margin-neg') : ''}>
                        {entry.marginPercent != null ? `${entry.marginPercent}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!statsLoading && !stats && (
            <p className="empty-state">{t('wineLists.statsEmpty')}</p>
          )}
        </div>
      )}

      {/* ── Share tab ── */}
      {activeTab === 'share' && (
        <div className="wle-section">
          <div className="wle-share-status">
            <span className={`status-badge ${wineList.isPublished ? 'published' : 'draft'}`}>
              {wineList.isPublished ? t('wineLists.published') : t('wineLists.draft')}
            </span>
          </div>

          {wineList.isPublished ? (
            <>
              <p>{t('wineLists.publishedDesc')}</p>
              <div className="form-group">
                <label>{t('wineLists.menuUrlLabel')}</label>
                <div className="wle-share-url">
                  <input type="text" readOnly value={menuUrl} className="wle-url-input" />
                  <button
                    className="btn btn-secondary"
                    onClick={() => { navigator.clipboard.writeText(menuUrl); }}
                  >
                    {t('wineLists.copy')}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>{t('wineLists.pdfUrlLabel')}</label>
                <div className="wle-share-url">
                  <input type="text" readOnly value={pdfUrl} className="wle-url-input" />
                  <button
                    className="btn btn-secondary"
                    onClick={() => { navigator.clipboard.writeText(pdfUrl); }}
                  >
                    {t('wineLists.copy')}
                  </button>
                </div>
              </div>
              <button className="btn btn-secondary" onClick={handleUnpublish}>{t('wineLists.unpublish')}</button>
            </>
          ) : (
            <>
              <p>{t('wineLists.publishDesc')}</p>
              <button className="btn btn-primary" onClick={handlePublish}>{t('wineLists.publishTitle')}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default WineListEditor;
