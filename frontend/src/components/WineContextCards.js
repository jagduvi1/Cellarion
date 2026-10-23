import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getMaturityStatus, maturityBadgeText } from '../utils/drinkStatus';
import { swatchType, wineTypeLabel } from '../utils/wineColour';

/**
 * The cards a public wine page shows around the wine, from the `context` that
 * GET /api/wines/:slug/public returns (backend services/winePageContext).
 *
 * Drink windows are the registry data most worth keeping: a signed-out
 * visitor sees how many vintages are reviewed and a sign-up link, a member
 * sees the windows. Each card renders nothing when it has nothing to show.
 */

// Members see this many vintages before "Show all".
const WINDOWS_SHOWN = 6;

function TypePill({ wine }) {
  const { t } = useTranslation();
  if (!wine.type) return null;
  // Its own class (styled in WineDetail.css): .wine-type-pill lives in a page
  // stylesheet that may not have loaded. ASCII class name for rosé.
  const swatch = String(swatchType(wine)).replace('é', 'e');
  return <span className={`wd-ctx-pill wd-ctx-pill--${swatch}`}>{wineTypeLabel(wine, t)}</span>;
}

// "→" after a link's words is decoration: screen readers skip it.
const Arrow = () => <span aria-hidden="true"> →</span>;

export function WhenToDrinkCard({ context, signedIn }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const windows = signedIn ? context?.drinkWindows || [] : [];
  const count = context?.reviewedVintages || 0;
  if (count === 0) return null;
  const shown = showAll ? windows : windows.slice(0, WINDOWS_SHOWN);
  return (
    <div className="wd-card wd-ctx-card">
      <div className="bd-ai-profile__header">
        <h2>{t('wineDetail.whenToDrink', 'When to drink')}</h2>
        <span className="bd-ai-tag bd-ai-tag--curator" title={t('wineDetail.windowReviewedTitle', 'A sommelier has reviewed these drink windows')}>
          {t('wineDetail.windowReviewedTag', 'Sommelier-reviewed')}
        </span>
      </div>
      {windows.length > 0 ? (
        <>
        <ul className="wd-ctx-list">
          {shown.map((w) => {
            const status = w.relative ? null : getMaturityStatus({ ...w, status: 'reviewed' });
            const best = w.relative
              ? t('wineDetail.windowBestRelative', { from: w.peakFrom, until: w.peakUntil, defaultValue: 'Best {{from}}–{{until}} years after purchase' })
              : t('wineDetail.windowBest', { from: w.peakFrom, until: w.peakUntil, defaultValue: 'Best {{from}}–{{until}}' });
            return (
              <li key={w.vintage}>
                <span className="wd-ctx-vintage">{w.vintage}</span>
                <span>{w.peakFrom != null && w.peakUntil != null ? best : null}</span>
                {status && <span className="wd-ctx-sub">{maturityBadgeText(status, t)}</span>}
              </li>
            );
          })}
        </ul>
        {windows.length > shown.length && (
          <button type="button" className="btn btn-secondary btn-small wd-ctx-showall" onClick={() => setShowAll(true)}>
            {t('wineDetail.windowShowAll', { count: windows.length, defaultValue: 'Show all {{count}} vintages' })}
          </button>
        )}
        </>
      ) : (
        <>
          <p className="wd-ctx-text">{t('wineDetail.windowTeaser', { count, defaultValue: 'Our sommeliers have reviewed when to drink {{count}} vintages of this wine.' })}</p>
          {!signedIn && (
            // A text link, not a button: the sign-up banner follows right after.
            <Link to="/login?mode=register" className="wd-ctx-more">
              {t('wineDetail.windowTeaserCta', 'Sign up free to see when it’s ready')}<Arrow />
            </Link>
          )}
        </>
      )}
    </div>
  );
}

export function WhereFromCard({ context, countryName }) {
  const { t } = useTranslation();
  const region = context?.region?.excerpt ? context.region : null;
  const grapes = (context?.grapes || []).filter((g) => g.excerpt);
  if (!region && grapes.length === 0) return null;
  const name = (entry) => (entry.path ? <Link to={entry.path}>{entry.name}</Link> : entry.name);
  return (
    <div className="wd-card wd-ctx-card">
      <div className="bd-ai-profile__header">
        <h2>{t('wineDetail.whereFrom', 'Where it comes from')}</h2>
      </div>
      {region && (
        <div className="wd-ctx-block">
          <span className="bd-ai-group-label">{t('wineDetail.region')}</span>
          <p className="wd-ctx-text"><strong>{name(region)}</strong>{countryName ? `, ${countryName}` : ''}</p>
          <p className="wd-ctx-text">{region.excerpt}</p>
          {region.path && (
            <Link to={region.path} className="wd-ctx-more">
              {t('wineDetail.moreAbout', { name: region.name, defaultValue: 'More about {{name}}' })}<Arrow />
            </Link>
          )}
        </div>
      )}
      {grapes.length > 0 && (
        <div className="wd-ctx-block">
          <span className="bd-ai-group-label">{t('wineDetail.grapes')}</span>
          {grapes.map((g) => (
            <div key={g.name} className="wd-ctx-grape">
              <p className="wd-ctx-text"><strong>{name(g)}</strong></p>
              <p className="wd-ctx-text">{g.excerpt}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WineList({ wines }) {
  return (
    <ul className="wd-ctx-list">
      {wines.map((w) => (
        <li key={w.path}>
          <span className="wd-ctx-name">
            <Link to={w.path}>{w.name}</Link>
            <span className="wd-ctx-sub">{[w.producer, w.place].filter(Boolean).join(' · ')}</span>
          </span>
          <TypePill wine={w} />
        </li>
      ))}
    </ul>
  );
}

export function MoreWinesCard({ context, wine }) {
  const { t } = useTranslation();
  const sameProducer = context?.sameProducer || [];
  const similar = context?.similar || [];
  if (sameProducer.length === 0 && similar.length === 0) return null;
  return (
    <div className="wd-card wd-ctx-card">
      <div className="bd-ai-profile__header">
        <h2>{t('wineDetail.moreWines', 'More wines')}</h2>
      </div>
      {sameProducer.length > 0 && (
        <div className="wd-ctx-block">
          <span className="bd-ai-group-label">{t('wineDetail.fromProducer', { producer: wine.producer, defaultValue: 'From {{producer}}' })}</span>
          <WineList wines={sameProducer} />
        </div>
      )}
      {similar.length > 0 && (
        <div className="wd-ctx-block">
          <span className="bd-ai-group-label">
            {/* One whole sentence per wine type (i18next context), so each language
                words it its own way instead of gluing in a lowercased type label. */}
            {t('wineDetail.moreFromRegion', { context: wine.type || undefined, region: wine.region?.name, defaultValue: 'More wines from {{region}}' })}
          </span>
          <WineList wines={similar} />
        </div>
      )}
    </div>
  );
}
