import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getWineList, updateWineList, publishWineList, unpublishWineList, uploadWineListLogo } from '../api/wineLists';
import { getCellar } from '../api/cellars';
import './WineListEditor.css';

const API_BASE = process.env.REACT_APP_API_URL || '';

function WineListEditor() {
  const { id: cellarId, listId } = useParams();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();

  const [wineList, setWineList] = useState(null);
  const [bottles, setBottles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('bottles');
  const [error, setError] = useState(null);
  const [bulkPercent, setBulkPercent] = useState('');

  // Load wine list and cellar bottles
  const fetchData = useCallback(async () => {
    try {
      const [wlRes, cellarRes] = await Promise.all([
        getWineList(apiFetch, listId),
        getCellar(apiFetch, cellarId, 'limit=500'),
      ]);
      const wlData = await wlRes.json();
      const cellarData = await cellarRes.json();

      if (!wlRes.ok) { setError(wlData.error || 'Failed to load wine list'); return; }
      if (!cellarRes.ok) { setError(cellarData.error || 'Failed to load cellar'); return; }

      setWineList(wlData);
      // Filter to active bottles only
      const activeBottles = (cellarData.bottles || []).filter(b => b.status === 'active');
      setBottles(activeBottles);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, listId, cellarId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // --- Save handler ---
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await updateWineList(apiFetch, listId, {
        name: wineList.name,
        structureMode: wineList.structureMode,
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

  // --- Entry helpers ---
  const getEntries = () => {
    if (wineList.structureMode === 'custom') {
      // Flatten all section entries for the selection check
      return (wineList.sections || []).flatMap(s => s.entries || []);
    }
    return wineList.autoGroupEntries || [];
  };

  const isBottleSelected = (bottleId) => {
    return getEntries().some(e => e.bottle === bottleId);
  };

  const toggleBottle = (bottle) => {
    const bottleId = bottle._id;
    if (wineList.structureMode === 'custom') {
      // In custom mode, add/remove from first section (or create one)
      const updated = { ...wineList };
      if (!updated.sections || updated.sections.length === 0) {
        updated.sections = [{ title: 'Wines', sortOrder: 0, entries: [] }];
      }
      const section = updated.sections[0];
      const idx = section.entries.findIndex(e => e.bottle === bottleId);
      if (idx >= 0) {
        section.entries.splice(idx, 1);
      } else {
        section.entries.push({
          bottle: bottleId,
          listPrice: bottle.price || null,
          glassPrice: null,
          sortOrder: section.entries.length,
        });
      }
      setWineList({ ...updated });
    } else {
      // Auto mode
      const entries = [...(wineList.autoGroupEntries || [])];
      const idx = entries.findIndex(e => e.bottle === bottleId);
      if (idx >= 0) {
        entries.splice(idx, 1);
      } else {
        entries.push({
          bottle: bottleId,
          listPrice: bottle.price || null,
          glassPrice: null,
          sortOrder: entries.length,
        });
      }
      setWineList({ ...wineList, autoGroupEntries: entries });
    }
  };

  const updateEntryPrice = (bottleId, field, value) => {
    const numVal = value === '' ? null : parseFloat(value);
    if (wineList.structureMode === 'custom') {
      const updated = { ...wineList };
      for (const section of updated.sections || []) {
        const entry = section.entries.find(e => e.bottle === bottleId);
        if (entry) { entry[field] = numVal; break; }
      }
      setWineList({ ...updated });
    } else {
      const entries = [...(wineList.autoGroupEntries || [])];
      const entry = entries.find(e => e.bottle === bottleId);
      if (entry) entry[field] = numVal;
      setWineList({ ...wineList, autoGroupEntries: entries });
    }
  };

  const getEntryPrice = (bottleId, field) => {
    const entries = getEntries();
    const entry = entries.find(e => e.bottle === bottleId);
    return entry ? entry[field] : null;
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
    const sections = [...(wineList.sections || [])];
    const [entry] = sections[sectionIdx].entries.splice(entryIdx, 1);
    sections[targetSectionIdx].entries.push(entry);
    setWineList({ ...wineList, sections });
  };

  // --- Bulk price adjustment ---
  const applyBulkPriceAdjust = () => {
    const pct = parseFloat(bulkPercent);
    if (isNaN(pct)) return;
    const multiplier = 1 + pct / 100;

    if (wineList.structureMode === 'custom') {
      const updated = { ...wineList };
      for (const section of updated.sections || []) {
        for (const entry of section.entries || []) {
          if (entry.listPrice != null) entry.listPrice = Math.round(entry.listPrice * multiplier);
          if (entry.glassPrice != null) entry.glassPrice = Math.round(entry.glassPrice * multiplier);
        }
      }
      setWineList({ ...updated });
    } else {
      const entries = (wineList.autoGroupEntries || []).map(e => ({
        ...e,
        listPrice: e.listPrice != null ? Math.round(e.listPrice * multiplier) : e.listPrice,
        glassPrice: e.glassPrice != null ? Math.round(e.glassPrice * multiplier) : e.glassPrice,
      }));
      setWineList({ ...wineList, autoGroupEntries: entries });
    }
    setBulkPercent('');
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
  const openPreview = () => {
    window.open(`${API_BASE}/api/wine-lists/${listId}/preview-pdf`, '_blank');
  };

  const getPublicUrl = () => {
    if (!wineList?.shareToken) return '';
    return `${API_BASE}/api/wine-lists/public/${wineList.shareToken}/pdf`;
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!wineList) return <div className="alert alert-error">Wine list not found</div>;

  const branding = wineList.branding || {};
  const layout = wineList.layout || {};

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

      {/* Tabs */}
      <div className="wle-tabs">
        {['bottles', 'branding', 'layout', 'share'].map(tab => (
          <button
            key={tab}
            className={`wle-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Bottles tab ── */}
      {activeTab === 'bottles' && (
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
                    <p className="text-muted-sm">No bottles in this section yet. Select bottles below.</p>
                  )}
                  {(section.entries || []).map((entry, eIdx) => {
                    const bottle = bottles.find(b => b._id === entry.bottle);
                    if (!bottle) return null;
                    const wine = bottle.wineDefinition || {};
                    return (
                      <div key={entry.bottle} className="wle-entry-row">
                        <span className="wle-entry-name">
                          {wine.name || 'Unknown'} {bottle.vintage || 'NV'}
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

          {/* Bulk price adjustment */}
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

          {/* Bottle selection list */}
          <h3 className="wle-subtitle">Select bottles</h3>
          <div className="wle-bottle-list">
            {bottles.map(bottle => {
              const wine = bottle.wineDefinition || {};
              const selected = isBottleSelected(bottle._id);
              return (
                <div key={bottle._id} className={`wle-bottle-row ${selected ? 'selected' : ''}`}>
                  <label className="wle-bottle-check">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleBottle(bottle)}
                    />
                    <span className="wle-bottle-info">
                      <strong>{wine.name || 'Unknown'}</strong> {bottle.vintage || 'NV'}
                      <span className="text-muted-sm">
                        {[wine.producer, wine.region?.name, wine.country?.name].filter(Boolean).join(' — ')}
                      </span>
                    </span>
                  </label>
                  {selected && (
                    <div className="wle-price-inputs">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="Bottle price"
                        value={getEntryPrice(bottle._id, 'listPrice') ?? ''}
                        onChange={e => updateEntryPrice(bottle._id, 'listPrice', e.target.value)}
                        className="wle-price-input"
                      />
                      {layout.showGlassPrice && (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          placeholder="Glass price"
                          value={getEntryPrice(bottle._id, 'glassPrice') ?? ''}
                          onChange={e => updateEntryPrice(bottle._id, 'glassPrice', e.target.value)}
                          className="wle-price-input"
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {bottles.length === 0 && (
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
              checked={layout.showGlassPrice || false}
              onChange={e => setWineList({
                ...wineList,
                layout: { ...layout, showGlassPrice: e.target.checked }
              })}
            />
            Show glass prices
          </label>
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
              <p>Your wine list is live. Anyone with the link can view and download the PDF.</p>
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
              <p>Publish your wine list to get a public URL that anyone can access without logging in.</p>
              <button className="btn btn-primary" onClick={handlePublish}>Publish Wine List</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default WineListEditor;
