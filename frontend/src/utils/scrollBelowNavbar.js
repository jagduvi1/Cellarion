/**
 * Scrolls an element's top into view just below the sticky top bar, so the
 * heading a link pointed at is never hidden under it. The bar's height varies
 * (the admin menu wraps onto several rows), so it is measured each time. The
 * scroll is instant for a reader whose system asks for reduced motion.
 *
 * Used where a link opens one part of a long page: a Settings group
 * (/settings#preferences), a Help section (/help#onOrder) and the Statistics
 * Maturity Status card (from the health card's phase counts).
 */
export default function scrollBelowNavbar(el) {
  if (!el) return;
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true;
  const behavior = reduceMotion ? 'auto' : 'smooth';
  const bar = document.querySelector('.navbar');
  const barBottom = bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().bottom : 0;
  if (typeof window.scrollTo === 'function' && barBottom > 0) {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - barBottom - 12, behavior });
  } else {
    el.scrollIntoView?.({ block: 'start', behavior });
  }
}
