import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getWineLists, createWineList, deleteWineList } from '../api/wineLists';
import Modal from '../components/Modal';
import './WineLists.css';

function WineLists() {
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

  const fetchLists = useCallback(async () => {
    try {
      const res = await getWineLists(apiFetch, cellarId);
      const data = await res.json();
      if (res.ok) {
        setLists(data);
      } else {
        setError(data.error || 'Failed to load wine lists');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, cellarId]);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await createWineList(apiFetch, { cellar: cellarId, name: newName.trim() });
      const data = await res.json();
      if (res.ok) {
        navigate(`/cellars/${cellarId}/wine-lists/${data._id}/edit`);
      } else {
        alert(data.error || 'Failed to create wine list');
      }
    } catch {
      alert('Network error');
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
        alert(data.error || 'Failed to delete');
      }
    } catch {
      alert('Network error');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="alert alert-error">{error}</div>;

  return (
    <div className="wine-lists-page">
      <div className="wine-lists-header">
        <div className="wine-lists-header-top">
          <Link to={`/cellars/${cellarId}`} className="back-link">&larr; Back to cellar</Link>
          <h1>Wine Lists</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          + New Wine List
        </button>
      </div>

      {showCreate && (
        <div className="card create-form">
          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label htmlFor="wl-name">Wine list name</label>
              <input
                id="wl-name"
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Spring Menu 2026"
                maxLength={200}
                autoFocus
                required
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating...' : 'Create'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowCreate(false); setNewName(''); }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {lists.length === 0 && !showCreate ? (
        <div className="empty-state">
          <p>No wine lists yet. Create one to generate a PDF menu for your restaurant.</p>
        </div>
      ) : (
        <div className="wine-lists-grid">
          {lists.map(list => (
            <div key={list._id} className="wine-list-card">
              <div className="wine-list-card-body">
                <h3>{list.name}</h3>
                <div className="wine-list-meta">
                  <span className={`status-badge ${list.isPublished ? 'published' : 'draft'}`}>
                    {list.isPublished ? 'Published' : 'Draft'}
                  </span>
                  <span className="text-muted-sm">
                    Updated {new Date(list.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <div className="wine-list-card-actions">
                <Link to={`/cellars/${cellarId}/wine-lists/${list._id}/edit`} className="btn btn-small btn-primary">
                  Edit
                </Link>
                <button className="btn btn-small btn-danger" onClick={() => setDeleteTarget(list)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <Modal title="Delete Wine List" onClose={() => setDeleteTarget(null)}>
          <p>Are you sure you want to delete &ldquo;{deleteTarget.name}&rdquo;? This cannot be undone.</p>
          <div className="form-actions">
            <button className="btn btn-danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default WineLists;
