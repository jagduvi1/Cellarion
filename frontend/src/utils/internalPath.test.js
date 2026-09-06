import internalPath from './internalPath';

test('keeps in-app paths, with their query and hash', () => {
  expect(internalPath('/cellars/abc')).toBe('/cellars/abc');
  expect(internalPath('/wines/x?tab=prices#top')).toBe('/wines/x?tab=prices#top');
  expect(internalPath('  /discussions/1 ')).toBe('/discussions/1');
});

test('refuses everything that could leave the origin', () => {
  for (const bad of [
    'https://evil.example/x', 'http://evil.example', '//evil.example/x', '/\\evil.example/x',
    '\\\\evil.example', 'javascript:alert(1)', 'cellars/abc', '', null, undefined, 42,
    '/a\x00b', '/ok\\..\\x',
  ]) {
    expect(internalPath(bad)).toBeNull();
  }
});
