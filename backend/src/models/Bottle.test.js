/**
 * Bottle schema — occasion note + personal drink-window fields.
 *
 * drinkFrom/drinkTo are the user's OWN per-bottle drink window (hand-set or
 * imported from CellarTracker BeginConsume/EndConsume) — deliberately
 * bottle-level, so the shared registry's WineVintageProfile stays
 * sommelier-curated. The schema is the last line of defence behind the
 * route/import validation: integer years 1900–2200, and drinkTo may not
 * precede drinkFrom. occasion is a personal purpose note distinct from
 * tasting notes.
 *
 * validateSync() only — no MongoDB needed.
 */

const mongoose = require('mongoose');
const Bottle = require('./Bottle');

function makeBottle(fields = {}) {
  return new Bottle({
    cellar: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    wineDefinition: new mongoose.Types.ObjectId(),
    vintage: '2020',
    ...fields,
  });
}

// 2026-10-13: Chrome's page translation stored "EURO" for "EUR".
describe('Bottle.currency', () => {
  test('every write stores an alias as its code', () => {
    expect(makeBottle({ currency: 'EURO' }).currency).toBe('EUR');
    expect(makeBottle({ currency: ' euro ' }).currency).toBe('EUR');
    const b = makeBottle({ currency: 'USD' });
    b.currency = 'Euros';
    expect(b.currency).toBe('EUR');
  });

  test('a code outside the supported list is kept (older imports) and still validates', () => {
    const b = makeBottle({ currency: 'ils' });
    expect(b.currency).toBe('ILS');
    expect(b.validateSync()).toBeUndefined();
  });

  test('defaults to USD', () => {
    expect(makeBottle().currency).toBe('USD');
  });
});

describe('Bottle.occasion', () => {
  test('accepts an occasion note and trims surrounding whitespace', () => {
    const bottle = makeBottle({ occasion: '  Saving for my 50th birthday  ' });
    expect(bottle.validateSync()).toBeUndefined();
    expect(bottle.occasion).toBe('Saving for my 50th birthday');
  });

  test('is optional — bottles without occasion stay valid', () => {
    const bottle = makeBottle();
    expect(bottle.validateSync()).toBeUndefined();
    expect(bottle.occasion).toBeUndefined();
  });

  test('accepts exactly 500 characters', () => {
    const bottle = makeBottle({ occasion: 'a'.repeat(500) });
    expect(bottle.validateSync()).toBeUndefined();
  });

  test('rejects more than 500 characters', () => {
    const bottle = makeBottle({ occasion: 'a'.repeat(501) });
    const err = bottle.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.occasion.message).toMatch(/Occasion too long/);
  });
});

describe('Bottle.drinkFrom / drinkTo schema validation', () => {
  test('bottle without a drink window validates (additive regression)', () => {
    expect(makeBottle().validateSync()).toBeUndefined();
  });

  test('valid window validates', () => {
    expect(makeBottle({ drinkFrom: 2018, drinkTo: 2046 }).validateSync()).toBeUndefined();
  });

  test('single-sided windows validate', () => {
    expect(makeBottle({ drinkFrom: 2025 }).validateSync()).toBeUndefined();
    expect(makeBottle({ drinkTo: 2035 }).validateSync()).toBeUndefined();
  });

  test('null values validate (clearing the window)', () => {
    expect(makeBottle({ drinkFrom: null, drinkTo: null }).validateSync()).toBeUndefined();
  });

  test('bounds 1900–2200 are enforced on both fields', () => {
    expect(makeBottle({ drinkFrom: 1899 }).validateSync().errors.drinkFrom).toBeDefined();
    expect(makeBottle({ drinkTo: 2201 }).validateSync().errors.drinkTo).toBeDefined();
    // Boundary years are fine
    expect(makeBottle({ drinkFrom: 1900, drinkTo: 2200 }).validateSync()).toBeUndefined();
  });

  test('non-integer years are rejected', () => {
    expect(makeBottle({ drinkFrom: 2020.5 }).validateSync().errors.drinkFrom.message)
      .toMatch(/whole year/);
    expect(makeBottle({ drinkTo: 2030.25 }).validateSync().errors.drinkTo.message)
      .toMatch(/whole year/);
  });

  test('drinkTo before drinkFrom is rejected (cross-field)', () => {
    const err = makeBottle({ drinkFrom: 2046, drinkTo: 2018 }).validateSync();
    expect(err.errors.drinkTo.message).toMatch(/cannot be before/);
  });

  test('cross-field check passes when either side is missing', () => {
    expect(makeBottle({ drinkFrom: 2046 }).validateSync()).toBeUndefined();
    expect(makeBottle({ drinkTo: 2018 }).validateSync()).toBeUndefined();
  });
});
