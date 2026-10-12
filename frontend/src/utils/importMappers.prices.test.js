/**
 * Import prices (forum feedback 2026-10-12: a generic file's price column was
 * not spelled exactly "Price", and every bottle came in without its price,
 * with no word about it).
 *
 * Pinned: header names are matched ignoring case, spaces, "_" and "-"; the
 * usual price names in several languages are read; a price column that names
 * its currency ("Price (AUD)") gives the currency too, unless a Currency
 * column says otherwise; a yes/no "Paid" column does not hide a real price; a
 * currency written before the number is stripped; and a filled-in column that
 * reads like a price but gave no bottle a price is reported.
 */
import { parseAndMap, parseLocaleNumber, normHeader, priceFromCurrencyHeader, looksLikePriceHeader } from './importMappers';

const csv = (header, ...rows) => [header, ...rows].join('\n');
const first = (text) => parseAndMap(text).items[0];

describe('normHeader', () => {
  it.each([
    ['Purchase_Price', 'purchase price'],
    ['  PRICE ', 'price'],
    ['purchase-price', 'purchase price'],
    ['Price  per   bottle', 'price per bottle'],
    ['﻿Price', 'price'],
  ])('%j → %j', (input, expected) => {
    expect(normHeader(input)).toBe(expected);
  });
});

describe('generic file prices', () => {
  it.each([
    'Price', 'price', 'PRICE', ' Price ', 'Purchase Price', 'purchase_price', 'Price Paid',
    'Bottle Price', 'Price per bottle', 'Unit Price', 'Cost', 'Pris', 'Inköpspris', 'Prix', 'Preis', 'Prezzo', 'Precio', 'Prijs',
  ])('reads a price from a column named %j', (header) => {
    const item = first(csv(`Wine,Producer,Vintage,${header}`, 'Barolo,Azelia,2016,45.50'));
    expect(item.price).toBe(45.5);
  });

  it.each([
    ['Price (AUD)', 'AUD'],
    ['Price [EUR]', 'EUR'],
    ['Purchase Price (in GBP)', 'GBP'],
    ['Price in SEK', 'SEK'],
    ['Price AUD', 'AUD'],
    ['Cost €', 'EUR'],
    ['Price £', 'GBP'],
  ])('a header %j gives the price and the currency %s', (header, currency) => {
    const item = first(csv(`Wine,Producer,Vintage,${header}`, 'Barolo,Azelia,2016,45'));
    expect(item.price).toBe(45);
    expect(item.currency).toBe(currency);
  });

  it.each(['Price ($)', 'Pris kr', 'Price $'])('a currency mark several currencies share (%j) gives the price but no currency', (header) => {
    const item = first(csv(`Wine,Producer,Vintage,${header}`, 'Barolo,Azelia,2016,45'));
    expect(item.price).toBe(45);
    expect(item.currency).toBeUndefined();
  });

  it('a Currency column wins over the currency in the price header', () => {
    const item = first(csv('Wine,Producer,Vintage,Price (AUD),Currency', 'Barolo,Azelia,2016,45,NZD'));
    expect(item.currency).toBe('NZD');
  });

  it('a yes/no "Paid" column does not hide the real price', () => {
    const item = first(csv('Wine,Producer,Vintage,Paid,Pris', 'Barolo,Azelia,2016,yes,"199,50"'));
    expect(item.price).toBe(199.5);
  });

  it('a value with its currency written first still reads', () => {
    const item = first(csv('Wine,Producer,Vintage,Price', 'Barolo,Azelia,2016,AUD 45.00'));
    expect(item.price).toBe(45);
  });

  it('"Value" is not taken as the purchase price', () => {
    const item = first(csv('Wine,Producer,Vintage,Value', 'Barolo,Azelia,2016,120'));
    expect(item.price).toBeUndefined();
  });
});

describe('priceFromCurrencyHeader', () => {
  it('ignores a bracket that is not a currency', () => {
    expect(priceFromCurrencyHeader({ 'Price (per case)': '300' })).toBeNull();
  });
  it('ignores a column that is not a price', () => {
    expect(priceFromCurrencyHeader({ 'Score (100)': '95', 'Wine EUR': 'x' })).toBeNull();
  });
  it('skips an empty price cell', () => {
    expect(priceFromCurrencyHeader({ 'Price (AUD)': ' ' })).toBeNull();
  });
});

describe('parseLocaleNumber with a currency in front', () => {
  it.each([
    ['AUD 45.00', 45],
    ['SEK 1 234,50', 1234.5],
    ['Fr. 30', 30],
    ['EUR -5', -5],
  ])('%j → %d', (input, n) => {
    expect(parseLocaleNumber(input)).toBe(n);
  });
  it('words without a number stay unreadable', () => {
    expect(parseLocaleNumber('abc')).toBeNaN();
    expect(parseLocaleNumber('n/a')).toBeNaN();
  });
});

describe('the "prices were not read" warning', () => {
  const warningsOf = (text) => parseAndMap(text).warnings || [];

  it('a filled-in price-like column that gave no bottle a price is reported by name', () => {
    const w = warningsOf(csv('Wine,Producer,Vintage,Cost per case', 'Barolo,Azelia,2016,300', 'Barbaresco,Gaja,2015,900'));
    expect(w).toContainEqual({ code: 'price-not-read', column: 'Cost per case' });
  });

  it('values that are not numbers are reported too', () => {
    const w = warningsOf(csv('Wine,Producer,Vintage,Price', 'Barolo,Azelia,2016,expensive'));
    expect(w).toContainEqual({ code: 'price-not-read', column: 'Price' });
  });

  it('no warning once any bottle has a price', () => {
    const w = warningsOf(csv('Wine,Producer,Vintage,Price', 'Barolo,Azelia,2016,45', 'Barbaresco,Gaja,2015,'));
    expect(w.find((x) => x.code === 'price-not-read')).toBeUndefined();
  });

  it('no warning when the file has no price column, or it is empty', () => {
    expect(warningsOf(csv('Wine,Producer,Vintage', 'Barolo,Azelia,2016')).find((x) => x.code === 'price-not-read')).toBeUndefined();
    expect(warningsOf(csv('Wine,Producer,Vintage,Price', 'Barolo,Azelia,2016,')).find((x) => x.code === 'price-not-read')).toBeUndefined();
  });

  it('looksLikePriceHeader reads several languages and not unrelated words', () => {
    expect(looksLikePriceHeader('Inköpspris')).toBe(true);
    expect(looksLikePriceHeader('Prix unitaire')).toBe(true);
    expect(looksLikePriceHeader('Price_per_case')).toBe(true);
    expect(looksLikePriceHeader('Priceless notes')).toBe(false);
    expect(looksLikePriceHeader('Producer')).toBe(false);
  });
});
