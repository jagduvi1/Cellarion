/**
 * H-4 — isIdentitySentinel must be UNICODE-AWARE.
 *
 * normalizeString emits `[a-z0-9 ]` only, so it strips every non-Latin script
 * outright: "Мукузани", "ქართული ღვინო", "獺祭" and "Δομαίν" all normalized to
 * '' and the empty result read as "this producer is MISSING". Two things broke.
 *
 *   (a) At mint the user's typed producer was discarded and the wine hidden —
 *       where before the pending-identity feature they at least got a clear 400.
 *   (b) At PROMOTION the WineDefinition pre-validate hook consults this same
 *       predicate, so a curator typing the producer exactly as printed on the
 *       label could never promote the row. It stayed hidden forever.
 *
 * (b) is what this file is really about: it is the one that could not be
 * recovered from through the product. The mint-side residue is documented at
 * services/findOrCreateWine (the producerNorm.length < 2 gate) — the registry's
 * normalizedKey is ASCII-only, so STORING such a producer needs a script-aware
 * key namespace, which is a registry-wide change and not this remediation.
 */
const mongoose = require('mongoose');
const { isIdentitySentinel } = require('./normalize');
const WineDefinition = require('../models/WineDefinition');

describe('genuine sentinels still are sentinels (no regression)', () => {
  test.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['-', 'a dash'],
    ['?', 'a question mark'],
    ['!!!', 'punctuation only'],
    ['Unknown', 'the English placeholder'],
    ['unknown', 'lowercased'],
    ['UNKNOWN', 'shouted'],
    ['N/A', 'the abbreviation — punctuation is stripped to "na"'],
    ['Okänd', 'Swedish, diacritics folded to "okand"'],
    ['Inconnu', 'French'],
    ['Unbekannt', 'German'],
    ['no producer', 'the two-word form'],
    ['Producer Unknown', 'the reversed two-word form'],
    ['Domaine Unknown', 'the wine-shaped form'],
    ['Unknown Winery', 'the other wine-shaped form'],
  ])('%j is a sentinel (%s)', (value) => {
    expect(isIdentitySentinel(value)).toBe(true);
  });

  test('a non-string carries no information either', () => {
    for (const v of [null, undefined, 5, {}, []]) expect(isIdentitySentinel(v)).toBe(true);
  });
});

describe('NON-LATIN producers are real information, not a missing value', () => {
  test.each([
    ['Мукузани', 'Cyrillic (Georgian wine, Russian spelling)'],
    ['ქართული ღვინო', 'Georgian (Mkhedruli)'],
    ['獺祭', 'Japanese (Dassai)'],
    ['Δομαίν', 'Greek, with a diacritic that NFD decomposes'],
    ['שדה בוקר', 'Hebrew'],
    ['شاتو مصر', 'Arabic'],
    ['장수막걸리', 'Korean'],
    ['張裕', 'Chinese'],
  ])('%j is NOT a sentinel (%s)', (value) => {
    expect(isIdentitySentinel(value)).toBe(false);
  });

  test('a MIXED value is judged on what it contains, not on the Latin fragment', () => {
    // normalizeString folds this to exactly 'unknown' (the Cyrillic is stripped),
    // which the sentinel regex matches — so the check has to happen BEFORE the fold.
    expect(isIdentitySentinel('Unknown Мукузани')).toBe(false);
  });
});

describe('ordinary Latin producers are unaffected', () => {
  test.each([
    ['Château Margaux'],
    ['Weingut Müller-Catoir'],
    ['Østerberg'],
    ['Viña Errázuriz'],
    ['A'],
    ['123'],
  ])('%j is not a sentinel', (value) => {
    expect(isIdentitySentinel(value)).toBe(false);
  });
});

describe('(b) the consequence that mattered: promotion works', () => {
  const pendingDoc = (producer) => new WineDefinition({
    name: 'Kaefferkopf',
    producer,
    country: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    normalizedKey: 'pending~aaa:kaefferkopf:',
    pendingIdentity: true,
  });

  test('a curator typing a CYRILLIC producer promotes the row', async () => {
    const doc = pendingDoc('Мукузани');
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });

  test('a curator typing a CJK producer promotes the row', async () => {
    const doc = pendingDoc('獺祭');
    await doc.validate();
    expect(doc.pendingIdentity).toBe(false);
  });

  test('a curator typing "Unknown" still does NOT promote it', async () => {
    const doc = pendingDoc('Unknown');
    await doc.validate();
    expect(doc.pendingIdentity).toBe(true);
  });
});
