import { useTranslation } from 'react-i18next';
import { CURRENCIES } from '../../config/currencies';

export default function CurrencyPicker({ value, onChange, profileCurrency, anyRowHasCurrency }) {
  const { t } = useTranslation();
  return (
    <div className="import-currency-block">
      <label className="import-currency-label">
        <strong>{t('importBottles.currency.label')}</strong>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <p className="import-currency-hint">
        {anyRowHasCurrency
          ? t('importBottles.currency.hintSomeRows', { currency: profileCurrency || 'USD' })
          : t('importBottles.currency.hintAllRows', { currency: profileCurrency || 'USD' })}
      </p>
    </div>
  );
}
