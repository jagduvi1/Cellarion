import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getPublicProfile } from '../api/profiles';
import { getUserReviews } from '../api/reviews';
import { getFollowers, getFollowing } from '../api/follows';
import ReviewCard from '../components/ReviewCard';
import FollowButton from '../components/FollowButton';
import Modal from '../components/Modal';
import CellarCredBadge from '../components/CellarCredBadge';
import './UserProfile.css';

function UserProfile() {
  const { t } = useTranslation();
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
  const [listError, setListError] = useState(false);

  const isOwnProfile = currentUser?.id === userId;

  useEffect(() => {
    // Reset stale state when navigating between profiles client-side,
    // otherwise a previously-errored view stays stuck.
    setLoading(true);
    setError(null);
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
        setError(data.error || t('userProfile.failedLoad'));
      }
    } catch {
      setError(t('userProfile.failedLoad'));
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
    setListError(false);

    try {
      const fetcher = type === 'followers' ? getFollowers : getFollowing;
      const res = await fetcher(apiFetch, userId, 'limit=50');
      const data = await res.json();
      if (res.ok) {
        setListUsers(data.users);
      } else {
        setListError(true);
      }
    } catch {
      setListError(true);
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
        <p className="user-profile__loading">{t('userProfile.loading')}</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="user-profile-page">
        <div className="alert alert-error">{error || t('userProfile.notFound')}</div>
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
            <h1 className="user-profile__name">
              {displayName}
              {' '}<CellarCredBadge tier={profile.contribution?.tier} specialty={profile.contribution?.specialty} size="md" />
            </h1>
            {profile.displayName && profile.displayName !== profile.username && (
              <p className="user-profile__username">@{profile.username}</p>
            )}
            {profile.bio && <p className="user-profile__bio">{profile.bio}</p>}
            <p className="user-profile__joined">{t('userProfile.memberSince', { date: memberSince })}</p>
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
            <span className="user-profile__stat-label">{t('userProfile.followers')}</span>
          </button>
          <button className="user-profile__stat" onClick={() => openList('following')}>
            <span className="user-profile__stat-value">{profile.followingCount}</span>
            <span className="user-profile__stat-label">{t('userProfile.following')}</span>
          </button>
          <div className="user-profile__stat">
            <span className="user-profile__stat-value">{profile.reviewCount}</span>
            <span className="user-profile__stat-label">{t('userProfile.reviews')}</span>
          </div>
        </div>
      </div>

      <div className="user-profile__reviews">
        <h2>{t('userProfile.reviews')}</h2>
        {reviews.length === 0 ? (
          <p className="user-profile__no-reviews">{t('userProfile.noReviews')}</p>
        ) : (
          reviews.map(review => (
            <ReviewCard
              key={review._id}
              review={review}
              showWine
              onDelete={id => {
                setReviews(prev => prev.filter(r => r._id !== id));
                setProfile(prev => prev ? { ...prev, reviewCount: Math.max(0, (prev.reviewCount || 0) - 1) } : prev);
              }}
            />
          ))
        )}

        {hasMoreReviews && (
          <div className="user-profile__load-more">
            <button
              className="btn btn-secondary"
              onClick={() => fetchReviews(reviewPage + 1)}
              disabled={loadingMore}
            >
              {loadingMore ? t('userProfile.loading') : t('userProfile.loadMore')}
            </button>
          </div>
        )}
      </div>

      {listModal && (
        <Modal
          title={listModal === 'followers' ? t('userProfile.followers') : t('userProfile.following')}
          onClose={() => setListModal(null)}
        >
          {listLoading ? (
            <p>{t('userProfile.loading')}</p>
          ) : listError ? (
            <p className="alert alert-error">{t('userProfile.listError')}</p>
          ) : listUsers.length === 0 ? (
            <p>{t('userProfile.noneYet')}</p>
          ) : (
            <div className="user-profile__user-list">
              {listUsers.map(u => (
                <div key={u._id} className="user-profile__user-item">
                  <Link
                    to={`/users/${u._id}`}
                    className="user-profile__user-link"
                    onClick={() => setListModal(null)}
                  >
                    <span className="user-profile__user-avatar">
                      {(u.displayName || u.username || '?').charAt(0).toUpperCase()}
                    </span>
                    <span className="user-profile__user-name">
                      {u.displayName || u.username}
                    </span>
                  </Link>
                  {u._id !== currentUser?.id && (
                    <FollowButton userId={u._id} initialFollowing={u.isFollowing} />
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={() => setListModal(null)}>{t('userProfile.close')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default UserProfile;
