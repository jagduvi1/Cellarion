import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar, getCellarStatistics, exportCellar } from '../api/cellars';
import { getRacks } from '../api/racks';
import ShareCellarModal from '../components/ShareCellarModal';
import { EditCellarModal } from '../components/EditCellarModal';
import { ColorPickerModal } from '../components/ColorPickerModal';
import { DeleteCellarModal } from '../components/DeleteCellarModal';
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
  const [activeTab, setActiveTab] = useState('bottles');
  const [filters, setFilters] = useState({
    search: '',
    vintage: '',
    minRating: '',
    sort: '-createdAt'
  });

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

  const canEdit = cellar?.userRole === 'owner' || cellar?.userRole === 'editor';

  if (loading) return <div className="loading">{t('cellarDetail.loadingCellar')}</div>;
  if (error)   return <div className="alert alert-error">{error}</div>;

  const h1Style = cellar.userColor
    ? { '--cellar-color': cellar.userColor }
    : {};
  const h1Class = cellar.userColor ? 'cellar-accent-border' : '';

  return (
    <div className="cellar-detail-page">
      {/* ── Clean header ── */}
      <div className="cellar-header">
        <div className="cellar-header-top">
          <Link to="/cellars" className="back-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            {t('cellarDetail.backToCellars')}
          </Link>
          {/* Desktop-only add bottle button */}
          <div className="cellar-header-desktop-actions">
            {canEdit && (
              <Link to={`/cellars/${id}/add-bottle`} className="btn btn-primary btn-small">
                + {t('cellarDetail.addBottle')}
              </Link>
            )}
            <div className="more-menu-wrap">
              <button
                className="btn btn-secondary btn-small btn-more"
                onClick={() => setMoreOpen(o => !o)}
                title="More actions"
                aria-haspopup="true"
                aria-expanded={moreOpen}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
              </button>
              {moreOpen && (
                <>
                  <div className="more-menu-backdrop" onClick={() => setMoreOpen(false)} />
                  <div className="more-menu-dropdown">
                    <button
                      className="more-menu-item"
                      onClick={() => setShowColorPicker(true) || setMoreOpen(false)}
                    >
                      🎨 {t('cellarDetail.setColor')}
                    </button>
                    {cellar.userRole === 'owner' && (
                      <button
                        className="more-menu-item"
                        onClick={() => { setShowEditModal(true); setMoreOpen(false); }}
                      >
                        ✏️ {t('cellarDetail.editCellar')}
                      </button>
                    )}
                    {cellar.userRole === 'owner' && (
                      <button
                        className="more-menu-item"
                        onClick={() => { setShowShareModal(true); setMoreOpen(false); }}
                      >
                        🔗 {t('cellarDetail.share')}
                      </button>
                    )}
                    <Link
                      to={`/cellars/${id}/racks`}
                      className="more-menu-item"
                      onClick={() => setMoreOpen(false)}
                    >
                      🗄️ {t('cellarDetail.racks')}
                    </Link>
                    <Link
                      to={`/cellars/${id}/history`}
                      className="more-menu-item"
                      onClick={() => setMoreOpen(false)}
                    >
                      📖 {t('cellarDetail.historyMenuItem')}
                    </Link>
                    {canEdit && (
                      <Link
                        to={`/cellars/${id}/import`}
                        className="more-menu-item"
                        onClick={() => setMoreOpen(false)}
                      >
                        📥 Import Bottles
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
                        📤 Export (JSON)
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
                        📄 Export (CSV)
                      </button>
                    )}
                    {cellar.userRole === 'owner' && (
                      <Link
                        to={`/cellars/${id}/audit`}
                        className="more-menu-item"
                        onClick={() => setMoreOpen(false)}
                      >
                        📋 {t('cellarDetail.auditLog')}
                      </Link>
                    )}
                    {cellar.userRole === 'owner' && (
                      <>
                        <div className="more-menu-divider" />
                        <button
                          className="more-menu-item more-menu-item--danger"
                          onClick={() => { setShowDeleteModal(true); setMoreOpen(false); }}
                        >
                          🗑️ {t('cellarDetail.deleteCellar')}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <h1 className={h1Class} style={h1Style}>{cellar.name}</h1>
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

      {/* ── Segmented tabs ── */}
      <div className="cellar-tabs">
        <button
          className={`cellar-tab ${activeTab === 'bottles' ? 'active' : ''}`}
          onClick={() => setActiveTab('bottles')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          Bottles
          {statistics && <span className="tab-count">{statistics.totalBottles}</span>}
        </button>
        <button
          className={`cellar-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          Overview
        </button>
      </div>

      {/* ── Overview tab ── */}
      {activeTab === 'overview' && (
        <div className="cellar-tab-content">
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

          {/* Quick links */}
          <div className="overview-links">
            <Link to={`/cellars/${id}/racks`} className="overview-link-card">
              <span className="overview-link-icon">🗄️</span>
              <div>
                <strong>{t('cellarDetail.racks')}</strong>
                <span>View rack layout</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
            <Link to={`/cellars/${id}/history`} className="overview-link-card">
              <span className="overview-link-icon">📖</span>
              <div>
                <strong>{t('cellarDetail.history')}</strong>
                <span>Consumed bottles</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </Link>
          </div>
        </div>
      )}

      {/* ── Bottles tab ── */}
      {activeTab === 'bottles' && (
        <div className="cellar-tab-content">
          <div className="filters-bar filters-bar-4">
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
              <p>{t('cellarDetail.noBottles')}</p>
              {canEdit && (
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
        </div>
      )}

      {/* ── FAB: Add Bottle (mobile only) ── */}
      {canEdit && (
        <Link
          to={`/cellars/${id}/add-bottle`}
          className="fab"
          aria-label={t('cellarDetail.addBottle')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </Link>
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
