const { pickReplacement } = require('./valuation');

describe('pickReplacement priority', () => {
  const secondary = { amount: 720, currency: 'SEK' };
  const currentRelease = { amount: 899, currency: 'SEK' };
  const paid = { amount: 550, currency: 'SEK' };

  test('secondary wins over everything', () => {
    expect(pickReplacement({ secondary, currentRelease, paid }))
      .toEqual({ amount: 720, currency: 'SEK', source: 'secondary' });
  });

  test('currentRelease wins when no secondary', () => {
    expect(pickReplacement({ secondary: null, currentRelease, paid }))
      .toEqual({ amount: 899, currency: 'SEK', source: 'currentRelease' });
  });

  test('falls back to paid', () => {
    expect(pickReplacement({ secondary: null, currentRelease: null, paid }))
      .toEqual({ amount: 550, currency: 'SEK', source: 'paid' });
  });

  test('null when nothing usable', () => {
    expect(pickReplacement({ secondary: null, currentRelease: null, paid: null })).toBeNull();
  });

  test('ignores non-positive amounts and continues down the chain', () => {
    expect(pickReplacement({ secondary: { amount: 0, currency: 'SEK' }, currentRelease, paid }))
      .toEqual({ amount: 899, currency: 'SEK', source: 'currentRelease' });
  });
});
