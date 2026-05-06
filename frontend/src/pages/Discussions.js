import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getDiscussions, createDiscussion } from '../api/discussions';
import DiscussionCard from '../components/DiscussionCard';
import CategoryBadge, { CATEGORY_LABELS } from '../components/CategoryBadge';
import CommunityCTA from '../components/CommunityCTA';
import Modal from '../components/Modal';
import WineSearchPicker from '../components/WineSearchPicker';
import SEOHead from '../components/SEOHead';
import './Discussions.css';

const CATEGORIES = Object.keys(CATEGORY_LABELS);
const SORT_KEYS = ['active', 'trending', 'newest', 'most-replies'];

function Discussions() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const location = useLocation();
  const [discussions, setDiscussions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('active');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', category: 'general' });
  const [linkedWine, setLinkedWine] = useState(null);
  const [formError, setFormError] = useState(null);

  const sortLabels = {
    'active': t('discussions.sortMostActive'),
    'trending': t('discussions.sortTrending'),
    'newest': t('discussions.sortNewest'),
    'most-replies': t('discussions.sortMostReplies')
  };

  const fetchDiscussions = useCallback(async (p, replace = false) => {
    try {
      if (replace) setLoading(true);
      else setLoadingMore(true);

      const params = new URLSearchParams({ page: p, limit: 20, sort });
      if (category) params.set('category', category);
      if (searchQuery) params.set('q', searchQuery);

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
  }, [apiFetch, category, sort, searchQuery, t]);

  useEffect(() => {
    setDiscussions([]);
    fetchDiscussions(1, true);
  }, [category, sort, searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearchQuery(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearchQuery('');
  };

  // Pre-fill the create modal when the user arrives from a wine page's
  // "Start a discussion about this wine" CTA. We use route state (not a query
  // param) so the wine object stays attached without a refetch and the URL
  // stays clean. Only fires for logged-in users — anon doesn't get the CTA.
  useEffect(() => {
    if (user && location.state?.newDiscussionWine) {
      setLinkedWine(location.state.newDiscussionWine);
      setShowCreate(true);
      // Clear the state so a Back-then-Forward doesn't re-open the modal
      window.history.replaceState({}, '');
    }
  }, [user, location.state]);

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
      <SEOHead
        title="Wine Discussions — Cellarion Community"
        description="Public wine discussion forum: tasting notes, food pairing, cellar tips, and recommendations from Cellarion users."
        path="/community/discussions"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: 'Wine Discussions — Cellarion Community',
          description: 'Public wine discussion forum: tasting notes, food pairing, cellar tips, and recommendations from Cellarion users.',
          ...(discussions.length > 0 ? {
            mainEntity: {
              '@type': 'ItemList',
              numberOfItems: discussions.length,
              itemListElement: discussions.slice(0, 20).map((d, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                url: `https://cellarion.app/community/discussions/${d.slug || d._id}`,
                name: d.title
              }))
            }
          } : {})
        }}
      />
      <div className="discussions__header">
        <h1>{t('discussions.community')}</h1>
        <span className="discussions__beta-badge">{t('discussions.beta')}</span>
      </div>

      <form className="discussions__search" onSubmit={handleSearchSubmit} role="search">
        <input
          type="search"
          className="input discussions__search-input"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder={t('discussions.searchPlaceholder')}
          aria-label={t('discussions.searchPlaceholder')}
        />
        {searchQuery && (
          <button type="button" className="btn btn-secondary btn-small" onClick={clearSearch}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="btn btn-primary btn-small">
          {t('discussions.search')}
        </button>
      </form>

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
        {user ? (
          <button className="btn btn-primary" data-guide="discussion-create" onClick={() => setShowCreate(true)}>
            {t('discussions.newDiscussion')}
          </button>
        ) : null}
      </div>

      {!user && <CommunityCTA variant="inline" />}

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="discussions__loading">{t('common.loading')}</p>
      ) : discussions.length === 0 ? (
        <div className="discussions__empty card">
          <h3>{t('discussions.noDiscussions')}</h3>
          <p>{user ? t('discussions.noDiscussionsHint') : t('discussions.signInToStart')}</p>
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
