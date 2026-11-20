import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MATURITY_PHASES, REGRET_LEVEL_COLORS, regretLevel, filteredBottlesUrl } from './chartHelpers';
import './CellarMaturityTable.css';

/**
 * Most in need first: most declining bottles, then most late. Ties keep the
 * payload's order, which is most bottles first.
 */
export function byNeed(a, b) {
  return (b.maturity.declining - a.maturity.declining) || (b.maturity.late - a.maturity.late);
}

/**
 * Maturity Status per cellar, side by side, so a cellar left alone with
 * bottles past their best stands out without opening each one. It renders its
 * own full-width card, and nothing below two cellars with bottles: with one,
 * the Maturity Status chart already says it all.
 *
 * A count opens that cellar's bottles in that phase through the cellar page's
 * ?maturity= filter, which classifies bottles as these counts do.
 */
function CellarMaturityTable({ cellars }) {
  const { t } = useTranslation();
  const titleId = useId();
  // A copy, sorted: the page hands the same array to its other cards.
  const rows = (cellars || []).filter(c => c.maturity).sort(byNeed);
  if (rows.length < 2) return null;

  return (
    <div className="stats-card stats-card--full">
      <h2 className="stats-card-title" id={titleId}>
        {t('statistics.sections.maturityByCellar')}
        <span className="stats-card-title-note">{t('statistics.sections.mostInNeedFirst')}</span>
      </h2>
      {/* A named, focusable region: at phone width the table scrolls sideways
          in here, and a keyboard must be able to scroll it too. */}
      <div className="cellar-maturity-scroll" role="region" tabIndex={0} aria-labelledby={titleId}>
        <table className="cellar-maturity-table" aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">{t('statistics.maturityByCellar.cellar')}</th>
              {MATURITY_PHASES.map(p => (
                <th key={p.key} scope="col">
                  <span className="drink-legend-dot" style={{ background: p.color }} />
                  {t(`statistics.maturityPhases.${p.key}`)}
                </th>
              ))}
              <th scope="col">{t('statistics.sections.regretIndex')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={c.id || i}>
                <th scope="row">
                  {c.id
                    ? <Link to={`/cellars/${c.id}`} className="cellar-breakdown-name--link">{c.name}</Link>
                    : c.name}
                </th>
                {MATURITY_PHASES.map(p => {
                  const count = c.maturity[p.key] || 0;
                  if (count === 0 || !c.id) {
                    return <td key={p.key} className={count === 0 ? 'cellar-maturity-zero' : undefined}>{count}</td>;
                  }
                  return (
                    <td key={p.key}>
                      <Link
                        to={filteredBottlesUrl({ maturity: p.filter }, { cellarId: c.id })}
                        className="cellar-maturity-count--link"
                        aria-label={t('statistics.maturityByCellar.countLink', {
                          count, phase: t(`statistics.maturityPhases.${p.key}`), cellar: c.name,
                        })}
                      >
                        {count}
                      </Link>
                    </td>
                  );
                })}
                <td className={c.regretIndex > 0 ? undefined : 'cellar-maturity-zero'}>
                  {c.regretIndex > 0 && (
                    <span className="drink-legend-dot" style={{ background: REGRET_LEVEL_COLORS[regretLevel(c.regretIndex)] }} />
                  )}
                  {c.regretIndex ?? 0}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default CellarMaturityTable;
