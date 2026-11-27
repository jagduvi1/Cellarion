import { useTranslation } from 'react-i18next';
import { MAX_IMPORT_ROWS } from './importConstants';
import { useContributionReviewed } from '../../utils/contributionReview';

// Non-blocking parse warnings (shown on both upload and review steps).
// The CT truncation warning gets elevated styling + a bold headline: a
// 25-row page export silently missing 90% of a cellar is the single worst
// "looked like it worked" outcome an import can have.
// A notice may carry a choice: a Ma Cave à Vins file's photo notice is the
// owner's "bring in the photos" box, kept on the notice itself and read by
// utils/importPayload applyImportPhotoChoice. It says where the photos go, as
// every photo upload does, in this server's words (reviewed or not). A
// resumed draft has no photo links (they never leave the browser that read
// the file), so its notice says the photos need the file again
// (utils/importMaCave resumedImportWarnings).
export default function ImportParseWarnings({ importWarnings, parsedItems, setImportWarnings }) {
  const { t } = useTranslation();
  const reviewed = useContributionReviewed();
  return (importWarnings.length > 0 || parsedItems.length > MAX_IMPORT_ROWS) && (
    <div className="import-parse-warnings">
      {parsedItems.length > MAX_IMPORT_ROWS && (
        <div className="import-parse-warning-banner import-parse-warning-strong" role="alert">
          <strong>{t('importBottles.warnings.tooManyRowsTitle', { count: parsedItems.length })}</strong>{' '}
          {t('importBottles.warnings.tooManyRows', { max: MAX_IMPORT_ROWS })}
        </div>
      )}
      {importWarnings.map((w, i) => (
        <div
          key={i}
          className={`import-parse-warning-banner${w.code === 'ct-truncated' ? ' import-parse-warning-strong' : ''}`}
          role={w.code === 'ct-truncated' ? 'alert' : undefined}
        >
          {w.code === 'ct-truncated' && (
            <>
              <strong>{t('importBottles.warnings.ctTruncatedTitle')}</strong>{' '}
              {t('importBottles.warnings.ctTruncated')}
            </>
          )}
          {w.code === 'ct-pending-skipped' && t('importBottles.warnings.ctPendingSkipped', {
            count: w.count,
            wines: (w.wines || []).join(', ')
          })}
          {w.code === 'ct-pending-on-order' && t('importBottles.warnings.ctPendingOnOrder', {
            count: w.count,
            wines: (w.wines || []).join(', ')
          })}
          {w.code === 'no-identity-skipped' && t('importBottles.warnings.noIdentitySkipped', { count: w.count })}
          {w.code === 'vintage-missing' && t('importBottles.warnings.vintageMissing', { count: w.count })}
          {w.code === 'price-not-read' && t('importBottles.warnings.priceNotRead', { column: w.column })}
          {w.code === 'extra-files-ignored' && t('importBottles.warnings.extraFilesIgnored', { count: w.count })}
          {w.code === 'ploc-placed' && t('importBottles.warnings.plocPlaced', { count: w.count, racks: w.racks })}
          {w.code === 'ploc-history' && t('importBottles.warnings.plocHistory', { count: w.count })}
          {w.code === 'ploc-no-cellars' && t('importBottles.warnings.plocNoCellars')}
          {w.code === 'ploc-no-history' && t('importBottles.warnings.plocNoHistory')}
          {w.code === 'ploc-rating-scale' && t('importBottles.warnings.plocRatingScale', { scale: w.scale })}
          {w.code === 'ploc-date-order-assumed' && t('importBottles.warnings.plocDateOrder')}
          {w.code === 'ploc-extra-slots' && t('importBottles.warnings.plocExtraSlots', { wine: w.wine, slots: w.slots, stock: w.stock })}
          {w.code === 'ploc-rack-too-big' && t('importBottles.warnings.plocRackTooBig', { rack: w.rack, rows: w.rows, cols: w.cols })}
          {w.code === 'ploc-unmatched-history' && t('importBottles.warnings.plocUnmatchedHistory', { count: w.count })}
          {w.code === 'macave-consumed-not-imported' && t('importBottles.warnings.maCaveConsumedNotImported', { n: w.count, column: w.column })}
          {w.code === 'macave-none-left' && t('importBottles.warnings.maCaveNoneLeft', { n: w.count })}
          {w.code === 'macave-photos-need-file' && t('importBottles.warnings.maCavePhotosNeedFile', { n: w.count })}
          {w.code === 'macave-photos' && (
            <>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={w.include === true}
                  disabled={!setImportWarnings}
                  onChange={(e) => {
                    const include = e.target.checked;
                    setImportWarnings((ws) => ws.map((x) => (x.code === 'macave-photos' ? { ...x, include } : x)));
                  }}
                />
                <span>{t('importBottles.warnings.maCavePhotos', { n: w.count })}</span>
              </label>
              <p className="rack-options-hint">
                {reviewed
                  ? t('bottleDetail.imageNotice', 'Images are reviewed by an admin before being added to the shared wine registry, where they will be visible to all Cellarion users.')
                  : t('bottleDetail.imageNoticeUnreviewed', 'Photos are added to the wine registry as soon as you upload them, where everyone on this server can see them.')}
              </p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
