import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import GrapePicker from '../components/GrapePicker';
import './AdminWines.css';

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

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
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editWine, setEditWine] = useState(null); // null = create, object = edit
  const [formData, setFormData] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [formError, setFormError] = useState(null);

  // Taxonomy
  const [countries, setCountries] = useState([]);
  const [regions, setRegions] = useState([]);
  const [appellations, setAppellations] = useState([]);
  const [grapes, setGrapes] = useState([]);

  const fetchWines = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 50 });
      if (search) params.set('search', search);
      const res = await apiFetch(`/api/admin/wines?${params}`);
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
  }, [apiFetch, page, search]);

  useEffect(() => {
    fetchWines();
  }, [fetchWines]);

  useEffect(() => {
    const fetchTaxonomy = async () => {
      try {
        const [cRes, gRes] = await Promise.all([
          apiFetch('/api/admin/taxonomy/countries'),
          apiFetch('/api/admin/taxonomy/grapes')
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
      const res = await apiFetch(`/api/admin/taxonomy/regions?country=${countryId}`);
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
      const res = await apiFetch(`/api/admin/taxonomy/appellations?${params}`);
      const data = await res.json();
      if (res.ok) setAppellations(data.appellations || []);
    } catch (err) {
      console.error('Failed to load appellations:', err);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const openCreate = () => {
    setEditWine(null);
    setFormData(emptyForm);
    setRegions([]);
    setAppellations([]);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = async (wine) => {
    setFormError(null);
    // Fetch full wine so we have ObjectId arrays for grapes
    try {
      const res = await apiFetch(`/api/admin/wines/${wine._id}`);
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

      const url = editWine
        ? `/api/admin/wines/${editWine._id}`
        : '/api/admin/wines';
      const method = editWine ? 'PUT' : 'POST';

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
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
      const res = await apiFetch(`/api/admin/wines/${wine._id}`, { method: 'DELETE' });
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

  return (
    <div className="admin-wines-page">
      <div className="page-header">
        <h1>{t('admin.wines.title')}</h1>
        <button className="btn btn-primary" onClick={openCreate}>
          {t('admin.wines.newWine')}
        </button>
      </div>

      {/* Search bar */}
      <form className="wines-search" onSubmit={handleSearch}>
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('admin.wines.searchPlaceholder')}
          className="wines-search-input"
        />
        <button type="submit" className="btn btn-secondary">{t('common.search')}</button>
        {search && (
          <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}>
            {t('common.clear')}
          </button>
        )}
      </form>

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
                  {/* Show current value even if it isn't in the taxonomy (e.g. from bulk import) */}
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
