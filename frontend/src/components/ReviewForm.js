import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import Modal from './Modal';
import RatingInput from './RatingInput';
import { createReview, updateReview } from '../api/reviews';
import './ReviewForm.css';

export default function ReviewForm({ wineDefinition, wineName, existingReview, defaultVintage, onClose, onSaved }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const isEdit = !!existingReview;

  const [rating, setRating] = useState(existingReview?.rating ?? null);
  const [ratingScale, setRatingScale] = useState(
    existingReview?.ratingScale || user?.preferences?.ratingScale || '5'
  );
  const [aroma, setAroma] = useState(existingReview?.tasting?.aroma || '');
  const [palate, setPalate] = useState(existingReview?.tasting?.palate || '');
  const [finish, setFinish] = useState(existingReview?.tasting?.finish || '');
  const [overall, setOverall] = useState(existingReview?.tasting?.overall || '');
  const [vintage, setVintage] = useState(existingReview?.vintage || defaultVintage || '');
  const [visibility, setVisibility] = useState(existingReview?.visibility || 'public');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (rating == null) {
      setError('Please provide a rating');
      return;
    }

    setSaving(true);
    setError(null);

    const data = {
      rating,
      ratingScale,
      vintage: vintage || null,
      tasting: { aroma, palate, finish, overall },
      visibility
    };

    try {
      let res;
      if (isEdit) {
        res = await updateReview(apiFetch, existingReview._id, data);
      } else {
        res = await createReview(apiFetch, { ...data, wineDefinition });
      }

      const result = await res.json();

      if (res.ok) {
        onSaved?.(result.review);
        onClose();
      } else {
        setError(result.error || 'Failed to save review');
      }
    } catch {
      setError('Failed to save review');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isEdit ? 'Edit Review' : `Review: ${wineName || 'Wine'}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="review-form">
        <div className="form-group">
          <label>Rating *</label>
          <RatingInput
            value={rating}
            scale={ratingScale}
            onChange={setRating}
            onScaleChange={setRatingScale}
            allowScaleOverride
          />
        </div>

        <div className="form-group">
          <label htmlFor="review-vintage">Vintage</label>
          <input
            id="review-vintage"
            type="text"
            className="input"
            value={vintage}
            onChange={e => setVintage(e.target.value)}
            placeholder="e.g. 2019"
            maxLength={10}
          />
        </div>

        <div className="form-group">
          <label>{t('reviews.visibility', 'Visibility')}</label>
          <div className="review-form__visibility-toggle">
            <button
              type="button"
              className={`review-form__vis-btn ${visibility === 'public' ? 'active' : ''}`}
              onClick={() => setVisibility('public')}
            >
              {t('reviews.visibilityPublic', 'Public')}
            </button>
            <button
              type="button"
              className={`review-form__vis-btn ${visibility === 'private' ? 'active' : ''}`}
              onClick={() => setVisibility('private')}
            >
              {t('reviews.visibilityPrivate', 'Private')}
            </button>
          </div>
          <span className="review-form__vis-hint">
            {visibility === 'private'
              ? t('reviews.visibilityPrivateHint', 'Only you can see this review')
              : t('reviews.visibilityPublicHint', 'Visible to all users')}
          </span>
        </div>

        <div className="form-group">
          <label htmlFor="review-overall">{t('reviews.overallImpression', 'Overall Impression')}</label>
          <textarea
            id="review-overall"
            className="input"
            value={overall}
            onChange={e => setOverall(e.target.value)}
            placeholder="What did you think of this wine?"
            rows={3}
            maxLength={2000}
          />
        </div>

        <details className="review-form__details">
          <summary>Detailed Tasting Notes</summary>
          <div className="review-form__tasting-fields">
            <div className="form-group">
              <label htmlFor="review-aroma">Aroma / Nose</label>
              <textarea
                id="review-aroma"
                className="input"
                value={aroma}
                onChange={e => setAroma(e.target.value)}
                placeholder="What do you smell?"
                rows={2}
                maxLength={1000}
              />
            </div>
            <div className="form-group">
              <label htmlFor="review-palate">Palate</label>
              <textarea
                id="review-palate"
                className="input"
                value={palate}
                onChange={e => setPalate(e.target.value)}
                placeholder="What do you taste?"
                rows={2}
                maxLength={1000}
              />
            </div>
            <div className="form-group">
              <label htmlFor="review-finish">Finish</label>
              <textarea
                id="review-finish"
                className="input"
                value={finish}
                onChange={e => setFinish(e.target.value)}
                placeholder="How does it linger?"
                rows={2}
                maxLength={1000}
              />
            </div>
          </div>
        </details>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || rating == null}>
            {saving ? 'Saving...' : (isEdit ? 'Update Review' : 'Submit Review')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
