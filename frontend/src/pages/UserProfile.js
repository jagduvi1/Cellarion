import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getPublicProfile } from '../api/profiles';
import { getUserReviews } from '../api/reviews';
import { getFollowers, getFollowing } from '../api/follows';
import ReviewCard from '../components/ReviewCard';
import FollowButton from '../components/FollowButton';
import Modal from '../components/Modal';
import './UserProfile.css';

function UserProfile() {
  const { userId } = useParams();
  const { apiFetch, user: currentUser } = useAuth();
  const [profile, setProfile] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [reviewPage, setReviewPage] = useState(1);
  const [hasMoreReviews, setHasMoreReviews] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  // Modal state for followers/following list
  const [listModal, setListModal] = useState(null); // 'followers' | 'following' | null
  const [listUsers, setListUsers] = useState([]);
  const [listLoading, setListLoading] = useState(false);

  const isOwnProfile = currentUser?.id === userId;

  useEffect(() => {
    fetchProfile();
    fetchReviews(1, true);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchProfile = async () => {
    try {
      const res = await getPublicProfile(apiFetch, userId);
      const data = await res.json();
      if (res.ok) {
        setProfile(data.user);
      } else {
        setError(data.error || 'Failed to load profile');
      }
    } catch {
      setError('Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  const fetchReviews = async (p, replace = false) => {
    try {
      if (!replace) setLoadingMore(true);
      const res = await getUserReviews(apiFetch, userId, `page=${p}&limit=20`);
      const data = await res.json();
      if (res.ok) {
        setReviews(prev => replace ? data.reviews : [...prev, ...data.reviews]);
        setReviewPage(p);
        setHasMoreReviews(p < data.pages);
      }
    } catch {
      // silently fail for reviews
    } finally {
      setLoadingMore(false);
    }
  };

  const openList = async (type) => {
    setListModal(type);
    setListLoading(true);
    setListUsers([]);

    try {
      const fetcher = type === 'followers' ? getFollowers : getFollowing;
      const res = await fetcher(apiFetch, userId, 'limit=50');
      const data = await res.json();
      if (res.ok) {
        setListUsers(data.users);
      }
    } catch {
      // silently fail
    } finally {
      setListLoading(false);
    }
  };

  const handleFollowToggle = (isFollowing) => {
    if (profile) {
      setProfile(prev => ({
        ...prev,
        isFollowing,
        followersCount: prev.followersCount + (isFollowing ? 1 : -1)
      }));
    }
  };

  if (loading) {
    return (
      <div className="user-profile-page">
        <p className="user-profile__loading">Loading...</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="user-profile-page">
        <div className="alert alert-error">{error || 'User not found'}</div>
      </div>
    );
  }

  const displayName = profile.displayName || profile.username;
  const memberSince = new Date(profile.createdAt).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long'
  });

  return (
    <div className="user-profile-page">
      <div className="user-profile__header card">
        <div className="user-profile__info">
          <div className="user-profile__avatar">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="user-profile__details">
            <h1 className="user-profile__name">{displayName}</h1>
            {profile.displayName && profile.displayName !== profile.username && (
              <p className="user-profile__username">@{profile.username}</p>
            )}
            {profile.bio && <p className="user-profile__bio">{profile.bio}</p>}
            <p className="user-profile__joined">Member since {memberSince}</p>
          </div>
          {!isOwnProfile && (
            <div className="user-profile__actions">
              <FollowButton
                userId={userId}
                initialFollowing={profile.isFollowing}
                onToggle={handleFollowToggle}
              />
            </div>
          )}
        </div>

        <div className="user-profile__stats">
          <button className="user-profile__stat" onClick={() => openList('followers')}>
            <span className="user-profile__stat-value">{profile.followersCount}</span>
            <span className="user-profile__stat-label">Followers</span>
          </button>
          <button className="user-profile__stat" onClick={() => openList('following')}>
            <span className="user-profile__stat-value">{profile.followingCount}</span>
            <span className="user-profile__stat-label">Following</span>
          </button>
          <div className="user-profile__stat">
            <span className="user-profile__stat-value">{profile.reviewCount}</span>
            <span className="user-profile__stat-label">Reviews</span>
          </div>
        </div>
      </div>

      <div className="user-profile__reviews">
        <h2>Reviews</h2>
        {reviews.length === 0 ? (
          <p className="user-profile__no-reviews">No reviews yet.</p>
        ) : (
          reviews.map(review => (
            <ReviewCard key={review._id} review={review} showWine />
          ))
        )}

        {hasMoreReviews && (
          <div className="user-profile__load-more">
            <button
              className="btn btn-secondary"
              onClick={() => fetchReviews(reviewPage + 1)}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}
      </div>

      {listModal && (
        <Modal
          title={listModal === 'followers' ? 'Followers' : 'Following'}
          onClose={() => setListModal(null)}
        >
          {listLoading ? (
            <p>Loading...</p>
          ) : listUsers.length === 0 ? (
            <p>None yet.</p>
          ) : (
            <div className="user-profile__user-list">
              {listUsers.map(u => (
                <div key={u._id} className="user-profile__user-item">
                  <a href={`/users/${u._id}`} className="user-profile__user-link">
                    <span className="user-profile__user-avatar">
                      {(u.displayName || u.username || '?').charAt(0).toUpperCase()}
                    </span>
                    <span className="user-profile__user-name">
                      {u.displayName || u.username}
                    </span>
                  </a>
                  {u._id !== currentUser?.id && (
                    <FollowButton userId={u._id} initialFollowing={u.isFollowing} />
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setListModal(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default UserProfile;
