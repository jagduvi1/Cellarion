import { cardDetails, readCardFields, storeCardFields, CARD_FIELDS, CARD_FIELDS_STORAGE_KEY } from './cardDetails';

const b = (over = {}) => ({
  _id: Math.random().toString(36).slice(2),
  rating: 4.5, ratingScale: '5',
  price: 45, currency: 'EUR',
  bottleSize: '750ml',
  purchaseDate: '2024-03-15',
  wineDefinition: { region: { name: 'Piedmont' }, country: { name: 'Italy' } },
  ...over,
});
const texts = (out) => out.map((d) => d.text);
const opts = { ratingScale: '5', locale: 'en' };

describe('cardDetails', () => {
  test('nothing picked, nothing shown', () => {
    expect(cardDetails([b()], [], opts)).toEqual([]);
  });

  test('every field for one bottle, in a fixed order whatever the pick order', () => {
    const out = cardDetails([b()], ['purchased', 'region', 'size', 'price', 'rating'], opts);
    expect(out.map((d) => d.field)).toEqual(CARD_FIELDS);
    expect(texts(out)).toEqual(['4.5★', '€45', '750 ml', 'Piedmont', 'Mar 2024']);
  });

  test('a rating shows in the viewer\'s own scale', () => {
    expect(texts(cardDetails([b({ rating: 18, ratingScale: '20' })], ['rating'], { ...opts, ratingScale: '100' }))[0]).toMatch(/pts$/);
    expect(texts(cardDetails([b({ rating: 92, ratingScale: '100' })], ['rating'], { ...opts, ratingScale: '100' }))).toEqual(['92pts']);
  });

  test('a stack shows one value when its bottles agree, a range when they do not', () => {
    expect(texts(cardDetails([b(), b()], ['rating', 'price'], opts))).toEqual(['4.5★', '€45']);
    expect(texts(cardDetails([b({ rating: 4 }), b({ rating: 4.5 })], ['rating'], opts))).toEqual(['4.0–4.5★']);
    expect(texts(cardDetails([b({ price: 40 }), b({ price: 55 })], ['price'], opts))).toEqual(['€40–55']);
    expect(texts(cardDetails([b({ purchaseDate: '2021-05-01' }), b({ purchaseDate: '2023-02-01' })], ['purchased'], opts))).toEqual(['2021–2023']);
  });

  test('left out where the bottles have no value, or prices in different currencies', () => {
    expect(cardDetails([b({ rating: null, price: null, purchaseDate: null })], ['rating', 'price', 'purchased'], opts)).toEqual([]);
    // A stored 0 means unrated, as on the server — never "0.0★" or a range from 0.
    expect(cardDetails([b({ rating: 0 })], ['rating'], opts)).toEqual([]);
    expect(texts(cardDetails([b({ rating: 0 }), b({ rating: 4.5 })], ['rating'], opts))).toEqual(['4.5★']);
    expect(cardDetails([b({ currency: 'EUR' }), b({ currency: 'SEK' })], ['price'], opts)).toEqual([]);
  });

  test('the region falls back to the country, and is left out where the card shows it already', () => {
    expect(texts(cardDetails([b({ wineDefinition: { country: { name: 'Italy' } } })], ['region'], opts))).toEqual(['Italy']);
    expect(cardDetails([b()], ['region'], { ...opts, cardShowsRegion: true })).toEqual([]);
    // The grid card shows region names only: a country-only wine still gets its country.
    expect(texts(cardDetails([b({ wineDefinition: { country: { name: 'Italy' } } })], ['region'], { ...opts, cardShowsRegion: true }))).toEqual(['Italy']);
  });

  test('a range whose ends read the same shows once', () => {
    expect(texts(cardDetails([b({ price: 149.5, currency: 'SEK' }), b({ price: 149.9, currency: 'SEK' })], ['price'], opts))).toHaveLength(1);
    expect(texts(cardDetails([b({ price: 149.5, currency: 'SEK' }), b({ price: 149.9, currency: 'SEK' })], ['price'], opts))[0]).not.toMatch(/–/);
    expect(texts(cardDetails([b({ rating: 91.6, ratingScale: '100' }), b({ rating: 92, ratingScale: '100' })], ['rating'], { ...opts, ratingScale: '100' }))).toEqual(['92pts']);
  });

  test('a purchase date stored as UTC midnight reads as that month everywhere', () => {
    expect(texts(cardDetails([b({ purchaseDate: '2024-03-01T00:00:00.000Z' })], ['purchased'], opts))).toEqual(['Mar 2024']);
    expect(texts(cardDetails([b({ purchaseDate: '2024-01-01T00:00:00.000Z' }), b({ purchaseDate: '2024-12-31T00:00:00.000Z' })], ['purchased'], opts))).toEqual(['2024']);
  });
});

describe('the stored pick', () => {
  // Node 25 ships a half-built global localStorage that shadows jsdom's — a
  // plain in-memory stand-in keeps the test about this module.
  beforeEach(() => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('round-trips, and ignores unknown or broken values', () => {
    storeCardFields(['price', 'rating']);
    expect(readCardFields()).toEqual(['rating', 'price']);
    localStorage.setItem(CARD_FIELDS_STORAGE_KEY, JSON.stringify(['bogus', 'size']));
    expect(readCardFields()).toEqual(['size']);
    localStorage.setItem(CARD_FIELDS_STORAGE_KEY, '{not json');
    expect(readCardFields()).toEqual([]);
  });
});
