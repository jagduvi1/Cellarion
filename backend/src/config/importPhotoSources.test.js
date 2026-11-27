// config/importPhotoSources — the only photo stores an import copies from.
// The import file names the link, so this list is all that stands between a
// file and "fetch whatever this row says".
const { importPhotoSource } = require('./importPhotoSources');

const OK = 'https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/wines%2Fu1%2Fphoto_1?alt=media&token=abc';

test('a Ma Cave à Vins photo link is one', () => {
  expect(importPhotoSource(OK)).toMatchObject({ source: 'macave' });
});

test.each([
  ['another app\'s bucket on the same host', 'https://firebasestorage.googleapis.com/v0/b/other-app.appspot.com/o/x?alt=media'],
  ['another host', 'https://example.com/v0/b/ma-cave-a-vins-app.appspot.com/o/x'],
  ['a look-alike host', 'https://firebasestorage.googleapis.com.example.com/v0/b/ma-cave-a-vins-app.appspot.com/o/x'],
  ['plain http', OK.replace('https:', 'http:')],
  ['another port', OK.replace('googleapis.com/', 'googleapis.com:8443/')],
  ['credentials in the link', OK.replace('https://', 'https://user:pass@')],
  ['a climb out of the prefix', 'https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/../../other-app.appspot.com/o/x'],
  ['an encoded climb out of the prefix', 'https://firebasestorage.googleapis.com/v0/b/ma-cave-a-vins-app.appspot.com/o/%2e%2e/%2e%2e/other-app.appspot.com/o/x'],
  ['an over-long link', `${OK}&pad=${'a'.repeat(2100)}`],
  ['not a link', 'ma-cave-a-vins-app'],
  ['not text', { href: OK }],
])('%s is not', (_, url) => {
  expect(importPhotoSource(url)).toBeNull();
});
