import { useTranslation } from 'react-i18next';
import './CellarCredBadge.css';

const TIER_CONFIG = {
  contributor: { icon: '🌱', cls: 'cred-badge--contributor' },
  enthusiast:  { icon: '🍇', cls: 'cred-badge--enthusiast' },
  connoisseur: { icon: '🏆', cls: 'cred-badge--connoisseur' },
  ambassador:  { icon: '⭐', cls: 'cred-badge--ambassador' },
};

const SPECIALTY_ICONS = {
  curator:      '📋',
  photographer: '📷',
  critic:       '✍️',
  community:    '💬',
  allrounder:   '🔄',
};

/**
 * Subtle contribution badge: tier + optional specialty.
 * Only renders for contributor tier and above.
 *
 * Props: tier, specialty, size ('sm' | 'md'), showSpecialty (default true)
 */
function CellarCredBadge({ tier, specialty, size = 'sm', showSpecialty = true }) {
  const { t } = useTranslation();
  const config = TIER_CONFIG[tier];
  if (!config) return null; // newcomer or unknown → nothing

  const tierLabel = t(`cellarCred.${tier}`);
  const specialtyLabel = specialty && showSpecialty ? t(`cellarCred.${specialty}`) : null;

  return (
    <span className={`cred-badge ${config.cls} cred-badge--${size}`}>
      <span className="cred-badge__icon" aria-hidden="true">{config.icon}</span>
      <span className="cred-badge__tier">{tierLabel}</span>
      {specialtyLabel && (
        <>
          <span className="cred-badge__sep" aria-hidden="true">·</span>
          {SPECIALTY_ICONS[specialty] && (
            <span className="cred-badge__spec-icon" aria-hidden="true">{SPECIALTY_ICONS[specialty]}</span>
          )}
          <span className="cred-badge__specialty">{specialtyLabel}</span>
        </>
      )}
    </span>
  );
}

export default CellarCredBadge;
