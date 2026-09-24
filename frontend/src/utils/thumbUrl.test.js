import { thumbUrl } from './thumbUrl';

const UUID = '0f3b2a1c-1111-4222-8333-944445555666';

describe('thumbUrl', () => {
  it('maps a processed upload to its thumbnail', () => {
    expect(thumbUrl(`/api/uploads/processed/${UUID}.png`)).toBe(`/api/uploads/thumbs/processed/${UUID}.png.webp`);
  });

  it('keeps an API origin prefix', () => {
    expect(thumbUrl(`https://api.example.com/api/uploads/processed/${UUID}.jpg`))
      .toBe(`https://api.example.com/api/uploads/thumbs/processed/${UUID}.jpg.webp`);
  });

  it.each([
    null,
    undefined,
    '',
    'https://example.com/label.png',
    `/api/uploads/originals/${UUID}.png`,
    '/api/uploads/processed/../x.png',
    '/api/uploads/processed/x.svg',
    'data:image/png;base64,AAAA',
  ])('leaves %s unchanged', (url) => {
    expect(thumbUrl(url)).toBe(url);
  });
});
