const mongoose = require('mongoose');
const Bottle = require('./Bottle');

// Schema-level validation only — no DB connection needed for validateSync().
function makeBottle(overrides = {}) {
  return new Bottle({
    cellar: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    wineDefinition: new mongoose.Types.ObjectId(),
    vintage: '2020',
    ...overrides,
  });
}

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
