/**
 * services/imageOps decodeInlineImage: the bytes of an inline picture.
 *
 * Used where an inline picture becomes a file: approving a wine request with
 * a photo, and scripts/convert-inline-wine-images.js. Anything that is not a
 * complete data:image/…;base64 reference gives null, never a partial buffer.
 */
const { decodeInlineImage } = require('./imageOps');

test('decodes a data:image base64 reference', () => {
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  expect(decodeInlineImage(`data:image/png;base64,${bytes.toString('base64')}`).equals(bytes)).toBe(true);
  expect(decodeInlineImage(`data:image/jpeg;base64,${bytes.toString('base64')}`)).toBeInstanceOf(Buffer);
});

test('anything else is null', () => {
  expect(decodeInlineImage('https://cdn.example.com/x.png')).toBeNull();
  expect(decodeInlineImage('/api/uploads/processed/x.webp')).toBeNull();
  expect(decodeInlineImage('data:image/png;base64,')).toBeNull();
  expect(decodeInlineImage('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
  expect(decodeInlineImage('data:text/html;base64,PGI+')).toBeNull();
  expect(decodeInlineImage('data:image/png;base64,abc def')).toBeNull();
  expect(decodeInlineImage(null)).toBeNull();
  expect(decodeInlineImage(undefined)).toBeNull();
});
