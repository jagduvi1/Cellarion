import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { followUser, unfollowUser } from '../api/follows';
import './FollowButton.css';

export default function FollowButton({ userId, initialFollowing, onToggle }) {
  const { apiFetch } = useAuth();
  const [following, setFollowing] = useState(initialFollowing);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    const prev = following;
    setFollowing(!following); // optimistic

    try {
      const res = following
        ? await unfollowUser(apiFetch, userId)
        : await followUser(apiFetch, userId);

      if (res.ok) {
        const data = await res.json();
        setFollowing(data.following);
        onToggle?.(data.following);
      } else {
        setFollowing(prev);
      }
    } catch {
      setFollowing(prev);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`follow-btn btn btn-small ${following ? 'follow-btn--following btn-secondary' : 'btn-primary'}`}
      onClick={handleToggle}
      disabled={loading}
    >
      {following ? 'Following' : 'Follow'}
    </button>
  );
}
