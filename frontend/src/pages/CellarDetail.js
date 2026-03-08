import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar, getCellarStatistics, updateCellar, deleteCellar, updateCellarColor, exportCellar } from '../api/cellars';
import { getRacks } from '../api/racks';
import ShareCellarModal from '../components/ShareCellarModal';
import CellarColorPicker from '../components/CellarColorPicker';
import Modal from '../components/Modal';
import BottleCard from '../components/BottleCard';
import './CellarDetail.css';

function CellarDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const userCurrency = user?.preferences?.currency || 'USD';
  const navigate = useNavigate();
  const [cellar, setCellar] = useState(null);
  const [bottles, setBottles] = useState([]);
  const [statistics, setStatistics] = useState(null);
  const [rackMap, setRackMap] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filters, setFilters] = useState({
    search: '',
    vintage: '',
    minRating: '',
    drinkStatus: '',
    sort: '-createdAt'
  });

  // Bottles list re-fetches when filters change; statistics and racks only need to reload when the cellar ID changes
  useEffect(() => {
    fetchCellarData();
  }, [id, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchStatistics();
    fetchRacks();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchCellarData = async () => {
    try {
      const params = new URLSearchParams();
      Object.keys(filters).forEach(key => {
        if (filters[key]) params.append(key, filters[key]);
      });
      const res = await getCellar(apiFetch, id, params);
      const data = await res.json();
      if (res.ok) {
        setCellar(data.cellar);
        setBottles(data.bottles.items);
      } else {
        setError(data.error || 'Failed to load cellar');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const fetchStatistics = async () => {
    try {
      const res = await getCellarStatistics(apiFetch, id, userCurrency);
      const data = await res.json();
      if (res.ok) setStatistics(data.statistics);
    } catch {}
  };

  const fetchRacks = async () => {
    try {
      const res = await getRacks(apiFetch, id);
      const data = await res.json();
      if (res.ok) {
        const map = new Map();
        data.racks.forEach(rack => {
          rack.slots.forEach(slot => {
            const bid = slot.bottle?._id || slot.bottle;
            if (bid) map.set(bid.toString(), { rackId: rack._id, rackName: rack.name, position: slot.position });
          });
        });
        setRackMap(map);
      }
    } catch {}
  };

  const hasAlerts = statistics && (statistics.drinkOverdue > 0 || statistics.drinkSoon > 0);

  if (loading) return <div className="loading">{t('cellarDetail.loadingCellar')}</div>;
  if (error)   return <div className="alert alert-error">{error}</div>;

  const h1Style = cellar.userColor
    ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' }
    : {};

  return (
    <div className="cellar-detail-page">
      <div className="page-header">
        <div>
          <Link to="/cellars" className="back-link">{t('cellarDetail.backToCellars')}</Link>
          <h1 style={h1Style}>{cellar.name}</h1>
          {cellar.description && <p className="cellar-description">{cellar.description}</p>}
          {cellar.userRole && cellar.userRole !== 'owner' && (
            <p className="shared-by-label">
              {t('cellarDetail.sharedBy')} <strong>{cellar.user?.username}</strong>
              {' · '}
              <span className={`shared-role-tag shared-role-tag--${cellar.userRole}`}>
                {cellar.userRole === 'editor' ? t('cellarDetail.editAccess') : t('cellarDetail.viewAccess')}
              </span>
            </p>
          )}
        </div>
        <div className="header-actions">
          {/* Color dot — always visible */}
          <button
            onClick={() => setShowColorPicker(true)}
            className="btn-color-dot"
            title="Set my cellar color"
            style={{ background: cellar.userColor || '#3a3a3a' }}
          />

          {/* Primary actions — always visible */}
          <Link to={`/cellars/${id}/history`} className="btn btn-secondary btn-icon" title="History">
            📖 <span className="btn-label">{t('cellarDetail.history')}</span>
          </Link>
          {(cellar.userRole === 'owner' || cellar.userRole === 'editor') && (
            <Link to={`/cellars/${id}/add-bottle`} className="btn btn-primary btn-icon">
              ➕ <span className="btn-label">{t('cellarDetail.addBottle')}</span>
            </Link>
          )}

          {/* Overflow menu */}
          <div className="more-menu-wrap">
            <button
              className="btn btn-secondary btn-more"
              onClick={() => setMoreOpen(o => !o)}
              title="More actions"
              aria-haspopup="true"
              aria-expanded={moreOpen}
            >
              ⋯
            </button>
            {moreOpen && (
              <>
                <div className="more-menu-backdrop" onClick={() => setMoreOpen(false)} />
                <div className="more-menu-dropdown">
                  <button
                    className="more-menu-item"
                    onClick={() => setShowColorPicker(true) || setMoreOpen(false)}
                  >
                    {t('cellarDetail.setColor')}
                  </button>
                  {cellar.userRole === 'owner' && (
                    <button
                      className="more-menu-item"
                      onClick={() => { setShowEditModal(true); setMoreOpen(false); }}
                    >
                      {t('cellarDetail.editCellar')}
                    </button>
                  )}
                  {cellar.userRole === 'owner' && (
                    <button
                      className="more-menu-item"
                      onClick={() => { setShowShareModal(true); setMoreOpen(false); }}
                    >
                      {t('cellarDetail.share')}
                    </button>
                  )}
                  <Link
                    to={`/cellars/${id}/racks`}
                    className="more-menu-item"
                    onClick={() => setMoreOpen(false)}
                  >
                    {t('cellarDetail.racks')}
                  </Link>
                  <Link
                    to={`/cellars/${id}/history`}
                    className="more-menu-item"
                    onClick={() => setMoreOpen(false)}
                  >
                    {t('cellarDetail.historyMenuItem')}
                  </Link>
                  {(cellar.userRole === 'owner' || cellar.userRole === 'editor') && (
                    <Link
                      to={`/cellars/${id}/import`}
                      className="more-menu-item"
                      onClick={() => setMoreOpen(false)}
                    >
                      Import Bottles
                    </Link>
                  )}
                  {cellar.userRole === 'owner' && (
                    <button
                      className="more-menu-item"
                      onClick={async () => {
                        setMoreOpen(false);
                        try {
                          const res = await exportCellar(apiFetch, id);
                          const data = await res.json();
                          if (!res.ok) { alert(data.error || 'Export failed'); return; }
                          const blob = new Blob([JSON.stringify(data.bottles, null, 2)], { type: 'application/json' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${data.cellarName || 'cellar'}-export.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch { alert('Export failed'); }
                      }}
                    >
                      Export Bottles (JSON)
                    </button>
                  )}
                  {cellar.userRole === 'owner' && (
                    <button
                      className="more-menu-item"
                      onClick={async () => {
                        setMoreOpen(false);
                        try {
                          const res = await exportCellar(apiFetch, id);
                          const data = await res.json();
                          if (!res.ok) { alert(data.error || 'Export failed'); return; }
                          const bottles = data.bottles;
                          if (bottles.length === 0) { alert('No bottles to export'); return; }
                          const cols = ['wineName','producer','vintage','country','region','appellation','type',
                            'price','currency','bottleSize','purchaseDate','purchaseLocation','location',
                            'notes','rating','ratingScale','drinkFrom','drinkBefore',
                            'rackName','rackPosition','rackRow','rackCol','dateAdded',
                            'addToHistory','consumedReason','consumedAt','consumedNote','consumedRating','consumedRatingScale'];
                          const escape = v => {
                            if (v == null || v === '') return '';
                            const s = String(v);
                            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
                          };
                          const csv = [cols.join(','), ...bottles.map(b => cols.map(c => escape(b[c])).join(','))].join('\n');
                          const blob = new Blob([csv], { type: 'text/csv' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${data.cellarName || 'cellar'}-export.csv`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch { alert('Export failed'); }
                      }}
                    >
                      Export Bottles (CSV)
                    </button>
                  )}
                  {cellar.userRole === 'owner' && (
                    <Link
                      to={`/cellars/${id}/audit`}
                      className="more-menu-item"
                      onClick={() => setMoreOpen(false)}
                    >
                      {t('cellarDetail.auditLog')}
                    </Link>
                  )}
                  {cellar.userRole === 'owner' && (
                    <>
                      <div className="more-menu-divider" />
                      <button
                        className="more-menu-item more-menu-item--danger"
                        onClick={() => { setShowDeleteModal(true); setMoreOpen(false); }}
                      >
                        {t('cellarDetail.deleteCellar')}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Drink alert strip */}
      {hasAlerts && (
        <div className="drink-alert-strip">
          <span className="drink-strip-label">{t('cellarDetail.drinkAlerts')}</span>
          {statistics.drinkOverdue > 0 && (
            <span className="drink-badge overdue">{t('cellarDetail.overdue', { count: statistics.drinkOverdue })}</span>
          )}
          {statistics.drinkSoon > 0 && (
            <span className="drink-badge soon">{t('cellarDetail.drinkSoon', { count: statistics.drinkSoon })}</span>
          )}
          <Link to={`/cellars/${id}/drink-alerts`} className="drink-strip-link">{t('cellarDetail.viewAll')}</Link>
        </div>
      )}

      {statistics && (
        <div className="statistics-grid">
          <div className="stat-card">
            <h3>{statistics.totalBottles}</h3>
            <p>{t('cellarDetail.totalBottles')}</p>
          </div>
          <div className="stat-card">
            <h3>{statistics.uniqueWines}</h3>
            <p>{t('cellarDetail.uniqueWines')}</p>
          </div>
          <div className="stat-card">
            <h3>{statistics.convertedTotal.toFixed(2)} {userCurrency}</h3>
            <p>{t('cellarDetail.totalValue')}</p>
          </div>
          <div className="stat-card">
            <h3>{statistics.convertedAverage.toFixed(2)} {userCurrency}</h3>
            <p>{t('cellarDetail.avgPrice')}</p>
          </div>
        </div>
      )}

      <div className="filters-bar filters-bar-5">
        <input
          type="text"
          placeholder={t('cellarDetail.searchPlaceholder')}
          value={filters.search}
          onChange={e => setFilters({ ...filters, search: e.target.value })}
          className="search-input"
        />
        <input
          type="text"
          placeholder={t('cellarDetail.vintagePlaceholder')}
          value={filters.vintage}
          onChange={e => setFilters({ ...filters, vintage: e.target.value })}
          className="filter-input"
        />
        <select
          value={filters.minRating}
          onChange={e => setFilters({ ...filters, minRating: e.target.value })}
          className="filter-select"
        >
          <option value="">{t('cellarDetail.allRatings')}</option>
          <option value="80">{t('cellarDetail.stars4Plus')}</option>
          <option value="60">{t('cellarDetail.stars3Plus')}</option>
          <option value="40">{t('cellarDetail.stars2Plus')}</option>
        </select>
        <select
          value={filters.drinkStatus}
          onChange={e => setFilters({ ...filters, drinkStatus: e.target.value })}
          className="filter-select"
        >
          <option value="">{t('cellarDetail.allDrinkWindows')}</option>
          <option value="overdue">{t('cellarDetail.filterOverdue')}</option>
          <option value="soon">{t('cellarDetail.filterSoon')}</option>
          <option value="inWindow">{t('cellarDetail.filterInWindow')}</option>
          <option value="notReady">{t('cellarDetail.filterNotReady')}</option>
        </select>
        <select
          value={filters.sort}
          onChange={e => setFilters({ ...filters, sort: e.target.value })}
          className="filter-select"
        >
          <option value="-createdAt">{t('cellarDetail.sortNewest')}</option>
          <option value="createdAt">{t('cellarDetail.sortOldest')}</option>
          <option value="name">{t('cellarDetail.sortNameAZ')}</option>
          <option value="-name">{t('cellarDetail.sortNameZA')}</option>
          <option value="vintage">{t('cellarDetail.sortVintageOld')}</option>
          <option value="-vintage">{t('cellarDetail.sortVintageNew')}</option>
          <option value="price">{t('cellarDetail.sortPriceLow')}</option>
          <option value="-price">{t('cellarDetail.sortPriceHigh')}</option>
        </select>
      </div>

      {bottles.length === 0 ? (
        <div className="empty-state">
          <p>
            {filters.drinkStatus
              ? t('cellarDetail.noDrinkWindowFilter')
              : t('cellarDetail.noBottles')}
          </p>
          {(cellar.userRole === 'owner' || cellar.userRole === 'editor') && (
            <Link to={`/cellars/${id}/add-bottle`} className="btn btn-primary">
              {t('cellarDetail.addFirstBottle')}
            </Link>
          )}
        </div>
      ) : (
        <BottlesList
          bottles={bottles}
          rackMap={rackMap}
          cellarId={id}
        />
      )}

      {showShareModal && (
        <ShareCellarModal
          cellarId={id}
          cellarName={cellar.name}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {showEditModal && (
        <EditCellarModal
          cellar={cellar}
          onSaved={updated => { setCellar(updated); setShowEditModal(false); }}
          onClose={() => setShowEditModal(false)}
        />
      )}

      {showColorPicker && (
        <ColorPickerModal
          currentColor={cellar.userColor}
          cellarId={id}
          onSaved={userColor => { setCellar(c => ({ ...c, userColor })); setShowColorPicker(false); }}
          onClose={() => setShowColorPicker(false)}
        />
      )}

      {showDeleteModal && (
        <DeleteCellarModal
          cellar={cellar}
          onDeleted={() => navigate('/cellars')}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
}

// ── Edit cellar modal (owner only — name & description) ──
function EditCellarModal({ cellar, onSaved, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({
    name: cellar.name,
    description: cellar.description || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await updateCellar(apiFetch, cellar._id, form);
      const data = await res.json();
      if (res.ok) {
        onSaved({ ...cellar, ...data.cellar });
      } else {
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('cellarDetail.editCellarTitle')} onClose={onClose}>
      {error && <div className="alert alert-error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>{t('common.name')}</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div className="form-group">
          <label>{t('common.description')}</label>
          <textarea
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            rows={3}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Personal color picker modal (any user) ──
function ColorPickerModal({ currentColor, cellarId, onSaved, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [color, setColor] = useState(currentColor || null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await updateCellarColor(apiFetch, cellarId, color);
      if (res.ok) onSaved(color);
    } catch {}
    setSaving(false);
  };

  return (
    <Modal title={t('cellarDetail.myCellarColor')} onClose={onClose}>
      <p className="modal-subtitle">{t('cellarDetail.colorOnlyYou')}</p>
      <CellarColorPicker value={color} onChange={setColor} />
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

// ── Delete cellar modal (owner only — requires typing cellar name to confirm) ──
function DeleteCellarModal({ cellar, onDeleted, onClose }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [typed, setTyped]   = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError]   = useState(null);

  const confirmed = typed === cellar.name;

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await deleteCellar(apiFetch, cellar._id);
      const data = await res.json();
      if (res.ok) {
        onDeleted();
      } else {
        setError(data.error || 'Failed to delete cellar');
        setDeleting(false);
      }
    } catch {
      setError('Network error');
      setDeleting(false);
    }
  };

  return (
    <Modal title={t('cellarDetail.deleteCellarTitle')} onClose={onClose}>
      <p className="delete-warning">
        This will delete <strong>{cellar.name}</strong> and all its racks.<br />
        {t('cellarDetail.bottlesPreserved')}
      </p>
      <p className="delete-recovery">
        {t('cellarDetail.deleteRecovery')}
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-group">
        <label>Type <strong>{cellar.name}</strong> to confirm</label>
        <input
          type="text"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={cellar.name}
          autoFocus
        />
      </div>
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button
          className="btn btn-danger"
          onClick={handleDelete}
          disabled={!confirmed || deleting}
        >
          {deleting ? t('cellarDetail.deleting') : t('cellarDetail.deleteCellarTitle')}
        </button>
      </div>
    </Modal>
  );
}

// ── Bottle list (list or card view) ──
function BottlesList({ bottles, rackMap, cellarId }) {
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_view') || 'list'; } catch { return 'list'; }
  });

  const setView = (mode) => {
    setViewMode(mode);
    try { localStorage.setItem('cellarion_bottle_view', mode); } catch {}
  };

  return (
    <>
      <div className="bottles-view-toggle">
        <button
          className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => setView('list')}
          title="List view"
          aria-label="List view"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </button>
        <button
          className={`view-toggle-btn ${viewMode === 'card' ? 'active' : ''}`}
          onClick={() => setView('card')}
          title="Card view"
          aria-label="Card view"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </button>
      </div>

      <div className={viewMode === 'list' ? 'bottles-list' : 'bottles-grid'}>
        {bottles.map(bottle => (
          <BottleCard
            key={bottle._id}
            bottle={bottle}
            rackMap={rackMap}
            cellarId={cellarId}
            viewMode={viewMode}
          />
        ))}
      </div>
    </>
  );
}

export default CellarDetail;
