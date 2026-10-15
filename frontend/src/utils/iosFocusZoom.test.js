import { isIOS, stopIOSFocusZoom } from './iosFocusZoom';

// iOS zooms the page in on a focused field with text under 16 px and leaves
// it zoomed; maximum-scale=1 stops that there (pinch-zoom still works on iOS).
// Android would lose pinch-zoom, so nothing changes off iOS.

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 };
const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 0 };
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
  expect(stopIOSFocusZoom(ios, IPHONE)).toBe(true);
  expect(viewport(ios)).toBe(`${base}, maximum-scale=1`);
  expect(stopIOSFocusZoom(ios, IPHONE)).toBe(false);
  expect(viewport(ios)).toBe(`${base}, maximum-scale=1`);

  const android = docWith(base);
  expect(stopIOSFocusZoom(android, ANDROID)).toBe(false);
  expect(viewport(android)).toBe(base);
});
