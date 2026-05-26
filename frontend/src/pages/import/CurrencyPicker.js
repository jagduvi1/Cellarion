import { CURRENCIES } from '../../config/currencies';

export default function CurrencyPicker({ value, onChange, profileCurrency, anyRowHasCurrency }) {
  return (
    <div className="import-currency-block">
      <label className="import-currency-label">
        <strong>Currency for prices</strong>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <p className="import-currency-hint">
        {anyRowHasCurrency ? (
          <>Applied to rows that don't already have a Currency column. Defaulted to your profile setting ({profileCurrency || 'USD'}).</>
        ) : (
          <>Your file has prices but no Currency column. All imported bottles will be tagged with this currency. Defaulted to your profile setting ({profileCurrency || 'USD'}).</>
        )}
      </p>
    </div>
  );
}
