import { WINE_TYPES } from '../../config/wineTypes';
import { isStyleType, colourLabel, WINE_COLOURS } from '../../utils/wineColour';

/**
 * The form for typing a wine in: after a scan the member says is not the
 * right wine, from the AI suggestion, or with no scan at all. The page owns
 * the wine being typed (pendingWineData) and what confirming it does.
 */
export default function ManualWineForm({
  showManualForm, pendingWineData, labelImage, t, setPendingWineData, handleConfirmManualWine,
  findingWine, handleScanReset,
}) {
  return (
    <>
      {showManualForm && pendingWineData && (
        <div className="scan-result-panel">
          {labelImage && (
            <div className="scan-manual-image-wrap">
              <img src={labelImage} alt="" className="scan-manual-label-img" />
            </div>
          )}
          <div className="grid-2">
            <div className="form-group">
              <label>{t('addBottle.scanWineName')} *</label>
              <input type="text" value={pendingWineData.name}
                onChange={e => setPendingWineData(p => ({ ...p, name: e.target.value }))} required />
            </div>
            <div className="form-group">
              {/* No `*` and no `required`: an unreadable producer must not
                  block the add. The bottle saves; the wine goes to the
                  sommelier queue and comes back completed. */}
              <label>{t('addBottle.scanProducer')}</label>
              <input type="text" value={pendingWineData.producer}
                placeholder={t('addBottle.scanProducerOptionalPlaceholder')}
                onChange={e => setPendingWineData(p => ({ ...p, producer: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>{t('addBottle.scanCountry')} *</label>
              <input type="text" value={pendingWineData.country}
                onChange={e => setPendingWineData(p => ({ ...p, country: e.target.value }))} required />
            </div>
            <div className="form-group">
              <label>{t('addBottle.scanRegion')}</label>
              <input type="text" value={pendingWineData.region}
                onChange={e => setPendingWineData(p => ({ ...p, region: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>{t('addBottle.scanAppellation')}</label>
              <input type="text" value={pendingWineData.appellation}
                onChange={e => setPendingWineData(p => ({ ...p, appellation: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>{t('addBottle.scanType')}</label>
              <select value={pendingWineData.category === 'other' ? 'other' : pendingWineData.type}
                onChange={e => setPendingWineData(p => ({
                  ...p,
                  // "Other" is a category, not a wine type: the drink is
                  // not wine, so it carries no type and never a colour.
                  type: e.target.value === 'other' ? '' : e.target.value,
                  category: e.target.value === 'other' ? 'other' : undefined,
                  // A colour belongs to sparkling/dessert/fortified only.
                  ...(isStyleType(e.target.value) ? {} : { colour: '' }),
                }))}>
                {/* Unknown is a real answer: the scan and the AI return
                    null rather than defaulting to red, so
                    the form must be able to carry that through instead of
                    making the user pick a colour to get past it. */}
                <option value="">{t('common.unknown')}</option>
                {WINE_TYPES.map(wt => <option key={wt} value={wt}>{wt}</option>)}
                <option value="other">{t('addBottle.typeOther', 'Other (not wine)')}</option>
              </select>
              {pendingWineData.category === 'other' && (
                <small className="form-hint">{t('addBottle.typeOtherHint', 'Cider, beer, spirits or anything else that is not wine. It stays in your cellar and never enters the shared wine registry.')}</small>
              )}
            </div>
            {/* Only where the type does not already say the colour. Left
                "not stated", a rosé name ("Brut Rosé") still fills it in. */}
            {isStyleType(pendingWineData.type) && (
              <div className="form-group">
                <label htmlFor="new-wine-colour">{t('wineColour.label', 'Colour')}</label>
                <select id="new-wine-colour" value={pendingWineData.colour || ''}
                  onChange={e => setPendingWineData(p => ({ ...p, colour: e.target.value }))}>
                  <option value="">{t('wineColour.notStated', 'Not stated')}</option>
                  {WINE_COLOURS.map(c => <option key={c} value={c}>{colourLabel(c, t)}</option>)}
                </select>
              </div>
            )}
            <div className="form-group form-group-full">
              <label>{t('addBottle.scanGrapes')}</label>
              <input type="text" value={pendingWineData.grapes}
                onChange={e => setPendingWineData(p => ({ ...p, grapes: e.target.value }))}
                placeholder={t('addBottle.scanGrapesPlaceholder')} />
            </div>
          </div>
          <div className="scan-result-actions">
            <button type="button" className="btn btn-success" onClick={handleConfirmManualWine} disabled={findingWine}>
              {findingWine ? t('addBottle.scanSaving') : t('addBottle.scanConfirmWine')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleScanReset}>
              {t('addBottle.scanSearchManually')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
