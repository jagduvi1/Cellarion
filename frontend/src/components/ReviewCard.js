import { useState, useRef, useLayoutEffect, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import RatingDisplay from './RatingDisplay';
import { toggleLike, deleteReview } from '../api/reviews';
import CellarCredBadge from './CellarCredBadge';
import Modal from './Modal';
import timeAgo from '../utils/timeAgo';
import { lazy } from '../utils/lazyWithReload';
import './ReviewCard.css';
import { formatVintage } from '../utils/vintage';

const ReviewForm = lazy(() => import('./ReviewForm'));

/**
 * One review: author, rating, the wine (optional), the tasting notes and the
 * like / edit / delete actions. The overall impression is clamped to three
 * lines until "Show more"; the author gets Edit when the list passes
 * `onUpdate` (called with the saved review) and Delete when it passes
 * `onDelete` (called with the review id).
 */
export default function ReviewCard({ review, showWine = true, onUpdate, onDelete }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [liked, setLiked] = useState(review.liked || false);
  const [likesCount, setLikesCount] = useState(review.likesCount || 0);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const overallRef = useRef(null);

  const author = review.author || {};
  const wine = review.wineDefinition || {};
  const tasting = review.tasting || {};
  const hasTasting = tasting.aroma || tasting.palate || tasting.finish || tasting.overall;
  const hasDetails = !!(tasting.aroma || tasting.palate || tasting.finish);
  const authorName = author.displayName || author.username || 'Unknown';
  const isOwnReview = user && author._id === user.id;

  // Whether the clamped overall text hides anything. Measured only while it is
  // clamped: expanded it always fits, and "Show less" must stay. Re-measured
  // when the card's width changes (a phone turned, a sidebar opened).
  useLayoutEffect(() => {
    const el = overallRef.current;
    if (!el || expanded) return undefined;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tasting.overall, expanded]);

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

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(false);
    try {
      const res = await deleteReview(apiFetch, review._id);
      if (res.ok) {
        setConfirmDelete(false);
        if (onDelete) onDelete(review._id);
      } else {
        setDeleteError(true);
      }
    } catch {
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="review-card card">
      <div className="review-card__header">
        <div className="review-card__author">
          <Link to={`/users/${author._id}`} className="review-card__author-link">
            {authorName}
          </Link>
          <CellarCredBadge tier={author.contribution?.tier} specialty={author.contribution?.specialty} plan={author.plan} />
          {review.vintage && (
            <span className="review-card__vintage">{formatVintage(review.vintage, t)}</span>
          )}
          {review.visibility === 'private' && (
            <span className="review-card__private-badge">{t('reviews.privateBadge', 'Private')}</span>
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
            <p className="review-card__overall" ref={overallRef}>{tasting.overall}</p>
          )}
          {expanded && hasDetails && (
            <div className="review-card__details">
              {tasting.aroma && <p><strong>{t('reviews.cardAroma', 'Aroma:')}</strong> {tasting.aroma}</p>}
              {tasting.palate && <p><strong>{t('reviews.cardPalate', 'Palate:')}</strong> {tasting.palate}</p>}
              {tasting.finish && <p><strong>{t('reviews.cardFinish', 'Finish:')}</strong> {tasting.finish}</p>}
            </div>
          )}
          {(hasDetails || clamped) && (
            <button
              type="button"
              className="review-card__expand-btn"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t('reviews.showLess', 'Show less') : t('reviews.showMore', 'Show more')}
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
        {isOwnReview && onUpdate && (
          <button
            type="button"
            className="review-card__edit-btn"
            onClick={() => setEditing(true)}
            title={t('reviews.editReview', 'Edit review')}
            aria-label={t('reviews.editReview', 'Edit review')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        )}
        {isOwnReview && onDelete && (
          <button
            className="review-card__delete-btn"
            onClick={() => { setDeleteError(false); setConfirmDelete(true); }}
            title={t('reviews.deleteReview', 'Delete review')}
            aria-label={t('reviews.deleteReview', 'Delete review')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        )}
      </div>

      {confirmDelete && (
        <Modal
          title={t('reviews.deleteTitle', 'Delete review?')}
          onClose={() => !deleting && setConfirmDelete(false)}
        >
          <p>{t('reviews.deleteBody', 'This will permanently delete your review. This cannot be undone.')}</p>
          {deleteError && (
            <p className="alert alert-error">{t('reviews.deleteError', 'Failed to delete the review — please try again.')}</p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? t('reviews.deleting', 'Deleting…') : t('common.delete', 'Delete')}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <Suspense fallback={null}>
          <ReviewForm
            existingReview={review}
            onClose={() => setEditing(false)}
            onSaved={(saved) => { if (saved) onUpdate(saved); }}
          />
        </Suspense>
      )}
    </div>
  );
}
