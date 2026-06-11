import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getWineList, updateWineList, publishWineList, unpublishWineList, uploadWineListLogo, getWineListStats, previewWineListPdf, getCellarWines } from '../api/wineLists';
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

function WineListEditor() {
  const { id: cellarId, listId } = useParams();
  const { apiFetch } = useAuth();

  const [wineList, setWineList] = useState(null);
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('wines');
  const [error, setError] = useState(null);
  const [bulkPercent, setBulkPercent] = useState('');
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showQuickStart, setShowQuickStart] = useState(false);
  const [wineSearch, setWineSearch] = useState('');

  // Load wine list and the cellar's distinct wines
  const fetchData = useCallback(async () => {
    try {
      const [wlRes, winesRes] = await Promise.all([
        getWineList(apiFetch, listId),
        getCellarWines(apiFetch, cellarId),
      ]);
      const wlData = await wlRes.json();
      const winesData = await winesRes.json();

      if (!wlRes.ok) { setError(wlData.error || 'Failed to load wine list'); return; }
      if (!winesRes.ok) { setError(winesData.error || 'Failed to load cellar wines'); return; }

      // Wines already on the list but out of stock are absent from the
      // picker data — merge them in (stock 0) so their entries stay editable.
      const { resolvedWines, ...list } = wlData;
      const pickerKeys = new Set(winesData.map(keyOf));
      const extras = (resolvedWines || [])
        .filter(rw => !pickerKeys.has(rw.key))
        .map(rw => ({ wine: rw.wine, vintage: rw.vintage, bottleSize: rw.bottleSize, stock: rw.stock, avgPrice: rw.avgPrice }));

      setWineList(list);
      setWines([...winesData, ...extras]);

      // Show quick-start if this is a fresh wine list (no entries yet)
      const hasEntries = list.structureMode === 'custom'
        ? (list.sections || []).some(s => (s.entries || []).length > 0)
        : (list.autoGroupEntries || []).length > 0;
      if (!hasEntries && winesData.length > 0) {
        setShowQuickStart(true);
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, listId, cellarId]);

  useEffect(() => { fetchData(); }, [fetchData]);

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
        : [{ title: 'Wines', sortOrder: 0, entries: [] }];
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
    const entries = wines.map((item, i) => {
      // Keep existing entries (with their prices) — only add what's missing
      return getEntry(keyOf(item)) || makeEntry(item, i);
    });
    if (wineList.structureMode === 'custom') {
      const sections = wineList.sections?.length ? [...wineList.sections] : [{ title: 'Wines', sortOrder: 0, entries: [] }];
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
    sections.push({ title: 'New Section', sortOrder: sections.length, entries: [] });
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
    setWineList({ ...wineList, sections });
  };

  const moveSectionEntry = (sectionIdx, entryIdx, targetSectionIdx) => {
    const sections = (wineList.sections || []).map(s => ({ ...s, entries: [...(s.entries || [])] }));
    const [entry] = sections[sectionIdx].entries.splice(entryIdx, 1);
    sections[targetSectionIdx].entries.push(entry);
    setWineList({ ...wineList, sections });
  };

  // --- Save handler ---
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await updateWineList(apiFetch, listId, {
        name: wineList.name,
        structureMode: wineList.structureMode,
        language: wineList.language,
        sections: wineList.sections,
        autoGrouping: wineList.autoGrouping,
        autoGroupEntries: wineList.autoGroupEntries,
        branding: wineList.branding,
        layout: wineList.layout,
      });
      const data = await res.json();
      if (res.ok) {
        setWineList(data);
      } else {
        alert(data.error || 'Failed to save');
      }
    } catch {
      alert('Save failed');
    } finally {
      setSaving(false);
    }
  };

  // --- Publish/Unpublish ---
  const handlePublish = async () => {
    try {
      const res = await publishWineList(apiFetch, listId);
      const data = await res.json();
      if (res.ok) {
        setWineList(prev => ({ ...prev, shareToken: data.shareToken, isPublished: true }));
      } else {
        alert(data.error || 'Failed to publish');
      }
    } catch { alert('Network error'); }
  };

  const handleUnpublish = async () => {
    try {
      const res = await unpublishWineList(apiFetch, listId);
      if (res.ok) {
        setWineList(prev => ({ ...prev, isPublished: false }));
      }
    } catch { alert('Network error'); }
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
        alert(data.error || 'Upload failed');
      }
    } catch { alert('Upload failed'); }
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
      alert('Failed to generate PDF preview');
    }
  };

  const getPublicUrl = () => {
    if (!wineList?.shareToken) return '';
    return `${API_BASE}/api/wine-lists/public/${wineList.shareToken}/pdf`;
  };

  // --- Filtered wines for search ---
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
  if (!wineList) return <div className="alert alert-error">Wine list not found</div>;

  const branding = wineList.branding || {};
  const selectedCount = getEntries().length;
  const tabs = ['wines', 'branding', 'layout', 'dashboard', 'share'];
  const winesByKey = new Map(wines.map(w => [keyOf(w), w]));

  const renderVintageSize = (vintage, bottleSize) => {
    const v = vintage || 'NV';
    return bottleSize && bottleSize !== '750ml' ? `${v} (${bottleSize})` : v;
  };

  return (
    <div className="wle-page">
      {/* Header */}
      <div className="wle-header">
        <Link to={`/cellars/${cellarId}/wine-lists`} className="back-link">&larr; Wine Lists</Link>
        <div className="wle-header-row">
          <input
            className="wle-title-input"
            value={wineList.name}
            onChange={e => setWineList({ ...wineList, name: e.target.value })}
            maxLength={200}
          />
          <div className="wle-header-actions">
            <button className="btn btn-secondary" onClick={openPreview}>Preview PDF</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Quick-start banner for empty lists */}
      {showQuickStart && (
        <div className="wle-quickstart">
          <div className="wle-quickstart-content">
            <strong>Quick start</strong>
            <p>Add all {wines.length} wines from your cellar and use their purchase prices as a starting point?</p>
          </div>
          <div className="wle-quickstart-actions">
            <button className="btn btn-primary" onClick={handleQuickStart}>
              Add all wines
            </button>
            <button className="btn btn-secondary" onClick={() => setShowQuickStart(false)}>
              I'll pick manually
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="wle-tabs">
        {tabs.map(tab => (
          <button
            key={tab}
            className={`wle-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'dashboard' ? 'Dashboard' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === 'wines' && selectedCount > 0 && (
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
              Auto-group (by type, country, region)
            </label>
            <label>
              <input
                type="radio"
                name="structureMode"
                value="custom"
                checked={wineList.structureMode === 'custom'}
                onChange={() => setWineList({ ...wineList, structureMode: 'custom' })}
              />
              Custom sections
            </label>
          </div>

          {/* Auto-grouping options */}
          {wineList.structureMode === 'auto' && (
            <div className="wle-auto-options">
              <div className="form-group">
                <label>Group by</label>
                <select
                  value={wineList.autoGrouping?.groupBy || 'type'}
                  onChange={e => setWineList({
                    ...wineList,
                    autoGrouping: { ...wineList.autoGrouping, groupBy: e.target.value }
                  })}
                  className="filter-select"
                >
                  <option value="type">Wine type (Red, White, ...)</option>
                  <option value="country">Country</option>
                  <option value="region">Region</option>
                </select>
              </div>
              <div className="form-group">
                <label>Sort within group</label>
                <select
                  value={wineList.autoGrouping?.withinGroup || 'country-region-name'}
                  onChange={e => setWineList({
                    ...wineList,
                    autoGrouping: { ...wineList.autoGrouping, withinGroup: e.target.value }
                  })}
                  className="filter-select"
                >
                  <option value="country-region-name">Country, region, name</option>
                  <option value="name">Name (A-Z)</option>
                  <option value="price-asc">Price (low to high)</option>
                  <option value="price-desc">Price (high to low)</option>
                  <option value="vintage">Vintage</option>
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
                    <input
                      className="wle-section-title-input"
                      value={section.title}
                      onChange={e => updateSectionTitle(sIdx, e.target.value)}
                      placeholder="Section title"
                    />
                    <button className="btn btn-small btn-danger" onClick={() => removeSection(sIdx)}>Remove</button>
                  </div>
                  {(section.entries || []).length === 0 && (
                    <p className="text-muted-sm">No wines in this section yet. Select wines below.</p>
                  )}
                  {(section.entries || []).map((entry, eIdx) => {
                    const item = winesByKey.get(keyOf(entry));
                    const wine = item?.wine || {};
                    return (
                      <div key={keyOf(entry)} className="wle-entry-row">
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
                              <option key={i} value={i}>{s.title || `Section ${i + 1}`}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              <button className="btn btn-secondary" onClick={addSection}>+ Add Section</button>
            </div>
          )}

          {/* Bulk actions */}
          <div className="wle-bulk-actions">
            {getEntries().length > 0 && (
              <div className="wle-bulk-pricing">
                <span>Adjust all prices by</span>
                <input
                  type="number"
                  value={bulkPercent}
                  onChange={e => setBulkPercent(e.target.value)}
                  placeholder="e.g. 10"
                />
                <span>%</span>
                <button className="btn btn-small btn-secondary" onClick={applyBulkPriceAdjust}>
                  Apply
                </button>
              </div>
            )}
            <div className="wle-select-actions">
              <button className="btn btn-small btn-secondary" onClick={selectAllWines}>Select all</button>
              {selectedCount > 0 && (
                <button className="btn btn-small btn-secondary" onClick={deselectAllWines}>Deselect all</button>
              )}
            </div>
          </div>

          {/* Wine search */}
          <div className="wle-bottle-search">
            <input
              type="text"
              placeholder="Search wines..."
              value={wineSearch}
              onChange={e => setWineSearch(e.target.value)}
              className="search-input"
            />
            <span className="text-muted-sm">{selectedCount} of {wines.length} selected</span>
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
                        {item.stock === 0 ? 'Out of stock' : `× ${item.stock}`}
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
                        placeholder="Bottle price"
                        value={entry.listPrice ?? ''}
                        onChange={e => setListPrice(key, e.target.value)}
                        className="wle-price-input"
                      />
                      <label className="wle-glass-toggle" title="Also available by the glass">
                        <input
                          type="checkbox"
                          checked={entry.byGlass || false}
                          onChange={() => toggleByGlass(key)}
                        />
                        <span aria-hidden="true">🍷</span> Glass
                      </label>
                      {entry.byGlass && (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          placeholder="Glass price"
                          value={entry.glassPrice ?? ''}
                          onChange={e => setGlassPrice(key, e.target.value)}
                          className={`wle-price-input ${entry.glassPriceManual ? '' : 'wle-price-suggested'}`}
                          title={entry.glassPriceManual ? 'Manually set price' : 'Suggested from the glass pricing rule — edit to override'}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {filteredWines.length === 0 && wines.length > 0 && (
              <p className="empty-state">No wines match your search.</p>
            )}
            {wines.length === 0 && (
              <p className="empty-state">No active bottles in this cellar.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Branding tab ── */}
      {activeTab === 'branding' && (
        <div className="wle-section">
          <div className="form-group">
            <label>Restaurant name</label>
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
            <label>Tagline</label>
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
            <label>Footer text</label>
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
            <label>Logo</label>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleLogoUpload} />
            {branding.logoUrl && (
              <img
                src={`${API_BASE}/api/uploads/${branding.logoUrl}`}
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
              <label>Style</label>
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
              <label>Font</label>
              <select
                value={layout.fontFamily || 'serif'}
                onChange={e => setWineList({
                  ...wineList,
                  layout: { ...layout, fontFamily: e.target.value }
                })}
                className="filter-select"
              >
                <option value="serif">Serif (classic)</option>
                <option value="sans-serif">Sans-serif (modern)</option>
              </select>
            </div>
            <div className="form-group">
              <label>Language</label>
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
              <label>Page size</label>
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
              <label>Currency symbol</label>
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
            Hide wines that are out of stock
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
            Lead with a &ldquo;Wines by the Glass&rdquo; section
          </label>

          <div className="wle-glass-calc">
            <h4>Glass pricing rule</h4>
            <p className="text-muted-sm">
              Suggested glass price = bottle price / glasses per bottle, plus markup.
              Wines marked &ldquo;Glass&rdquo; get this suggestion automatically — prices you
              type yourself are never overwritten.
            </p>
            <div className="wle-glass-calc-fields">
              <div className="form-group">
                <label>Glasses per bottle</label>
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
                <label>Glass markup %</label>
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
                <label>Round to nearest</label>
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
                Recalculate suggested prices
              </button>
              <button className="btn btn-small btn-secondary" onClick={() => recalcGlassPrices(true)}>
                Reset all to rule
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
                  <p>Wines on list</p>
                </div>
                <div className="stat-card">
                  <h2>{stats.summary.totalBottlesInStock}</h2>
                  <p>Bottles in stock</p>
                </div>
                <div className="stat-card">
                  <h2>{layout.currencySymbol || '$'}{stats.summary.potentialRevenue.toLocaleString()}</h2>
                  <p>Potential revenue</p>
                </div>
                <div className="stat-card">
                  <h2>{stats.summary.overallMarginPercent != null ? `${stats.summary.overallMarginPercent}%` : '—'}</h2>
                  <p>Overall margin</p>
                </div>
              </div>

              <table className="wle-stats-table">
                <thead>
                  <tr>
                    <th>Wine</th>
                    <th>Vintage</th>
                    <th>Stock</th>
                    <th>Cost</th>
                    <th>List price</th>
                    <th>Glass</th>
                    <th>Margin</th>
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
            <p className="empty-state">Save your wine list first to see dashboard stats.</p>
          )}
        </div>
      )}

      {/* ── Share tab ── */}
      {activeTab === 'share' && (
        <div className="wle-section">
          <div className="wle-share-status">
            <span className={`status-badge ${wineList.isPublished ? 'published' : 'draft'}`}>
              {wineList.isPublished ? 'Published' : 'Draft'}
            </span>
          </div>

          {wineList.isPublished ? (
            <>
              <p>Your wine list is live. Anyone with the link can view and download the PDF. A QR code linking to this URL is automatically included on the PDF.</p>
              <div className="wle-share-url">
                <input type="text" readOnly value={getPublicUrl()} className="wle-url-input" />
                <button
                  className="btn btn-secondary"
                  onClick={() => { navigator.clipboard.writeText(getPublicUrl()); }}
                >
                  Copy
                </button>
              </div>
              <button className="btn btn-secondary" onClick={handleUnpublish}>Unpublish</button>
            </>
          ) : (
            <>
              <p>Publish your wine list to get a public URL. A QR code will be automatically added to the PDF so customers can scan it.</p>
              <button className="btn btn-primary" onClick={handlePublish}>Publish Wine List</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default WineListEditor;
