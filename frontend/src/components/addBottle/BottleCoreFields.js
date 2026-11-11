import { CURRENCIES } from '../../config/currencies';
import { BOTTLE_SIZES, bottleSizeLabel } from '../../config/bottleSizes';
import { validatePriceSanity } from '../../utils/priceValidation';
import RatingInput from '../RatingInput';
import { vintageInputProps } from '../../utils/vintage';

/**
 * The fields every bottle has: vintage, size, how many, price and currency,
 * and the rating. The page owns the values (bottleData, numBottles).
 */
export default function BottleCoreFields({
  t, bottleData, setBottleData, numBottles, setNumBottles,
}) {
  return (
    <>
      <div className="grid-2" style={{ marginTop: '1.25rem' }}>
        <div className="form-group">
          <label>{t('common.vintage')} *</label>
          <input
            type="text"
            value={bottleData.vintage}
            onChange={(e) => setBottleData({ ...bottleData, vintage: e.target.value })}
            placeholder={t('addBottle.vintagePlaceholder')}
            {...vintageInputProps(t)}
            title={t('addBottle.vintagePattern')}
            required
            autoFocus
          />
        </div>

        <div className="form-group">
          <label>{t('addBottle.numberOfBottles')}</label>
          <input
            type="number"
            inputMode="numeric"
            value={numBottles}
            onChange={(e) => setNumBottles(Math.max(1, parseInt(e.target.value) || 1))}
            onFocus={(e) => e.target.select()}
            min="1"
            required
          />
        </div>

        <div className="form-group">
          <label>{t('common.price')}</label>
          <input
            type="number"
            step="0.01"
            value={bottleData.price}
            onChange={(e) => setBottleData({ ...bottleData, price: e.target.value })}
            placeholder="0.00"
          />
          {(() => {
            const warns = validatePriceSanity({
              price: parseFloat(bottleData.price),
              currency: bottleData.currency || 'USD',
            });
            if (warns.length === 0) return null;
            return (
              <ul className="price-warnings">
                {warns.map(w => (
                  <li key={w.code} className={`price-warning price-warning--${w.severity}`}>
                    {t(`addBottle.priceWarning.${w.code}`, w.context)}
                  </li>
                ))}
              </ul>
            );
          })()}
        </div>

        <div className="form-group">
          <label>{t('common.currency')}</label>
          {/* Each option carries its code as value, and the list is
              never translated: browser page translation rewrote the
              option TEXT "EUR" as "EURO", and an option without a value
              sends its text (2026-10-13). */}
          <select
            translate="no"
            value={bottleData.currency}
            onChange={(e) => setBottleData({ ...bottleData, currency: e.target.value })}
          >
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.bottleSize')}</label>
          <select
            value={bottleData.bottleSize}
            onChange={(e) => setBottleData({ ...bottleData, bottleSize: e.target.value })}
          >
            {BOTTLE_SIZES.map((s) => (
              <option key={s.code} value={s.code}>{bottleSizeLabel(s.code, t)}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.ratingLabel')}</label>
          <RatingInput
            value={bottleData.rating}
            scale={bottleData.ratingScale}
            onChange={v => setBottleData({ ...bottleData, rating: v ?? '' })}
            onScaleChange={s => setBottleData({ ...bottleData, ratingScale: s, rating: '' })}
            allowScaleOverride
          />
        </div>
      </div>
    </>
  );
}
