/**
 * bottleSummary — the bottle line item every MCP list returns. Support ticket
 * 2026-09-07: peak_from / peak_until are writable through update_bottle but
 * were missing from every read, so an assistant could set them and never see
 * them again.
 */
jest.mock('../utils/reservationUtils', () => ({ isReserved: () => false }));

const { bottleSummary } = require('./toolUtil');

test('the drink window and the peak pair both come back on a bottle summary', () => {
  const out = bottleSummary({
    _id: 'b1', wineDefinition: { name: 'Magari', producer: "Ca' Marcanda", type: 'red' },
    vintage: '2019', status: 'active', cellar: 'c1',
    drinkFrom: 2024, drinkTo: 2034, peakFrom: 2027, peakUntil: 2031,
  });
  expect(out).toMatchObject({ drink_from: 2024, drink_to: 2034, peak_from: 2027, peak_until: 2031 });
});

test('an unset peak reads as null, not undefined, so a client can tell "no window" from "field missing"', () => {
  const out = bottleSummary({ _id: 'b2', wineDefinition: { name: 'X' }, vintage: 'NV', status: 'active', cellar: 'c1' });
  expect(out.peak_from).toBeNull();
  expect(out.peak_until).toBeNull();
});
