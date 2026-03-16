import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getReviewFeed, getDiscoverFeed } from '../api/reviews';
import { searchUsers } from '../api/profiles';
import ReviewCard from '../components/ReviewCard';
import FollowButton from '../components/FollowButton';
import './ReviewFeed.css';

function ReviewFeed() {
  const { apiFetch, user } = useAuth();
  const [tab, setTab] = useState('discover'); // 'discover' | 'following'
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const fetchReviews = useCallback(async (p, replace = false, activeTab = tab) => {
    try {
      if (replace) setLoading(true);
      else setLoadingMore(true);

      const fetcher = activeTab === 'following' ? getReviewFeed : getDiscoverFeed;
      const res = await fetcher(apiFetch, `page=${p}&limit=20`);
      const data = await res.json();

      if (res.ok) {
        setReviews(prev => replace ? data.reviews : [...prev, ...data.reviews]);
        setPage(p);
        setHasMore(p < data.pages);
        setError(null);
      } else {
        setError(data.error || 'Failed to load feed');
      }
    } catch {
      setError('Failed to load feed');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [apiFetch, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setReviews([]);
    fetchReviews(1, true, tab);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = async (e) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (q.length < 2) return;

    setSearching(true);
    try {
      const res = await searchUsers(apiFetch, q);
      const data = await res.json();
      if (res.ok) {
        setSearchResults(data.users);
      }
    } catch {
      // silently fail
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
  };

  return (
    <div className="review-feed-page">
      <div className="review-feed__header">
        <h1>Community</h1>
      </div>

      {/* User search */}
      <form className="review-feed__search" onSubmit={handleSearch}>
        <input
          type="text"
          className="input review-feed__search-input"
          placeholder="Search users..."
          value={searchQuery}
          onChange={e => {
            setSearchQuery(e.target.value);
            if (!e.target.value.trim()) setSearchResults(null);
          }}
          minLength={2}
        />
        <button type="submit" className="btn btn-secondary btn-small" disabled={searching || searchQuery.trim().length < 2}>
          {searching ? '...' : 'Search'}
        </button>
      </form>

      {/* Search results */}
      {searchResults !== null && (
        <div className="review-feed__search-results card">
          <div className="review-feed__search-header">
            <span>{searchResults.length} user{searchResults.length !== 1 ? 's' : ''} found</span>
            <button className="review-feed__search-clear" onClick={clearSearch}>Clear</button>
          </div>
          {searchResults.length === 0 ? (
            <p className="review-feed__search-empty">No users found. Only users with public profiles appear in search.</p>
          ) : (
            <div className="review-feed__user-list">
              {searchResults.map(u => (
                <div key={u._id} className="review-feed__user-item">
                  <Link to={`/users/${u._id}`} className="review-feed__user-link">
                    <span className="review-feed__user-avatar">
                      {(u.displayName || u.username || '?').charAt(0).toUpperCase()}
                    </span>
                    <span className="review-feed__user-info">
                      <span className="review-feed__user-name">{u.displayName || u.username}</span>
                      {u.reviewCount > 0 && (
                        <span className="review-feed__user-reviews">{u.reviewCount} review{u.reviewCount !== 1 ? 's' : ''}</span>
                      )}
                    </span>
                  </Link>
                  {u._id !== user?.id && (
                    <FollowButton userId={u._id} initialFollowing={u.isFollowing} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="review-feed__tabs">
        <button
          className={`review-feed__tab ${tab === 'discover' ? 'active' : ''}`}
          onClick={() => setTab('discover')}
        >
          Discover
        </button>
        <button
          className={`review-feed__tab ${tab === 'following' ? 'active' : ''}`}
          onClick={() => setTab('following')}
        >
          Following
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <p className="review-feed__loading">Loading...</p>
      ) : reviews.length === 0 ? (
        <div className="review-feed__empty card">
          {tab === 'following' ? (
            <>
              <h3>Your feed is empty</h3>
              <p>Follow other wine enthusiasts to see their reviews here. Try the Discover tab or search for users above.</p>
            </>
          ) : (
            <>
              <h3>No reviews yet</h3>
              <p>Be the first to review a wine! Open a bottle from your cellar and write a review.</p>
            </>
          )}
        </div>
      ) : (
        <div className="review-feed__list">
          {reviews.map(review => (
            <ReviewCard key={review._id} review={review} showWine />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="review-feed__load-more">
          <button
            className="btn btn-secondary"
            onClick={() => fetchReviews(page + 1)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
}

export default ReviewFeed;
