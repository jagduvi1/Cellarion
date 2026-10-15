// iOS (every iOS browser is WebKit) zooms the page in when a field whose text
// is under 16 px gets focus, and leaves it zoomed after — the add-bottle form,
// the filters and most pop-ups have such fields, so the page jumps sideways
// under the person's thumb. With maximum-scale=1 in the viewport iOS no longer
// zooms on focus, and still lets people pinch-zoom: it has ignored
// maximum-scale for that since iOS 10. Android honours maximum-scale and would
// lose pinch-zoom (an accessibility loss), so this is for iOS only. The fields
// keep their size: the layout does not change.

/** iPhone, iPod, or an iPad (iPadOS 13+ says "Macintosh", but a Mac has no touch). */
export function isIOS(nav = typeof navigator !== 'undefined' ? navigator : null) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

/** Add maximum-scale=1 to the viewport on iOS. True when it was added. */
export function stopIOSFocusZoom(doc = typeof document !== 'undefined' ? document : null, nav = undefined) {
  if (!doc || !isIOS(nav)) return false;
  const meta = doc.querySelector('meta[name="viewport"]');
  if (!meta) return false;
  const content = meta.getAttribute('content') || '';
  if (/maximum-scale/i.test(content)) return false;
  meta.setAttribute('content', content ? `${content}, maximum-scale=1` : 'maximum-scale=1');
  return true;
}
