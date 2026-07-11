import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getWishlist, updateWishlistItem, removeWishlistItem } from '../api/wishlist';
import Modal from '../components/Modal';
import './AddBottle.css';
import WineImage from '../components/WineImage';
import './Wishlist.css';

const PRIORITY_KEYS = { high: 'wishlist.priorityHigh', medium: 'wishlist.priorityMedium', low: 'wishlist.priorityLow' };

function Wishlist() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('wanted');
  const [sortBy, setSortBy] = useState('newest');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // Pagination
  const [skip, setSkip] = useState(0);
  const LIMIT = 50;

  // Modal state
  const [editItem, setEditItem] = useState(null);
  const [editNotes, setEditNotes] = useState('');
  const [editPriority, setEditPriority] = useState('medium');
  const [editVintage, setEditVintage] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Per-item in-flight guard for the Bought/Undo toggle: a double-click would
  // otherwise send two PUTs and decrement the total twice.
  const [togglingIds, setTogglingIds] = useState(() => new Set());

  // Reset pagination when filters change. The reset lands one render later,
  // so derive the effective skip for the current render — otherwise a filter
  // change fires a request with the stale offset whose slow response can
  // clobber the correct page-0 one.
  const filtersKey = `${statusFilter}|${sortBy}|${search}`;
  const skipFiltersRef = useRef(filtersKey);
  const effectiveSkip = skipFiltersRef.current === filtersKey ? skip : 0;
  useEffect(() => {
    if (skipFiltersRef.current !== filtersKey) {
      skipFiltersRef.current = filtersKey;
      setSkip(0);
    }
  }, [filtersKey]);

  // Latest-wins guard for out-of-order responses.
  const fetchSeq = useRef(0);

  const fetchItems = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      params.set('sort', sortBy);
      params.set('limit', LIMIT);
      params.set('skip', effectiveSkip);
      if (search.trim()) params.set('search', search.trim());

      const res = await getWishlist(apiFetch, params.toString());
      const data = await res.json();
      if (seq !== fetchSeq.current) return;
      if (!res.ok) { setError(data.error || t('wishlist.failedLoad')); return; }
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch {
      if (seq === fetchSeq.current) setError(t('wishlist.networkError'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [apiFetch, statusFilter, sortBy, search, effectiveSkip]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // When the last item of a page is removed (delete / status toggle) but
  // earlier pages still exist, step back one page instead of stranding the
  // user on an empty page.
  useEffect(() => {
    if (!loading && items.length === 0 && total > 0 && skip > 0) {
      setSkip(s => Math.max(0, s - LIMIT));
    }
  }, [loading, items.length, total, skip]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearch(searchInput);
  };

  const handleToggleStatus = async (item) => {
    if (togglingIds.has(item._id)) return;
    setTogglingIds(prev => new Set(prev).add(item._id));
    const newStatus = item.status === 'wanted' ? 'bought' : 'wanted';
    try {
      const res = await updateWishlistItem(apiFetch, item._id, { status: newStatus });
      if (!res.ok) { setError(t('wishlist.failedUpdateStatus')); return; }
      // Remove from current list if filter doesn't match
      if (statusFilter !== 'all' && newStatus !== statusFilter) {
        setItems(prev => prev.filter(i => i._id !== item._id));
        setTotal(prev => prev - 1);
      } else {
        const data = await res.json();
        setItems(prev => prev.map(i => i._id === item._id ? data.item : i));
      }
    } catch {
      setError(t('wishlist.failedUpdateStatus'));
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev);
        next.delete(item._id);
        return next;
      });
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await removeWishlistItem(apiFetch, id);
      if (!res.ok) { setError(t('wishlist.failedRemove')); return; }
      setItems(prev => prev.filter(i => i._id !== id));
      setTotal(prev => prev - 1);
      setDeleteConfirm(null);
    } catch {
      setError(t('wishlist.failedRemove'));
    }
  };

  const openEdit = (item) => {
    setEditItem(item);
    setEditNotes(item.notes || '');
    setEditPriority(item.priority || 'medium');
    setEditVintage(item.vintage || '');
  };

  const handleSaveEdit = async () => {
    if (!editItem) return;
    setSaving(true);
    try {
      const res = await updateWishlistItem(apiFetch, editItem._id, {
        notes: editNotes,
        priority: editPriority,
        vintage: editVintage
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || t('wishlist.failedUpdate')); return; }
      setItems(prev => prev.map(i => i._id === editItem._id ? data.item : i));
      setEditItem(null);
    } catch {
      setError(t('wishlist.networkError'));
    } finally {
      setSaving(false);
    }
  };

  const wineImage = (wd) => (
    <WineImage image={wd?.image} alt={wd?.name} className="wishlist-wine-img" wineType={wd?.type} placeholder="wishlist-wine-placeholder" />
  );

  return (
    <div className="wishlist-page">
      <div className="wishlist-header">
        <div>
          <h1>{t('wishlist.title')}</h1>
          <p className="wishlist-subtitle">{t('wishlist.subtitle')}</p>
        </div>
        <Link to="/wishlist/add" className="btn btn-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {t('wishlist.addWine')}
        </Link>
      </div>

      {/* Filters bar */}
      <div className="wishlist-filters">
        <div className="wishlist-tabs">
          <button
            className={`wishlist-tab ${statusFilter === 'wanted' ? 'active' : ''}`}
            onClick={() => setStatusFilter('wanted')}
          >
            {t('wishlist.tabWanted')}
          </button>
          <button
            className={`wishlist-tab ${statusFilter === 'bought' ? 'active' : ''}`}
            onClick={() => setStatusFilter('bought')}
          >
            {t('wishlist.tabBought')}
          </button>
          <button
            className={`wishlist-tab ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            {t('wishlist.tabAll')}
          </button>
        </div>

        <div className="wishlist-controls">
          <form onSubmit={handleSearchSubmit} className="wishlist-search-form">
            <input
              type="text"
              placeholder={t('wishlist.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="wishlist-search-input"
            />
          </form>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="wishlist-sort-select">
            <option value="newest">{t('wishlist.sortNewest')}</option>
            <option value="oldest">{t('wishlist.sortOldest')}</option>
            <option value="name">{t('wishlist.sortName')}</option>
            <option value="priority">{t('wishlist.sortPriority')}</option>
          </select>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* List */}
      {loading && items.length === 0 ? (
        <div className="wishlist-loading">{t('wishlist.loading')}</div>
      ) : total === 0 ? (
        <div className="wishlist-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <p>{statusFilter === 'wanted' ? t('wishlist.emptyWanted') : statusFilter === 'bought' ? t('wishlist.emptyBought') : t('wishlist.emptyAll')}</p>
          <Link to="/wishlist/add" className="btn btn-primary">{t('wishlist.addFirstWine')}</Link>
        </div>
      ) : (
        <>
          <div className="wishlist-count">{t('wishlist.wineCount', { count: total })}</div>
          <div className="wishlist-list">
            {items.map(item => {
              const wd = item.wineDefinition;
              return (
                <div key={item._id} className={`wishlist-item ${item.status === 'bought' ? 'wishlist-item--bought' : ''}`}>
                  <div className="wishlist-item-image">
                    {wineImage(wd)}
                  </div>
                  <div className="wishlist-item-body">
                    <div className="wishlist-item-top">
                      <h3 className="wishlist-item-name">{wd?.name}</h3>
                      <span className={`wishlist-priority-badge priority-${item.priority}`}>
                        {t(PRIORITY_KEYS[item.priority])}
                      </span>
                    </div>
                    <p className="wishlist-item-producer">{wd?.producer}</p>
                    <div className="wine-meta">
                      {wd?.country?.name && <span>{wd.country.name}</span>}
                      {wd?.region?.name && <span>• {wd.region.name}</span>}
                      {wd?.type && <span className={`wine-type-pill ${wd.type}`}>{wd.type}</span>}
                    </div>
                    {item.vintage && <span className="wishlist-item-vintage">{t('wishlist.vintageLine', { vintage: item.vintage })}</span>}
                    {item.notes && <p className="wishlist-item-notes">{item.notes}</p>}
                    {item.status === 'bought' && item.boughtAt && (
                      <span className="wishlist-item-bought-date">{t('wishlist.boughtOn', { date: new Date(item.boughtAt).toLocaleDateString() })}</span>
                    )}
                  </div>
                  <div className="wishlist-item-actions">
                    <button
                      className={`btn btn-small ${item.status === 'wanted' ? 'btn-success' : 'btn-secondary'}`}
                      onClick={() => handleToggleStatus(item)}
                      disabled={togglingIds.has(item._id)}
                      title={item.status === 'wanted' ? t('wishlist.markBought') : t('wishlist.moveBackWanted')}
                    >
                      {item.status === 'wanted' ? t('wishlist.bought') : t('wishlist.undo')}
                    </button>
                    <button className="btn btn-small btn-ghost" onClick={() => openEdit(item)} title={t('wishlist.edit')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button className="btn btn-small btn-ghost wishlist-btn-delete" onClick={() => setDeleteConfirm(item)} title={t('wishlist.remove')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {total > LIMIT && (
            <div className="wishlist-pagination">
              <button className="btn btn-secondary btn-small" disabled={skip === 0} onClick={() => setSkip(s => Math.max(0, s - LIMIT))}>
                {t('wishlist.previous')}
              </button>
              <span className="wishlist-page-info">{t('wishlist.pageInfo', { from: skip + 1, to: Math.min(skip + LIMIT, total), total })}</span>
              <button className="btn btn-secondary btn-small" disabled={skip + LIMIT >= total} onClick={() => setSkip(s => s + LIMIT)}>
                {t('wishlist.next')}
              </button>
            </div>
          )}
        </>
      )}

      {/* Edit modal */}
      {editItem && (
        <Modal title={t('wishlist.editModalTitle')} onClose={() => setEditItem(null)}>
          <div className="form-group">
            <label>{t('wishlist.vintage')}</label>
            <input type="text" value={editVintage} onChange={(e) => setEditVintage(e.target.value)} maxLength={20} placeholder={t('wishlist.vintagePlaceholder')} />
          </div>
          <div className="form-group">
            <label>{t('wishlist.priority')}</label>
            <select value={editPriority} onChange={(e) => setEditPriority(e.target.value)}>
              <option value="low">{t('wishlist.priorityLow')}</option>
              <option value="medium">{t('wishlist.priorityMedium')}</option>
              <option value="high">{t('wishlist.priorityHighOption')}</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('wishlist.notes')}</label>
            <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows="3" maxLength={2000} placeholder={t('wishlist.notesPlaceholder')} />
          </div>
          <div className="form-actions">
            <button className="btn btn-success" onClick={handleSaveEdit} disabled={saving}>
              {saving ? t('wishlist.saving') : t('wishlist.save')}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditItem(null)}>{t('wishlist.cancel')}</button>
          </div>
        </Modal>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <Modal title={t('wishlist.removeModalTitle')} onClose={() => setDeleteConfirm(null)}>
          <p>
            <Trans
              i18nKey="wishlist.removeConfirm"
              values={{ name: deleteConfirm.wineDefinition?.name }}
              components={{ 1: <strong /> }}
            />
          </p>
          <div className="form-actions">
            <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm._id)}>{t('wishlist.remove')}</button>
            <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>{t('wishlist.cancel')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Wishlist;
