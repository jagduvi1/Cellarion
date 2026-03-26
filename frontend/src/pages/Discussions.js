import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getDiscussions, createDiscussion } from '../api/discussions';
import DiscussionCard from '../components/DiscussionCard';
import CategoryBadge, { CATEGORY_LABELS } from '../components/CategoryBadge';
import Modal from '../components/Modal';
import WineSearchPicker from '../components/WineSearchPicker';
import './Discussions.css';

const CATEGORIES = Object.keys(CATEGORY_LABELS);
const SORT_OPTIONS = [
  { value: 'active', label: 'Most Active' },
  { value: 'newest', label: 'Newest' },
  { value: 'most-replies', label: 'Most Replies' }
];

function Discussions() {
  const { apiFetch } = useAuth();
  const [discussions, setDiscussions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('active');

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', category: 'general' });
  const [linkedWine, setLinkedWine] = useState(null);
  const [formError, setFormError] = useState(null);

  const fetchDiscussions = useCallback(async (p, replace = false) => {
    try {
      if (replace) setLoading(true);
      else setLoadingMore(true);

      const params = new URLSearchParams({ page: p, limit: 20, sort });
      if (category) params.set('category', category);

      const res = await getDiscussions(apiFetch, params.toString());
      const data = await res.json();

      if (res.ok) {
        setDiscussions(prev => replace ? data.discussions : [...prev, ...data.discussions]);
        setPage(p);
        setHasMore(p < data.pages);
        setError(null);
      } else {
        setError(data.error || 'Failed to load discussions');
      }
    } catch {
      setError('Failed to load discussions');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [apiFetch, category, sort]);

  useEffect(() => {
    setDiscussions([]);
    fetchDiscussions(1, true);
  }, [category, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async (e) => {
    e.preventDefault();
    setFormError(null);

    if (!form.title.trim() || !form.body.trim()) {
      setFormError('Title and body are required');
      return;
    }

    setCreating(true);
    try {
      const payload = { ...form };
      if (linkedWine) payload.wineDefinition = linkedWine._id;
      const res = await createDiscussion(apiFetch, payload);
      const data = await res.json();

      if (res.ok) {
        setShowCreate(false);
        setForm({ title: '', body: '', category: 'general' });
        setLinkedWine(null);
        // Prepend new discussion to list
        setDiscussions(prev => [data.discussion, ...prev]);
      } else {
        setFormError(data.error || 'Failed to create discussion');
      }
    } catch {
      setFormError('Failed to create discussion');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="discussions-page">
      <div className="discussions__header">
        <h1>Community</h1>
        <span className="discussions__beta-badge">Beta</span>
      </div>
      <div className="discussions__controls">
        <div className="discussions__filters">
          <div className="discussions__categories">
            <button
              className={`discussions__cat-btn ${!category ? 'active' : ''}`}
              onClick={() => setCategory('')}
            >
              All
            </button>
            {CATEGORIES.map(cat => (
              <CategoryBadge
                key={cat}
                category={cat}
                onClick={() => setCategory(cat === category ? '' : cat)}
              />
            ))}
          </div>
          <select
            className="input discussions__sort"
            value={sort}
            onChange={e => setSort(e.target.value)}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" data-guide="discussion-create" onClick={() => setShowCreate(true)}>
          New Discussion
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="discussions__loading">Loading...</p>
      ) : discussions.length === 0 ? (
        <div className="discussions__empty card">
          <h3>No discussions yet</h3>
          <p>Start a conversation! Click "New Discussion" to create the first thread.</p>
        </div>
      ) : (
        <div className="discussions__list">
          {discussions.map(d => (
            <DiscussionCard key={d._id} discussion={d} />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="discussions__load-more">
          <button
            className="btn btn-secondary"
            onClick={() => fetchDiscussions(page + 1)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}

      {showCreate && (
        <Modal title="New Discussion" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="discussions__create-form">
            {formError && <div className="alert alert-error">{formError}</div>}

            <div className="form-group">
              <label className="form-label">Category</label>
              <select
                className="input"
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              >
                {CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Title</label>
              <input
                type="text"
                className="input"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="What's on your mind?"
                maxLength={200}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Body</label>
              <textarea
                className="input discussions__create-body"
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                placeholder="Share your thoughts, questions, or experiences..."
                rows={6}
                maxLength={5000}
                required
              />
              <span className="form-hint">{form.body.length} / 5000</span>
            </div>

            <div className="form-group">
              <label className="form-label">Link a Wine (optional)</label>
              <WineSearchPicker selected={linkedWine} onSelect={setLinkedWine} />
            </div>

            <div className="discussions__create-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating...' : 'Create Discussion'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default Discussions;
