/**
 * Champagne's Premier Cru and Grand Cru rate the village, not the appellation:
 * a cru typed into the appellation is the appellation Champagne plus a tier
 * (docs/wine-fields.md). Only the appellation Champagne followed by exactly a
 * cru rank counts, and every identity key reads such a value as Champagne, so
 * a wine typed with the cru has the key of the wine stored without it.
 */
const { CHAMPAGNE, champagneCruOf, withoutChampagneCru, splitChampagneCru, foldAppellation } = require('./champagneCru');
const { normalizeAppellationKey, generateWineKey, pendingWineKey, draftWineKey } = require('./normalize');
const { computeCanonicalKey } = require('./wineIdentity');

const GRAND = ['Champagne Grand Cru', 'champagne grand cru', 'CHAMPAGNE GRAND CRU', '  Champagne   Grand  Cru ', 'Champagne Grand Crû', 'Champagne Grand-Cru', 'Champagne, Grand Cru', 'Champagne (Grand Cru)'];
const PREMIER = ['Champagne Premier Cru', 'champagne premier cru', 'Champagne 1er Cru', 'champagne 1er cru', 'Champagne  1ER  CRU', 'Chămpagne Premier Cru', 'Champagne Premier-Cru'];
const NOT_A_CRU_FORM = [
  'Champagne', 'Grande Champagne', 'Petite Champagne', 'Fine Champagne', 'Ratafia de Champagne',
  'Coteaux Champenois', 'Rosé des Riceys', 'Champagne Grand Cru (Bouzy)', 'Champagne Grand Cru (Cramant)',
  'Champagne Grand Cru Bouzy', 'Champagne Premier Cru Brut', 'Grand Cru Champagne', 'Grande Champagne Premier Cru',
  'Chablis Grand Cru', 'Alsace Grand Cru', 'Saint-Émilion Grand Cru', 'Corton Grand Cru', 'Champagne Cru',
  'Champagne Grand', 'Champagne Grand Cru Classé', 'Champagne 2ème Cru', '', '   ', null, undefined, 42, {},
];

describe('champagneCruOf', () => {
  test('the three forms, whatever the case, accents, spacing and punctuation', () => {
    for (const v of GRAND) expect([v, champagneCruOf(v)]).toEqual([v, 'Grand Cru']);
    for (const v of PREMIER) expect([v, champagneCruOf(v)]).toEqual([v, 'Premier Cru']);
  });

  test('Champagne alone, Cognac\'s crus, the other appellations of the region and a named village are not', () => {
    for (const v of NOT_A_CRU_FORM) expect([v, champagneCruOf(v)]).toEqual([v, null]);
  });

  test('its fold is the appellation key\'s fold', () => {
    for (const v of [...GRAND, ...PREMIER, ...NOT_A_CRU_FORM.filter((x) => typeof x === 'string'), 'Châteauneuf-du-Pape', 'Côte-Rôtie  (AOC)', "Barbera d'Asti", 'Mâcon–Villages']) {
      expect([v, foldAppellation(v)]).toEqual([v, normalizeAppellationKey(v)]);
    }
  });
});

describe('withoutChampagneCru and splitChampagneCru', () => {
  test('a cru form reads as Champagne, anything else as given', () => {
    expect(withoutChampagneCru('Champagne Grand Cru')).toBe(CHAMPAGNE);
    expect(withoutChampagneCru('champagne 1er cru')).toBe('Champagne');
    for (const v of ['Champagne', 'Grande Champagne', 'Champagne Grand Cru (Bouzy)', 'Barolo', '', null, undefined]) {
      expect(withoutChampagneCru(v)).toBe(v);
    }
  });

  test('the cru joins the classification that was given, and is never the only thing lost', () => {
    expect(splitChampagneCru('Champagne Grand Cru', null)).toEqual({ appellation: 'Champagne', classification: 'Grand Cru', cru: 'Grand Cru' });
    expect(splitChampagneCru('Champagne 1er Cru', '  ')).toEqual({ appellation: 'Champagne', classification: 'Premier Cru', cru: 'Premier Cru' });
    expect(splitChampagneCru('champagne premier cru', 'Old Vines')).toEqual({ appellation: 'Champagne', classification: 'Premier Cru, Old Vines', cru: 'Premier Cru' });
  });

  test('another appellation comes back untouched, with its classification', () => {
    expect(splitChampagneCru('Grande Champagne', 'XO')).toEqual({ appellation: 'Grande Champagne', classification: 'XO', cru: null });
    expect(splitChampagneCru('Champagne Grand Cru (Bouzy)', null)).toEqual({ appellation: 'Champagne Grand Cru (Bouzy)', classification: null, cru: null });
    expect(splitChampagneCru(null, undefined)).toEqual({ appellation: null, classification: undefined, cru: null });
  });
});

