import { render, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';

// A build with one unfinished language: it must be offered inside the app but
// never advertised to crawlers.
vi.mock('virtual:locale-coverage', () => ({
  BETA_BELOW: 0.9,
  LIST_ABOVE: 0.1,
  LOCALES: [
    { code: 'en', translated: 100, total: 100, ratio: 1, beta: false },
    { code: 'sv', translated: 99, total: 100, ratio: 0.99, beta: false },
    { code: 'fr', translated: 62, total: 100, ratio: 0.62, beta: true },
  ],
  LOCALE_CODES: ['en', 'fr', 'sv'],
  SHIPPED_CODES: ['en', 'sv'],
}));

const { default: SEOHead, serializeJsonLd } = await import('./SEOHead');

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

describe('hreflang alternates', () => {
  const renderHead = (props) =>
    render(
      <HelmetProvider>
        <SEOHead title="Cellarion" description="d" path="/help" {...props} />
      </HelmetProvider>
    );

  const alternates = () =>
    [...document.head.querySelectorAll('link[rel="alternate"]')].map((l) => l.getAttribute('hreflang'));

  test('declares every finished language, plus x-default', async () => {
    renderHead();
    await waitFor(() => expect(alternates()).toContain('en'));
    expect(alternates()).toContain('sv');
    expect(alternates()).toContain('x-default');
  });

  test('does not advertise an unfinished language to search engines', async () => {
    // Pointing a crawler at a 62 %-translated page is worse than not claiming
    // the language: it wins the impression and then disappoints the reader.
    renderHead();
    await waitFor(() => expect(alternates()).toContain('en'));
    expect(alternates()).not.toContain('fr');
  });

  test('emits nothing when the page opts out of hreflang', async () => {
    renderHead({ hreflang: 'none' });
    await waitFor(() => expect(document.head.querySelector('link[rel="canonical"]')).toBeTruthy());
    expect(alternates()).toEqual([]);
  });
});
