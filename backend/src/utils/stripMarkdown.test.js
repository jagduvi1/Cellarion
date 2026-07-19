const { stripMarkdown } = require('./stripMarkdown');

describe('stripMarkdown', () => {
  test('falsy input returns an empty string', () => {
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown(undefined)).toBe('');
    expect(stripMarkdown('')).toBe('');
  });

  // The exact leak from #788 (Matua Pinot Noir, enriched by claude-sonnet-5).
  test('unwraps the bold emphasis the enrichment model emits', () => {
    expect(stripMarkdown('an everyday **cherry**-driven pinot rather than a serious cellaring wine.'))
      .toBe('an everyday cherry-driven pinot rather than a serious cellaring wine.');
  });

  test('handles the rest of the inline syntax prose can pick up', () => {
    expect(stripMarkdown('*Bright* and __lively__, with `zest`.')).toBe('Bright and lively, with zest.');
    expect(stripMarkdown('See [the appellation](https://example.com/x) notes.')).toBe('See the appellation notes.');
    expect(stripMarkdown('![label](https://example.com/a.png)Crisp.')).toBe('Crisp.');
  });

  test('flattens block syntax and collapses the resulting whitespace', () => {
    expect(stripMarkdown('## Tasting\n\n> Elegant.\n\n- cherry\n- plum\n\n1. decant')).
      toBe('Tasting Elegant. cherry plum decant');
  });

  test('is a no-op on already-plain prose, so re-running the cleanup is idempotent', () => {
    const plain = 'A juicy, medium-bodied red with soft tannins. Drink now.';
    expect(stripMarkdown(plain)).toBe(plain);
    expect(stripMarkdown(stripMarkdown(plain))).toBe(plain);
  });

  test('stripping twice equals stripping once for marked-up prose too', () => {
    const once = stripMarkdown('**Bold** and *bright*.');
    expect(stripMarkdown(once)).toBe(once);
  });
});
