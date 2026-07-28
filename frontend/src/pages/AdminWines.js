import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  adminGetWines, adminGetWine, adminSaveWine, adminDeleteWine,
  adminMergeWine,
  adminGetCountries, adminGetGrapes, adminGetRegions, adminGetAppellations,
  adminAssignImageToWine,
} from '../api/admin';
import Modal from '../components/Modal';
import Drawer from '../components/Drawer';
import WineDuplicatesModal from '../components/WineDuplicatesModal';
import WineProducerInNameModal from '../components/WineProducerInNameModal';
import WineLowConfidenceModal from '../components/WineLowConfidenceModal';
import { WINE_TYPES } from '../config/wineTypes';
import GrapePicker from '../components/GrapePicker';
import ImageUpload from '../components/ImageUpload';
import ImageGallery from '../components/ImageGallery';
import { getWineImageUrl } from '../utils/wineImageUrl';
import './AdminWines.css';

const emptyForm = {
  name: '',
  producer: '',
  country: '',
  region: '',
  type: 'red',
  appellation: '',
  grapes: [],
};

function AdminWines() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [wines, setWines] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ type: '', sort: 'name' });
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);

  // Transient action-feedback toasts (no global toast system in this app).
  const [toasts, setToasts] = useState([]);
  const pushToast = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(ts => [...ts, { id, message, type }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 3500);
  }, []);

  const [showForm, setShowForm] = useState(false);
  const [editWine, setEditWine] = useState(null);
  const [formData, setFormData] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [dupCandidates, setDupCandidates] = useState(null);
  const [imageCredit, setImageCredit] = useState('');
  const galleryRef = useRef(null);

  // Delete confirmation modal
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Merge modal
  const [mergeSource, setMergeSource] = useState(null); // wine being deleted
  const [mergeBottleCount, setMergeBottleCount] = useState(0);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeResults, setMergeResults] = useState([]);
  const [mergeTarget, setMergeTarget] = useState(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState(null);

  // Registry-wide duplicate scanner
  const [showDuplicatesScanner, setShowDuplicatesScanner] = useState(false);

  // Producer-in-name cleanup tool
  const [showProducerInName, setShowProducerInName] = useState(false);
  const [showLowConfidence, setShowLowConfidence] = useState(false);

  // Taxonomy
  const [countries, setCountries] = useState([]);
  const [regions, setRegions] = useState([]);
  const [appellations, setAppellations] = useState([]);
  const [grapes, setGrapes] = useState([]);

  // Debounce search input → search state (only fires when empty or ≥2 chars)
  useEffect(() => {
    if (searchInput.length === 1) return;
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 600);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [filters]);

  const fetchWines = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({ page, limit: pageSize });
      if (search) params.set('search', search);
      if (filters.type) params.set('type', filters.type);
      params.set('sort', filters.sort);
      const res = await adminGetWines(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setWines(data.wines || []);
        setTotal(data.total || 0);
        setPages(data.pages || 1);
      } else {
        setListError(data.error || `Failed to load wines (${res.status})`);
      }
    } catch (err) {
      console.error('Failed to fetch wines:', err);
      setListError('Failed to load wines — check your connection and retry.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, search, filters, pageSize]);

  useEffect(() => {
    fetchWines();
  }, [fetchWines]);

  useEffect(() => {
    const fetchTaxonomy = async () => {
      try {
        const [cRes, gRes] = await Promise.all([
          adminGetCountries(apiFetch),
          adminGetGrapes(apiFetch)
        ]);
        const [cData, gData] = await Promise.all([cRes.json(), gRes.json()]);
        if (cRes.ok) setCountries(cData.countries || []);
        if (gRes.ok) setGrapes(gData.grapes || []);
      } catch (err) {
        console.error('Failed to load taxonomy:', err);
      }
    };
    fetchTaxonomy();
  }, [apiFetch]);

  const fetchRegions = async (countryId) => {
    if (!countryId) { setRegions([]); setAppellations([]); return; }
    try {
      const res = await adminGetRegions(apiFetch, countryId);
      const data = await res.json();
      if (res.ok) setRegions(data.regions || []);
    } catch (err) {
      console.error('Failed to load regions:', err);
    }
  };

  const fetchAppellations = async (countryId, regionId) => {
    if (!countryId) { setAppellations([]); return; }
    try {
      const params = new URLSearchParams({ country: countryId });
      if (regionId) params.set('region', regionId);
      const res = await adminGetAppellations(apiFetch, params);
      const data = await res.json();
      if (res.ok) setAppellations(data.appellations || []);
    } catch (err) {
      console.error('Failed to load appellations:', err);
    }
  };

  const openCreate = () => {
    setEditWine(null);
    setFormData(emptyForm);
    setRegions([]);
    setAppellations([]);
    setFormError(null);
    setImageCredit('');
    setShowForm(true);
  };

  const openEdit = async (wine) => {
    setFormError(null);
    setImageCredit('');
    try {
      const res = await adminGetWine(apiFetch, wine._id);
      const data = await res.json();
      if (res.ok) {
        const w = data.wine;
        const countryId = w.country?._id || w.country || '';
        const regionId = w.region?._id || w.region || '';
        if (countryId) {
          fetchRegions(countryId);
          fetchAppellations(countryId, regionId);
        }
        setFormData({
          name: w.name || '',
          producer: w.producer || '',
          country: countryId,
          region: regionId,
          type: w.type || 'red',
          appellation: w.appellation || '',
          grapes: (w.grapes || []).map(g => g._id || g),
        });
        setEditWine(w);
        setShowForm(true);
      }
    } catch (err) {
      console.error('Failed to load wine:', err);
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setEditWine(null);
    setFormData(emptyForm);
    setFormError(null);
    setDupCandidates(null);
    setImageCredit('');
  };

  const handleSubmit = async (e, confirmCreate = false) => {
    e?.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setDupCandidates(null);
    try {
      const payload = {
        name: formData.name.trim(),
        producer: formData.producer.trim(),
        country: formData.country,
        region: formData.region || null,
        type: formData.type,
        appellation: formData.appellation.trim() || null,
        grapes: formData.grapes,
        // Only meaningful on create: skips the server-side duplicate probe
        // after the admin explicitly chose "create anyway".
        ...(confirmCreate && !editWine ? { confirmCreate: true } : {}),
      };

      const res = await adminSaveWine(apiFetch, payload, editWine?._id);
      const data = await res.json();
      if (res.ok) {
        const name = data.wine?.name || payload.name;
        if (editWine) {
          pushToast(`Saved “${name}”`);
          closeForm();
        } else {
          // Stay in the drawer, flipped to edit mode: the image + credit
          // section only renders for an existing wine, and "create, close,
          // re-open to add the photo" was the papercut being fixed.
          pushToast(`Created “${name}” — add its image below`);
          setEditWine(data.wine);
        }
        fetchWines();
      } else if (res.status === 409 && data.candidates?.length) {
        // The registry already has very similar wine(s) — show them so the
        // admin links/merges instead, with an explicit "create anyway" out.
        setDupCandidates(data.candidates);
        setFormError(data.error || 'Very similar registry wines already exist');
      } else {
        setFormError(data.error || 'Failed to save wine');
      }
    } catch (err) {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (wine) => {
    setDeleteCandidate(wine);
  };

  const confirmDelete = async () => {
    if (!deleteCandidate) return;
    setDeleting(true);
    try {
      const res = await adminDeleteWine(apiFetch, deleteCandidate._id);
      const data = await res.json();
      if (res.ok) {
        pushToast(`Deleted “${deleteCandidate.name}”`);
        setDeleteCandidate(null);
        fetchWines();
      } else if (data.bottleCount) {
        // Has bottles — switch to merge modal
        setMergeSource(deleteCandidate);
        setMergeBottleCount(data.bottleCount);
        setMergeSearch('');
        setMergeResults([]);
        setMergeTarget(null);
        setMergeError(null);
        setDeleteCandidate(null);
      } else {
        setDeleteCandidate(null);
        setError(data.error || 'Failed to delete');
      }
    } catch (err) {
      setDeleteCandidate(null);
      setError('Network error');
    } finally {
      setDeleting(false);
    }
  };

  const closeMergeModal = () => {
    setMergeSource(null);
    setMergeTarget(null);
    setMergeSearch('');
    setMergeResults([]);
    setMergeError(null);
  };

  // Search for target wine in merge modal
  useEffect(() => {
    if (!mergeSource || mergeSearch.length < 2) {
      setMergeResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ search: mergeSearch, limit: 10 });
        const res = await adminGetWines(apiFetch, params);
        const data = await res.json();
        if (res.ok) {
          // Exclude the source wine from results
          setMergeResults((data.wines || []).filter(w => w._id !== mergeSource._id));
        }
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [mergeSearch, mergeSource, apiFetch]);

  const handleMerge = async () => {
    if (!mergeSource || !mergeTarget) return;
    setMerging(true);
    setMergeError(null);
    try {
      const res = await adminMergeWine(apiFetch, mergeSource._id, mergeTarget._id);
      const data = await res.json();
      if (res.ok) {
        pushToast(`Merged into “${mergeTarget.name}”`);
        closeMergeModal();
        fetchWines();
      } else {
        setMergeError(data.error || 'Failed to merge');
      }
    } catch {
      setMergeError('Network error');
    } finally {
      setMerging(false);
    }
  };

  const clearFilters = () => {
    setSearchInput('');
    setFilters({ type: '', sort: 'name' });
    setPage(1);
  };

  const hasActiveFilters = searchInput || filters.type || filters.sort !== 'name';

  return (
    <div className="admin-wines-page">
      <div className="page-header">
        <div>
          <h1>{t('admin.wines.title')}</h1>
          {!loading && <p className="page-subtitle">{t('admin.wines.wineDefinitions', { count: total })}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowDuplicatesScanner(true)} title="Scan the wine registry for likely duplicates">
            Find duplicates
          </button>
          <button className="btn btn-secondary" onClick={() => setShowProducerInName(true)} title={t('admin.wines.producerInName.buttonTitle')}>
            {t('admin.wines.producerInName.button')}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowLowConfidence(true)} title={t('admin.wines.lowConfidence.buttonTitle')}>
            {t('admin.wines.lowConfidence.button')}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            {t('admin.wines.newWine')}
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="wines-filter-bar">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('admin.wines.searchPlaceholder')}
          className="wines-search-input"
        />
        <select
          value={filters.type}
          onChange={(e) => setFilters(f => ({ ...f, type: e.target.value }))}
          className="wines-filter-select"
        >
          <option value="">{t('wines.allTypes')}</option>
          {WINE_TYPES.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
        <select
          value={filters.sort}
          onChange={(e) => setFilters(f => ({ ...f, sort: e.target.value }))}
          className="wines-filter-select"
        >
          <option value="name">{t('wines.sortNameAZ')}</option>
          <option value="-name">{t('wines.sortNameZA')}</option>
          <option value="producer">{t('wines.sortProducerAZ')}</option>
          <option value="-createdAt">{t('wines.sortRecentlyAdded')}</option>
        </select>
        {hasActiveFilters && (
          <button type="button" className="btn btn-secondary" onClick={clearFilters}>
            {t('common.clear')}
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Create / Edit drawer */}
      {showForm && (
        <Drawer
          title={editWine ? t('admin.wines.editWineTitle') : t('admin.wines.addWineTitle')}
          onClose={closeForm}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={closeForm}>{t('common.cancel')}</button>
              <button type="submit" form="wine-form" className="btn btn-primary" disabled={submitting}>
                {submitting ? t('common.saving') : editWine ? t('admin.wines.saveBtn') : t('admin.wines.createBtn')}
              </button>
            </>
          }
        >
          {formError && <div className="alert alert-error">{formError}</div>}
          {!editWine && dupCandidates?.length > 0 && (
            <div className="alert alert-info">
              <strong>{t('admin.wines.dupTitle')}</strong>
              <ul style={{ margin: '8px 0 8px 18px' }}>
                {dupCandidates.map((c) => (
                  <li key={c._id}>
                    “{c.name}” — {c.producer}{c.appellation ? ` (${c.appellation})` : ''}
                  </li>
                ))}
              </ul>
              <div>{t('admin.wines.dupHint')}</div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 8 }}
                disabled={submitting}
                onClick={(e) => handleSubmit(e, true)}
              >
                {t('admin.wines.dupCreateAnyway')}
              </button>
            </div>
          )}
          <form id="wine-form" onSubmit={handleSubmit}>
            <div className="wine-form-grid">
              <div className="form-group">
                <label>{t('admin.wines.nameLabel')}</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>{t('admin.wines.producerLabel')}</label>
                <input
                  type="text"
                  value={formData.producer}
                  onChange={(e) => setFormData({ ...formData, producer: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('admin.wines.countryLabel')}</label>
                <select
                  value={formData.country}
                  onChange={(e) => {
                    setFormData({ ...formData, country: e.target.value, region: '', appellation: '' });
                    fetchRegions(e.target.value);
                    fetchAppellations(e.target.value, '');
                  }}
                  required
                >
                  <option value="">{t('admin.wines.selectCountry')}</option>
                  {countries.map(c => (
                    <option key={c._id} value={c._id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>{t('admin.wines.regionLabel')}</label>
                <select
                  value={formData.region}
                  onChange={(e) => {
                    const regionId = e.target.value;
                    setFormData({ ...formData, region: regionId, appellation: '' });
                    fetchAppellations(formData.country, regionId);
                  }}
                  disabled={!formData.country}
                >
                  <option value="">{t('admin.wines.selectRegion')}</option>
                  {regions.map(r => (
                    <option key={r._id} value={r._id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>{t('admin.wines.typeLabel')}</label>
                <select
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                >
                  {WINE_TYPES.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>{t('admin.wines.appellationLabel')}</label>
                <select
                  value={formData.appellation}
                  onChange={(e) => setFormData({ ...formData, appellation: e.target.value })}
                  disabled={!formData.country}
                >
                  <option value="">{t('admin.wines.selectAppellation')}</option>
                  {formData.appellation && !appellations.some(a => a.name === formData.appellation) && (
                    <option value={formData.appellation}>{formData.appellation}</option>
                  )}
                  {appellations.map(a => (
                    <option key={a._id} value={a.name}>{a.name}</option>
                  ))}
                </select>
              </div>
              {grapes.length > 0 && (
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>
                    {t('admin.wines.grapesLabel')}
                    {formData.grapes.length > 0 && (
                      <span className="grape-count"> ({formData.grapes.length} selected)</span>
                    )}
                  </label>
                  <GrapePicker
                    grapes={grapes}
                    selected={formData.grapes}
                    onChange={(ids) => setFormData({ ...formData, grapes: ids })}
                  />
                </div>
              )}

              {/* Image upload — only available when editing an existing wine */}
              {editWine && (
                <div className="form-group wine-image-section" style={{ gridColumn: '1 / -1' }}>
                  <label>Wine Images</label>
                  <p className="wine-image-hint">{t('admin.wines.defaultImageHint', 'Click the star to set the default image for this wine.')}</p>

                  {/* Current default image with explicit remove button. The
                      WineDefinition.image field can hold a URL that doesn't
                      correspond to a WineImage record (legacy auto-saved
                      label scans), so the gallery alone can't clear it. */}
                  {editWine.image && (
                    <div className="wine-image-current">
                      <img
                        src={getWineImageUrl(editWine.image)}
                        alt={editWine.name}
                        className="wine-image-current-thumb"
                      />
                      <div className="wine-image-current-info">
                        <p className="wine-image-current-label">Current default image</p>
                        <button
                          type="button"
                          className="btn btn-danger btn-small"
                          onClick={async () => {
                            try {
                              const res = await adminSaveWine(apiFetch, { image: null }, editWine._id);
                              if (res.ok) {
                                // Server may auto-promote an approved gallery
                                // image — use the response value, not null.
                                const data = await res.json().catch(() => ({}));
                                setEditWine({ ...editWine, image: data.wine?.image ?? null });
                                galleryRef.current?.refresh();
                                fetchWines();
                              } else {
                                const data = await res.json().catch(() => ({}));
                                setFormError(data.error || 'Failed to remove image');
                              }
                            } catch {
                              setFormError('Network error while removing image');
                            }
                          }}
                        >
                          Remove default image
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="wine-image-existing">
                    <ImageGallery
                      ref={galleryRef}
                      wineDefinitionId={editWine._id}
                      size="medium"
                      showAll
                      onSetDefault={async (imageId) => {
                        if (!imageId) return;
                        const res = await adminAssignImageToWine(apiFetch, imageId, { wineDefinitionId: editWine._id });
                        if (!res.ok) {
                          const data = await res.json().catch(() => ({}));
                          throw new Error(data.error || 'Failed to assign image');
                        }
                      }}
                    />
                  </div>
                  <div className="form-group image-credit-field">
                    <label className="image-credit-label">
                      Image credit
                      <span className="image-credit-hint">Added to all images uploaded below</span>
                    </label>
                    <input
                      type="text"
                      value={imageCredit}
                      onChange={(e) => setImageCredit(e.target.value)}
                      placeholder="e.g. Courtesy of Vinifera Imports"
                      maxLength={200}
                    />
                  </div>
                  <ImageUpload
                    wineDefinitionId={editWine._id}
                    credit={imageCredit}
                    onUploadComplete={() => galleryRef.current?.refresh()}
                  />
                </div>
              )}
            </div>
          </form>
        </Drawer>
      )}

      {/* Wine list */}
      <div className="wines-meta">
        <span>{t('admin.wines.wineDefinitions', { count: total })}</span>
      </div>

      {listError && !loading && (
        <div className="alert alert-error wines-error">
          <span>{listError}</span>
          <button type="button" className="btn btn-secondary btn-small" onClick={fetchWines}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="wines-table-wrap">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="wine-skeleton-row" aria-hidden="true">
              <span className="wine-list-thumb wine-list-thumb--empty" />
              <span className="skeleton-bar" style={{ flex: 3 }} />
              <span className="skeleton-bar" style={{ flex: 1 }} />
            </div>
          ))}
        </div>
      ) : listError ? null : wines.length === 0 ? (
        <div className="empty-state">
          {hasActiveFilters ? (
            <>
              <p>No wines match your search or filters.</p>
              <button type="button" className="btn btn-secondary" onClick={clearFilters}>{t('common.clear')}</button>
            </>
          ) : (
            <p>{t('admin.wines.noWines')}</p>
          )}
        </div>
      ) : (
        <div className="wines-table-wrap">
          <table className="wines-table">
            <thead>
              <tr>
                <th className="col-img"></th>
                <th>{t('admin.wines.nameLabel')}</th>
                <th>{t('admin.wines.producerLabel')}</th>
                <th>{t('admin.wines.countryLabel')}</th>
                <th>{t('admin.wines.regionLabel')}</th>
                <th>{t('admin.wines.typeLabel')}</th>
                <th>{t('admin.wines.grapesLabel')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {wines.map(wine => {
                const imgSrc = getWineImageUrl(wine.image);
                return (
                <tr key={wine._id} className={editWine?._id === wine._id ? 'row-editing' : ''}>
                  <td className="col-img">
                    {imgSrc
                      ? <img src={imgSrc} alt={wine.name} className="wine-list-thumb" />
                      : <span className="wine-list-thumb wine-list-thumb--empty" />}
                  </td>
                  <td className="wine-name">
                    <button type="button" className="wine-name-link" onClick={() => openEdit(wine)} title="Edit this wine">
                      {wine.name}
                    </button>
                  </td>
                  <td>{wine.producer}</td>
                  <td>{wine.country?.name || '—'}</td>
                  <td>{wine.region?.name || '—'}</td>
                  <td><span className={`type-badge type-${wine.type}`}>{wine.type}</span></td>
                  <td className="grapes-cell">
                    {wine.grapes?.length > 0
                      ? wine.grapes.map(g => g.name).join(', ')
                      : '—'}
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => openEdit(wine)}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      className="btn btn-danger btn-small"
                      onClick={() => handleDelete(wine)}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!loading && !listError && total > 0 && (
        <div className="pagination wines-pagination">
          <span className="pagination-range">
            Showing {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
          </span>
          <div className="pagination-controls">
            <label className="page-size">
              Per page{' '}
              <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {[50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="btn btn-secondary btn-small" disabled={page <= 1} onClick={() => setPage(1)}>« First</button>
            <button className="btn btn-secondary btn-small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('common.previous')}</button>
            <span className="pagination-page">{t('admin.audit.page', { current: page, total: pages })}</span>
            <button className="btn btn-secondary btn-small" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('common.next')}</button>
            <button className="btn btn-secondary btn-small" disabled={page >= pages} onClick={() => setPage(pages)}>Last »</button>
          </div>
        </div>
      )}
      {/* Delete confirmation modal */}
      {deleteCandidate && (
        <Modal title={t('admin.wines.deleteTitle')} onClose={() => setDeleteCandidate(null)}>
          <p>{t('admin.wines.deleteConfirm', { name: deleteCandidate.name })}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDeleteCandidate(null)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleting ? t('common.saving') : t('common.delete')}
            </button>
          </div>
        </Modal>
      )}

      {/* Merge modal */}
      {mergeSource && (
        <Modal title={t('admin.wines.mergeTitle')} onClose={closeMergeModal}>
          <p className="merge-info">
            {t('admin.wines.mergeInfo', {
              name: mergeSource.name,
              count: mergeBottleCount,
            })}
          </p>

          {mergeError && <div className="alert alert-error">{mergeError}</div>}

          <div className="form-group">
            <label>{t('admin.wines.mergeSearchLabel')}</label>
            <input
              type="text"
              value={mergeSearch}
              onChange={(e) => { setMergeSearch(e.target.value); setMergeTarget(null); }}
              placeholder={t('admin.wines.searchPlaceholder')}
              autoFocus
            />
          </div>

          {mergeResults.length > 0 && !mergeTarget && (
            <ul className="merge-results">
              {mergeResults.map(w => (
                <li key={w._id} className="merge-result-item" onClick={() => setMergeTarget(w)}>
                  <span className="merge-result-name">{w.name}</span>
                  <span className="merge-result-producer">{w.producer}</span>
                  <span className={`type-badge type-${w.type}`}>{w.type}</span>
                </li>
              ))}
            </ul>
          )}

          {mergeTarget && (
            <div className="merge-target-selected">
              <p className="merge-target-label">{t('admin.wines.mergeTarget')}</p>
              <div className="merge-target-card">
                <strong>{mergeTarget.name}</strong> — {mergeTarget.producer}
                <span className={`type-badge type-${mergeTarget.type}`}>{mergeTarget.type}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => setMergeTarget(null)}
                >
                  {t('common.clear')}
                </button>
              </div>
            </div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closeMergeModal}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!mergeTarget || merging}
              onClick={handleMerge}
            >
              {merging ? t('common.saving') : t('admin.wines.mergeBtn')}
            </button>
          </div>
        </Modal>
      )}

      {showDuplicatesScanner && (
        <WineDuplicatesModal
          apiFetch={apiFetch}
          onClose={() => setShowDuplicatesScanner(false)}
          onMerged={fetchWines}
        />
      )}

      {showProducerInName && (
        <WineProducerInNameModal
          apiFetch={apiFetch}
          onClose={() => setShowProducerInName(false)}
          onChanged={fetchWines}
        />
      )}

      {showLowConfidence && (
        <WineLowConfidenceModal
          apiFetch={apiFetch}
          onClose={() => setShowLowConfidence(false)}
          onChanged={fetchWines}
        />
      )}

      {/* Action-feedback toasts */}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map(tt => (
            <div key={tt.id} className={`toast toast--${tt.type}`}>{tt.message}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default AdminWines;
