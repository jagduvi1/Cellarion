import { useTranslation } from 'react-i18next';
import { isOnOrder, formatArrivalMonth } from '../utils/onOrder';

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const CONSUMED_LABEL_KEYS = {
  drank:  'history.reasonDrank',
  gifted: 'history.reasonGifted',
  sold:   'history.reasonSold',
  other:  'history.reasonOther',
};

/**
 * Per-bottle journey timeline: "Added to A → Moved to B → Drank". Built from the
 * bottle's cellarHistory (seeded on add, appended on each move) plus the consumed
 * fields. Falls back to a single "added" entry when history isn't seeded yet.
 */
export default function BottleJourney({ bottle }) {
  const { t, i18n } = useTranslation();
  if (!bottle) return null;

  const history = Array.isArray(bottle.cellarHistory) && bottle.cellarHistory.length
    ? bottle.cellarHistory
    : [{ cellarName: bottle.cellar?.name || bottle.cellarName, enteredAt: bottle.addedToCellarAt || bottle.createdAt }];

  const items = history.map((h, i) => ({
    key: `c${i}`,
    icon: i === 0 ? '➕' : '📦',
    text: i === 0
      ? t('history.journey.added', { cellar: h.cellarName || '—' })
      : t('history.journey.moved', { cellar: h.cellarName || '—' }),
    date: h.enteredAt,
  }));

  // Bought on order: the delivery is its own step, in date order with any
  // move made while the bottle was still on its way.
  if (bottle.arrivedAt) {
    items.push({ key: 'arrived', icon: '🚚', text: t('history.journey.arrived'), date: bottle.arrivedAt });
    items.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  }
  if (isOnOrder(bottle)) {
    const month = formatArrivalMonth(bottle.expectedArrival, i18n?.language);
    items.push({
      key: 'onorder',
      icon: '🚚',
      text: month ? t('history.journey.onOrderExpected', { month }) : t('history.journey.onOrder'),
    });
  } else if (bottle.status && bottle.status !== 'active') {
    const reasonKey = CONSUMED_LABEL_KEYS[bottle.consumedReason] || CONSUMED_LABEL_KEYS[bottle.status];
    items.push({
      key: 'consumed',
      icon: '🍷',
      text: reasonKey ? t(reasonKey) : bottle.status,
      date: bottle.consumedAt,
    });
  }

  return (
    <section className="bottle-journey">
      <h3 className="bottle-journey-title">{t('history.journey.title')}</h3>
      <ul className="bottle-journey-list">
        {items.map((it) => (
          <li key={it.key} className="bottle-journey-item">
            <span className="bottle-journey-icon" aria-hidden="true">{it.icon}</span>
            <span className="bottle-journey-text">{it.text}</span>
            {it.date && <span className="bottle-journey-date">{fmtDate(it.date)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
