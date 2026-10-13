import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './CollapsibleBlock.css';

/**
 * The fold button of a block: a chevron that says what it shows or hides.
 */
export function CollapseToggle({ collapsed, onToggle, label, controls }) {
  const { t } = useTranslation();
  const text = collapsed
    ? t('collapse.show', 'Show {{name}}', { name: label })
    : t('collapse.hide', 'Hide {{name}}', { name: label });
  return (
    <button
      type="button"
      className={`cblock-toggle${collapsed ? ' cblock-toggle--collapsed' : ''}`}
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={text}
      title={text}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/**
 * A card that folds down to its title row (the wine and vintage page, beta
 * feedback 2026-10-12). Wraps an existing card component untouched: the
 * button sits in the card's top-right corner and, folded, everything but the
 * card's first row (its title) is hidden — hidden, not unmounted, so the card
 * keeps what it loaded. `nested`: the card's title row is one level down
 * (the wine record's section inside its card).
 *
 * Many cards render nothing when they have nothing to say; the button only
 * appears once there is a card to fold.
 */
export default function CollapsibleBlock({ id, label, collapsed, onToggle, nested = false, children }) {
  const ref = useRef(null);
  const [hasCard, setHasCard] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => setHasCard(!!el.querySelector(':scope > .card'));
    check();
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, []);
  const domId = `cblock-${id.replace(/\./g, '-')}`;
  return (
    <div
      ref={ref}
      id={domId}
      className={`cblock${collapsed ? ' cblock--collapsed' : ''}${nested ? ' cblock--nested' : ''}`}
      data-block={id}
    >
      {hasCard && <CollapseToggle collapsed={collapsed} onToggle={onToggle} label={label} controls={domId} />}
      {children}
    </div>
  );
}
