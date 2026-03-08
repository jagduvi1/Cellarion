import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  adminGetWines, adminGetWine, adminSaveWine, adminDeleteWine,
  adminGetCountries, adminGetGrapes, adminGetRegions, adminGetAppellations,
} from '../api/admin';
import { WINE_TYPES } from '../config/wineTypes';
import GrapePicker from '../components/GrapePicker';
import ImageUpload from '../components/ImageUpload';
import ImageGallery from '../components/ImageGallery';
import './AdminWines.css';

const emptyForm = {
  name: '',
  producer: '',
  country: '',
  region: '',
  type: 'red',
  appellation: '',
  grapes: [],
  image: ''
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
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editWine, setEditWine] = useState(null);
  const [formData, setFormData] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [imageCredit, setImageCredit] = useState('');

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
    try {
      const params = new URLSearchParams({ page, limit: 50 });
      if (search) params.set('search', search);
      if (filters.type) params.set('type', filters.type);
      params.set('sort', filters.sort);
      const res = await adminGetWines(apiFetch, params);
      const data = await res.json();
      if (res.ok) {
        setWines(data.wines);
        setTotal(data.total);
        setPages(data.pages);
      }
    } catch (err) {
      console.error('Failed to fetch wines:', err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page, search, filters]);

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
          image: w.image || ''
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
    setImageCredit('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = {
        name: formData.name.trim(),
        producer: formData.producer.trim(),
        country: formData.country,
        region: formData.region || null,
        type: formData.type,
        appellation: formData.appellation.trim() || null,
        grapes: formData.grapes,
        image: formData.image.trim() || null
      };

      const res = await adminSaveWine(apiFetch, payload, editWine?._id);
      const data = await res.json();
      if (res.ok) {
        closeForm();
        fetchWines();
      } else {
        setFormError(data.error || 'Failed to save wine');
      }
    } catch (err) {
      setFormError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (wine) => {
    if (!window.confirm(t('admin.wines.deleteConfirm', { name: wine.name }))) return;
    try {
      const res = await adminDeleteWine(apiFetch, wine._id);
      const data = await res.json();
      if (res.ok) {
        fetchWines();
      } else {
        setError(data.error || 'Failed to delete');
      }
    } catch (err) {
      setError('Network error');
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
          {!loading && <p className="page-subtitle">{total.toLocaleString()} {t('admin.wines.wineDefinitions')}</p>}
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          {t('admin.wines.newWine')}
        </button>
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

      {/* Create / Edit form */}
      {showForm && (
        <div className="card wine-form-card">
          <h2>{editWine ? t('admin.wines.editWineTitle') : t('admin.wines.addWineTitle')}</h2>
          {formError && <div className="alert alert-error">{formError}</div>}
          <form onSubmit={handleSubmit}>
            <div className="wine-form-grid">
              <div className="form-group">
                <label>{t('admin.wines.nameLabel')}</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
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
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>{t('admin.wines.imageUrlLabel')}</label>
                <input
                  type="url"
                  value={formData.image}
                  onChange={(e) => setFormData({ ...formData, image: e.target.value })}
                  placeholder="https://..."
                />
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
                  <div className="wine-image-existing">
                    <ImageGallery wineDefinitionId={editWine._id} size="medium" />
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
                    onUploadComplete={() => {}}
                  />
                </div>
              )}
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting
                  ? t('common.saving')
                  : editWine
                    ? t('admin.wines.saveBtn')
                    : t('admin.wines.createBtn')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeForm}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Wine list */}
      <div className="wines-meta">
        <span>{t('admin.wines.totalCount', { count: total })}</span>
      </div>

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : wines.length === 0 ? (
        <div className="empty-state"><p>{t('admin.wines.noWines')}</p></div>
      ) : (
        <div className="wines-table-wrap">
          <table className="wines-table">
            <thead>
              <tr>
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
              {wines.map(wine => (
                <tr key={wine._id} className={editWine?._id === wine._id ? 'row-editing' : ''}>
                  <td className="wine-name">{wine.name}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="pagination">
          <button
            className="btn btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            {t('common.previous')}
          </button>
          <span>{t('admin.audit.page', { current: page, total: pages })}</span>
          <button
            className="btn btn-secondary"
            disabled={page >= pages}
            onClick={() => setPage(p => p + 1)}
          >
            {t('common.next')}
          </button>
        </div>
      )}
    </div>
  );
}

export default AdminWines;
