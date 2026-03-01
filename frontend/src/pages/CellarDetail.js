import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getDrinkStatus } from '../utils/drinkStatus';
import ShareCellarModal from '../components/ShareCellarModal';
import CellarColorPicker from '../components/CellarColorPicker';
import './CellarDetail.css';

function CellarDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch } = useAuth();
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

  useEffect(() => {
    fetchCellarData();
    fetchStatistics();
    fetchRacks();
  }, [id, filters]); // eslint-disable-line react-hooks/exhaustive-deps


  const fetchCellarData = async () => {
    try {
      const params = new URLSearchParams();
      Object.keys(filters).forEach(key => {
        if (filters[key]) params.append(key, filters[key]);
      });
      const res = await apiFetch(`/api/cellars/${id}?${params}`);
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
      const res = await apiFetch(`/api/cellars/${id}/statistics`);
      const data = await res.json();
      if (res.ok) setStatistics(data.statistics);
    } catch {}
  };

  const fetchRacks = async () => {
    try {
      const res = await apiFetch(`/api/racks?cellar=${id}`);
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
            <h3>${statistics.totalValue.toFixed(2)}</h3>
            <p>{t('cellarDetail.totalValue')}</p>
          </div>
          <div className="stat-card">
            <h3>${statistics.averagePrice.toFixed(2)}</h3>
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
          <option value="4">{t('cellarDetail.stars4Plus')}</option>
          <option value="3">{t('cellarDetail.stars3Plus')}</option>
          <option value="2">{t('cellarDetail.stars2Plus')}</option>
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
      const res = await apiFetch(`/api/cellars/${cellar._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>{t('cellarDetail.editCellarTitle')}</h2>
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
      </div>
    </div>
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
      const res = await apiFetch(`/api/cellars/${cellarId}/color`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color })
      });
      if (res.ok) onSaved(color);
    } catch {}
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>{t('cellarDetail.myCellarColor')}</h2>
        <p className="modal-subtitle">{t('cellarDetail.colorOnlyYou')}</p>
        <CellarColorPicker value={color} onChange={setColor} />
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
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
      const res = await apiFetch(`/api/cellars/${cellar._id}`, {
        method: 'DELETE'
      });
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>{t('cellarDetail.deleteCellarTitle')}</h2>
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
      </div>
    </div>
  );
}

// ── Compact bottle list ──
function BottlesList({ bottles, rackMap, cellarId }) {
  const navigate = useNavigate();

  return (
    <div className="bottles-list">
      {bottles.map(bottle => {
        const rackInfo = rackMap.get(bottle._id);
        const drinkStatus = getDrinkStatus(bottle);

        return (
          <div
            key={bottle._id}
            className="bottle-card"
            onClick={() => navigate(`/cellars/${cellarId}/bottles/${bottle._id}`)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && navigate(`/cellars/${cellarId}/bottles/${bottle._id}`)}
          >
            {(bottle.wineDefinition?.image || bottle.pendingImageUrl) ? (
              <img
                src={bottle.wineDefinition?.image || bottle.pendingImageUrl}
                alt={bottle.wineDefinition?.name}
                className="bottle-wine-image"
                onError={e => { e.target.style.display = 'none'; }}
              />
            ) : (
              <div className={`bottle-wine-placeholder ${bottle.wineDefinition?.type}`} />
            )}

            <div className="bottle-info">
              <div className="bottle-name">{bottle.wineDefinition?.name || 'Unknown Wine'}</div>
              <div className="bottle-meta">
                <span className="bottle-producer">{bottle.wineDefinition?.producer}</span>
                {bottle.vintage && <span className="bottle-vintage">{bottle.vintage}</span>}
              </div>
              <div className="bottle-badges">
                {rackInfo && (
                  <Link
                    to={`/cellars/${cellarId}/racks?highlight=${bottle._id}`}
                    className="rack-badge"
                    onClick={e => e.stopPropagation()}
                  >
                    📍 {rackInfo.rackName}
                  </Link>
                )}
                {drinkStatus && (
                  <span className={`drink-status-badge badge-sm ${drinkStatus.status}`}>
                    {drinkStatus.label}
                  </span>
                )}
              </div>
            </div>

            <span className="bottle-chevron" aria-hidden="true">›</span>
          </div>
        );
      })}
    </div>
  );
}

export default CellarDetail;
