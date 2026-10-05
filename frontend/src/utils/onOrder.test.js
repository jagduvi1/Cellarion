import {
  isOnOrder, toMonthInput, formatArrivalMonth, isArrivalLate, groupOnOrder, totalsByCurrency,
} from './onOrder';
import { applyImportOnOrder } from './importPayload';

const MARCH = '2027-03-01T12:00:00.000Z'; // how the server stores "March 2027"

test('the month helpers read the stored month in UTC', () => {
  expect(toMonthInput(MARCH)).toBe('2027-03');
  expect(toMonthInput(null)).toBe('');
  expect(formatArrivalMonth(MARCH, 'en-GB')).toBe('March 2027');
  expect(formatArrivalMonth('', 'en-GB')).toBe('');
});

test('late only once the expected month is over', () => {
  expect(isArrivalLate(MARCH, new Date('2027-03-31T22:00:00Z'))).toBe(false);
  expect(isArrivalLate(MARCH, new Date('2027-04-01T00:00:00Z'))).toBe(true);
  expect(isArrivalLate(null)).toBe(false);
});

test('isOnOrder', () => {
  expect(isOnOrder({ status: 'ordered' })).toBe(true);
  expect(isOnOrder({ status: 'active' })).toBe(false);
  expect(isOnOrder(null)).toBe(false);
});

test('groupOnOrder: one row per wine, vintage, size and expected month, in the order given', () => {
  const b = (id, wine, vintage, month, size = '750ml') => ({
    _id: id, wineDefinition: { _id: wine }, vintage, bottleSize: size, expectedArrival: month,
  });
  const groups = groupOnOrder([
    b('1', 'w1', '2023', MARCH), b('2', 'w1', '2023', MARCH), b('3', 'w1', '2023', MARCH, '1500ml'),
    b('4', 'w2', '2022', null), b('5', 'w1', '2023', '2027-05-01T12:00:00.000Z'),
  ]);
  expect(groups.map((g) => g.bottles.map((x) => x._id))).toEqual([['1', '2'], ['3'], ['4'], ['5']]);
});

test('totalsByCurrency sums priced bottles per currency', () => {
  expect(totalsByCurrency([
    { price: 50, currency: 'EUR' }, { price: 50, currency: 'EUR' }, { price: 300, currency: 'SEK' }, { currency: 'EUR' },
  ])).toEqual([{ currency: 'EUR', total: 100 }, { currency: 'SEK', total: 300 }]);
});

test('applyImportOnOrder: cellar rows come in on order; history, wishlist and own-dated rows are left alone', () => {
  const items = [
    { wineName: 'A' },
    { wineName: 'B', addToHistory: true },
    { wineName: 'C', addToWishlist: true },
    { wineName: 'D', onOrder: true, expectedArrival: '2026-11' },
  ];
  expect(applyImportOnOrder(items, { onOrder: false })).toBe(items);
  expect(applyImportOnOrder(items, { onOrder: true, expectedArrival: '2027-03' })).toEqual([
    { wineName: 'A', onOrder: true, expectedArrival: '2027-03' },
    { wineName: 'B', addToHistory: true },
    { wineName: 'C', addToWishlist: true },
    { wineName: 'D', onOrder: true, expectedArrival: '2026-11' },
  ]);
});
