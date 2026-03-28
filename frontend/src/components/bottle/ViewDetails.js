import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth, usePlan } from '../../contexts/AuthContext';
import { getMaturityStatus } from '../../utils/drinkStatus';
import { convertAmountHistorical } from '../../utils/currency';
import { buildRackUrl } from '../../utils/rackNavigation';
import safeUrl from '../../utils/safeUrl';
import RatingDisplay from '../RatingDisplay';
import ContributePrompt from './ContributePrompt';
import MaturityPhaseTable from './MaturityPhaseTable';
import PriceHistoryTimeline from './PriceHistoryTimeline';

function ViewDetails({ bottle, rackInfo, cellarId, vintageProfile, priceHistory, rates, userCurrency, canEdit, hasImage, onEdit, onSuggestGrapes, onRemove, onReportWine }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { plan, hasFeature } = usePlan();
  const hasAgingMaturity = hasFeature('agingMaturity');
  const hasPriceEvolution = hasFeature('priceEvolution');
  const maturityStatus = getMaturityStatus(vintageProfile);
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
            <span className="bd-detail-value">{bottle.bottleSize}</span>
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
      </div>

      {/* Missing photo contribution prompt */}
      {!hasImage && canEdit && (
        <ContributePrompt
          storageKey={`cellarion_contrib_photo_${wine?._id}`}
          icon="\u{1F4F7}"
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
              <span key={g._id} className="bd-grape-pill">{g.name}</span>
            ))}
          </div>
        ) : canEdit ? (
          <ContributePrompt
            storageKey={`cellarion_contrib_grapes_${wine?._id}`}
            icon="\u{1F347}"
            title={t('bottleDetail.contributeGrapesTitle', 'Help the community')}
            message={t('bottleDetail.contributeGrapesMsg', 'Grape varieties aren\'t listed for this wine yet. Suggest them and our team will review.')}
            actionLabel={t('bottleDetail.contributeGrapesAction', 'Suggest grapes')}
            onAction={onSuggestGrapes}
          />
        ) : (
          <span className="bd-missing-hint">{t('bottleDetail.noGrapes', 'No grape varieties listed')}</span>
        )}
      </div>

      {/* Sommelier maturity section — premium feature, not shown for NV */}
      {bottle.vintage && bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.sommMaturity')}</span>
          {hasAgingMaturity ? (
            !vintageProfile ? (
              <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>
            ) : vintageProfile.status === 'pending' ? (
              <div className="bd-maturity-pending">
                <span className="maturity-badge maturity-badge--pending">{t('bottleDetail.awaitingSommelier')}</span>
                <span className="bd-maturity-note">
                  {t('bottleDetail.sommelierWillSet')}
                </span>
              </div>
            ) : (
              <div className="bd-maturity-reviewed">
                {maturityStatus && (
                  <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>
                    {maturityStatus.label}
                  </span>
                )}
                <MaturityPhaseTable profile={vintageProfile} />
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
            )
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon" aria-hidden="true">{'\u{1F512}'}</span>
              <div>
                <strong>{t('bottleDetail.premiumFeature')}</strong>
                <p>{t('bottleDetail.agingMaturityPremiumDesc')}</p>
              </div>
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

      {/* Price Evolution — premium feature, not shown for NV */}
      {bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.priceEvolution')}</span>
          {hasPriceEvolution ? (
            <PriceHistoryTimeline history={priceHistory} rates={rates} userCurrency={userCurrency} />
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon" aria-hidden="true">{'\u{1F512}'}</span>
              <div>
                <strong>{t('bottleDetail.premiumFeature')}</strong>
                <p>{t('bottleDetail.premiumFeatureDesc')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {bottle.wineDefinition && (
        <div className="bd-report-wine">
          <button className="btn-report-wine" onClick={onReportWine}>
            Report an issue with this wine
          </button>
        </div>
      )}
    </div>
  );
}

export default ViewDetails;
