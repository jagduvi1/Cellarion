/**
 * isImplausibleIdentity — the BLOCKING shape test, plus the auto-promote hook
 * that consults it.
 *
 * THE BUG THIS SUITE NOW EXISTS TO PREVENT is not the "Increíble" echo. It is
 * what the fix for that echo did: the predicate grew terms that judged identity
 * QUALITY from string shape (`p === n`, stop-word-stripped containment,
 * digits-only) and, measured against 91 real producer/name pairs, refused to
 * promote 67 of them. Château Margaux, Petrus, Krug, Salon, Dom Pérignon, Opus
 * One, Sassicaia, Masseto, Château Rayas, J.J. Prüm — the SINGLE-WINE ESTATE,
 * where the producer IS the wine — plus Domaine de la Romanée-Conti /
 * "Romanée-Conti", Harlan Estate / "Harlan", Duckhorn / "Duckhorn Vineyards",
 * and the Penedès house "1+1=3".
 *
 * Producer == name is not a defect, it is a category of wine. The suspicion
 * moved to utils/crossFieldChecks' producer-echoes-name.v1, which FLAGS it for
 * a curator with the label photo in front of them (P2's 7-day grace window),
 * and this predicate keeps only what cannot possibly be an identity in any
 * language: a sub-2-char producer, and a short producer made of nothing but
 * house/stop words.
 *
 * The inverted assertions below are marked WAS-BLOCKED with the reason. Every
 * one of them must stay green: this bug class must never come back.
 */
const { isImplausibleIdentity, isIdentitySentinel } = require('./normalize');
const { CROSS_FIELD_CHECKS } = require('./crossFieldChecks');

describe('producer == name is a CATEGORY OF WINE, not a defect', () => {
  // WAS-BLOCKED by the `p === n` term. Every one of these is a real, famous
  // single-wine estate that could not be promoted, minted or curated.
  test.each([
    ['Château Margaux', 'Château Margaux'],
    ['Petrus', 'Petrus'],
    ['Krug', 'Krug'],
    ['Salon', 'Salon'],
    ['Dom Pérignon', 'Dom Pérignon'],
    ['Veuve Clicquot', 'Veuve Clicquot'],
    ['Pol Roger', 'Pol Roger'],
    ['Opus One', 'Opus One'],
    ['Screaming Eagle', 'Screaming Eagle'],
    ['Sassicaia', 'Sassicaia'],
    ['Masseto', 'Masseto'],
    ['Ornellaia', 'Ornellaia'],
    ['Tignanello', 'Tignanello'],
    ['Château Musar', 'Château Musar'],
    ['Château Rayas', 'Château Rayas'],
    ['Zind-Humbrecht', 'Zind-Humbrecht'],
    ['J.J. Prüm', 'J.J. Prüm'],
  ])('producer %p + name %p is PLAUSIBLE', (producer, name) => {
    expect(isImplausibleIdentity(producer, name)).toBe(false);
  });

  test('the "Increíble" row is plausible HERE — and flagged where a human sees it', () => {
    // Inverted deliberately. Nothing in the STRING separates "Increíble" /
    // "Increíble" from "Petrus" / "Petrus"; only the label does. So this
    // predicate no longer refuses it…
    expect(isImplausibleIdentity('Increíble', 'Increíble')).toBe(false);
    // …and the cross-field review queue raises it instead, where a curator can
    // clear it in one click (crossChecksCleared) with the scan still readable.
    const rule = CROSS_FIELD_CHECKS.find(c => c.id === 'producer-echoes-name.v1');
    expect(rule).toBeDefined();
    expect(rule.detect({ producer: 'Increíble', name: 'Increíble' }, {})).toBeTruthy();
    // …including for the estates above, which a curator clears once, for good.
    expect(rule.detect({ producer: 'Petrus', name: 'Petrus' }, {})).toBeTruthy();
  });

  test('and it is not a SENTINEL either', () => {
    expect(isIdentitySentinel('Increíble')).toBe(false);
  });
});

describe('dropping the house word is how labels and databases disagree', () => {
  // WAS-BLOCKED by the stop-word-stripped containment term.
  test.each([
    ['Domaine de la Romanée-Conti', 'Romanée-Conti'],
    ['Harlan Estate', 'Harlan'],
    ['Domaine Leflaive', 'Leflaive'],
    ['Weingut Keller', 'Keller'],
    ['Casa Ferreirinha', 'Ferreirinha'],
    ['Viña Vik', 'Vik'],
    ['Duckhorn', 'Duckhorn Vineyards'],
    ['Bodegas Muga', 'Muga Winery'],
    ['Increíble Wines', 'Increíble'],
  ])('producer %p + name %p is PLAUSIBLE', (producer, name) => {
    expect(isImplausibleIdentity(producer, name)).toBe(false);
  });
});

