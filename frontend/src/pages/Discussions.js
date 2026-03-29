import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getDiscussions, createDiscussion } from '../api/discussions';
import DiscussionCard from '../components/DiscussionCard';
import CategoryBadge, { CATEGORY_LABELS } from '../components/CategoryBadge';
import Modal from '../components/Modal';
import WineSearchPicker from '../components/WineSearchPicker';
import './Discussions.css';

const CATEGORIES = Object.keys(CATEGORY_LABELS);
const SORT_KEYS = ['active', 'newest', 'most-replies'];

function Discussions() {
  const { t } = useTranslation();
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

  const sortLabels = {
    'active': t('discussions.sortMostActive'),
    'newest': t('discussions.sortNewest'),
    'most-replies': t('discussions.sortMostReplies')
  };

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
        setError(data.error || t('discussions.failedLoad'));
      }
    } catch {
      setError(t('discussions.failedLoad'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [apiFetch, category, sort, t]);

  useEffect(() => {
    setDiscussions([]);
    fetchDiscussions(1, true);
  }, [category, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async (e) => {
    e.preventDefault();
    setFormError(null);

    if (!form.title.trim() || !form.body.trim()) {
      setFormError(t('discussions.titleBodyRequired'));
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
        setFormError(data.error || t('discussions.failedCreate'));
      }
    } catch {
      setFormError(t('discussions.failedCreate'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="discussions-page">
      <div className="discussions__header">
        <h1>{t('discussions.community')}</h1>
        <span className="discussions__beta-badge">{t('discussions.beta')}</span>
      </div>
      <div className="discussions__controls">
        <div className="discussions__filters">
          <div className="discussions__categories">
            <button
              className={`discussions__cat-btn ${!category ? 'active' : ''}`}
              onClick={() => setCategory('')}
            >
              {t('discussions.all')}
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
            {SORT_KEYS.map(key => (
              <option key={key} value={key}>{sortLabels[key]}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" data-guide="discussion-create" onClick={() => setShowCreate(true)}>
          {t('discussions.newDiscussion')}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="discussions__loading">{t('common.loading')}</p>
      ) : discussions.length === 0 ? (
        <div className="discussions__empty card">
          <h3>{t('discussions.noDiscussions')}</h3>
          <p>{t('discussions.noDiscussionsHint')}</p>
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
            {loadingMore ? t('common.loading') : t('discussions.loadMore')}
          </button>
        </div>
      )}

      {showCreate && (
        <Modal title={t('discussions.newDiscussion')} onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="discussions__create-form">
            {formError && <div className="alert alert-error">{formError}</div>}

            <div className="form-group">
              <label className="form-label">{t('discussions.category')}</label>
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
              <label className="form-label">{t('discussions.title')}</label>
              <input
                type="text"
                className="input"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder={t('discussions.titlePlaceholder')}
                maxLength={200}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t('discussions.body')}</label>
              <textarea
                className="input discussions__create-body"
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                placeholder={t('discussions.bodyPlaceholder')}
                rows={6}
                maxLength={5000}
                required
              />
              <span className="form-hint">{form.body.length} / 5000</span>
            </div>

            <div className="form-group">
              <label className="form-label">{t('discussions.linkWine')}</label>
              <WineSearchPicker selected={linkedWine} onSelect={setLinkedWine} />
            </div>

            <div className="discussions__create-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? t('common.creating') : t('discussions.createDiscussion')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default Discussions;
