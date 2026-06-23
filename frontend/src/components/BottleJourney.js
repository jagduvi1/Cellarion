import { useTranslation } from 'react-i18next';

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const CONSUMED_LABEL_KEYS = {
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
  const { t } = useTranslation();
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

  if (bottle.status && bottle.status !== 'active') {
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
