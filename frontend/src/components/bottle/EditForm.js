import { useState, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { updateBottle, setBottleDefaultImage } from '../../api/bottles';
import { toInputDate, validateDrinkWindowFields, DRINK_YEAR_MIN, DRINK_YEAR_MAX } from '../../utils/drinkStatus';
import { API_URL } from '../../api/apiConstants';
import { CURRENCIES } from '../../config/currencies';
import { BOTTLE_SIZES, bottleSizeLabel, normalizeBottleSize } from '../../config/bottleSizes';
import RatingInput from '../RatingInput';

const ImageUpload = lazy(() => import('../ImageUpload'));
const ImageGallery = lazy(() => import('../ImageGallery'));

function EditForm({ bottle, onSaved, onCancel, onImageUploaded }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const galleryRef = useRef(null);
  const [form, setForm] = useState({
    vintage:          bottle.vintage     || '',
    rating:           bottle.rating      || '',
    ratingScale:      bottle.ratingScale || '5',
    notes:            bottle.notes   || '',
    occasion:         bottle.occasion || '',
    drinkFrom:        bottle.drinkFrom != null ? String(bottle.drinkFrom) : '',
    drinkTo:          bottle.drinkTo   != null ? String(bottle.drinkTo)   : '',
    price:            bottle.price   || '',
    // If bottle has a price, keep stored currency (price and currency must stay in sync).
    // If no price yet, default to user's preference so they don't have to change it every time.
    currency:         bottle.price ? (bottle.currency || 'USD') : (user?.preferences?.currency || bottle.currency || 'USD'),
    bottleSize:       normalizeBottleSize(bottle.bottleSize) || bottle.bottleSize || '750ml',
    purchaseDate:     toInputDate(bottle.purchaseDate),
    purchaseLocation: bottle.purchaseLocation || '',
    purchaseUrl:      bottle.purchaseUrl || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    // Mirrors the backend rules: integer years 1900–2200, from ≤ to, ≤500 chars.
    const windowError = validateDrinkWindowFields(form, t);
    if (windowError) { setError(windowError); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await updateBottle(apiFetch, bottle._id, {
        ...form,
        price:  form.price  ? parseFloat(form.price)  : null,
        rating: form.rating ? parseFloat(form.rating) : null,
        ratingScale: form.ratingScale || '5',
        purchaseDate: form.purchaseDate || null,
        drinkFrom: form.drinkFrom ? parseInt(form.drinkFrom, 10) : null,
        drinkTo:   form.drinkTo   ? parseInt(form.drinkTo, 10)   : null,
      });
      const data = await res.json();
      if (res.ok) onSaved(data.bottle);
      else setError(data.error || 'Failed to save');
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="bd-edit-form card" onSubmit={handleSave}>
      <h2>{t('bottleDetail.editBottleTitle')}</h2>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="bd-edit-grid">
        <div className="form-group">
          <label>{t('bottleDetail.vintage')}</label>
          <input
            type="text"
            value={form.vintage}
            onChange={set('vintage')}
            placeholder={t('bottleDetail.vintagePlaceholder')}
            pattern="^(?:[Nn][Vv]|[Uu]nknown|(?:19|20)\d{2})$"
            title={t('bottleDetail.vintagePattern')}
            maxLength={7}
          />
        </div>

        <div className="form-group">
          <label>{t('bottleDetail.ratingLabel')}</label>
          <RatingInput
            value={form.rating}
            scale={form.ratingScale}
            onChange={v => setForm(f => ({ ...f, rating: v ?? '' }))}
            onScaleChange={s => setForm(f => ({ ...f, ratingScale: s, rating: '' }))}
            allowScaleOverride
          />
        </div>

        <div className="form-group">
          <label>{t('common.price')}</label>
          <input type="number" step="0.01" min="0" value={form.price} onChange={set('price')} placeholder="0.00" />
        </div>

        <div className="form-group">
          <label>{t('common.currency')}</label>
          <select value={form.currency} onChange={set('currency')}>
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.bottleSize')}</label>
          <select value={form.bottleSize} onChange={set('bottleSize')}>
            {!BOTTLE_SIZES.some((s) => s.code === form.bottleSize) && form.bottleSize && (
              <option value={form.bottleSize}>{bottleSizeLabel(form.bottleSize, t)}</option>
            )}
            {BOTTLE_SIZES.map((s) => (
              <option key={s.code} value={s.code}>{bottleSizeLabel(s.code, t)}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.purchaseDate')}</label>
          <input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} />
        </div>
      </div>

      <div className="form-group">
        <label>{t('common.notes')}</label>
        <textarea value={form.notes} onChange={set('notes')} rows={4} placeholder={t('addBottle.notesPlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('addBottle.occasion')}</label>
        <input
          type="text"
          value={form.occasion}
          onChange={set('occasion')}
          placeholder={t('addBottle.occasionPlaceholder')}
          maxLength={500}
        />
      </div>

      <div className="form-group">
        <label>{t('addBottle.drinkWindow')}</label>
        <div className="bd-edit-grid">
          <div className="form-group">
            <label>{t('addBottle.drinkFrom')}</label>
            <input
              type="number"
              value={form.drinkFrom}
              onChange={set('drinkFrom')}
              placeholder={t('addBottle.drinkFromPlaceholder')}
              min={DRINK_YEAR_MIN}
              max={DRINK_YEAR_MAX}
              step="1"
            />
          </div>
          <div className="form-group">
            <label>{t('addBottle.drinkTo')}</label>
            <input
              type="number"
              value={form.drinkTo}
              onChange={set('drinkTo')}
              placeholder={t('addBottle.drinkToPlaceholder')}
              min={DRINK_YEAR_MIN}
              max={DRINK_YEAR_MAX}
              step="1"
            />
          </div>
        </div>
        <p className="help-text">{t('addBottle.drinkWindowHint')}</p>
      </div>

      <div className="form-group">
        <label>{t('addBottle.purchaseLocation')}</label>
        <input type="text" value={form.purchaseLocation} onChange={set('purchaseLocation')} placeholder={t('addBottle.purchaseLocationPlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('addBottle.purchaseUrl')}</label>
        <input type="url" value={form.purchaseUrl} onChange={set('purchaseUrl')} placeholder="https://\u2026" />
      </div>

      <div className="form-group bd-image-section">
        <label>
          {t('bottleDetail.addWineImage', 'Wine Photo')}
          <span className="bd-label-optional"> ({t('common.optional', 'optional')})</span>
        </label>
        <p className="bd-image-default-hint">{t('bottleDetail.defaultImageHint', 'Click the star to choose which image is shown first.')}</p>
        <Suspense fallback={null}>
          <ImageGallery
            ref={galleryRef}
            bottleId={bottle._id}
            size="medium"
            onSetDefault={async (imageId) => {
              const res = await setBottleDefaultImage(apiFetch, bottle._id, imageId);
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to set default image');
              }
            }}
          />
        </Suspense>
        <Suspense fallback={null}>
          <ImageUpload
            bottleId={bottle._id}
            wineDefinitionId={bottle.wineDefinition?._id}
            onUploadComplete={(img) => {
              if (onImageUploaded && img?.originalUrl) {
                const url = img.originalUrl.startsWith('http')
                  ? img.originalUrl
                  : `${API_URL}${img.originalUrl}`;
                onImageUploaded(url);
              }
              galleryRef.current?.refresh();
            }}
            onProcessingComplete={(url) => {
              onImageUploaded?.(url);
              galleryRef.current?.refresh();
            }}
          />
        </Suspense>
        <p className="image-public-notice">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {t('bottleDetail.imageNotice', 'Images are reviewed by an admin before being added to the shared wine registry, where they will be visible to all Cellarion users.')}
        </p>
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : t('bottleDetail.saveChanges')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

export default EditForm;
