import { useState, useEffect, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { lazy } from '../../utils/lazyWithReload';
import { useAuth } from '../../contexts/AuthContext';
import { updateConsumedRating } from '../../api/bottles';
import { getWineReviews } from '../../api/reviews';
import RatingDisplay from '../RatingDisplay';
import RatingInput from '../RatingInput';
import { CONSUMED_LABEL_KEYS } from '../BottleJourney';

const ReviewForm = lazy(() => import('../ReviewForm'));

const CONSUMED_REASON_ICONS = { drank: '\u{1F377}', gifted: '\u{1F381}', sold: '\u{1F4B0}', other: '\u{1F4E6}' };

/**
 * What happened to a bottle that left the cellar: why, when, the rating and
 * note given then (editable by the owner). For a bottle the viewer drank and
 * rated or described, "Share as review" starts a review of the wine from that
 * rating and note, linked to this bottle; once one exists the same button
 * edits it. `onReviewSaved` tells the page, so its reviews list can reload.
 */
function ConsumedDetails({ bottle, canEdit, onUpdate, onReviewSaved }) {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const reason = bottle.consumedReason || bottle.status;
  const wine = bottle.wineDefinition && typeof bottle.wineDefinition === 'object' ? bottle.wineDefinition : null;
  // Demo accounts cannot write reviews (POST /api/reviews is requireNonDemo).
  const shareable = !!canEdit && !user?.isDemo && reason === 'drank' && !!wine?._id
    && !!(bottle.consumedRating || bottle.consumedNote);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [linkedReview, setLinkedReview] = useState(null);

  // The viewer's review already linked to this bottle, if any. An answer for
  // a bottle the page has left (or after unmount) is dropped.
  useEffect(() => {
    setLinkedReview(null);
    if (!shareable) return undefined;
    let current = true;
    (async () => {
      try {
        const res = await getWineReviews(apiFetch, wine._id, 'audience=mine&limit=50');
        if (!res.ok) return;
        const data = await res.json();
        if (!current) return;
        const mine = (data.reviews || []).find((r) => String(r.bottle?._id || r.bottle || '') === String(bottle._id));
        setLinkedReview(mine || null);
      } catch {
        // Not critical: the button then offers a new review.
      }
    })();
    return () => { current = false; };
  }, [apiFetch, shareable, wine?._id, bottle._id]);
  const icon = CONSUMED_REASON_ICONS[reason] || '\u{1F4E6}';
  const consumedDate = bottle.consumedAt
    ? new Date(bottle.consumedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(bottle.consumedRating || null);
  const [ratingScale, setRatingScale] = useState(bottle.consumedRatingScale || user?.preferences?.ratingScale || '5');
  const [note, setNote] = useState(bottle.consumedNote || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await updateConsumedRating(apiFetch, bottle._id, {
        rating, ratingScale, note
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save'); setSaving(false); return; }
      setEditing(false);
      if (onUpdate) onUpdate(data.bottle);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`bd-consumed card bd-consumed--${reason}`}>
      <div className="bd-consumed__header">
        <span className="bd-consumed__icon">{icon}</span>
        <span className="bd-consumed__reason">
          {t(CONSUMED_LABEL_KEYS[reason] || CONSUMED_LABEL_KEYS.other)}
        </span>
        {consumedDate && <span className="bd-consumed__date">{consumedDate}</span>}
      </div>

      {!editing && bottle.consumedRating && (
        <div className="bd-consumed__rating">
          <span className="bd-detail-label">{t('history.atConsumption', 'Rating at consumption')}</span>
          <div className="bd-consumed__rating-row">
            <RatingDisplay value={bottle.consumedRating} scale={bottle.consumedRatingScale || '5'} preferredScale={user?.preferences?.ratingScale} />
            {canEdit && (
              <button type="button" className="bd-consumed__edit-btn" onClick={() => setEditing(true)}>
                {t('common.edit', 'Edit')}
              </button>
            )}
          </div>
        </div>
      )}

      {!editing && !bottle.consumedRating && canEdit && (
        <button type="button" className="bd-consumed__rate-btn" onClick={() => setEditing(true)}>
          {t('history.rateThisBottle', 'Rate this bottle')}
        </button>
      )}

      {!editing && bottle.consumedNote && (
        <p className="bd-consumed__note">"{bottle.consumedNote}"</p>
      )}

      {!editing && shareable && (
        <button type="button" className="bd-consumed__rate-btn" onClick={() => setReviewOpen(true)}>
          {linkedReview ? t('reviews.editSharedReview', 'Edit your review') : t('reviews.shareAsReview', 'Share as review')}
        </button>
      )}

      <Suspense fallback={null}>
        {reviewOpen && (
          <ReviewForm
            wineDefinition={wine._id}
            wineName={wine.name}
            existingReview={linkedReview || undefined}
            defaultVintage={bottle.vintage && bottle.vintage !== 'NV' ? bottle.vintage : ''}
            prefill={{ rating: bottle.consumedRating ?? null, ratingScale: bottle.consumedRatingScale, overall: bottle.consumedNote || '' }}
            bottleId={bottle._id}
            onClose={() => setReviewOpen(false)}
            onSaved={(review) => { if (review) setLinkedReview(review); if (onReviewSaved) onReviewSaved(review); }}
          />
        )}
      </Suspense>

      {editing && (
        <div className="bd-consumed__edit-form">
          <div className="bd-consumed__edit-field">
            <label className="bd-detail-label">{t('history.atConsumption', 'Rating at consumption')}</label>
            <RatingInput
              value={rating}
              scale={ratingScale}
              onChange={setRating}
              onScaleChange={setRatingScale}
              allowScaleOverride
            />
          </div>
          <div className="bd-consumed__edit-field">
            <label className="bd-detail-label">{t('history.tastingNote', 'Tasting note')}</label>
            <textarea
              className="bd-consumed__note-input"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('history.tastingNotePlaceholder', 'How was the wine?')}
              rows={3}
              maxLength={1000}
            />
          </div>
          {error && <p className="bd-consumed__error">{error}</p>}
          <div className="bd-consumed__edit-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ConsumedDetails;
