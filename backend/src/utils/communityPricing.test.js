const {
  median,
  quantileSorted,
  trimOutliersIQR,
  buildReleaseCurve,
} = require('./communityPricing');

describe('median', () => {
  test('odd length', () => expect(median([3, 1, 2])).toBe(2));
  test('even length averages the two middles', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  test('empty → null', () => expect(median([])).toBeNull());
});

describe('quantileSorted', () => {
  test('p25 / p75 of 1..5', () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantileSorted(s, 0.25)).toBe(2);
    expect(quantileSorted(s, 0.75)).toBe(4);
  });
});

describe('trimOutliersIQR', () => {
  test('drops a wild high outlier', () => {
    const out = trimOutliersIQR([100, 105, 110, 95, 102, 5000]);
    expect(out).not.toContain(5000);
  });
  test('arrays shorter than 4 are returned as-is', () => {
    expect(trimOutliersIQR([100, 5000])).toEqual([100, 5000]);
  });
});

describe('buildReleaseCurve', () => {
  test('stable single-owner curve: all indicative, none suspect', () => {
    const curve = buildReleaseCurve([
      { vintage: '2019', ownerPrices: [550] },
      { vintage: '2020', ownerPrices: [565] },
      { vintage: '2021', ownerPrices: [590] },
      { vintage: '2022', ownerPrices: [625] },
    ]);
    expect(curve).toHaveLength(4);
    expect(curve.every((c) => c.confidence === 'indicative')).toBe(true);
    expect(curve.every((c) => c.suspect === false)).toBe(true);
    expect(curve.find((c) => c.vintage === '2022').medianPrice).toBe(625);
  });

  test('a 10× fat-finger vintage is flagged suspect', () => {
    const curve = buildReleaseCurve([
      { vintage: '2019', ownerPrices: [550] },
      { vintage: '2020', ownerPrices: [560] },
      { vintage: '2021', ownerPrices: [5600] }, // decimal typo
      { vintage: '2022', ownerPrices: [600] },
    ]);
    const bad = curve.find((c) => c.vintage === '2021');
    expect(bad.suspect).toBe(true);
    // The good vintages survive.
    expect(curve.filter((c) => !c.suspect).map((c) => c.vintage).sort())
      .toEqual(['2019', '2020', '2022']);
  });

  test('a 1/10th fat-finger (missing digit) is flagged suspect', () => {
    const curve = buildReleaseCurve([
      { vintage: '2019', ownerPrices: [550] },
      { vintage: '2020', ownerPrices: [56] }, // typo: 560 → 56
      { vintage: '2021', ownerPrices: [580] },
    ]);
    expect(curve.find((c) => c.vintage === '2020').suspect).toBe(true);
  });

  test('>= 3 owners → firm, median + IQR trim, p25/p75 set', () => {
    const curve = buildReleaseCurve([
      { vintage: '2022', ownerPrices: [600, 610, 620, 9999] }, // 9999 is an outlier
    ]);
    const c = curve[0];
    expect(c.confidence).toBe('firm');
    expect(c.sampleSize).toBe(4);
    // 9999 trimmed by IQR before the median, so it stays near the cluster.
    expect(c.medianPrice).toBeLessThan(1000);
    expect(c.p25).toBeDefined();
    expect(c.p75).toBeDefined();
  });

  test('single vintage cannot be cross-checked, so never suspect', () => {
    const curve = buildReleaseCurve([{ vintage: '2020', ownerPrices: [999999] }]);
    expect(curve[0].suspect).toBe(false);
  });

  test('genuine ~2× vintage variation is NOT flagged', () => {
    const curve = buildReleaseCurve([
      { vintage: '2018', ownerPrices: [400] }, // poor vintage
      { vintage: '2019', ownerPrices: [800] }, // great vintage
      { vintage: '2020', ownerPrices: [500] },
    ]);
    expect(curve.every((c) => c.suspect === false)).toBe(true);
  });

  test('non-positive prices are ignored', () => {
    const curve = buildReleaseCurve([{ vintage: '2020', ownerPrices: [0, -5, 560] }]);
    expect(curve[0].sampleSize).toBe(1);
    expect(curve[0].medianPrice).toBe(560);
  });

  // Real-world regression (Paolo Scavino Barolo, SEK): users mis-attached an
  // entry-level wine (240) and a cru (2899) to the classico. The pollution
  // itself widens the tolerance band — at 4× both slipped through; the 3×
  // band must catch both while keeping the genuine 399–1199 spread.
  test('mis-attached bottlings are flagged while genuine spread survives (3× band)', () => {
    const curve = buildReleaseCurve([
      { vintage: '2013', ownerPrices: [240] },   // entry-level wine money
      { vintage: '2016', ownerPrices: [2899] },  // cru/riserva money
      { vintage: '2018', ownerPrices: [1199] },
      { vintage: '2019', ownerPrices: [399] },
      { vintage: '2020', ownerPrices: [769] },
      { vintage: '2021', ownerPrices: [419, 834] },
      { vintage: '2022', ownerPrices: [899] },
    ]);
    const byVintage = Object.fromEntries(curve.map((c) => [c.vintage, c.suspect]));
    expect(byVintage['2013']).toBe(true);
    expect(byVintage['2016']).toBe(true);
    expect(byVintage['2018']).toBe(false);
    expect(byVintage['2019']).toBe(false);
    expect(byVintage['2020']).toBe(false);
    expect(byVintage['2021']).toBe(false);
    expect(byVintage['2022']).toBe(false);
  });
});
