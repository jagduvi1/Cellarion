import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { lazy } from '../../utils/lazyWithReload';
import { useAuth } from '../../contexts/AuthContext';
import { getWineReviews } from '../../api/reviews';
import { fromNormalized } from '../../utils/ratingUtils';
import ReviewCard from '../ReviewCard';

const ReviewForm = lazy(() => import('../ReviewForm'));

/**
 * The community reviews of a wine: the average, filters (everyone / mine /
 * the people I follow; this vintage / all vintages), the list with paging,
 * and "Write a Review". Shared by the bottle page and the vintage page — a
 * review belongs to the wine and a vintage, not to one bottle.
 *
 * `communityRating` is the wine's stored aggregate; after a review is saved
 * or deleted it is dropped rather than shown stale.
 */
export default function WineReviewsCard({ wine, vintage, communityRating }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const wineId = wine?._id;
  const [reviews, setReviews] = useState([]);
  const [rating, setRating] = useState(communityRating?.reviewCount > 0 ? communityRating : null);
  const [audience, setAudience] = useState('all');
  const [vintageFilter, setVintageFilter] = useState('this');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [formOpen, setFormOpen] = useState(false);

  // Another wine (the bottle page moving to another bottle) brings its own aggregate.
  useEffect(() => {
    setRating(communityRating?.reviewCount > 0 ? communityRating : null);
  }, [wineId, communityRating?.reviewCount, communityRating?.averageNormalized]); // eslint-disable-line react-hooks/exhaustive-deps

  // ...and never shows the last wine's reviews while its own load.
  useEffect(() => { setReviews([]); setPages(0); setPage(1); }, [wineId]);

  // Only the latest request may fill the list: a slow answer for the last
  // wine, filter or page must not land over the current one.
  const seq = useRef(0);
  const load = useCallback(async (nextPage = 1) => {
    if (!wineId) return;
    const mine = ++seq.current;
    try {
      const params = new URLSearchParams();
      params.set('limit', '10');
      params.set('page', String(nextPage));
      params.set('audience', audience);
      if (vintageFilter === 'this' && vintage) params.set('vintage', vintage);
      const res = await getWineReviews(apiFetch, wineId, params.toString());
      const data = await res.json();
      if (mine !== seq.current) return;
      if (res.ok) {
        setReviews(data.reviews || []);
        setPages(data.pages || 0);
        setPage(nextPage);
      }
    } catch {
      // Non-critical
    }
  }, [apiFetch, wineId, vintage, audience, vintageFilter]);

  useEffect(() => { load(1); }, [load]);

  // After a review is saved or deleted: refetch the list and drop the (now
  // stale) community aggregate.
  const changed = () => { load(1); setRating(null); };

  if (!wine) return null;
  const scale = user?.preferences?.ratingScale || '5';

  return (
    <>
      <div className="bd-reviews card">
        <div className="bd-reviews__header">
          <h2>{t('reviews.communityReviews', 'Reviews')}</h2>
          {rating && rating.reviewCount > 0 && (
            <span className="bd-reviews__avg">
              {fromNormalized(rating.averageNormalized, scale).toFixed(1)}
              {scale === '100' ? 'pts' : scale === '20' ? '/20' : '★'}
              <span className="bd-reviews__count">({rating.reviewCount})</span>
            </span>
          )}
        </div>
        <div className="bd-reviews__filters">
          <select value={audience} onChange={(e) => setAudience(e.target.value)} className="bd-reviews__filter-select">
            <option value="all">{t('reviews.audienceAll', 'All')}</option>
            <option value="mine">{t('reviews.audienceMine', 'My Reviews')}</option>
            <option value="following">{t('reviews.audienceFollowing', 'Following')}</option>
          </select>
          <select value={vintageFilter} onChange={(e) => setVintageFilter(e.target.value)} className="bd-reviews__filter-select">
            <option value="this">{t('reviews.vintageThis', 'This vintage')}</option>
            <option value="all">{t('reviews.vintageAll', 'All vintages')}</option>
          </select>
        </div>
        {reviews.length > 0 ? (
          reviews.map((review) => (
            <ReviewCard key={review._id} review={review} showWine={false} onDelete={changed} />
          ))
        ) : (
          <p className="bd-reviews__empty">{t('reviews.noReviews', 'No reviews yet. Be the first to review this wine!')}</p>
        )}
        {pages > 1 && (
          <div className="bd-reviews__pagination">
            <button className="btn btn-secondary btn-small" disabled={page <= 1} onClick={() => load(page - 1)}>
              {t('common.previous', 'Previous')}
            </button>
            <span className="bd-reviews__page-info">{page} / {pages}</span>
            <button className="btn btn-secondary btn-small" disabled={page >= pages} onClick={() => load(page + 1)}>
              {t('common.next', 'Next')}
            </button>
          </div>
        )}
        <button className="btn btn-primary btn-small" onClick={() => setFormOpen(true)}>
          {t('reviews.writeReview', 'Write a Review')}
        </button>
      </div>

      <Suspense fallback={null}>
        {formOpen && (
          <ReviewForm
            wineDefinition={wine._id}
            wineName={wine.name}
            defaultVintage={vintage && vintage !== 'NV' ? vintage : ''}
            onClose={() => setFormOpen(false)}
            onSaved={changed}
          />
        )}
      </Suspense>
    </>
  );
}
