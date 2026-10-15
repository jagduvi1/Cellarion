import { isIOS, isSafariTab, stopIOSFocusZoom } from './iosFocusZoom';

// iOS zooms the page in on a focused field with text under 16 px and leaves
// it zoomed; maximum-scale=1 stops that. Safari still lets people pinch-zoom
// with it; other iOS browsers, in-app viewers and the home-screen app may not,
// and Android would not — so only Safari itself gets it.

const SAFARI_TAIL = ' (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE = { userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15${SAFARI_TAIL}`, maxTouchPoints: 5 };
const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 0 };
const CHROME_IOS = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 };
const IN_APP = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0', maxTouchPoints: 5 };
const HOME_SCREEN = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', maxTouchPoints: 5, standalone: true };
const noWin = { matchMedia: () => ({ matches: false }) };
const ANDROID = { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile', maxTouchPoints: 5 };

const docWith = (content) => {
  const doc = document.implementation.createHTMLDocument('t');
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'viewport');
  meta.setAttribute('content', content);
  doc.head.appendChild(meta);
  return doc;
};
const viewport = (doc) => doc.querySelector('meta[name="viewport"]').getAttribute('content');

test('iPhones and iPads (which call themselves a Mac) are iOS; a Mac and Android are not', () => {
  expect(isIOS(IPHONE)).toBe(true);
  expect(isIOS(IPAD)).toBe(true);
  expect(isIOS(MAC)).toBe(false);
  expect(isIOS(ANDROID)).toBe(false);
  expect(isIOS(null)).toBe(false);
});

test('on iOS the viewport gains maximum-scale=1, once; elsewhere it is left alone', () => {
  const base = 'width=device-width, initial-scale=1, viewport-fit=cover';
  const ios = docWith(base);
  expect(stopIOSFocusZoom(ios, IPHONE, noWin)).toBe(true);
  expect(viewport(ios)).toBe(`${base}, maximum-scale=1`);
  expect(stopIOSFocusZoom(ios, IPHONE, noWin)).toBe(false);
  expect(viewport(ios)).toBe(`${base}, maximum-scale=1`);

  const android = docWith(base);
  expect(stopIOSFocusZoom(android, ANDROID, noWin)).toBe(false);
  expect(viewport(android)).toBe(base);
});

test('only Safari itself: Chrome on iOS, in-app viewers and the home-screen app keep pinch-zoom', () => {
  expect(isSafariTab(IPHONE, noWin)).toBe(true);
  expect(isSafariTab(CHROME_IOS, noWin)).toBe(false);
  expect(isSafariTab(IN_APP, noWin)).toBe(false);
  expect(isSafariTab(HOME_SCREEN, noWin)).toBe(false);
  // Safari's own user agent, but opened from the home screen.
  expect(isSafariTab(IPHONE, { matchMedia: () => ({ matches: true }) })).toBe(false);
  const base = 'width=device-width, initial-scale=1';
  for (const nav of [CHROME_IOS, IN_APP, HOME_SCREEN]) {
    const doc = docWith(base);
    expect(stopIOSFocusZoom(doc, nav, noWin)).toBe(false);
    expect(viewport(doc)).toBe(base);
  }
});
