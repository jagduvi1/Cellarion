const {
  validatePriceSanity,
  ABSOLUTE_CAP,
  USER_MEDIAN_MULTIPLE,
  MARKET_MEDIAN_MULTIPLE,
  centsHeuristicFloor,
} = require('./priceValidation');

describe('validatePriceSanity', () => {
  describe('input validation', () => {
    it('returns no warnings for a typical price', () => {
      expect(validatePriceSanity({ price: 25, currency: 'EUR' })).toEqual([]);
    });

    it('returns no warnings for null/undefined/NaN/zero/negative', () => {
      expect(validatePriceSanity({ price: null })).toEqual([]);
      expect(validatePriceSanity({ price: undefined })).toEqual([]);
      expect(validatePriceSanity({ price: NaN })).toEqual([]);
      expect(validatePriceSanity({ price: 0 })).toEqual([]);
      expect(validatePriceSanity({ price: -100, currency: 'USD' })).toEqual([]);
    });

    it('returns no warnings when price is not a number', () => {
      expect(validatePriceSanity({ price: '100' })).toEqual([]);
    });
  });

  describe('rule: absolute cap per currency', () => {
    it('warns when USD price exceeds the typical maximum', () => {
      const w = validatePriceSanity({ price: ABSOLUTE_CAP.USD + 1, currency: 'USD' });
      expect(w.find(x => x.code === 'absoluteCap')).toBeDefined();
      expect(w[0].severity).toBe('warning');
      expect(w[0].context.cap).toBe(ABSOLUTE_CAP.USD);
    });

    it('uses currency-specific caps', () => {
      // 100,000 SEK is fine (under SEK cap), 100,000 USD is not (over USD cap)
      const sekOk  = validatePriceSanity({ price: 100000, currency: 'SEK' });
      const usdHit = validatePriceSanity({ price: 100000, currency: 'USD' });
      expect(sekOk.find(x => x.code === 'absoluteCap')).toBeUndefined();
      expect(usdHit.find(x => x.code === 'absoluteCap')).toBeDefined();
    });

    it('falls back to USD cap for unknown currencies', () => {
      const w = validatePriceSanity({ price: ABSOLUTE_CAP.USD + 1, currency: 'XYZ' });
      expect(w.find(x => x.code === 'absoluteCap')).toBeDefined();
    });

    it('is case-insensitive on currency', () => {
      const w = validatePriceSanity({ price: 100000, currency: 'usd' });
      expect(w.find(x => x.code === 'absoluteCap')).toBeDefined();
    });
  });

  describe("rule: outlier vs user's own median", () => {
    it('warns when price >= 50× user median (with enough sample)', () => {
      const w = validatePriceSanity({
        price: 5000,
        currency: 'EUR',
        userMedianPrice: 100,
        userMedianSample: 20,
      });
      const outlier = w.find(x => x.code === 'userOutlier');
      expect(outlier).toBeDefined();
      expect(outlier.context.ratio).toBe(50);
      expect(outlier.context.median).toBe(100);
    });

    it('does NOT warn for small sample sizes', () => {
      const w = validatePriceSanity({
        price: 5000,
        currency: 'EUR',
        userMedianPrice: 100,
        userMedianSample: 3,  // below the 5-bottle threshold
      });
      expect(w.find(x => x.code === 'userOutlier')).toBeUndefined();
    });

    it('does NOT warn within the expected range', () => {
      const w = validatePriceSanity({
        price: 200,
        currency: 'EUR',
        userMedianPrice: 100,
        userMedianSample: 20,
      });
      expect(w.find(x => x.code === 'userOutlier')).toBeUndefined();
    });

    it('uses the configured multiplier', () => {
      // Exactly at threshold = warn
      const at = validatePriceSanity({
        price: 100 * USER_MEDIAN_MULTIPLE,
        currency: 'EUR',
        userMedianPrice: 100,
        userMedianSample: 10,
      });
      expect(at.find(x => x.code === 'userOutlier')).toBeDefined();
      // Just below = no warn
      const below = validatePriceSanity({
        price: 100 * USER_MEDIAN_MULTIPLE - 1,
        currency: 'EUR',
        userMedianPrice: 100,
        userMedianSample: 10,
      });
      expect(below.find(x => x.code === 'userOutlier')).toBeUndefined();
    });
  });

  describe('rule: outlier vs known market price', () => {
    it('warns when price >= 5× market median', () => {
      const w = validatePriceSanity({
        price: 1000,
        currency: 'USD',
        marketMedianPrice: 100,
      });
      const above = w.find(x => x.code === 'aboveMarket');
      expect(above).toBeDefined();
      expect(above.context.ratio).toBe(10);
      expect(above.context.marketPrice).toBe(100);
    });

    it('does NOT warn within the expected market range', () => {
      const w = validatePriceSanity({
        price: 200,
        currency: 'USD',
        marketMedianPrice: 100,
      });
      expect(w.find(x => x.code === 'aboveMarket')).toBeUndefined();
    });

    it('uses the configured multiplier exactly', () => {
      const at = validatePriceSanity({
        price: 100 * MARKET_MEDIAN_MULTIPLE,
        currency: 'USD',
        marketMedianPrice: 100,
      });
      expect(at.find(x => x.code === 'aboveMarket')).toBeDefined();
    });

    it('does NOT warn when marketMedianPrice is missing', () => {
      const w = validatePriceSanity({ price: 1000, currency: 'USD' });
      expect(w.find(x => x.code === 'aboveMarket')).toBeUndefined();
    });
  });

  describe('rule: possibly-cents heuristic', () => {
    it('flags suspiciously round large prices as possibly cents', () => {
      const w = validatePriceSanity({ price: 260000, currency: 'USD' });
      const cents = w.find(x => x.code === 'possiblyCents');
      expect(cents).toBeDefined();
      expect(cents.severity).toBe('info');
      expect(cents.context.ifCents).toBe(2600);
    });

    it('does NOT flag round prices below the floor', () => {
      const w = validatePriceSanity({ price: 5000, currency: 'USD' });
      expect(w.find(x => x.code === 'possiblyCents')).toBeUndefined();
    });

    it('does NOT flag large prices with cents/decimals', () => {
      const w = validatePriceSanity({ price: 25099, currency: 'USD' });
      expect(w.find(x => x.code === 'possiblyCents')).toBeUndefined();
    });

    it('scales the floor per currency — ordinary JPY/SEK prices do not trip it', () => {
      // ¥20,000 (~$130) and 15,000 SEK are normal bottle prices, round to 100.
      // Under the old flat 10,000 floor both fired constantly.
      const jpy = validatePriceSanity({ price: 20000, currency: 'JPY' });
      expect(jpy.find(x => x.code === 'possiblyCents')).toBeUndefined();
      const sek = validatePriceSanity({ price: 15000, currency: 'SEK' });
      expect(sek.find(x => x.code === 'possiblyCents')).toBeUndefined();
    });

    it('still flags genuinely huge round JPY/SEK prices', () => {
      // JPY floor = 7,500,000 / 5 = 1,500,000; SEK floor = 500,000 / 5 = 100,000
      const jpy = validatePriceSanity({ price: 2000000, currency: 'JPY' });
      expect(jpy.find(x => x.code === 'possiblyCents')).toBeDefined();
      const sek = validatePriceSanity({ price: 150000, currency: 'SEK' });
      expect(sek.find(x => x.code === 'possiblyCents')).toBeDefined();
    });

    it('keeps the historical 10,000 floor for USD/EUR-magnitude currencies', () => {
      expect(centsHeuristicFloor(ABSOLUTE_CAP.USD)).toBe(10000);
      expect(centsHeuristicFloor(ABSOLUTE_CAP.EUR)).toBe(10000);
      const usd = validatePriceSanity({ price: 10000, currency: 'USD' });
      expect(usd.find(x => x.code === 'possiblyCents')).toBeDefined();
      const eur = validatePriceSanity({ price: 9900, currency: 'EUR' });
      expect(eur.find(x => x.code === 'possiblyCents')).toBeUndefined();
    });
  });

  describe('combined behaviour', () => {
    it('stacks multiple warnings on the production-incident case', () => {
      // The Chevalier-Montrachet $260k row from the live audit
      const w = validatePriceSanity({
        price: 260000,
        currency: 'USD',
        userMedianPrice: 690,
        userMedianSample: 27,
        marketMedianPrice: 2600,
      });
      const codes = w.map(x => x.code).sort();
      expect(codes).toEqual(['aboveMarket', 'absoluteCap', 'possiblyCents', 'userOutlier']);
    });

    it('returns no warnings on the median bottle in the dataset', () => {
      // Median active USD bottle from /admin/stats is around $24
      const w = validatePriceSanity({
        price: 24,
        currency: 'USD',
        userMedianPrice: 20,
        userMedianSample: 150,
        marketMedianPrice: 25,
      });
      expect(w).toEqual([]);
    });
  });
});
