import { useTranslation } from 'react-i18next';
import { getMaturityPhases, isPhaseActive } from '../../utils/maturityUtils';

function MaturityPhaseTable({ profile }) {
  const { t } = useTranslation();
  const CURRENT_YEAR = new Date().getFullYear();

  const phases = getMaturityPhases(profile, {
    early: t('bottleDetail.maturityPhaseEarly'),
    peak:  t('bottleDetail.maturityPhasePeak'),
    late:  t('bottleDetail.maturityPhaseLate'),
  });

  if (phases.length === 0) return null;

  return (
    <div className="bd-maturity-table">
      {phases.map(p => {
        const active = isPhaseActive(p, CURRENT_YEAR);

        const yrsFrom  = p.from  && !isNaN(p.vintageInt) ? p.from  - p.vintageInt : null;
        const yrsUntil = p.until && !isNaN(p.vintageInt) ? p.until - p.vintageInt : null;

        return (
          <div key={p.cls} className={`bd-maturity-row ${active ? 'bd-maturity-row--active' : ''}`}>
            <div className={`bd-maturity-phase-dot bd-maturity-phase-dot--${p.cls}`} />
            <span className="bd-maturity-phase-name">{p.label}</span>
            <span className="bd-maturity-phase-range">
              {p.from && p.until ? `${p.from}\u2013${p.until}` : p.from ? `from ${p.from}` : `until ${p.until}`}
            </span>
            {(yrsFrom !== null) && (
              <span className="bd-maturity-phase-yrs">
                {yrsUntil !== null ? `${yrsFrom}\u2013${yrsUntil} yrs` : `${yrsFrom}+ yrs`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default MaturityPhaseTable;
