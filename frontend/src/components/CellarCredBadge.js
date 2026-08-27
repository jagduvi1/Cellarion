import { useLayoutEffect, useRef, useState } from 'react';
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
 * One compact chip: icon-only at rest, the text label revealed on hover or
 * keyboard focus, and a small popover with the label PLUS a one-line
 * explanation on tap (mobile has no hover — the tap toggle is the whole
 * reason this is a button). Label and explanation both ride aria-label, so
 * the collapsed state loses nothing for screen readers; the popover itself
 * is a decorative duplicate.
 */
function Chip({ cls, size, icons, label, explain }) {
  const [open, setOpen] = useState(false);
  // Viewport clamp for the popover (bug seen live on v1.179.0): the chip
  // often sits at the END of the author row, so a left-anchored popover runs
  // off the right edge of a phone. Measure once per open (shift starts at 0,
  // so the measurement is of the unshifted box) and slide it just enough to
  // stay on screen with an 8px margin. jsdom reports zero-size rects — the
  // width guard keeps tests inert.
  const popRef = useRef(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setShift(0); return; }
    const el = popRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const margin = 8;
    let dx = 0;
    if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
    if (r.left + dx < margin) dx = margin - r.left;
    if (dx !== 0) setShift(dx);
  }, [open]);
  return (
    <button
      type="button"
      className={`cred-badge ${cls} cred-badge--${size}${open ? ' is-open' : ''}`}
      aria-label={explain ? `${label}. ${explain}` : label}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onBlur={() => setOpen(false)}
    >
      {icons.map((icon, i) => (
        <span key={i} className="cred-badge__icon" aria-hidden="true">{icon}</span>
      ))}
      <span className="cred-badge__label" aria-hidden="true">{label}</span>
      {explain && open && (
        <span
          className="cred-badge__pop"
          aria-hidden="true"
          ref={popRef}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
        >
          <span className="cred-badge__pop-title">{label}</span>
          {explain}
        </span>
      )}
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
  let credExplain = null;
  if (cred) {
    const tierLabel = t(`cellarCred.${tier}`);
    const specialtyLabel = specialty && showSpecialty ? t(`cellarCred.${specialty}`) : null;
    credLabel = specialtyLabel ? `${tierLabel} · ${specialtyLabel}` : tierLabel;
    credIcons = [cred.icon];
    if (specialtyLabel && SPECIALTY_ICONS[specialty]) credIcons.push(SPECIALTY_ICONS[specialty]);
    credExplain = t(`cellarCred.explain_${tier}`);
    if (specialtyLabel) credExplain += ` ${t(`cellarCred.explain_${specialty}`)}`;
  }

  return (
    <span className="cred-badges">
      {cred && (
        <Chip cls={cred.cls} size={size} icons={credIcons} label={credLabel} explain={credExplain} />
      )}
      {paid && (
        <Chip
          cls={paid.cls}
          size={size}
          icons={[paid.icon]}
          label={t(`cellarCred.plan_${plan}`)}
          explain={t(`cellarCred.explain_plan_${plan}`)}
        />
      )}
    </span>
  );
}

export default CellarCredBadge;
