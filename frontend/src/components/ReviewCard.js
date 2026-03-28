import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import RatingDisplay from './RatingDisplay';
import { toggleLike } from '../api/reviews';
import CellarCredBadge from './CellarCredBadge';
import timeAgo from '../utils/timeAgo';
import './ReviewCard.css';

export default function ReviewCard({ review, showWine = true, onUpdate }) {
  const { apiFetch, user } = useAuth();
  const [liked, setLiked] = useState(review.liked || false);
  const [likesCount, setLikesCount] = useState(review.likesCount || 0);
  const [expanded, setExpanded] = useState(false);

  const author = review.author || {};
  const wine = review.wineDefinition || {};
  const tasting = review.tasting || {};
  const hasTasting = tasting.aroma || tasting.palate || tasting.finish || tasting.overall;
  const authorName = author.displayName || author.username || 'Unknown';
  const isOwnReview = user && author._id === user.id;

  const handleLike = async () => {
    const prevLiked = liked;
    const prevCount = likesCount;
    // Optimistic update
    setLiked(!liked);
    setLikesCount(liked ? likesCount - 1 : likesCount + 1);

    try {
      const res = await toggleLike(apiFetch, review._id);
      if (res.ok) {
        const data = await res.json();
        setLiked(data.liked);
        setLikesCount(data.likesCount);
      } else {
        setLiked(prevLiked);
        setLikesCount(prevCount);
      }
    } catch {
      setLiked(prevLiked);
      setLikesCount(prevCount);
    }
  };

  return (
    <div className="review-card card">
      <div className="review-card__header">
        <div className="review-card__author">
          <Link to={`/users/${author._id}`} className="review-card__author-link">
            {authorName}
          </Link>
          <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} />
          {review.vintage && (
            <span className="review-card__vintage">{review.vintage}</span>
          )}
          {review.visibility === 'private' && (
            <span className="review-card__private-badge">Private</span>
          )}
          <span className="review-card__time" title={new Date(review.createdAt).toLocaleDateString()}>
            {timeAgo(review.createdAt)}
          </span>
        </div>
        <div className="review-card__rating">
          <RatingDisplay
            value={review.rating}
            scale={review.ratingScale}
            preferredScale={user?.preferences?.ratingScale}
          />
        </div>
      </div>

      {showWine && wine.name && (
        <div className="review-card__wine">
          <span className="review-card__wine-type">{wine.type}</span>
          <span className="review-card__wine-name">{wine.name}</span>
          {wine.producer && <span className="review-card__wine-producer">by {wine.producer}</span>}
          {wine.country?.name && <span className="review-card__wine-country">{wine.country.name}</span>}
        </div>
      )}

      {hasTasting && (
        <div className={`review-card__tasting ${expanded ? 'expanded' : ''}`}>
          {tasting.overall && (
            <p className="review-card__overall">{tasting.overall}</p>
          )}
          {expanded && (
            <div className="review-card__details">
              {tasting.aroma && <p><strong>Aroma:</strong> {tasting.aroma}</p>}
              {tasting.palate && <p><strong>Palate:</strong> {tasting.palate}</p>}
              {tasting.finish && <p><strong>Finish:</strong> {tasting.finish}</p>}
            </div>
          )}
          {(tasting.aroma || tasting.palate || tasting.finish) && (
            <button
              className="review-card__expand-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      <div className="review-card__footer">
        <button
          className={`review-card__like-btn ${liked ? 'liked' : ''}`}
          onClick={handleLike}
          disabled={isOwnReview}
          title={isOwnReview ? 'Cannot like your own review' : (liked ? 'Unlike' : 'Like')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <span>{likesCount}</span>
        </button>
      </div>
    </div>
  );
}
