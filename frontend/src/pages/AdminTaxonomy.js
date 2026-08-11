import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import {
  adminGetTaxonomy, adminGetCountries, adminGetGrapes, adminGetRegions,
  adminCreateTaxonomy, adminUpdateTaxonomy, adminDeleteTaxonomy,
  adminMergeTaxonomy, adminApproveRegion,
} from '../api/admin';
import GrapePicker from '../components/GrapePicker';
import ConfirmModal from '../components/ConfirmModal';
import Modal from '../components/Modal';
import BottleSizesAdmin from '../components/BottleSizesAdmin';
import AppellationUnmatchedModal from '../components/AppellationUnmatchedModal';
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
  const [mergeItem, setMergeItem] = useState(null);         // item being merged away
  const [showUnmatched, setShowUnmatched] = useState(false); // appellation review queue
  const [mergeTarget, setMergeTarget] = useState('');       // toId
  const [merging, setMerging] = useState(false);

  // Merge backends exist for exactly these three (services/taxonomyMerge.js);
  // appellations have no merge service — wines reference them by string, so a
  // rename IS the merge there.
  const MERGEABLE_TABS = ['countries', 'regions', 'grapes'];

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

  // ── Regional display names editor (grapes tab) ─────────────────────────────
  // Rows of [country, optional region, display name] on the grape form — e.g.
  // Tempranillo shown as "Tinta Roriz" on Douro wines. Each row can point at a
  // DIFFERENT country, so regions are cached per country here instead of going
  // through the single-country allRegions state the region/appellation forms
  // share (that would cross-talk between rows).
  const [regionsByCountry, setRegionsByCountry] = useState({});

  const loadRegionsForCountry = async (countryId) => {
    if (!countryId || regionsByCountry[countryId]) return;
    try {
      const res = await adminGetRegions(apiFetch, countryId);
      const data = await res.json();
      if (res.ok) setRegionsByCountry(prev => ({ ...prev, [countryId]: data.regions || [] }));
    } catch (err) {
      console.error('Failed to load regions', err);
    }
  };

  const setRegionalNameRow = (idx, patch) => {
    const rows = [...(formData.regionalNames || [])];
    rows[idx] = { ...rows[idx], ...patch };
    setFormData({ ...formData, regionalNames: rows });
  };

  const addRegionalNameRow = () => {
    setFormData({
      ...formData,
      regionalNames: [...(formData.regionalNames || []), { country: '', region: '', name: '' }]
    });
  };

  const removeRegionalNameRow = (idx) => {
    setFormData({
      ...formData,
      regionalNames: (formData.regionalNames || []).filter((_, i) => i !== idx)
    });
  };

  // Monotonic fetch id: each fetch (tab switch, create/update/delete refresh)
  // invalidates any still in-flight response, so a slow response for the
  // previous tab can't render its documents under the new tab.
  const fetchSeqRef = useRef(0);

  const fetchItems = async () => {
    const seq = ++fetchSeqRef.current;
    if (activeTab === 'bottleSizes') { setItems([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetTaxonomy(apiFetch, endpoints[activeTab]);
      const data = await res.json();
      if (seq !== fetchSeqRef.current) return; // stale — a newer fetch superseded this one
      if (res.ok) {
        // Index by the tab's expected key so a mismatched response shape
        // can't populate the list with another tab's documents.
        setItems(data[activeTab] || []);
      }
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError('Failed to load data');
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
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

  const handleMerge = async () => {
    if (!mergeItem || !mergeTarget) return;
    setMerging(true);
    setError(null);
    try {
      const res = await adminMergeTaxonomy(apiFetch, activeTab, mergeItem._id, mergeTarget);
      const data = await res.json();
      if (res.ok) {
        setMergeItem(null);
        setMergeTarget('');
        fetchItems();
      } else {
        setError(data.error || 'Failed to merge');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setMerging(false);
    }
  };

  // Merge candidates: same taxon, never itself; regions only within the same
  // country (the backend enforces this — mirroring it here keeps the dropdown
  // from offering choices that would 400).
  const mergeCandidates = mergeItem
    ? items.filter(i =>
        i._id !== mergeItem._id &&
        (activeTab !== 'regions' ||
          String(i.country?._id || i.country) === String(mergeItem.country?._id || mergeItem.country)))
    : [];

  const handleApproveRegion = async (id) => {
    setError(null);
    try {
      const res = await adminApproveRegion(apiFetch, id);
      const data = await res.json();
      if (res.ok) fetchItems();
      else setError(data.error || 'Failed to approve');
    } catch { setError('Network error'); }
  };

  const handleEditClick = (item) => {
    setShowForm(false);
    setEditItem(item);
    // Populate formData from item
    if (activeTab === 'countries') {
      setFormData({ name: item.name, code: item.code || '', description: item.description || '' });
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
        permittedGrapes: (item.permittedGrapes || []).map(g => g._id || g),
        description: item.description || ''
      });
    } else if (activeTab === 'grapes') {
      const regionalNames = (item.regionalNames || []).map(rn => ({
        country: rn.country?._id || rn.country || '',
        region: rn.region?._id || rn.region || '',
        name: rn.name || ''
      }));
      // Warm the per-country region cache so existing rows show their region
      // names immediately instead of an empty dropdown.
      [...new Set(regionalNames.map(rn => rn.country).filter(Boolean))].forEach(loadRegionsForCountry);
      setFormData({
        name: item.name,
        synonymsText: (item.synonyms || []).join(', '),
        synonyms: item.synonyms || [],
        color: item.color || '',
        origin: item.origin || '',
        characteristicsText: (item.characteristics || []).join(', '),
        characteristics: item.characteristics || [],
        agingPotential: item.agingPotential || '',
        prestige: item.prestige || '',
        description: item.description || '',
        regionalNames
      });
    } else if (activeTab === 'appellations') {
      const countryId = item.country?._id || item.country || '';
      fetchRegionsForCountry(countryId);
      setFormData({
        name: item.name,
        country: countryId,
        region: item.region?._id || item.region || '',
        synonyms: (item.synonyms || []).join(', ')
      });
    }
  };

  // Build the API payload from formData (handles comma-separated text → arrays, etc.)
  const buildPayload = (fd) => {
    if (activeTab === 'countries') {
      return { name: fd.name, code: fd.code, description: fd.description || '' };
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
        permittedGrapes: fd.permittedGrapes || [],
        description: fd.description || ''
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
        prestige: fd.prestige || null,
        description: fd.description || '',
        // Fully empty rows (no country, no name) are just an unused "+ add"
        // click — drop them. Half-filled rows are KEPT so the backend's
        // validation message reaches the admin instead of silent data loss.
        regionalNames: (fd.regionalNames || [])
          .filter(rn => rn.country || (rn.name || '').trim())
          .map(rn => ({ country: rn.country, region: rn.region || null, name: (rn.name || '').trim() }))
      };
    }
    if (activeTab === 'appellations') {
      return {
        name: fd.name,
        country: fd.country,
        region: fd.region || null,
        synonyms: fd.synonyms ? fd.synonyms.split(',').map(s => s.trim()).filter(Boolean) : []
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
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label>Description <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>(shown publicly on /countries/:slug)</span></label>
        <textarea
          rows={6}
          value={formData.description || ''}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Write a curated description of this country's wine culture. At least 100 unique words for SEO value."
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
      <div className="form-group">
        <label>Description <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>(shown publicly on /regions/:slug)</span></label>
        <textarea
          rows={6}
          value={formData.description || ''}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Write a curated description of this wine region. At least 100 unique words for SEO value."
        />
      </div>
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
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label>{t('admin.taxonomy.regionalNamesLabel')}</label>
        <p className="regional-names-hint">{t('admin.taxonomy.regionalNamesHint')}</p>
        {(formData.regionalNames || []).map((rn, idx) => (
          <div key={idx} className="regional-name-row">
            <select
              value={rn.country || ''}
              onChange={(e) => {
                // Country drives the region list — changing it resets the
                // row's region (same interlock as the appellation form).
                setRegionalNameRow(idx, { country: e.target.value, region: '' });
                loadRegionsForCountry(e.target.value);
              }}
              aria-label={t('admin.requests.countryLabel')}
            >
              <option value="">{t('admin.taxonomy.selectCountry')}</option>
              {allCountries.map(c => (
                <option key={c._id} value={c._id}>{c.name}</option>
              ))}
            </select>
            <select
              value={rn.region || ''}
              onChange={(e) => setRegionalNameRow(idx, { region: e.target.value })}
              disabled={!rn.country}
              aria-label={t('admin.taxonomy.appellationRegionLabel')}
            >
              <option value="">{t('admin.taxonomy.regionalNameWholeCountry')}</option>
              {(regionsByCountry[rn.country] || []).map(r => (
                <option key={r._id} value={r._id}>{r.name}</option>
              ))}
            </select>
            <input
              type="text"
              value={rn.name || ''}
              maxLength={60}
              placeholder={t('admin.taxonomy.regionalNamePlaceholder')}
              onChange={(e) => setRegionalNameRow(idx, { name: e.target.value })}
              aria-label={t('admin.taxonomy.regionalNamesLabel')}
            />
            <button
              type="button"
              className="btn btn-danger btn-small"
              onClick={() => removeRegionalNameRow(idx)}
            >
              {t('admin.taxonomy.regionalNameRemove')}
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-small" onClick={addRegionalNameRow}>
          {t('admin.taxonomy.addRegionalName')}
        </button>
      </div>
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label>Description <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>(shown publicly on /grapes/:slug)</span></label>
        <textarea
          rows={6}
          value={formData.description || ''}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Write a curated description of this grape variety. At least 100 unique words for SEO value."
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
        <label>{t('admin.taxonomy.synonymsLabel')}</label>
        <input
          type="text"
          value={formData.synonyms || ''}
          onChange={(e) => setFormData({ ...formData, synonyms: e.target.value })}
          placeholder={t('admin.taxonomy.appellationSynonymsPlaceholder')}
        />
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

  const isBottleSizes = activeTab === 'bottleSizes';

  return (
    <div className="admin-taxonomy-page">
      <div className="page-header">
        <h1>{t('admin.taxonomy.title')}</h1>
        {!isEditing && !isBottleSizes && (
          <div style={{ display: 'flex', gap: 8 }}>
            {activeTab === 'appellations' && (
              <button onClick={() => setShowUnmatched(true)} className="btn btn-secondary" title={t('admin.taxonomy.unmatched.buttonTitle')}>
                {t('admin.taxonomy.unmatched.button')}
              </button>
            )}
            <button onClick={() => { setShowForm(!showForm); setFormData({}); }} className="btn btn-primary">
              {showForm ? t('common.cancel') : addBtnLabel}
            </button>
          </div>
        )}
      </div>

      <div className="tabs">
        {['countries', 'regions', 'appellations', 'grapes', 'bottleSizes'].map(tab => (
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

      {isBottleSizes && <BottleSizesAdmin apiFetch={apiFetch} />}

      {!isBottleSizes && showForm && !isEditing && (
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

      {!isBottleSizes && isEditing && (
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

      {!isBottleSizes && (loading ? (
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
                  {item.pendingReview && (
                    <>
                      <span className="taxonomy-badge taxonomy-badge--pending" title={t('admin.taxonomy.pendingRegionTitle')}>
                        {t('admin.taxonomy.pendingRegion')}
                      </span>
                      <button
                        onClick={() => handleApproveRegion(item._id)}
                        className="btn btn-primary btn-small"
                      >
                        {t('admin.taxonomy.approveRegion')}
                      </button>
                    </>
                  )}
                  {typeof item.wineCount === 'number' && (
                    <span
                      className={`taxonomy-usage ${item.wineCount === 0 ? 'taxonomy-usage--zero' : ''}`}
                      title={t('admin.taxonomy.wineCountTitle')}
                    >
                      {t('admin.taxonomy.wineCount', { count: item.wineCount })}
                    </span>
                  )}
                  <button
                    onClick={() => handleEditClick(item)}
                    className="btn btn-secondary btn-small"
                  >
                    {t('common.edit')}
                  </button>
                  {MERGEABLE_TABS.includes(activeTab) && (
                    <button
                      onClick={() => { setMergeItem(item); setMergeTarget(''); }}
                      className="btn btn-secondary btn-small"
                      title={t('admin.taxonomy.mergeTitle')}
                    >
                      {t('admin.taxonomy.mergeBtn')}
                    </button>
                  )}
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
      ))}

      {confirmDelete && (
        <ConfirmModal
          title={t('admin.taxonomy.deleteBtn')}
          message={t('admin.taxonomy.confirmDeleteItem', 'Delete this item?')}
          warning={t('admin.taxonomy.deleteWarning', 'This action cannot be undone.')}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {showUnmatched && (
        <AppellationUnmatchedModal
          apiFetch={apiFetch}
          countries={allCountries}
          onClose={() => setShowUnmatched(false)}
          onPromoted={fetchItems}
        />
      )}

      {mergeItem && (
        <Modal
          title={t('admin.taxonomy.mergeModalTitle', { name: mergeItem.name })}
          onClose={() => { setMergeItem(null); setMergeTarget(''); }}
        >
          <p className="taxonomy-merge-explainer">
            {t('admin.taxonomy.mergeExplainer', {
              name: mergeItem.name,
              wineCount: mergeItem.wineCount ?? 0,
            })}
          </p>
          <div className="form-group">
            <label htmlFor="taxonomy-merge-target">{t('admin.taxonomy.mergeTargetLabel')}</label>
            <select
              id="taxonomy-merge-target"
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
            >
              <option value="">{t('admin.taxonomy.mergeTargetPlaceholder')}</option>
              {mergeCandidates.map(c => (
                <option key={c._id} value={c._id}>
                  {c.name}{typeof c.wineCount === 'number' ? ` (${t('admin.taxonomy.wineCount', { count: c.wineCount })})` : ''}
                </option>
              ))}
            </select>
          </div>
          <p className="taxonomy-merge-hint">{t('admin.taxonomy.mergeHint')}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setMergeItem(null); setMergeTarget(''); }}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!mergeTarget || merging}
              onClick={handleMerge}
            >
              {merging ? t('admin.taxonomy.merging') : t('admin.taxonomy.mergeConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default AdminTaxonomy;
