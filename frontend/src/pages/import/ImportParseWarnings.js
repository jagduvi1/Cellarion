import { useTranslation } from 'react-i18next';
import { MAX_IMPORT_ROWS } from './importConstants';

// Non-blocking parse warnings (shown on both upload and review steps).
// The CT truncation warning gets elevated styling + a bold headline: a
// 25-row page export silently missing 90% of a cellar is the single worst
// "looked like it worked" outcome an import can have.
export default function ImportParseWarnings({ importWarnings, parsedItems }) {
  const { t } = useTranslation();
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
        </div>
      ))}
    </div>
  );
}
