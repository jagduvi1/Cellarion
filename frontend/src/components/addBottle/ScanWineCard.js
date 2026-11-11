import WineImage from '../WineImage';
import { swatchType } from '../../utils/wineColour';
import { formatVintage } from '../../utils/vintage';

/**
 * What a label scan found, as one card: the photo beside the registry's
 * picture when the wine is known, the wine as read, and the two answers
 * (this is the wine, or it is not). The page owns the scan and both answers.
 */
export default function ScanWineCard({
  scanResult, showManualForm, scanMatchedWine, labelImage, t, handleConfirmScan, findingWine,
  handleNotRightWine,
}) {
  return (
    <>
      {scanResult && !showManualForm && (
        <div className="scan-wine-card">
          <div className={`scan-wine-image-wrap${scanMatchedWine?.image ? ' scan-wine-image-wrap--compare' : ''}`}>
            <figure className="scan-wine-shot">
              {/* Wrapped so both shots have an identically sized slot: a
                  failed image is hidden by WineImage's onError, and without
                  a fixed box its column would collapse and knock the two
                  captions off one baseline. */}
              <div className="scan-wine-shot-img-wrap">
                {labelImage
                  ? <img src={labelImage} alt={scanResult.extracted.name} className="scan-wine-label-img" />
                  : <div className={`wine-row-placeholder scan-wine-placeholder ${scanResult.extracted.type || 'unknown'}`} />
                }
              </div>
              {scanMatchedWine?.image && (
                <figcaption className="scan-wine-shot-caption">{t('addBottle.scanYourPhoto')}</figcaption>
              )}
            </figure>
            {scanMatchedWine?.image && (
              <figure className="scan-wine-shot">
                <WineImage
                  image={scanMatchedWine.image}
                  alt={scanMatchedWine.name}
                  className="scan-wine-label-img"
                  wrapClass="scan-wine-shot-img-wrap"
                  credit={scanMatchedWine.imageCredit}
                  creditClass="wine-row-credit"
                  wineType={swatchType(scanMatchedWine)}
                  placeholder="wine-row-placeholder scan-wine-placeholder"
                />
                <figcaption className="scan-wine-shot-caption">{t('addBottle.scanRegistryPhoto')}</figcaption>
              </figure>
            )}
          </div>
          <div className="scan-wine-body">
            {/* NAMES the matched row. A bare "Already in the registry"
                beside the scanned name would make a wine about to be filed
                under its neighbour in the same range look perfect. The
                registry-photo compare beside it is the other half of the
                answer, and small estates have no photo, which leaves this
                badge as the only signal there is a match at all. */}
            {scanMatchedWine && (
              <div className="ai-result-badge scan-wine-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 8 0"/><path d="M17 12H7"/></svg>
                {t('addBottle.scanRegistryMatch', {
                  name: scanMatchedWine.name,
                  percent: Math.round((scanResult.match?.confidence || 0) * 100),
                })}
              </div>
            )}
            <h2 className="scan-wine-name">{scanResult.extracted.name}</h2>
            <p className="scan-wine-producer">{scanResult.extracted.producer}</p>
            {scanResult.extracted.confidence != null && (
              <div style={{ marginBottom: '0.5rem' }}>
                <span className="scan-confidence">
                  {Math.round(scanResult.extracted.confidence * 100)}% confident
                </span>
              </div>
            )}
            <div className="wine-meta" style={{ marginBottom: '0.5rem' }}>
              {scanResult.extracted.country && <span>{scanResult.extracted.country}</span>}
              {scanResult.extracted.region && <span>• {scanResult.extracted.region}</span>}
              {scanResult.extracted.appellation && <span>• {scanResult.extracted.appellation}</span>}
              <span className={`wine-type-pill ${scanResult.extracted.type || 'unknown'}`}>
                {scanResult.extracted.type || t('common.unknown')}
              </span>
            </div>
            {scanResult.extracted.grapes?.length > 0 && (
              <p className="wine-grapes">{scanResult.extracted.grapes.join(', ')}</p>
            )}
            {scanResult.extracted.vintage && (
              <p className="scan-vintage-note">
                {t('addBottle.scanVintageDetected', { year: formatVintage(scanResult.extracted.vintage, t) })}
              </p>
            )}
            <div className="scan-wine-actions">
              <button
                type="button"
                className="btn btn-success"
                onClick={handleConfirmScan}
                disabled={findingWine}
              >
                {findingWine ? t('addBottle.scanSaving') : t('addBottle.scanConfirmWine')}
              </button>
              <button type="button" className="btn-not-right" onClick={handleNotRightWine}>
                {t('addBottle.scanNotRight')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
