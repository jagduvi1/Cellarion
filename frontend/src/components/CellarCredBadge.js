import { useState } from 'react';
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

// Supporter-tier chips (2026-08-27, Johan): one per paid plan, thanking the
// people who fund development. Icons escalate as a celebration, never as a
// rank — the /supporter page renders all tiers as equals and so do we.
const PLAN_CONFIG = {
  supporter:  { icon: '❤️', cls: 'cred-badge--plan-supporter' },
  patron:     { icon: '🥂', cls: 'cred-badge--plan-patron' },
  benefactor: { icon: '🍾', cls: 'cred-badge--plan-benefactor' },
};

/**
 * One compact chip: icon-only at rest, the text label revealed on hover,
 * keyboard focus, or tap (mobile has no hover — the tap toggle is the whole
 * reason this is a button). The full text always rides aria-label, so the
 * collapsed state loses nothing for screen readers.
 */
function Chip({ cls, size, icons, label }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`cred-badge ${cls} cred-badge--${size}${open ? ' is-open' : ''}`}
      aria-label={label}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onBlur={() => setOpen(false)}
    >
      {icons.map((icon, i) => (
        <span key={i} className="cred-badge__icon" aria-hidden="true">{icon}</span>
      ))}
      <span className="cred-badge__label" aria-hidden="true">{label}</span>
    </button>
  );
}

/**
 * Subtle contribution + supporter badges for an author line.
 *
 * Renders up to two chips: the Cellar Cred tier (contributor and above, with
 * optional specialty) and the supporter plan (any paid tier). Both are
 * icon-only until pressed or hovered — the labels were crowding the
 * community cards (Johan, 2026-08-27).
 *
 * Props: tier, specialty, plan, size ('sm' | 'md'), showSpecialty (default true)
 */
function CellarCredBadge({ tier, specialty, plan, size = 'sm', showSpecialty = true }) {
  const { t } = useTranslation();
  const cred = TIER_CONFIG[tier];       // newcomer or unknown → no cred chip
  const paid = PLAN_CONFIG[plan];       // free or unknown → no supporter chip
  if (!cred && !paid) return null;

  let credLabel = null;
  let credIcons = [];
  if (cred) {
    const tierLabel = t(`cellarCred.${tier}`);
    const specialtyLabel = specialty && showSpecialty ? t(`cellarCred.${specialty}`) : null;
    credLabel = specialtyLabel ? `${tierLabel} · ${specialtyLabel}` : tierLabel;
    credIcons = [cred.icon];
    if (specialtyLabel && SPECIALTY_ICONS[specialty]) credIcons.push(SPECIALTY_ICONS[specialty]);
  }

  return (
    <span className="cred-badges">
      {cred && <Chip cls={cred.cls} size={size} icons={credIcons} label={credLabel} />}
      {paid && (
        <Chip
          cls={paid.cls}
          size={size}
          icons={[paid.icon]}
          label={t(`cellarCred.plan_${plan}`)}
        />
      )}
    </span>
  );
}

export default CellarCredBadge;
