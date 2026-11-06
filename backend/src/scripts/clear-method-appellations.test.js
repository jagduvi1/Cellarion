// The DB loop is not under test; the decision per row is.
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('./lib/backupLog', () => ({ createBackupLog: jest.fn() }));
jest.mock('../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('./lib/scriptSearch', () => ({ initSearch: jest.fn() }));
// The REAL snapshot — pure and dependency-free; a hand mirror would rot the
// day the field list changes (same reasoning as normalize-classification-tiers.test.js).
jest.mock('../services/enrichmentJob', () => ({
  profileInputsSnapshot: jest.requireActual('../services/enrichmentJob').profileInputsSnapshot,
}));

const { planMethodFix, withoutAppellationSegment } = require('./clear-method-appellations');
const { generateWineKey, pendingWineKey, sweetnessKeySegment, normalizeString } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');
const { profileInputsSnapshot } = require('../services/enrichmentJob');

const row = (over = {}) => {
  const base = { _id: 'w1', name: 'Brut Rosé', producer: 'Scacciadiavoli', country: 'c1', region: 'r1', type: 'sparkling', grapes: ['g1'], ...over };
  // The keys as the rule BEFORE this change wrote them: the method in the last segment.
  const method = normalizeString(base.appellation || '');
  return {
    normalizedKey: `${generateWineKey(base.name, base.producer, '')}${method}`,
    canonicalKey: `${computeCanonicalKey(base.name, base.producer, '')}${method}`,
    ...base,
  };
};

describe('clear-method-appellations planMethodFix', () => {
  it('clears a method-only appellation and empties the appellation segment of both keys', () => {
    const update = planMethodFix(row({ appellation: 'Metodo Classico' }));
    expect(update.$set.appellation).toBeNull();
    expect(update.$set.normalizedKey).toBe(generateWineKey('Brut Rosé', 'Scacciadiavoli', ''));
    expect(update.$set.canonicalKey).toBe(computeCanonicalKey('Brut Rosé', 'Scacciadiavoli', ''));
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves a place beside the method, and a legal name ending in it, for a curator', () => {
    for (const appellation of ['Touraine AOP – Méthode Traditionnelle', 'Asti DOCG Metodo Classico', 'Oltrepò Pavese Metodo Classico', 'Clairette de Die Méthode Dioise Ancestrale', 'Western Cape']) {
      expect(planMethodFix(row({ appellation }))).toBeNull();
    }
  });

  it('keeps a pending row in its namespace and keeps the sweetness suffix', () => {
    const pendingKey = `${pendingWineKey('Brut Rosé', 'u1', '')}${normalizeString('Méthode Traditionnelle')}${sweetnessKeySegment('Brut')}`;
    const update = planMethodFix(row({ appellation: 'Méthode Traditionnelle', normalizedKey: pendingKey }));
    expect(update.$set.normalizedKey).toBe(pendingWineKey('Brut Rosé', 'u1', '', { sweetness: 'Brut' }));
  });

  it('leaves a key that does not end in the method as written', () => {
    const update = planMethodFix(row({ appellation: 'Metodo Classico', normalizedKey: generateWineKey('Brut Rosé', 'Scacciadiavoli', '') }));
    expect(update.$set).not.toHaveProperty('normalizedKey');
    expect(update.$set.appellation).toBeNull();
  });

  it('moves an IN-SYNC profile snapshot along, and leaves a stale one alone', () => {
    const r = row({ appellation: 'Méthode Cap Classique' });
    r.aiProfile = { inputsSnapshot: profileInputsSnapshot(r) };
    expect(planMethodFix(r).$set['aiProfile.inputsSnapshot']).toBe(profileInputsSnapshot({ ...r, appellation: null }));
    const stale = row({ appellation: 'Méthode Cap Classique' });
    stale.aiProfile = { inputsSnapshot: profileInputsSnapshot({ ...stale, name: 'Other' }) };
    expect(planMethodFix(stale).$set).not.toHaveProperty('aiProfile.inputsSnapshot');
  });
});

describe('withoutAppellationSegment', () => {
  it('empties only the last segment', () => {
    expect(withoutAppellationSegment('p:n:metodo classico', 'metodo classico')).toBe('p:n:');
    expect(withoutAppellationSegment('p:n:metodo classico#sw=brut', 'metodo classico')).toBe('p:n:#sw=brut');
    expect(withoutAppellationSegment('p:n:barolo', 'metodo classico')).toBeNull();
    expect(withoutAppellationSegment('', 'metodo classico')).toBeNull();
    expect(withoutAppellationSegment(null, 'metodo classico')).toBeNull();
  });
});
