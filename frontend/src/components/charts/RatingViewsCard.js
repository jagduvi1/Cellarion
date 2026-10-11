import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import RatingChart from './RatingChart';

const VIEWS = ['all', 'cellar', 'history'];

/**
 * The rating distribution three ways (support ticket 2026-10-11: someone who
 * rates only when drinking saw an empty card). "All" by default: every
 * rating at once, the bottles in the cellar and the ones drunk, each bottle
 * once and a drunk one with the rating given when drinking. "In the cellar"
 * and "History" (drunk, gifted, sold — the cellar's History) show either
 * part. A band opens the bottles behind it in that view (`onBand(view,
 * band)`).
 *
 * `views` is the overview's ratingViews; without it (an answer from before
 * the views existed) the card shows `fallback`, the cellar's distribution.
 */
export default function RatingViewsCard({ views, fallback, targetScale, onBand }) {
  const { t } = useTranslation();
  const [view, setView] = useState('all');
  const data = views || { cellar: fallback };
  const shown = data[view] ? view : 'cellar';
  const current = data[shown] || { byRating: {}, avg: null };
  const labels = {
    all: t('statistics.ratingViews.all', 'All'),
    cellar: t('statistics.ratingViews.cellar', 'In the cellar'),
    history: t('statistics.ratingViews.history', 'History'),
  };

  return (
    <>
      {views && (
        <div className="rating-views" role="group" aria-label={t('statistics.ratingViews.label', 'Which ratings')}>
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={`rating-view-btn${shown === v ? ' active' : ''}`}
              aria-pressed={shown === v}
              onClick={() => setView(v)}
            >
              {labels[v]} <span className="rating-view-count">{views[v]?.count ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      <RatingChart
        byRating={current.byRating}
        avg={current.avg}
        targetScale={targetScale}
        onBandClick={onBand ? (band) => onBand(shown, band) : undefined}
      />
    </>
  );
}