describe('the identity keys read a cru form as Champagne', () => {
  const FORMS = ['Champagne Grand Cru', 'Champagne Premier Cru', 'Champagne 1er Cru', 'champagne  grand cru', 'CHAMPAGNE 1ER CRU'];

  test('generateWineKey, pendingWineKey and draftWineKey', () => {
    for (const form of FORMS) {
      expect([form, generateWineKey('Clos du Mesnil', 'Maison Exemple', form)]).toEqual([form, generateWineKey('Clos du Mesnil', 'Maison Exemple', 'Champagne')]);
      expect([form, pendingWineKey('Clos du Mesnil', 'u1', form)]).toEqual([form, pendingWineKey('Clos du Mesnil', 'u1', 'Champagne')]);
      expect([form, draftWineKey('Clos du Mesnil', 'Maison Exemple', 'u1', form)]).toEqual([form, draftWineKey('Clos du Mesnil', 'Maison Exemple', 'u1', 'Champagne')]);
    }
    expect(generateWineKey('Clos du Mesnil', 'Maison Exemple', 'Champagne Grand Cru')).toBe('maison exemple:clos du mesnil:champagne');
    // The label sweetness suffix still rides along.
    expect(generateWineKey('Blanc de Blancs', 'Maison Exemple', 'Champagne Grand Cru', { sweetness: 'Extra Brut' }))
      .toBe(generateWineKey('Blanc de Blancs', 'Maison Exemple', 'Champagne', { sweetness: 'Extra Brut' }));
  });

  test('computeCanonicalKey, also behind a regulatory mark', () => {
    for (const form of [...FORMS, 'Champagne Grand Cru AOC', 'AOP Champagne Premier Cru']) {
      expect([form, computeCanonicalKey('Clos du Mesnil', 'Maison Exemple', form)]).toEqual([form, computeCanonicalKey('Clos du Mesnil', 'Maison Exemple', 'Champagne')]);
    }
    expect(computeCanonicalKey('Blanc de Blancs', 'Maison Exemple', 'Champagne 1er Cru', { sweetness: 'Brut' }))
      .toBe(computeCanonicalKey('Blanc de Blancs', 'Maison Exemple', 'Champagne', { sweetness: 'Brut' }));
  });

  test('Cognac, the other Champagne-region appellations and a named village key exactly as before', () => {
    const cases = [
      ['Grande Champagne', 'grande champagne'], ['Petite Champagne', 'petite champagne'], ['Fine Champagne', 'fine champagne'],
      ['Ratafia de Champagne', 'ratafia de champagne'], ['Coteaux Champenois', 'coteaux champenois'], ['Rosé des Riceys', 'rose des riceys'],
      ['Champagne Grand Cru (Bouzy)', 'champagne grand cru bouzy'], ['Champagne', 'champagne'],
      ['Chablis Grand Cru', 'chablis grand cru'], ['Corton Grand Cru', 'corton grand cru'],
    ];
    for (const [appellation, segment] of cases) {
      expect(generateWineKey('XO', 'Maison Exemple', appellation)).toBe(`maison exemple:xo:${segment}`);
      expect(computeCanonicalKey('XO', 'Maison Exemple', appellation).endsWith(`:${segment}`)).toBe(true);
      expect(pendingWineKey('XO', 'u1', appellation).endsWith(`:${segment}`)).toBe(true);
      expect(draftWineKey('XO', 'Maison Exemple', 'u1', appellation).endsWith(`:${segment}`)).toBe(true);
    }
  });
});
