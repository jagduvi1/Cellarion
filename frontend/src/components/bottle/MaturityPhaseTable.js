import { useTranslation } from 'react-i18next';
import { getMaturityPhases, isPhaseActive } from '../../utils/maturityUtils';
import { getMaturityStatus } from '../../utils/drinkStatus';

function MaturityPhaseTable({ profile, anchorYear }) {
  const { t } = useTranslation();
  const CURRENT_YEAR = new Date().getFullYear();
  // The row marked as now is the phase the maturity status names, so the
  // table and the status can never disagree (release audit 2026-10-13: an
  // open-ended phase, a phase with only an end year, or a gap between phases
  // marked two rows or none). Before the first phase and past prime, no row
  // is marked. Without a reviewed status, a row is marked by its own years.
  const status = getMaturityStatus(profile, anchorYear, CURRENT_YEAR)?.status;

  const phases = getMaturityPhases(profile, {
    early: t('bottleDetail.maturityPhaseEarly'),
    peak:  t('bottleDetail.maturityPhasePeak'),
    late:  t('bottleDetail.maturityPhaseLate'),
  }, anchorYear);

  if (phases.length === 0) return null;

  return (
    <div className="bd-maturity-table">
      {phases.map(p => {
        const active = status ? p.cls === status : isPhaseActive(p, CURRENT_YEAR);

        const yrsFrom  = p.from  && !isNaN(p.vintageInt) ? p.from  - p.vintageInt : null;
        const yrsUntil = p.until && !isNaN(p.vintageInt) ? p.until - p.vintageInt : null;

        return (
          <div key={p.cls} className={`bd-maturity-row ${active ? 'bd-maturity-row--active' : ''}`}>
            <div className={`bd-maturity-phase-dot bd-maturity-phase-dot--${p.cls}`} />
            <span className="bd-maturity-phase-name">{p.label}</span>
            <span className="bd-maturity-phase-range">
              {p.from && p.until
                ? (p.from === p.until ? `${p.from}` : `${p.from}\u2013${p.until}`)
                : p.from
                  ? t('bottleDetail.maturityPhaseFrom', { year: p.from, defaultValue: 'from {{year}}' })
                  : t('bottleDetail.maturityPhaseUntil', { year: p.until, defaultValue: 'until {{year}}' })}
            </span>
            {(yrsFrom !== null) && (
              <span className="bd-maturity-phase-yrs">
                {yrsUntil === null ? t('bottleDetail.maturityYearsPlus', { count: yrsFrom, defaultValue: '{{count}}+ yrs' })
                  : yrsUntil === yrsFrom ? t('bottleDetail.maturityYears', { count: yrsFrom, defaultValue: '{{count}} yrs' })
                  : t('bottleDetail.maturityYearsRange', { from: yrsFrom, until: yrsUntil, defaultValue: '{{from}}\u2013{{until}} yrs' })}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default MaturityPhaseTable;
