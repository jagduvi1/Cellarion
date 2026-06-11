import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getWineLists, createWineList, deleteWineList, duplicateWineList } from '../api/wineLists';
import { getCurrencySymbol } from '../config/currencies';
import Modal from '../components/Modal';
import './WineLists.css';

function WineLists() {
  const { t } = useTranslation();
  const { id: cellarId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();

  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Duplicate
  const [duplicatingId, setDuplicatingId] = useState(null);

  const fetchLists = useCallback(async () => {
    try {
      const res = await getWineLists(apiFetch, cellarId);
      const data = await res.json();
      if (res.ok) {
        setLists(data);
      } else {
        setError(data.error || t('wineLists.saveFailed'));
      }
    } catch {
      setError(t('wineLists.networkError'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, cellarId, t]);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      // New lists start in the user's currency instead of defaulting to $
      const currency = user?.preferences?.currency;
      const res = await createWineList(apiFetch, {
        cellar: cellarId,
        name: newName.trim(),
        ...(currency ? { currency, currencySymbol: getCurrencySymbol(currency) } : {}),
      });
      const data = await res.json();
      if (res.ok) {
        navigate(`/cellars/${cellarId}/wine-lists/${data._id}/edit`);
      } else {
        alert(data.error || t('wineLists.saveFailed'));
      }
    } catch {
      alert(t('wineLists.networkError'));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await deleteWineList(apiFetch, deleteTarget._id);
      if (res.ok) {
        setLists(prev => prev.filter(l => l._id !== deleteTarget._id));
        setDeleteTarget(null);
      } else {
        const data = await res.json();
        alert(data.error || t('wineLists.saveFailed'));
      }
    } catch {
      alert(t('wineLists.networkError'));
    } finally {
      setDeleting(false);
    }
  };

  const handleDuplicate = async (list) => {
    setDuplicatingId(list._id);
    try {
      const res = await duplicateWineList(apiFetch, list._id);
      const data = await res.json();
      if (res.ok) {
        navigate(`/cellars/${cellarId}/wine-lists/${data._id}/edit`);
      } else {
        alert(data.error || t('wineLists.saveFailed'));
      }
    } catch {
      alert(t('wineLists.networkError'));
    } finally {
      setDuplicatingId(null);
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  return (
    <div className="wine-lists-page">
      <div className="wine-lists-header">
        <div className="wine-lists-header-top">
          <Link to={`/cellars/${cellarId}`} className="back-link">&larr; {t('wineLists.backToCellar')}</Link>
          <h1>{t('wineLists.title')}</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + {t('wineLists.newWineList')}
        </button>
      </div>

      {showCreate && (
        <div className="card create-form">
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label htmlFor="wl-name">{t('wineLists.nameLabel')}</label>
              <input
                id="wl-name"
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t('wineLists.namePlaceholder')}
                maxLength={200}
                autoFocus
                required
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? t('wineLists.creating') : t('wineLists.create')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowCreate(false); setNewName(''); }}>
                {t('wineLists.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {lists.length === 0 && !showCreate ? (
        <div className="empty-state">
          <p>{t('wineLists.emptyState')}</p>
        </div>
      ) : (
        <div className="wine-lists-grid">
          {lists.map(list => (
            <div key={list._id} className="wine-list-card">
              <div className="wine-list-card-body">
                <h3>{list.name}</h3>
                <div className="wine-list-meta">
                  <span className={`status-badge ${list.isPublished ? 'published' : 'draft'}`}>
                    {list.isPublished ? t('wineLists.published') : t('wineLists.draft')}
                  </span>
                  <span className="text-muted-sm">
                    {new Date(list.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <div className="wine-list-card-actions">
                <Link to={`/cellars/${cellarId}/wine-lists/${list._id}/edit`} className="btn btn-small btn-primary">
                  {t('wineLists.edit')}
                </Link>
                <button
                  className="btn btn-small btn-secondary"
                  onClick={() => handleDuplicate(list)}
                  disabled={duplicatingId === list._id}
                >
                  {duplicatingId === list._id ? t('wineLists.duplicating') : t('wineLists.duplicate')}
                </button>
                <button className="btn btn-small btn-danger" onClick={() => setDeleteTarget(list)}>
                  {t('wineLists.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <Modal title={t('wineLists.deleteTitle')} onClose={() => setDeleteTarget(null)}>
          <p>{t('wineLists.deleteConfirm')}</p>
          <div className="form-actions">
            <button className="btn btn-danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? t('wineLists.deleting') : t('wineLists.delete')}
            </button>
            <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{t('wineLists.cancel')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default WineLists;
