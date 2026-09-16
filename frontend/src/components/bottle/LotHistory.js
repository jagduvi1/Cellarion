import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { fetchLotHistory } from '../../api/bottles';
import RatingDisplay from '../RatingDisplay';
import { CONSUMED_LABEL_KEYS } from '../BottleJourney';
import './LotHistory.css';

const REASON_ICONS = { drank: '\u{1F377}', gifted: '\u{1F381}', sold: '\u{1F4B0}', other: '\u{1F4E6}' };

/**
 * "This wine in your cellar" — what happened to the viewer's OTHER bottles of
 * the wine on screen (support ticket 2026-09-16: "if I drink a bottle, I can't
 * see that information in the other bottles"). Each drunk sibling shows its
 * date, rating and note, and links to its own page.
 *
 * Nothing is copied between bottles: the rows are computed on read by
 * GET /api/bottles/:id/lot-history, so each bottle stays the single truth
 * about itself and a later correction is never stale on a copy.
 *
 * VINTAGES ARE NEVER MERGED. The bottle's own vintage is the card; the other
 * vintages of the same wine are a collapsed section below it, newest first,
 * because a rating of the 2015 says nothing about whether the 2020 is ready
 * (the drink window and the pace verdict are per vintage). Same shape as the
 * Reviews card's "this vintage / all vintages" filter further down the page.
 *
 * The whole card hides itself when there is nothing to say — one bottle, never
 * drunk, no other vintages — so a single-bottle cellar gains no empty box.
 */
function EventRow({ event, currentBottleId }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const reason = event.reason || 'drank';
  const isCurrent = currentBottleId && String(event.bottle_id) === String(currentBottleId);
  const date = event.date
    ? new Date(event.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  const head = (
    <>
      <span className="lot-history__icon" aria-hidden="true">{REASON_ICONS[reason] || REASON_ICONS.other}</span>
      <span className="lot-history__reason">
        {t(CONSUMED_LABEL_KEYS[reason] || CONSUMED_LABEL_KEYS.other)}
      </span>
      {date && <span className="lot-history__date">{date}</span>}
    </>
  );

  return (
    <li className={`lot-history__event${isCurrent ? ' lot-history__event--current' : ''}`}>
      <div className="lot-history__event-head">
        {/* The bottle you are already looking at is listed for an honest count,
            but must not link to the page you are on. */}
        {isCurrent
          ? <span className="lot-history__self">{head} <em>{t('lotHistory.thisBottle', 'this bottle')}</em></span>
          : <Link className="lot-history__link" to={`/cellars/${event.cellar_id}/bottles/${event.bottle_id}`}>{head}</Link>}
        {event.rating != null && (
          <RatingDisplay
            value={event.rating}
            scale={event.rating_scale || '5'}
            preferredScale={user?.preferences?.ratingScale}
          />
        )}
      </div>
      {/* One text node, not entity + value + entity: the quoted note stays
          selectable and copyable as a single run of text. */}
      {event.note && <p className="lot-history__note">{`\u201C${event.note}\u201D`}</p>}
    </li>
  );
}

function LotBlock({ lot, currentBottleId, heading }) {
  const { t } = useTranslation();
  const events = lot.consumed_events || [];
  const remaining = lot.counts?.remaining ?? 0;
  const consumed = lot.counts?.consumed ?? 0;

  return (
    <div className="lot-history__lot">
      {heading && <h3 className="lot-history__vintage">{heading}</h3>}
      <p className="lot-history__counts">
        <span>{t('lotHistory.remaining', '{{count}} in your cellar', { count: remaining })}</span>
        {consumed > 0 && (
          <>
            <span aria-hidden="true"> · </span>
            <span>{t('lotHistory.consumed', '{{count}} drunk', { count: consumed })}</span>
          </>
        )}
      </p>
      {events.length > 0 && (
        <ul className="lot-history__events">
          {events.map((e) => (
            <EventRow key={String(e.bottle_id)} event={e} currentBottleId={currentBottleId} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function LotHistory({ apiFetch, bottleId, vintage, isOwner = true }) {
  const { t } = useTranslation();
  const [lots, setLots] = useState(null);
  const [showOthers, setShowOthers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLots(null);
    setShowOthers(false);
    // Owned cellars only (the route answers empty for anyone else), so a
    // shared-cellar bottle costs no request; and it waits for the bottle
    // itself, so the card never renders against a vintage not yet loaded.
    if (!isOwner) return undefined;
    (async () => {
      try {
        // Every vintage in one call: the toggle below is then instant, and the
        // card knows whether it has anything to show before it renders.
        const res = await fetchLotHistory(apiFetch, bottleId, { vintages: 'all' });
        const data = await res.json();
        if (!cancelled) setLots(res.ok && Array.isArray(data.lots) ? data.lots : []);
      } catch {
        // A side card must never take the bottle page down.
        if (!cancelled) setLots([]);
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, bottleId, isOwner]);

  if (!lots) return null;

  const own = String(vintage || 'NV');
  const thisLot = lots.find((l) => String(l.vintage) === own) || null;
  const otherLots = lots.filter((l) => String(l.vintage) !== own);

  // Nothing to say: this is the only bottle of its vintage (drunk or not — a
  // lone drunk bottle's row would only repeat the consumption card above it),
  // and there is no other vintage of the wine in the cellar.
  const thisLotSpeaks = !!thisLot && (thisLot.counts?.total ?? 0) > 1;
  if (!thisLotSpeaks && otherLots.length === 0) return null;

  return (
    <div className="lot-history card">
      <h2>{t('lotHistory.title', 'This wine in your cellar')}</h2>

      {thisLot
        ? <LotBlock lot={thisLot} currentBottleId={bottleId} />
        : <p className="lot-history__counts">{t('lotHistory.noneThisVintage', 'No bottles of this vintage.')}</p>}

      {otherLots.length > 0 && (
        <div className="lot-history__others">
          <button
            type="button"
            className="lot-history__toggle"
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
          >
            {showOthers
              ? t('lotHistory.hideOtherVintages', 'Hide other vintages')
              : t('lotHistory.showOtherVintages', 'Other vintages you have ({{count}})', { count: otherLots.length })}
          </button>
          {showOthers && (
            <>
              <p className="lot-history__hint">
                {t('lotHistory.otherVintagesHint', 'Kept apart on purpose: how a different vintage showed says nothing about when this one is ready.')}
              </p>
              {otherLots.map((lot) => (
                <LotBlock
                  key={String(lot.vintage)}
                  lot={lot}
                  currentBottleId={bottleId}
                  heading={lot.vintage}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
