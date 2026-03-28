import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  adminGetTaxonomy, adminGetCountries, adminGetGrapes, adminGetRegions,
  adminCreateTaxonomy, adminUpdateTaxonomy, adminDeleteTaxonomy,
} from '../api/admin';
import GrapePicker from '../components/GrapePicker';
import ConfirmModal from '../components/ConfirmModal';
import './AdminTaxonomy.css';

function AdminTaxonomy() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [activeTab, setActiveTab] = useState('countries');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formData, setFormData] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null); // item being edited
  const [error, setError] = useState(null);
  const [allCountries, setAllCountries] = useState([]);
  const [allGrapes, setAllGrapes] = useState([]);
  const [allRegions, setAllRegions] = useState([]); // for parent region / appellation dropdowns
  const [confirmDelete, setConfirmDelete] = useState(null); // id of item to delete

  const endpoints = {
    countries: '/api/admin/taxonomy/countries',
    regions: '/api/admin/taxonomy/regions',
    grapes: '/api/admin/taxonomy/grapes',
    appellations: '/api/admin/taxonomy/appellations'
  };

  useEffect(() => {
    fetchItems();
    setShowForm(false);
    setEditItem(null);
    setFormData({});
  }, [activeTab, apiFetch]);

  useEffect(() => {
    const fetchCountries = async () => {
      try {
        const res = await adminGetCountries(apiFetch);
        const data = await res.json();
        if (res.ok) setAllCountries(data.countries || []);
      } catch (err) {
        console.error('Failed to load countries', err);
      }
    };
    const fetchGrapes = async () => {
      try {
        const res = await adminGetGrapes(apiFetch);
        const data = await res.json();
        if (res.ok) setAllGrapes(data.grapes || []);
      } catch (err) {
        console.error('Failed to load grapes', err);
      }
    };
    fetchCountries();
    fetchGrapes();
  }, [apiFetch]);

  // When region form's country changes, load sibling regions for parent dropdown
  const fetchRegionsForCountry = async (countryId) => {
    if (!countryId) { setAllRegions([]); return; }
    try {
      const res = await adminGetRegions(apiFetch, countryId);
      const data = await res.json();
      if (res.ok) setAllRegions(data.regions || []);
    } catch (err) {
      console.error('Failed to load regions', err);
    }
  };

  const fetchItems = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetTaxonomy(apiFetch, endpoints[activeTab]);
      const data = await res.json();
      if (res.ok) {
        setItems(data.countries || data.regions || data.grapes || data.appellations || []);
      }
    } catch (err) {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const payload = buildPayload(formData);
      const res = await adminCreateTaxonomy(apiFetch, endpoints[activeTab], payload);
      const data = await res.json();
      if (res.ok) {
        setShowForm(false);
        setFormData({});
        fetchItems();
        // Refresh grapes list if a grape was added (needed for region forms)
        if (activeTab === 'grapes') {
          const gRes = await adminGetGrapes(apiFetch);
          const gData = await gRes.json();
          if (gRes.ok) setAllGrapes(gData.grapes || []);
        }
      } else {
        setError(data.error || 'Failed to create');
      }
    } catch (err) {
      setError('Network error');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const payload = buildPayload(formData);
      const res = await adminUpdateTaxonomy(apiFetch, endpoints[activeTab], editItem._id, payload);
      const data = await res.json();
      if (res.ok) {
        setEditItem(null);
        setFormData({});
        fetchItems();
      } else {
        setError(data.error || 'Failed to update');
      }
    } catch (err) {
      setError('Network error');
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await adminDeleteTaxonomy(apiFetch, endpoints[activeTab], id);
      const data = await res.json();
      if (res.ok) {
        fetchItems();
      } else {
        setError(data.error || 'Failed to delete');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleEditClick = (item) => {
    setShowForm(false);
    setEditItem(item);
    // Populate formData from item
    if (activeTab === 'countries') {
      setFormData({ name: item.name, code: item.code || '' });
    } else if (activeTab === 'regions') {
      const countryId = item.country?._id || item.country || '';
      fetchRegionsForCountry(countryId);
      setFormData({
        name: item.name,
        country: countryId,
        parentRegion: item.parentRegion?._id || item.parentRegion || '',
        classification: item.classification || '',
        stylesText: (item.styles || []).join(', '),
        styles: item.styles || [],
        agingMinMonths: item.agingRules?.legalMinMonths || '',
        agingNotes: item.agingRules?.notes || '',
        prestigeLevel: item.prestigeLevel || '',
        typicalGrapes: (item.typicalGrapes || []).map(g => g._id || g),
        permittedGrapes: (item.permittedGrapes || []).map(g => g._id || g)
      });
    } else if (activeTab === 'grapes') {
      setFormData({
        name: item.name,
        synonymsText: (item.synonyms || []).join(', '),
        synonyms: item.synonyms || [],
        color: item.color || '',
        origin: item.origin || '',
        characteristicsText: (item.characteristics || []).join(', '),
        characteristics: item.characteristics || [],
        agingPotential: item.agingPotential || '',
        prestige: item.prestige || ''
      });
    } else if (activeTab === 'appellations') {
      const countryId = item.country?._id || item.country || '';
      fetchRegionsForCountry(countryId);
      setFormData({
        name: item.name,
        country: countryId,
        region: item.region?._id || item.region || ''
      });
    }
  };

  // Build the API payload from formData (handles comma-separated text → arrays, etc.)
  const buildPayload = (fd) => {
    if (activeTab === 'countries') {
      return { name: fd.name, code: fd.code };
    }
    if (activeTab === 'regions') {
      return {
        name: fd.name,
        country: fd.country,
        parentRegion: fd.parentRegion || null,
        classification: fd.classification || null,
        styles: fd.styles || [],
        agingRules: {
          legalMinMonths: fd.agingMinMonths ? parseInt(fd.agingMinMonths) : null,
          notes: fd.agingNotes || null
        },
        prestigeLevel: fd.prestigeLevel || null,
        typicalGrapes: fd.typicalGrapes || [],
        permittedGrapes: fd.permittedGrapes || []
      };
    }
    if (activeTab === 'grapes') {
      return {
        name: fd.name,
        synonyms: fd.synonyms || [],
        color: fd.color || null,
        origin: fd.origin || null,
        characteristics: fd.characteristics || [],
        agingPotential: fd.agingPotential || null,
        prestige: fd.prestige || null
      };
    }
    if (activeTab === 'appellations') {
      return {
        name: fd.name,
        country: fd.country,
        region: fd.region || null
      };
    }
    return fd;
  };

  const addBtnLabel = {
    countries: t('admin.taxonomy.addCountry'),
    regions: t('admin.taxonomy.addRegion'),
    grapes: t('admin.taxonomy.addGrape'),
    appellations: t('admin.taxonomy.addAppellation')
  }[activeTab] || '';

  const renderCountryForm = () => (
    <>
      <div className="form-group">
        <label>{t('admin.taxonomy.countryNameLabel')}</label>
        <input
          type="text"
          value={formData.name || ''}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.isoCodeLabel')}</label>
        <input
          type="text"
          value={formData.code || ''}
          onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
          maxLength="2"
          placeholder="FR"
        />
      </div>
    </>
  );

  const renderRegionForm = () => (
    <div className="taxonomy-full-form">
      <div className="form-row-2">
        <div className="form-group">
          <label>{t('admin.taxonomy.regionNameLabel')}</label>
          <input
            type="text"
            value={formData.name || ''}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
          />
        </div>
        <div className="form-group">
          <label>{t('admin.requests.countryLabel')}</label>
          <select
            value={formData.country || ''}
            onChange={(e) => {
              setFormData({ ...formData, country: e.target.value, parentRegion: '' });
              fetchRegionsForCountry(e.target.value);
            }}
            required
            disabled={!!editItem} // country is immutable on edit
          >
            <option value="">{t('admin.taxonomy.selectCountry')}</option>
            {allCountries.map(c => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>{t('admin.taxonomy.parentRegionLabel')}</label>
          <select
            value={formData.parentRegion || ''}
            onChange={(e) => setFormData({ ...formData, parentRegion: e.target.value })}
            disabled={!formData.country}
          >
            <option value="">{t('admin.taxonomy.selectParentRegion')}</option>
            {allRegions
              .filter(r => !editItem || r._id !== editItem._id) // don't allow self as parent
              .map(r => (
                <option key={r._id} value={r._id}>{r.name}</option>
              ))}
          </select>
        </div>
        <div className="form-group">
          <label>{t('admin.taxonomy.classificationLabel')}</label>
          <input
            type="text"
            value={formData.classification || ''}
            onChange={(e) => setFormData({ ...formData, classification: e.target.value })}
            placeholder="AOC, DOC, AVA..."
          />
        </div>
        <div className="form-group">
          <label>{t('admin.taxonomy.stylesLabel')}</label>
          <input
            type="text"
            value={formData.stylesText || ''}
            onChange={(e) => setFormData({
              ...formData,
              stylesText: e.target.value,
              styles: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
            })}
            placeholder="Red, White, Rosé"
          />
        </div>
        <div className="form-group">
          <label>{t('admin.taxonomy.prestigeLevelLabel')}</label>
          <input
            type="text"
            value={formData.prestigeLevel || ''}
            onChange={(e) => setFormData({ ...formData, prestigeLevel: e.target.value })}
            placeholder="Premier Cru, Grand Cru..."
          />
        </div>
        <div className="form-group">
          <label>{t('admin.taxonomy.agingMinMonthsLabel')}</label>
          <input
            type="number"
            min="0"
            value={formData.agingMinMonths || ''}
            onChange={(e) => setFormData({ ...formData, agingMinMonths: e.target.value })}
            placeholder="e.g. 12"
          />
        </div>
        <div className="form-group">
          <label>{t('admin.taxonomy.agingNotesLabel')}</label>
          <input
            type="text"
            value={formData.agingNotes || ''}
            onChange={(e) => setFormData({ ...formData, agingNotes: e.target.value })}
            placeholder="Optional aging rule notes"
          />
        </div>
      </div>
      {allGrapes.length > 0 && (
        <>
          <div className="form-group">
            <label>
              {t('admin.taxonomy.typicalGrapesLabel')}
              {(formData.typicalGrapes || []).length > 0 && (
                <span className="grape-count"> ({formData.typicalGrapes.length} selected)</span>
              )}
            </label>
            <GrapePicker
              grapes={allGrapes}
              selected={formData.typicalGrapes || []}
              onChange={(ids) => setFormData({ ...formData, typicalGrapes: ids })}
            />
          </div>
          <div className="form-group">
            <label>
              {t('admin.taxonomy.permittedGrapesLabel')}
              {(formData.permittedGrapes || []).length > 0 && (
                <span className="grape-count"> ({formData.permittedGrapes.length} selected)</span>
              )}
            </label>
            <GrapePicker
              grapes={allGrapes}
              selected={formData.permittedGrapes || []}
              onChange={(ids) => setFormData({ ...formData, permittedGrapes: ids })}
            />
          </div>
        </>
      )}
    </div>
  );

  const renderGrapeForm = () => (
    <div className="form-row-2">
      <div className="form-group">
        <label>{t('admin.taxonomy.grapeNameLabel')}</label>
        <input
          type="text"
          value={formData.name || ''}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.colorLabel')}</label>
        <select
          value={formData.color || ''}
          onChange={(e) => setFormData({ ...formData, color: e.target.value })}
        >
          <option value="">— {t('common.color')} —</option>
          <option value="Red">{t('admin.taxonomy.colorRed')}</option>
          <option value="White">{t('admin.taxonomy.colorWhite')}</option>
        </select>
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.synonymsLabel')}</label>
        <input
          type="text"
          value={formData.synonymsText || ''}
          onChange={(e) => setFormData({
            ...formData,
            synonymsText: e.target.value,
            synonyms: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
          })}
          placeholder={t('admin.taxonomy.synonymsPlaceholder')}
        />
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.originLabel')}</label>
        <input
          type="text"
          value={formData.origin || ''}
          onChange={(e) => setFormData({ ...formData, origin: e.target.value })}
          placeholder="e.g. Bordeaux, France"
        />
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.characteristicsLabel')}</label>
        <input
          type="text"
          value={formData.characteristicsText || ''}
          onChange={(e) => setFormData({
            ...formData,
            characteristicsText: e.target.value,
            characteristics: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
          })}
          placeholder="Tannic, Full-bodied, Dark fruit"
        />
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.agingPotentialLabel')}</label>
        <input
          type="text"
          value={formData.agingPotential || ''}
          onChange={(e) => setFormData({ ...formData, agingPotential: e.target.value })}
          placeholder="e.g. 10-20 years"
        />
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.prestigeLabel')}</label>
        <input
          type="text"
          value={formData.prestige || ''}
          onChange={(e) => setFormData({ ...formData, prestige: e.target.value })}
          placeholder="e.g. Noble, Premium"
        />
      </div>
    </div>
  );

  const renderAppellationForm = () => (
    <div className="form-row-2">
      <div className="form-group">
        <label>{t('admin.taxonomy.appellationNameLabel')}</label>
        <input
          type="text"
          value={formData.name || ''}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          required
        />
      </div>
      <div className="form-group">
        <label>{t('admin.requests.countryLabel')}</label>
        <select
          value={formData.country || ''}
          onChange={(e) => {
            setFormData({ ...formData, country: e.target.value, region: '' });
            fetchRegionsForCountry(e.target.value);
          }}
          required
          disabled={!!editItem}
        >
          <option value="">{t('admin.taxonomy.selectCountry')}</option>
          {allCountries.map(c => (
            <option key={c._id} value={c._id}>{c.name}</option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label>{t('admin.taxonomy.appellationRegionLabel')}</label>
        <select
          value={formData.region || ''}
          onChange={(e) => setFormData({ ...formData, region: e.target.value })}
          disabled={!formData.country}
        >
          <option value="">{t('admin.taxonomy.appellationRegionNone')}</option>
          {allRegions.map(r => (
            <option key={r._id} value={r._id}>{r.name}</option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderForm = () => {
    if (activeTab === 'countries') return renderCountryForm();
    if (activeTab === 'regions') return renderRegionForm();
    if (activeTab === 'grapes') return renderGrapeForm();
    if (activeTab === 'appellations') return renderAppellationForm();
  };

  const renderItem = (item) => {
    if (activeTab === 'countries') {
      return <span>{item.name} {item.code && <em>({item.code})</em>}</span>;
    }
    if (activeTab === 'regions') {
      return (
        <span>
          {item.name}
          {item.country?.name && <em> — {item.country.name}</em>}
          {item.classification && <span className="taxonomy-badge">{item.classification}</span>}
          {item.prestigeLevel && <span className="taxonomy-badge taxonomy-badge--prestige">{item.prestigeLevel}</span>}
        </span>
      );
    }
    if (activeTab === 'grapes') {
      return (
        <span>
          {item.name}
          {item.color && <span className={`taxonomy-badge taxonomy-badge--color taxonomy-badge--${item.color.toLowerCase()}`}>{item.color}</span>}
          {item.synonyms?.length > 0 && <em className="taxonomy-synonyms"> ({item.synonyms.join(', ')})</em>}
        </span>
      );
    }
    if (activeTab === 'appellations') {
      return (
        <span>
          {item.name}
          {item.region?.name && <em> — {item.region.name}</em>}
          {item.country?.name && <span className="taxonomy-badge">{item.country.name}</span>}
        </span>
      );
    }
  };

  const isEditing = !!editItem;

  return (
    <div className="admin-taxonomy-page">
      <div className="page-header">
        <h1>{t('admin.taxonomy.title')}</h1>
        {!isEditing && (
          <button onClick={() => { setShowForm(!showForm); setFormData({}); }} className="btn btn-primary">
            {showForm ? t('common.cancel') : addBtnLabel}
          </button>
        )}
      </div>

      <div className="tabs">
        {['countries', 'regions', 'appellations', 'grapes'].map(tab => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {t(`admin.taxonomy.${tab}`)}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && !isEditing && (
        <div className="card create-form">
          <h2>{addBtnLabel}</h2>
          <form onSubmit={handleCreate}>
            {renderForm()}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">{t('admin.taxonomy.createBtn')}</button>
              <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">{t('common.cancel')}</button>
            </div>
          </form>
        </div>
      )}

      {isEditing && (
        <div className="card create-form">
          <h2>{t('admin.taxonomy.editTitle', { name: editItem.name })}</h2>
          <form onSubmit={handleUpdate}>
            {renderForm()}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">{t('common.save')}</button>
              <button type="button" onClick={() => { setEditItem(null); setFormData({}); }} className="btn btn-secondary">{t('common.cancel')}</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : (
        <div className="items-list">
          {items.length === 0 ? (
            <div className="empty-state"><p>{t('admin.taxonomy.noItems', { tab: activeTab })}</p></div>
          ) : (
            items.map(item => (
              <div key={item._id} className={`taxonomy-item ${editItem?._id === item._id ? 'editing' : ''}`}>
                <div className="taxonomy-item-content">{renderItem(item)}</div>
                <div className="taxonomy-item-actions">
                  <button
                    onClick={() => handleEditClick(item)}
                    className="btn btn-secondary btn-small"
                  >
                    {t('common.edit')}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(item._id)}
                    className="btn btn-danger btn-small"
                  >
                    {t('admin.taxonomy.deleteBtn')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t('admin.taxonomy.deleteBtn')}
          message={t('admin.taxonomy.confirmDeleteItem', 'Delete this item?')}
          warning={t('admin.taxonomy.deleteWarning', 'This action cannot be undone.')}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

export default AdminTaxonomy;
