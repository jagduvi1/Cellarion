/**
 * isImplausibleIdentity — the shape test that stands between a half-read label
 * and the public registry, plus the auto-promote hook that consults it.
 *
 * THE LIVE BUG this pins: a wine with producer "Increíble" AND name
 * "Increíble" — the label's one readable word echoed into both boxes — passed
 * the old "non-empty and not a sentinel" promotion rule, left the pending
 * queue, and reached the maturity queue as public registry data. By then its
 * label photo was gated behind "is this row still pending?", so the one piece
 * of evidence that could have corrected it was gone.
 *
 * The suite is deliberately as loud about what must NOT fire: this predicate
 * blocks promotion, and a false positive traps a wine a curator identified
 * correctly.
 */
const { isImplausibleIdentity, isIdentitySentinel } = require('./normalize');

describe('the echo — producer and name are the same string', () => {
  test.each([
    ['Increíble', 'Increíble'],          // the prod row
    ['increible', 'INCREÍBLE'],          // case + diacritics fold
    ["Trader Joe's", 'Trader Joes'],     // punctuation folds away
    ['Château  Musar', 'Château Musar'], // whitespace collapses
  ])('producer %p + name %p is implausible', (producer, name) => {
    expect(isImplausibleIdentity(producer, name)).toBe(true);
  });

  test('and it is not a SENTINEL — which is exactly why the old rule let it through', () => {
    // The old promotion condition, spelled out: both fields "real", so it
    // promoted. Nothing about the sentinel test was wrong; it was incomplete.
    expect(isIdentitySentinel('Increíble')).toBe(false);
  });
});

describe('containment that leaves no distinct producer', () => {
  test.each([
    ['Increíble Wines', 'Increíble'],    // the echo wearing an estate word
    ['Increíble', 'Increíble Wine'],
    ['Domaine Leflaive', 'Leflaive'],    // 'domaine' is a stop word, nothing distinct remains
    ['Bodegas Muga', 'Muga Winery'],
  ])('producer %p + name %p is implausible', (producer, name) => {
    expect(isImplausibleIdentity(producer, name)).toBe(true);
  });

  test('a producer that is nothing but house words is implausible', () => {
    expect(isImplausibleIdentity('Domaine', 'Les Pucelles')).toBe(true);
    expect(isImplausibleIdentity('Cantina', 'Barbera')).toBe(true);
  });
});

describe('degenerate producers', () => {
  test('a single character carries no identity', () => {
    expect(isImplausibleIdentity('X', 'Chardonnay')).toBe(true);
  });

  test('digits only', () => {
    expect(isImplausibleIdentity('2019', 'Reserva')).toBe(true);
    expect(isImplausibleIdentity('12345', 'Reserva')).toBe(true);
  });

  test('a producer with digits AND letters is fine — "19 Crimes" is a real house', () => {
    expect(isImplausibleIdentity('19 Crimes', 'The Banished')).toBe(false);
  });
});

describe('what must NOT fire — a false positive traps a correctly identified wine', () => {
  test.each([
    ['Cloudy Bay', 'Sauvignon Blanc'],
    // Producer embedded in the name with a real remainder: a FORMATTING defect
    // (the cross-field review queue's name-in-producer rule), not a missing
    // identity. Refusing it would trap a wine transcribed straight off a label.
    ['Cloudy Bay', 'Cloudy Bay Sauvignon Blanc'],
    ['Felton Road', 'Block 3 Pinot Noir'],
    ['Château Margaux', 'Pavillon Rouge'],
    ['Kumeu River Wines Limited', 'Maté\'s Vineyard Chardonnay'],
    // A producer that is a PLACE is wrong, but this predicate has no DB and
    // says nothing about it — the mint gate and the cross-field rules do.
    ['Chablis', 'Premier Cru Montmains'],
    ['Tokaji', 'Aszú 5 Puttonyos'],
  ])('producer %p + name %p is plausible here', (producer, name) => {
    expect(isImplausibleIdentity(producer, name)).toBe(false);
  });

  test('NON-LATIN identities are exempt — normalizeString cannot see them (audit H-4)', () => {
    // Both fold to '' under normalizeString. Condemning them is precisely the
    // regression that made "Мукузани" rows unpromotable forever.
    expect(isImplausibleIdentity('Мукузани', 'Мукузани')).toBe(false);
    expect(isImplausibleIdentity('獺祭', '純米大吟醸')).toBe(false);
    expect(isImplausibleIdentity('ქართული ღვინო', 'საფერავი')).toBe(false);
  });

  test('MISSING is isIdentitySentinel\'s verdict, not this one\'s', () => {
    // Kept strictly complementary so callers can ask both without either
    // predicate second-guessing the other.
    expect(isImplausibleIdentity('', 'Barolo')).toBe(false);
    expect(isImplausibleIdentity('Rinaldi', '')).toBe(false);
    expect(isImplausibleIdentity(null, 'Barolo')).toBe(false);
    expect(isImplausibleIdentity('Rinaldi', undefined)).toBe(false);
  });
});

describe('the auto-promote hook consults it', () => {
  const mongoose = require('mongoose');
  const WineDefinition = require('../models/WineDefinition');
  const oid = () => new mongoose.Types.ObjectId();

  const newPending = (name) => new WineDefinition({
    name,
    producer: '',
    country: oid(),
    createdBy: oid(),
    normalizedKey: `pending~aaa:${name.toLowerCase()}:`,
    pendingIdentity: true,
  });

  test('THE BUG: "Increíble" as producer of "Increíble" does NOT promote', async () => {
    const doc = newPending('Increíble');
    doc.producer = 'Increíble';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
    // …and it therefore keeps no public URL either.
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(false);
  });

  test('a legitimate identity still promotes', async () => {
    const doc = newPending('Sauvignon Blanc');
    doc.producer = 'Cloudy Bay';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(true);
  });

  test('a producer-in-name row still promotes — formatting is not an identity failure', async () => {
    const doc = newPending('Cloudy Bay Sauvignon Blanc');
    doc.producer = 'Cloudy Bay';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });

  test('a sentinel producer still does not promote (the older rule is intact)', async () => {
    const doc = newPending('Barolo');
    doc.producer = 'Unknown';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });
});