describe('digits are not disqualifying — real houses are named with them', () => {
  // WAS-BLOCKED by the digits-only term.
  test('the Penedès house "1+1=3" (normalizes to 113) and Viña San Pedro\'s "1865"', () => {
    expect(isImplausibleIdentity('1+1=3', 'Cava Brut Nature')).toBe(false);
    expect(isImplausibleIdentity('1865', 'Cabernet Sauvignon')).toBe(false);
  });

  test('so is a bare year — wrong, probably, but nothing here can prove it', () => {
    // WAS-BLOCKED. A producer of "2019" is almost certainly a misplaced vintage,
    // but "almost certainly" is the judgement that condemned 1+1=3 and 1865.
    // It stays pending or gets flagged; it is not refused on shape.
    expect(isImplausibleIdentity('2019', 'Reserva')).toBe(false);
  });

  test('a producer with digits AND letters is fine — "19 Crimes" is a real house', () => {
    expect(isImplausibleIdentity('19 Crimes', 'The Banished')).toBe(false);
  });
});

describe('what STILL blocks — the whole list', () => {
  test('a producer shorter than 2 characters carries no identity', () => {
    expect(isImplausibleIdentity('X', 'Chardonnay')).toBe(true);
    expect(isImplausibleIdentity('.', 'Chardonnay')).toBe(false); // → '' = MISSING, not this predicate's call
  });

  test('a SHORT producer that is nothing but house/stop words', () => {
    expect(isImplausibleIdentity('Domaine', 'Les Pucelles')).toBe(true);
    expect(isImplausibleIdentity('Cantina', 'Barbera')).toBe(true);
    expect(isImplausibleIdentity('Casa', 'Rioja')).toBe(true);
    expect(isImplausibleIdentity('The Wine Estate', 'Merlot')).toBe(true);
  });

  test('…but the length bound keeps a LONG name from being swallowed', () => {
    // WINE_STOP_WORDS is broad ('the', 'de', 'la', 'estate', 'wine'), so a long
    // string can fold to zero tokens without being a placeholder. Above the
    // bound it is a human's call, never a refusal.
    expect(isImplausibleIdentity('Domaine du Château', 'Meursault')).toBe(false);
  });

  test('and that is ALL it blocks', () => {
    // A guard against the predicate quietly regrowing terms: the only inputs in
    // this table that block are the two documented shapes.
    const table = [
      ['Château Margaux', 'Château Margaux', false],
      ['Domaine de la Romanée-Conti', 'Romanée-Conti', false],
      ['1+1=3', 'Cava Brut Nature', false],
      ['Chablis', 'Premier Cru Montmains', false],
      ['X', 'Chardonnay', true],
      ['Domaine', 'Les Pucelles', true],
    ];
    expect(table.map(([p, n]) => isImplausibleIdentity(p, n)))
      .toEqual(table.map(([, , expected]) => expected));
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

  test('the transliterated twin of a Cyrillic row promotes too (audit L-8)', () => {
    // "Мукузани" was exempt via the non-Latin guard while "Mukuzani" — the same
    // Georgian appellation-named wine, transliterated — was condemned by
    // `p === n`. One row promotable and its twin not, on script alone.
    expect(isImplausibleIdentity('Mukuzani', 'Mukuzani')).toBe(false);
    expect(isImplausibleIdentity('Мукузани', 'Мукузани')).toBe(false);
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

  test('INVERTED: "Increíble" as producer of "Increíble" DOES promote now', async () => {
    // It used to be held back, and holding it back also held back Château
    // Margaux, Petrus and 65 others — the hook cannot tell them apart, because
    // the strings are the same shape. It promotes, gets a slug, and lands in
    // the producer-echoes-name.v1 review queue with its label scan readable for
    // 7 more days (services/labelScanAccess).
    const doc = newPending('Increíble');
    doc.producer = 'Increíble';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(true);
  });

  test('a single-wine estate promotes — the case the old rule could not express', async () => {
    const doc = newPending('Château Margaux');
    doc.producer = 'Château Margaux';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });

  test('a producer of nothing but house words still does NOT promote', async () => {
    const doc = newPending('Les Pucelles');
    doc.producer = 'Domaine';
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
    expect(WineDefinition.shouldAssignSlug(doc)).toBe(false);
  });

  /**
   * Audit M-4: the TRANSITION now records itself, so the post-save hook can
   * start the label scan's retention clock on EVERY promoting write path — the
   * admin PUT and /strip-producer promote by setting a producer and saving, and
   * used to stamp nothing, leaving the scan unreadable AND unsweepable.
   */
  test('a promoting save marks itself, so the scan-retention stamp cannot be skipped', async () => {
    const doc = newPending('Sauvignon Blanc');
    doc.producer = 'Cloudy Bay';
    await doc.validate();
    expect(WineDefinition.promotedOnThisSave(doc)).toBe(true);
  });

  test('a save that does NOT promote marks nothing', async () => {
    const doc = newPending('Barolo');
    doc.producer = 'Unknown';
    await doc.validate();
    expect(WineDefinition.promotedOnThisSave(doc)).toBe(false);
  });

  test('an ordinary non-pending save marks nothing either', async () => {
    const doc = newPending('Sauvignon Blanc');
    doc.producer = 'Cloudy Bay';
    doc.pendingIdentity = false;
    await doc.validate();
    expect(WineDefinition.promotedOnThisSave(doc)).toBe(false);
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
