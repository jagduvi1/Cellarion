import { memo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { buildRackUrl } from '../utils/rackNavigation';
import { useTranslation } from 'react-i18next';
import AuthImage from './AuthImage';
import { glassesLeft, daysLeft, freshnessStatus } from '../utils/openBottle';
import { isReserved, reservationSummary } from '../utils/reservation';
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
function BottleCard({ bottle, rackMap, cellarId, viewMode, groupCount = 1, onClick, showCellarBadge = false, compact = false, rackKnown = false, showNotes = false }) {
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
  // "Unplaced" = the caller knows this cellar's rack layout (single-cellar view
  // of a cellar that has racks) and this active bottle isn't in any slot — i.e.
  // it's been added but not shelved. Suppressed for groups (members may differ)
  // and whenever placement is unknown (cross-cellar view, or no racks exist).
  const isUnplaced = rackKnown && !isGroup && !rackInfo && bottle.status === 'active';
  const rackNavPref = user?.preferences?.rackNavigation || 'auto';
  const imgSrc = bottle.defaultImageUrl || bottle.wineDefinition?.image || bottle.pendingImageUrl;
  const credit = bottle.defaultImageUrl ? null : bottle.wineDefinition?.imageCredit;
  const isPending = !bottle.wineDefinition && !!bottle.pendingWineRequest;
  const displayName = bottle.wineDefinition?.name || bottle.pendingWineRequest?.wineName || t('common.unknownWine');
  const displayProducer = bottle.wineDefinition?.producer || bottle.pendingWineRequest?.producer;
  const maturityInfo = bottle.maturityStatus ? MATURITY_LABELS[bottle.maturityStatus] : null;
  // The backend computes maturityStatus with the bottle's OWN personal window
  // taking precedence over the vintage profile — flag the source here. Peak
  // fields count too: MCP can set a peak without a window, and that bottle's
  // status is still personally sourced.
  const hasPersonalWindow = Number.isFinite(bottle.drinkFrom) || Number.isFinite(bottle.drinkTo)
    || Number.isFinite(bottle.peakFrom) || Number.isFinite(bottle.peakUntil);
  // Reserved ("spoken for") — suppressed for collapsed groups, whose members
  // may carry different reservations (same reasoning as the rack badge).
  const reserved = !isGroup && bottle.status === 'active' && isReserved(bottle);

  // onClick overrides navigation — used to expand a collapsed group instead.
  const handleClick = onClick || (() => navigate(`/cellars/${cellarId}/bottles/${bottle._id}`));
  const handleKey = e => e.key === 'Enter' && handleClick();

  // Opt-in personal-note preview (list view only). Occasion ("Gift from Anna")
  // leads, then the first line of the tasting notes; CSS clamps to one line.
  // Suppressed for collapsed groups — members may carry different notes, so a
  // single bottle's text would be misleading (same reasoning as the rack badge).
  const occasion = (bottle.occasion || '').trim();
  const firstNoteLine = (bottle.notes || '').split('\n')[0].trim();
  const notePreview = showNotes && !isGroup && viewMode !== 'card'
    ? [occasion, firstNoteLine].filter(Boolean).join(' · ')
    : '';
  // Desktop hover bonus (the ticket asked for a tooltip): full text on title.
  const noteTitle = notePreview
    ? [occasion, (bottle.notes || '').trim()].filter(Boolean).join('\n\n')
    : undefined;

  if (viewMode === 'card') {
    return (
      <div
        className={`bottle-grid-card${isGroup ? ' bottle-grid-card--stacked' : ''}`}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={handleKey}
        title={isGroup ? t('bottleCard.groupTooltip', { count: groupCount }) : undefined}
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
              <span className="pending-wine-badge">{t('bottleCard.pendingReview')}</span>
            )}
            {bottle.openedAt && bottle.status === 'active' && (
              <span className={`open-bottle-badge open-bottle-badge--${freshnessStatus(bottle) || 'ok'}`}>
                🍷 {t('bottleCard.openBadge', '{{glasses}} gl · {{days}}d', {
                  glasses: glassesLeft(bottle),
                  days: Math.max(0, daysLeft(bottle) ?? 0),
                })}
              </span>
            )}
            {reserved && (
              <span className="reserved-badge" title={reservationSummary(bottle, t)}>
                <span aria-hidden="true">🔖</span> {bottle.reservedUntil != null
                  ? t('bottleCard.reservedUntil', { year: bottle.reservedUntil })
                  : t('bottleCard.reserved')}
              </span>
            )}
            {maturityInfo && (
              <span
                className={`maturity-badge ${maturityInfo.cls}`}
                title={hasPersonalWindow ? t('bottleCard.yourWindowTooltip') : undefined}
              >{t(maturityInfo.key)}</span>
            )}
            {maturityInfo && hasPersonalWindow && (
              <span className="maturity-badge maturity-badge--personal" title={t('bottleCard.yourWindowTooltip')}>
                {t('bottleCard.yourWindow')}
              </span>
            )}
            {!maturityInfo && bottle.maturityStatus === null && bottle.hasOwnProperty('maturityStatus') && (
              <span className="maturity-badge maturity-badge--none">{t('maturity.noData')}</span>
            )}
            {isUnplaced && (
              <span className="unplaced-badge" title={t('bottleCard.unplacedTooltip', 'Added but not placed in a rack')}>
                {t('bottleCard.unplaced', 'Unplaced')}
              </span>
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
      className={`bottle-card${isGroup ? ' bottle-card--stacked' : ''}${compact ? ' bottle-card--compact' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={handleKey}
      title={isGroup ? t('bottleCard.groupTooltip', { count: groupCount }) : undefined}
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
        {notePreview && (
          <div className="bottle-note-preview" title={noteTitle}>{notePreview}</div>
        )}
        <div className="bottle-badges">
          {cellarBadge && (
            <span className="cellar-badge" style={cellarBadgeColor ? { '--cellar-badge-color': cellarBadgeColor } : undefined}>
              <span className="cellar-badge-dot" aria-hidden="true" /> {cellarBadge}
            </span>
          )}
          {isPending && (
            <span className="pending-wine-badge">{t('bottleCard.pendingReview')}</span>
          )}
          {reserved && (
            <span className="reserved-badge" title={reservationSummary(bottle, t)}>
              <span aria-hidden="true">🔖</span> {bottle.reservedUntil != null
                ? t('bottleCard.reservedUntil', { year: bottle.reservedUntil })
                : t('bottleCard.reserved')}
            </span>
          )}
          {maturityInfo && (
            <span
              className={`maturity-badge ${maturityInfo.cls}`}
              title={hasPersonalWindow ? t('bottleCard.yourWindowTooltip') : undefined}
            >{t(maturityInfo.key)}</span>
          )}
          {maturityInfo && hasPersonalWindow && (
            <span className="maturity-badge maturity-badge--personal" title={t('bottleCard.yourWindowTooltip')}>
              {t('bottleCard.yourWindow')}
            </span>
          )}
          {!maturityInfo && bottle.maturityStatus === null && bottle.hasOwnProperty('maturityStatus') && (
            <span className="maturity-badge maturity-badge--none">{t('maturity.noData')}</span>
          )}
          {isUnplaced && (
            <span className="unplaced-badge" title={t('bottleCard.unplacedTooltip', 'Added but not placed in a rack')}>
              {t('bottleCard.unplaced', 'Unplaced')}
            </span>
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
const COMPARED_PROPS = ['bottle', 'rackMap', 'cellarId', 'viewMode', 'groupCount', 'showCellarBadge', 'compact', 'rackKnown', 'showNotes'];
export default memo(BottleCard, (prev, next) =>
  COMPARED_PROPS.every(key => prev[key] === next[key])
);
