/**
 * Scrolls an element's top into view just below the sticky top bar, so the
 * heading a link pointed at is never hidden under it. The bar's height varies
 * (the admin menu wraps onto several rows), so it is measured each time.
 *
 * Used where a link opens one part of a long page: a Settings group
 * (/settings#preferences) and a Help section (/help#onOrder).
 */
export default function scrollBelowNavbar(el) {
  if (!el) return;
  const bar = document.querySelector('.navbar');
  const barBottom = bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().bottom : 0;
  if (typeof window.scrollTo === 'function' && barBottom > 0) {
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - barBottom - 12, behavior: 'smooth' });
  } else {
    el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }
}
