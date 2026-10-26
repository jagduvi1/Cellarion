// The DB loop is not under test; the decision per row is.
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('./lib/backupLog', () => ({ createBackupLog: jest.fn() }));
// The REAL snapshot — pure and dependency-free; a hand mirror would rot the
// day the field list changes (same reasoning as wines.reenrichOnEdit.test.js).
jest.mock('../services/enrichmentJob', () => ({
  profileInputsSnapshot: jest.requireActual('../services/enrichmentJob').profileInputsSnapshot,
}));

const { planClassificationFix, CANDIDATES } = require('./normalize-classification-tiers');
const { profileInputsSnapshot } = require('../services/enrichmentJob');

const row = (over = {}) => ({
  _id: 'w1', name: 'Barolo', producer: 'Azelia', country: 'c1', region: 'r1',
  appellation: 'Barolo', type: 'red', grapes: ['g1'], ...over,
});

describe('normalize-classification-tiers planClassificationFix', () => {
  it('clears a classification that is only the regulatory mark', () => {
    for (const mark of ['DOCG', 'DOC', 'D.O.C.', '(DOCG)', 'AOC', 'IGT', 'DAC', 'Denominazione di Origine Controllata e Garantita', "Appellation d'Origine Protégée", 'Appellation Pauillac Contrôlée']) {
      const update = planClassificationFix(row({ classification: mark }));
      expect(update.$set.classification).toBeNull();
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    }
  });

  it('keeps the tier and drops the mark beside it', () => {
    expect(planClassificationFix(row({ classification: 'Riserva DOCG' })).$set.classification).toBe('Riserva');
    expect(planClassificationFix(row({ classification: 'Gran Reserva DOCa' })).$set.classification).toBe('Gran Reserva');
  });

  it('leaves a clean row alone', () => {
    expect(planClassificationFix(row({ classification: 'Grand Cru Classé en 1855' }))).toBeNull();
    expect(planClassificationFix(row({ classification: 'Premier Cru' }))).toBeNull();
    expect(planClassificationFix(row({ classification: 'Kabinett' }))).toBeNull();
  });

  it('moves an IN-SYNC profile snapshot along, so the cleanup queues no regeneration', () => {
    const r = row({ classification: 'DOCG' });
    r.aiProfile = { inputsSnapshot: profileInputsSnapshot(r) };
    const update = planClassificationFix(r);
    expect(update.$set['aiProfile.inputsSnapshot']).toBe(profileInputsSnapshot({ ...r, classification: null }));
    expect(update.$set['aiProfile.inputsSnapshot']).not.toBe(r.aiProfile.inputsSnapshot);
  });

  it('leaves an already-stale snapshot, and a row without one, as they are', () => {
    const stale = row({ classification: 'DOCG' });
    stale.aiProfile = { inputsSnapshot: profileInputsSnapshot({ ...stale, name: 'Barolo Riserva' }) };
    expect(planClassificationFix(stale).$set).not.toHaveProperty('aiProfile.inputsSnapshot');
    expect(planClassificationFix(row({ classification: 'DOCG' })).$set).not.toHaveProperty('aiProfile.inputsSnapshot');
  });

  it('never touches a canary and skips rows without a classification', () => {
    expect(CANDIDATES.canary).toEqual({ $ne: true });
    expect(CANDIDATES.classification).toEqual({ $nin: [null, ''] });
  });
});
