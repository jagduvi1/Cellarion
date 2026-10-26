// The DB loop is not under test; the decision per row is.
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('./lib/backupLog', () => ({ createBackupLog: jest.fn() }));

const { planClassificationFix, CANDIDATES } = require('./normalize-classification-tiers');

describe('normalize-classification-tiers planClassificationFix', () => {
  it('clears a classification that is only the regulatory mark', () => {
    for (const mark of ['DOCG', 'DOC', 'D.O.C.', 'AOC', 'IGT', 'Denominazione di Origine Controllata e Garantita', "Appellation d'Origine Protégée"]) {
      const update = planClassificationFix({ _id: 'w1', classification: mark });
      expect(update.$set.classification).toBeNull();
      expect(update.$set.updatedAt).toBeInstanceOf(Date);
    }
  });

  it('keeps the tier and drops the mark beside it', () => {
    expect(planClassificationFix({ classification: 'Riserva DOCG' }).$set.classification).toBe('Riserva');
    expect(planClassificationFix({ classification: 'Gran Reserva DOCa' }).$set.classification).toBe('Gran Reserva');
  });

  it('leaves a clean row alone', () => {
    expect(planClassificationFix({ classification: 'Grand Cru Classé en 1855' })).toBeNull();
    expect(planClassificationFix({ classification: 'Premier Cru' })).toBeNull();
    expect(planClassificationFix({ classification: 'Kabinett' })).toBeNull();
  });

  it('never touches a canary and skips rows without a classification', () => {
    expect(CANDIDATES.canary).toEqual({ $ne: true });
    expect(CANDIDATES.classification).toEqual({ $nin: [null, ''] });
  });
});
