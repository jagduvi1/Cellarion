import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getWishlist, updateWishlistItem, removeWishlistItem } from '../api/wishlist';
import Modal from '../components/Modal';
import './AddBottle.css';
import './Wishlist.css';

const PRIORITY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

function Wishlist() {
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

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      params.set('sort', sortBy);
      params.set('limit', LIMIT);
      params.set('skip', skip);
      if (search.trim()) params.set('search', search.trim());

      const res = await getWishlist(apiFetch, params.toString());
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to load wishlist'); return; }
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, statusFilter, sortBy, search, skip]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Reset pagination when filters change
  useEffect(() => { setSkip(0); }, [statusFilter, sortBy, search]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearch(searchInput);
  };

  const handleToggleStatus = async (item) => {
    const newStatus = item.status === 'wanted' ? 'bought' : 'wanted';
    try {
      const res = await updateWishlistItem(apiFetch, item._id, { status: newStatus });
      if (!res.ok) return;
      // Remove from current list if filter doesn't match
      if (statusFilter !== 'all' && newStatus !== statusFilter) {
        setItems(prev => prev.filter(i => i._id !== item._id));
        setTotal(prev => prev - 1);
      } else {
        const data = await res.json();
        setItems(prev => prev.map(i => i._id === item._id ? data.item : i));
      }
    } catch {
      setError('Failed to update status');
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await removeWishlistItem(apiFetch, id);
      if (!res.ok) return;
      setItems(prev => prev.filter(i => i._id !== id));
      setTotal(prev => prev - 1);
      setDeleteConfirm(null);
    } catch {
      setError('Failed to remove item');
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
      if (!res.ok) { setError(data.error || 'Failed to update'); return; }
      setItems(prev => prev.map(i => i._id === editItem._id ? data.item : i));
      setEditItem(null);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const wineImage = (wd) => {
    if (wd?.image) return <img src={wd.image} alt={wd.name} className="wishlist-wine-img" onError={(e) => { e.target.style.display = 'none'; }} />;
    return <div className={`wishlist-wine-placeholder ${wd?.type || 'red'}`} />;
  };

  return (
    <div className="wishlist-page">
      <div className="wishlist-header">
        <div>
          <h1>Wishlist</h1>
          <p className="wishlist-subtitle">Wines you want to buy</p>
        </div>
        <Link to="/wishlist/add" className="btn btn-primary" data-guide="add-wishlist">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Wine
        </Link>
      </div>

      {/* Filters bar */}
      <div className="wishlist-filters">
        <div className="wishlist-tabs">
          <button
            className={`wishlist-tab ${statusFilter === 'wanted' ? 'active' : ''}`}
            onClick={() => setStatusFilter('wanted')}
          >
            Wanted
          </button>
          <button
            className={`wishlist-tab ${statusFilter === 'bought' ? 'active' : ''}`}
            onClick={() => setStatusFilter('bought')}
          >
            Bought
          </button>
          <button
            className={`wishlist-tab ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All
          </button>
        </div>

        <div className="wishlist-controls">
          <form onSubmit={handleSearchSubmit} className="wishlist-search-form">
            <input
              type="text"
              placeholder="Search wines..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="wishlist-search-input"
            />
          </form>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="wishlist-sort-select">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">By name</option>
            <option value="priority">By priority</option>
          </select>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* List */}
      {loading && items.length === 0 ? (
        <div className="wishlist-loading">Loading...</div>
      ) : items.length === 0 ? (
        <div className="wishlist-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <p>{statusFilter === 'wanted' ? 'No wines on your wishlist yet' : statusFilter === 'bought' ? 'No bought wines yet' : 'Your wishlist is empty'}</p>
          <Link to="/wishlist/add" className="btn btn-primary">Add your first wine</Link>
        </div>
      ) : (
        <>
          <div className="wishlist-count">{total} {total === 1 ? 'wine' : 'wines'}</div>
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
                        {PRIORITY_LABELS[item.priority]}
                      </span>
                    </div>
                    <p className="wishlist-item-producer">{wd?.producer}</p>
                    <div className="wine-meta">
                      {wd?.country?.name && <span>{wd.country.name}</span>}
                      {wd?.region?.name && <span>• {wd.region.name}</span>}
                      {wd?.type && <span className={`wine-type-pill ${wd.type}`}>{wd.type}</span>}
                    </div>
                    {item.vintage && <span className="wishlist-item-vintage">Vintage: {item.vintage}</span>}
                    {item.notes && <p className="wishlist-item-notes">{item.notes}</p>}
                    {item.status === 'bought' && item.boughtAt && (
                      <span className="wishlist-item-bought-date">Bought {new Date(item.boughtAt).toLocaleDateString()}</span>
                    )}
                  </div>
                  <div className="wishlist-item-actions">
                    <button
                      className={`btn btn-small ${item.status === 'wanted' ? 'btn-success' : 'btn-secondary'}`}
                      onClick={() => handleToggleStatus(item)}
                      title={item.status === 'wanted' ? 'Mark as bought' : 'Move back to wanted'}
                    >
                      {item.status === 'wanted' ? 'Bought' : 'Undo'}
                    </button>
                    <button className="btn btn-small btn-ghost" onClick={() => openEdit(item)} title="Edit">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button className="btn btn-small btn-ghost wishlist-btn-delete" onClick={() => setDeleteConfirm(item)} title="Remove">
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
                Previous
              </button>
              <span className="wishlist-page-info">{skip + 1}–{Math.min(skip + LIMIT, total)} of {total}</span>
              <button className="btn btn-secondary btn-small" disabled={skip + LIMIT >= total} onClick={() => setSkip(s => s + LIMIT)}>
                Next
              </button>
            </div>
          )}
        </>
      )}

      {/* Edit modal */}
      {editItem && (
        <Modal title="Edit Wishlist Item" onClose={() => setEditItem(null)}>
          <div className="form-group">
            <label>Vintage</label>
            <input type="text" value={editVintage} onChange={(e) => setEditVintage(e.target.value)} maxLength={20} placeholder="e.g. 2020" />
          </div>
          <div className="form-group">
            <label>Priority</label>
            <select value={editPriority} onChange={(e) => setEditPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High — must buy!</option>
            </select>
          </div>
          <div className="form-group">
            <label>Notes</label>
            <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows="3" maxLength={2000} placeholder="Where you tried it, price you saw..." />
          </div>
          <div className="form-actions">
            <button className="btn btn-success" onClick={handleSaveEdit} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="btn btn-secondary" onClick={() => setEditItem(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (
        <Modal title="Remove from Wishlist" onClose={() => setDeleteConfirm(null)}>
          <p>Remove <strong>{deleteConfirm.wineDefinition?.name}</strong> from your wishlist?</p>
          <div className="form-actions">
            <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm._id)}>Remove</button>
            <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Wishlist;
