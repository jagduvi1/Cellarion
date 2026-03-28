import { useTranslation } from 'react-i18next';
import { convertAmountHistorical } from '../../utils/currency';
import { calculatePriceChange } from '../../utils/priceHistoryUtils';
import timeAgo from '../../utils/timeAgo';

function PriceHistoryTimeline({ history, rates, userCurrency }) {
  const { t } = useTranslation();
  if (history === null) {
    return <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>;
  }
  if (history.length === 0) {
    return (
      <div className="bd-price-history-empty">
        <span className="bd-no-dates">{t('bottleDetail.noPriceData')}</span>
        <span className="bd-maturity-note">{t('bottleDetail.sommelierAddPricing')}</span>
      </div>
    );
  }

  const latest = history[0];
  const previous = history.length > 1 ? history[1] : null;
  const change = calculatePriceChange(latest, previous);

  // Convert latest price using historically-anchored rates (rate at time of recording)
  const latestConverted = convertAmountHistorical(latest.price, latest.currency, userCurrency, latest.exchangeRates, rates);

  return (
    <div className="bd-price-history">
      <div className="bd-price-latest">
        <span className="bd-price-latest__amount">
          {latest.price.toLocaleString()} {latest.currency}
        </span>
        {latestConverted !== null && (
          <span className="bd-price-converted">&asymp; {latestConverted.toLocaleString()} {userCurrency}</span>
        )}
        {change && (
          <span className={`bd-price-change bd-price-change--${change.up ? 'up' : 'down'}`}>
            {change.up ? '\u2191' : '\u2193'} {Math.abs(change.diff).toFixed(2)} ({change.up ? '+' : ''}{change.pct}%)
          </span>
        )}
      </div>
      <div className="bd-price-latest__meta">
        {timeAgo(latest.setAt)}
        {latest.source && <> &middot; <em>{latest.source}</em></>}
        {latest.setBy?.username && <> &middot; {latest.setBy.username}</>}
      </div>

      {history.length > 1 && (
        <div className="bd-price-timeline">
          {history.slice(1).map((entry, i) => {
            const converted = convertAmountHistorical(entry.price, entry.currency, userCurrency, entry.exchangeRates, rates);
            return (
              <div key={i} className="bd-price-entry">
                <span className="bd-price-entry__price">{entry.price.toLocaleString()} {entry.currency}</span>
                {converted !== null && (
                  <span className="bd-price-entry__converted">&asymp; {converted.toLocaleString()} {userCurrency}</span>
                )}
                <span className="bd-price-entry__date">{timeAgo(entry.setAt)}</span>
                {entry.source && <span className="bd-price-entry__source">{entry.source}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PriceHistoryTimeline;
