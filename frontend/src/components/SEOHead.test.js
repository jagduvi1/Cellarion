import { serializeJsonLd } from './SEOHead';

describe('serializeJsonLd', () => {
  test('neutralizes </script> breakout characters while parsing back to identical data', () => {
    const jsonLd = {
      name: 'x</script><img src=https://evil.tld/b>',
      description: 'Cabernet & friends <3',
    };
    const out = serializeJsonLd(jsonLd);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    expect(JSON.parse(out)).toEqual(jsonLd);
  });

  test('plain JSON-LD round-trips unchanged', () => {
    const jsonLd = { '@context': 'https://schema.org', '@type': 'Product', name: 'Barolo' };
    expect(JSON.parse(serializeJsonLd(jsonLd))).toEqual(jsonLd);
  });
});
