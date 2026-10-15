// iOS (every iOS browser is WebKit) zooms the page in when a field whose text
// is under 16 px gets focus, and leaves it zoomed after — the add-bottle form,
// the filters and most pop-ups have such fields, so the page jumps sideways
// under the person's thumb. With maximum-scale=1 in the viewport Safari no
// longer zooms on focus, and still lets people pinch-zoom: it has ignored
// maximum-scale for that since iOS 10. Other iOS browsers and in-app browsers
// (Chrome, Firefox, a mail or social app's viewer) are web views that may
// honour it and lose pinch-zoom — an accessibility loss — so only Safari and
// the app added to the home screen get it; elsewhere iOS zooms as before.
// Android honours maximum-scale too and is left alone. The fields keep their
// size: the layout does not change.

/** iPhone, iPod, or an iPad (iPadOS 13+ says "Macintosh", but a Mac has no touch). */
export function isIOS(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

// Browsers and app viewers on iOS that are web views, not Safari.
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|Twitter|LinkedInApp|Snapchat|DuckDuckGo/;

/** Safari itself, or this app opened from the home screen. */
export function isSafariOrHomeScreen(nav = typeof navigator !== 'undefined' ? navigator : null, win = typeof window !== 'undefined' ? window : null) {
  if (!nav) return false;
  const standalone = nav.standalone === true || !!win?.matchMedia?.('(display-mode: standalone)').matches;
  if (standalone) return true;
  const ua = nav.userAgent || '';
  return /Safari\//.test(ua) && /Version\//.test(ua) && !NOT_SAFARI.test(ua);
}

/** Add maximum-scale=1 to the viewport on iOS Safari / home screen. True when it was added. */
export function stopIOSFocusZoom(doc = typeof document !== 'undefined' ? document : null, nav = undefined, win = undefined) {
  if (!doc || !isIOS(nav) || !isSafariOrHomeScreen(nav, win)) return false;
  const meta = doc.querySelector('meta[name="viewport"]');
  if (!meta) return false;
  const content = meta.getAttribute('content') || '';
  if (/maximum-scale/i.test(content)) return false;
  meta.setAttribute('content', content ? `${content}, maximum-scale=1` : 'maximum-scale=1');
  return true;
}
