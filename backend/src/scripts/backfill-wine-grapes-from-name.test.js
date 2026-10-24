// The meilisearch package is ESM and Jest cannot load it; the script only
// needs the handles.
jest.mock('../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('./lib/scriptSearch', () => ({ initSearch: jest.fn() }));

const { CANDIDATES, buildGrapeWrite } = require('./backfill-wine-grapes-from-name');

const EMPTY_GRAPES = { $or: [{ grapes: { $exists: false } }, { grapes: { $size: 0 } }] };
const row = { _id: 'w1', name: 'Block 3 Pinot Noir', producer: 'Felton Road', grapes: [] };

describe('backfill-wine-grapes-from-name', () => {
  it('reads only empty-grape rows of this install, never Registry Bridge copies', () => {
    expect(CANDIDATES).toEqual({ ...EMPTY_GRAPES, registryId: null });
  });

  it('re-checks both in the write filter, so an adopted copy or grapes set since the read are never written', () => {
    const { filter } = buildGrapeWrite(row, ['g1']);
    expect(filter).toEqual({ _id: 'w1', ...EMPTY_GRAPES, registryId: null });
  });

  it('sets the grapes and moves updatedAt', () => {
    const { update } = buildGrapeWrite(row, ['g1', 'g2']);
    expect(update.$set.grapes).toEqual(['g1', 'g2']);
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
  });

  it('drops the cross-field clearance with its timestamp, as a save that changes grapes does', () => {
    const { update } = buildGrapeWrite(row, ['g1']);
    expect(update.$unset).toEqual({ crossChecksCleared: '' });
    expect(update.$set.crossChecksClearedAt).toBeNull();
  });
});
