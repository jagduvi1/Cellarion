import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getMaturityStatus, getPersonalWindowStatus } from '../../utils/drinkStatus';
import { isReserved, reservationSummary } from '../../utils/reservation';
import { bottleAnchorYear } from '../../utils/maturityUtils';
import { convertAmountHistorical } from '../../utils/currency';
import { bottleSizeLabel } from '../../config/bottleSizes';
import { buildRackUrl } from '../../utils/rackNavigation';
import safeUrl from '../../utils/safeUrl';
import RatingDisplay from '../RatingDisplay';
import ContributePrompt from './ContributePrompt';
import MaturityPhaseTable from './MaturityPhaseTable';
import PriceHistoryTimeline from './PriceHistoryTimeline';
import PriceTrackingToggle from './PriceTrackingToggle';

function ViewDetails({ bottle, rackInfo, cellarId, vintageProfile, priceHistory, currentRelease, rates, userCurrency, canEdit, hasImage, onEdit, onSuggestGrapes, onRemove, onReportWine }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const anchorYear = bottleAnchorYear(bottle);
  const maturityStatus = getMaturityStatus(vintageProfile, anchorYear);
  // The user's OWN drink window (drinkFrom/drinkTo) — takes precedence over
  // the sommelier profile status when set.
  const personalWindow = getPersonalWindowStatus(bottle);
  const isNv = bottle.vintage === 'NV';
  // An NV window is only meaningful once a somm has saved it in relative mode
  // (offsets from purchase). An old absolute-year NV profile would be stale, so
  // treat it as still awaiting review rather than showing wrong years.
  const maturityReviewed = vintageProfile?.status === 'reviewed' && (!isNv || vintageProfile.relative);
  const [showSommNotes, setShowSommNotes] = useState(false);
  const wine = bottle.wineDefinition;
  const grapes = wine?.grapes || [];

  return (
    <div className="bd-details card">
      <div className="bd-detail-grid">
        <div className="bd-detail-item">
          <span className="bd-detail-label">{t('bottleDetail.vintage')}</span>
          <span className="bd-detail-value">{bottle.vintage}</span>
        </div>
        {bottle.bottleSize && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.size')}</span>
            <span className="bd-detail-value">{bottleSizeLabel(bottle.bottleSize, t)}</span>
          </div>
        )}
        {bottle.rating && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.ratingLabel')}</span>
            <span className="bd-detail-value">
              <RatingDisplay value={bottle.rating} scale={bottle.ratingScale || '5'} preferredScale={user?.preferences?.ratingScale} />
            </span>
          </div>
        )}
        {bottle.price && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.pricePaid')}</span>
            <span className="bd-detail-value">
              {bottle.price} {bottle.currency}
              {(() => {
                const c = convertAmountHistorical(bottle.price, bottle.currency, userCurrency, bottle.priceCurrencyRates, rates);
                return c !== null ? (
                  <span
                    className="bd-detail-converted"
                    title={t('bottleDetail.priceAtEntryTooltip')}
                  > &asymp; {c.toLocaleString()} {userCurrency}</span>
                ) : null;
              })()}
            </span>
          </div>
        )}
        {currentRelease && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.currentRelease', 'Current release')}</span>
            <span className="bd-detail-value">
              {currentRelease.medianPrice.toLocaleString()} {currentRelease.currency}
              {currentRelease.vintage && (
                <span className="bd-detail-converted"> &middot; {currentRelease.vintage}</span>
              )}
              {(() => {
                const c = convertAmountHistorical(currentRelease.medianPrice, currentRelease.currency, userCurrency, null, rates);
                return c !== null ? (
                  <span className="bd-detail-converted"> &asymp; {c.toLocaleString()} {userCurrency}</span>
                ) : null;
              })()}
              {/* The % delta only shows at 'firm' confidence (≥3 owners) — a
                  single owner's price shouldn't shout "+125%" at people. The
                  indicative price itself still displays, with its label. */}
              {bottle.price > 0 && currentRelease.currency === bottle.currency && currentRelease.confidence === 'firm' && (() => {
                const pct = Math.round(((currentRelease.medianPrice - bottle.price) / bottle.price) * 100);
                if (!isFinite(pct) || pct === 0) return null;
                return (
                  <span
                    style={{ color: pct >= 0 ? '#2D7A45' : '#C0504D' }}
                    title={t('bottleDetail.currentReleaseDeltaTooltip', 'Current release vs what you paid')}
                  > {pct >= 0 ? '+' : ''}{pct}%</span>
                );
              })()}
              <span
                className="bd-detail-converted"
                title={t('bottleDetail.currentReleaseTooltip', 'Estimated from what Cellarion users paid for the latest vintage of this wine (standard 750 ml), in this currency. A replacement-price guide, not a secondary-market valuation.')}
              >
                {currentRelease.confidence === 'firm'
                  ? ` · ${currentRelease.sampleSize} ${currentRelease.sampleSize === 1
                      ? t('bottleDetail.buyerOne', 'buyer')
                      : t('bottleDetail.buyerOther', 'buyers')}`
                  : ` · ${t('bottleDetail.indicativePrice', 'indicative')}`}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Missing photo contribution prompt */}
      {!hasImage && canEdit && (
        <ContributePrompt
          storageKey={`cellarion_contrib_photo_${wine?._id}`}
          icon="📷"
          title={t('bottleDetail.contributePhotoTitle', 'Help the community')}
          message={t('bottleDetail.contributePhotoMsg', 'This wine has no photo yet. Adding one helps other collectors recognise it \u2014 it will be reviewed before going public.')}
          actionLabel={t('bottleDetail.contributePhotoAction', 'Add a photo')}
          onAction={onEdit}
        />
      )}

      {/* Grapes */}
      <div className="bd-section">
        <span className="bd-section-label">{t('bottleDetail.grapes', 'Grape Varieties')}</span>
        {grapes.length > 0 ? (
          <div className="bd-grapes">
            {grapes.map(g => (
              // displayName = regionally correct label ("Tinta Roriz" on a
              // Douro Port); name stays the canonical variety.
              <span key={g._id} className="bd-grape-pill">{g.displayName || g.name}</span>
            ))}
          </div>
        ) : canEdit ? (
          <ContributePrompt
            storageKey={`cellarion_contrib_grapes_${wine?._id}`}
            icon="🍇"
            title={t('bottleDetail.contributeGrapesTitle', 'Help the community')}
            message={t('bottleDetail.contributeGrapesMsg', 'Grape varieties aren\'t listed for this wine yet. Suggest them and our team will review.')}
            actionLabel={t('bottleDetail.contributeGrapesAction', 'Suggest grapes')}
            onAction={onSuggestGrapes}
          />
        ) : (
          <span className="bd-missing-hint">{t('bottleDetail.noGrapes', 'No grape varieties listed')}</span>
        )}
      </div>

      {/* Personal drink window — the user's own drinkFrom/drinkTo. Takes
          precedence over the sommelier profile status below, so the profile
          badge is suppressed while this is set. */}
      {personalWindow && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.personalWindow')}</span>
          <div className="bd-personal-window">
            <span className={`maturity-badge maturity-badge--${personalWindow.status}`}>
              {personalWindow.status === 'not-ready'
                ? t('bottleDetail.personalNotReady', { year: personalWindow.from })
                : personalWindow.status === 'declining'
                  ? t('bottleDetail.personalPast')
                  : t('bottleDetail.personalDrinkNow')}
            </span>
            <span className="bd-window-source" title={t('bottleDetail.yourWindowTooltip')}>
              {t('bottleDetail.yourWindow')}
            </span>
            <span className="bd-personal-window-years">
              {personalWindow.from && personalWindow.to
                ? `${personalWindow.from}–${personalWindow.to}`
                : personalWindow.from
                  ? t('bottleDetail.windowFromYear', { year: personalWindow.from })
                  : t('bottleDetail.windowUntilYear', { year: personalWindow.to })}
            </span>
          </div>
        </div>
      )}

      {/* Sommelier maturity section — shown for NV too (somms can set a drink
          window for non-vintage sparkling); only hidden for unknown vintages */}
      {bottle.vintage && bottle.vintage !== 'Unknown' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.sommMaturity')}</span>
          {!vintageProfile ? (
            <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>
          ) : !maturityReviewed ? (
            <div className="bd-maturity-pending">
              <span className="maturity-badge maturity-badge--pending">{t('bottleDetail.awaitingSommelier')}</span>
              <span className="bd-maturity-note">
                {t('bottleDetail.sommelierWillSet')}
              </span>
            </div>
          ) : (
            <div className="bd-maturity-reviewed">
              {/* Profile status badge hidden while a personal window is set —
                  the personal window (above) takes precedence. */}
              {maturityStatus && !personalWindow && (
                <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>
                  {maturityStatus.label}
                </span>
              )}
              <MaturityPhaseTable profile={vintageProfile} anchorYear={anchorYear} />
              {vintageProfile.sommNotes && (
                <div className="bd-somm-notes-toggle">
                  <button
                    className="bd-somm-notes-btn"
                    onClick={() => setShowSommNotes(v => !v)}
                    aria-expanded={showSommNotes}
                  >
                    {t('bottleDetail.sommNotes')}
                    <span className={`bd-somm-notes-chevron${showSommNotes ? ' bd-somm-notes-chevron--open' : ''}`}>&rsaquo;</span>
                  </button>
                  {showSommNotes && (
                    <p className="bd-maturity-notes">{vintageProfile.sommNotes}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Rack location */}
      {rackInfo && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.rackLocation')}</span>
          <Link
            to={buildRackUrl(cellarId, { rackId: rackInfo.rackId, bottleId: bottle._id, inRoom: rackInfo.inRoom, preference: user?.preferences?.rackNavigation || 'auto' })}
            className="bd-rack-link"
          >
            <span aria-hidden="true">{'\u{1F4CD}'}</span> {rackInfo.rackName} &middot; {t('bottleDetail.rackSlot')} {rackInfo.position}
          </Link>
        </div>
      )}

      {/* Notes */}
      {bottle.notes && (
        <div className="bd-section">
          <span className="bd-section-label">{t('common.notes')}</span>
          <p className="bd-notes">{bottle.notes}</p>
        </div>
      )}

      {/* Occasion — personal purpose note, distinct from tasting notes */}
      {bottle.occasion && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.occasion')}</span>
          <p className="bd-notes"><span aria-hidden="true">{'\u{1F381}'}</span> {bottle.occasion}</p>
        </div>
      )}

      {/* Reservation ("spoken for") — the bottle is being held; it stays out
          of drink suggestions and the consume flow warns before logging it. */}
      {isReserved(bottle) && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.reservationLabel')}</span>
          <div className="bd-reservation">
            <span className="reserved-badge"><span aria-hidden="true">🔖</span> {reservationSummary(bottle, t)}</span>
            <span className="bd-reservation-hint">{t('bottleDetail.reservationHint')}</span>
          </div>
        </div>
      )}

      {/* Purchase info */}
      {(bottle.purchaseDate || bottle.purchaseLocation || bottle.purchaseUrl) && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.purchase')}</span>
          <div className="bd-purchase">
            {bottle.purchaseDate && (
              <span>{new Date(bottle.purchaseDate).toLocaleDateString()}</span>
            )}
            {bottle.purchaseLocation && <span>{bottle.purchaseLocation}</span>}
            {safeUrl(bottle.purchaseUrl) && (
              <a href={safeUrl(bottle.purchaseUrl)} target="_blank" rel="noreferrer" className="bd-purchase-link">
                <span aria-hidden="true">{'\u{1F517}'}</span> Link
              </a>
            )}
          </div>
        </div>
      )}

      {/* Price Evolution — not shown for NV */}
      {bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.priceEvolution')}</span>
          <PriceHistoryTimeline history={priceHistory} rates={rates} userCurrency={userCurrency} />
          {priceHistory && priceHistory.length > 0 && wine && (
            <button
              className="btn-report-wine sp-report-price"
              onClick={() => onReportWine('wrong_price')}
            >
              {t('bottleDetail.reportPrice')}
            </button>
          )}
          {/* Only offer price tracking while there's no price yet — once a
              sommelier has set one, the request is moot and we hide the button. */}
          {!(priceHistory && priceHistory.length > 0) && (
            <PriceTrackingToggle bottleId={bottle._id} vintage={bottle.vintage} />
          )}
        </div>
      )}

      {bottle.wineDefinition && (
        <div className="bd-report-wine">
          {/* Wrap the handler — passing it directly would hand the click
              event to the `reason` parameter and break the report form */}
          <button className="btn-report-wine" onClick={() => onReportWine()}>
            Report an issue with this wine
          </button>
        </div>
      )}
    </div>
  );
}

export default ViewDetails;
