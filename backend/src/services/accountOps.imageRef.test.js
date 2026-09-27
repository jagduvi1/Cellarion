/**
 * services/accountOps validateImageRef: which picture references are accepted.
 *
 * WHY THIS TEST EXISTS:
 * A wine request may carry an inline photo (the request form sends one), but a
 * wine record never stores its picture inline (allowInline: false): from
 * 2026-09-27 the photo becomes a file when the request is approved. Both modes
 * keep refusing what audit 2026-09 F06-1 closed (protocol-relative,
 * javascript:, private hosts).
 */
process.env.FRONTEND_URL = 'https://cellarion.test';

const { validateImageRef } = require('./accountOps');

const INLINE = 'data:image/png;base64,iVBORw0KGgo=';

test('a request may carry an inline photo, a link or one of our uploads', () => {
  expect(validateImageRef(INLINE)).toBeNull();
  expect(validateImageRef('https://cdn.example.com/label.jpg')).toBeNull();
  expect(validateImageRef('/api/uploads/processed/abc.webp')).toBeNull();
  expect(validateImageRef('https://cellarion.test/api/uploads/processed/abc.webp')).toBeNull();
  expect(validateImageRef('')).toBeNull();
  expect(validateImageRef(null)).toBeNull();
});

test('a wine record takes a link or one of our uploads, never an inline image', () => {
  expect(validateImageRef(INLINE, { allowInline: false })).toBe('A wine picture cannot be stored inline; upload it or use a link');
  expect(validateImageRef('https://cdn.example.com/label.jpg', { allowInline: false })).toBeNull();
  expect(validateImageRef('/api/uploads/processed/abc.webp', { allowInline: false })).toBeNull();
  expect(validateImageRef('', { allowInline: false })).toBeNull();
});

test('both refuse what is neither, and say what is accepted', () => {
  expect(validateImageRef('//attacker.example/x.png')).toMatch(/^Image must be an http\(s\) link or an inline image/);
  expect(validateImageRef('javascript:alert(1)', { allowInline: false })).toMatch(/^Image must be an http\(s\) link or an uploaded file/);
  expect(validateImageRef('/api/uploads/../../etc/passwd', { allowInline: false })).toMatch(/^Image must be/);
  expect(validateImageRef(42, { allowInline: false })).toBe('Image must be an http(s) link or an uploaded file');
  expect(validateImageRef('x'.repeat(500001))).toBe('Image reference is too large');
});
