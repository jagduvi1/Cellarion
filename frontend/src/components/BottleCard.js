import { memo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { buildRackUrl } from '../utils/rackNavigation';
import { useTranslation } from 'react-i18next';
import AuthImage from './AuthImage';
import './BottleCard.css';

const MATURITY_LABELS = {
  'not-ready': { key: 'maturity.notReady', cls: 'maturity-badge--not-ready' },
  early:       { key: 'maturity.early',    cls: 'maturity-badge--early' },
  peak:        { key: 'maturity.peak',     cls: 'maturity-badge--peak' },
  late:        { key: 'maturity.late',     cls: 'maturity-badge--late' },
  declining:   { key: 'maturity.declining', cls: 'maturity-badge--declining' },
};

/**
 * Renders a single bottle in either list or card (grid) view.
 * Props: bottle, rackMap, cellarId, viewMode ('list' | 'card')
 */
function BottleCard({ bottle, rackMap, cellarId, viewMode, groupCount = 1, onClick, showCellarBadge = false }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isGroup = groupCount > 1;
  // Cross-cellar views tag each bottle with the cellar it lives in.
  const cellarBadge = showCellarBadge && bottle.cellarName ? bottle.cellarName : null;
  const cellarBadgeColor = bottle.cellarColor || null;
  // A collapsed group spans multiple bottles (possibly in different racks), so a
  // single rack badge would be misleading — suppress it until the group expands.
  const rackInfo = isGroup ? null : rackMap?.get(bottle._id);
  const rackNavPref = user?.preferences?.rackNavigation || 'auto';
  const imgSrc = bottle.defaultImageUrl || bottle.wineDefinition?.image || bottle.pendingImageUrl;
  const credit = bottle.defaultImageUrl ? null : bottle.wineDefinition?.imageCredit;
  const isPending = !bottle.wineDefinition && !!bottle.pendingWineRequest;
  const displayName = bottle.wineDefinition?.name || bottle.pendingWineRequest?.wineName || 'Unknown Wine';
  const displayProducer = bottle.wineDefinition?.producer || bottle.pendingWineRequest?.producer;
  const maturityInfo = bottle.maturityStatus ? MATURITY_LABELS[bottle.maturityStatus] : null;

  // onClick overrides navigation — used to expand a collapsed group instead.
  const handleClick = onClick || (() => navigate(`/cellars/${cellarId}/bottles/${bottle._id}`));
  const handleKey = e => e.key === 'Enter' && handleClick();

  if (viewMode === 'card') {
    return (
      <div
        className={`bottle-grid-card${isGroup ? ' bottle-grid-card--stacked' : ''}`}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={handleKey}
        title={isGroup ? `${groupCount} identical bottles — click to expand` : undefined}
      >
        {isGroup && <span className="bottle-count-badge">×{groupCount}</span>}
        <div className="bottle-grid-image-wrap">
          {imgSrc ? (
            <>
              <AuthImage
                src={imgSrc}
                alt={displayName}
                className="bottle-grid-image"
                loading="lazy"
                onError={e => { e.target.style.display = 'none'; }}
              />
              {credit && <span className="img-credit-tooltip">{credit}</span>}
            </>
          ) : (
            <div className={`bottle-grid-placeholder ${bottle.wineDefinition?.type}`} />
          )}
        </div>
        <div className="bottle-grid-info">
          <div className="bottle-grid-name">{displayName}</div>
          <div className="bottle-grid-producer">{displayProducer}</div>
          <div className="bottle-grid-meta">
            {bottle.vintage && <span className="bottle-vintage">{bottle.vintage}</span>}
            {bottle.wineDefinition?.region?.name && (
              <span className="bottle-grid-region">{bottle.wineDefinition.region.name}</span>
            )}
          </div>
          <div className="bottle-badges">
            {cellarBadge && (
              <span className="cellar-badge" style={cellarBadgeColor ? { '--cellar-badge-color': cellarBadgeColor } : undefined}>
                <span className="cellar-badge-dot" aria-hidden="true" /> {cellarBadge}
              </span>
            )}
            {isPending && (
              <span className="pending-wine-badge">Pending review</span>
            )}
            {maturityInfo && (
              <span className={`maturity-badge ${maturityInfo.cls}`}>{t(maturityInfo.key)}</span>
            )}
            {!maturityInfo && bottle.maturityStatus === null && bottle.hasOwnProperty('maturityStatus') && (
              <span className="maturity-badge maturity-badge--none">{t('maturity.noData')}</span>
            )}
            {rackInfo && (
              <Link
                to={buildRackUrl(cellarId, { rackId: rackInfo.rackId, bottleId: bottle._id, inRoom: rackInfo.inRoom, preference: rackNavPref })}
                className="rack-badge"
                onClick={e => e.stopPropagation()}
              >
                <span aria-hidden="true">📍</span> {rackInfo.rackName}
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // list view (default)
  return (
    <div
      className={`bottle-card${isGroup ? ' bottle-card--stacked' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={handleKey}
      title={isGroup ? `${groupCount} identical bottles — click to expand` : undefined}
    >
      {imgSrc ? (
        <div className="bottle-img-wrap">
          <AuthImage
            src={imgSrc}
            alt={displayName}
            className="bottle-wine-image"
            loading="lazy"
            onError={e => { e.target.style.display = 'none'; }}
          />
          {credit && <span className="img-credit-tooltip">{credit}</span>}
        </div>
      ) : (
        <div className={`bottle-wine-placeholder ${bottle.wineDefinition?.type}`} />
      )}

      <div className="bottle-info">
        <div className="bottle-name">
          {displayName}
          {isGroup && <span className="bottle-count-pill">×{groupCount}</span>}
        </div>
        <div className="bottle-meta">
          <span className="bottle-producer">{displayProducer}</span>
          {bottle.vintage && <span className="bottle-vintage">{bottle.vintage}</span>}
        </div>
        <div className="bottle-badges">
          {cellarBadge && (
            <span className="cellar-badge" style={cellarBadgeColor ? { '--cellar-badge-color': cellarBadgeColor } : undefined}>
              <span className="cellar-badge-dot" aria-hidden="true" /> {cellarBadge}
            </span>
          )}
          {isPending && (
            <span className="pending-wine-badge">Pending review</span>
          )}
          {maturityInfo && (
            <span className={`maturity-badge ${maturityInfo.cls}`}>{t(maturityInfo.key)}</span>
          )}
          {!maturityInfo && bottle.maturityStatus === null && bottle.hasOwnProperty('maturityStatus') && (
            <span className="maturity-badge maturity-badge--none">{t('maturity.noData')}</span>
          )}
          {rackInfo && (
            <Link
              to={buildRackUrl(cellarId, { rackId: rackInfo.rackId, bottleId: bottle._id, inRoom: rackInfo.inRoom, preference: rackNavPref })}
              className="rack-badge"
              onClick={e => e.stopPropagation()}
            >
              📍 {rackInfo.rackName}
            </Link>
          )}
        </div>
      </div>

      <span className="bottle-chevron" aria-hidden="true">{isGroup ? '⊕' : '›'}</span>
    </div>
  );
}

// Memoized: CellarDetail accumulates load-more pages into one list, and every
// search keystroke re-renders the page — without memo, hundreds of cards
// re-render per keystroke even though their props are unchanged.
//
// onClick is excluded from the comparison: callers pass inline arrows
// (`onClick={() => toggleGroup(item.key)}`), whose identity changes every
// parent render and would defeat the memo for exactly the grouped cards it
// exists for. This is safe because every current onClick closes only over
// values derived from the OTHER compared props (the bottle/group item) — if a
// future caller closes over unrelated state, that handler must be stabilized
// with useCallback instead.
const COMPARED_PROPS = ['bottle', 'rackMap', 'cellarId', 'viewMode', 'groupCount', 'showCellarBadge'];
export default memo(BottleCard, (prev, next) =>
  COMPARED_PROPS.every(key => prev[key] === next[key])
);
