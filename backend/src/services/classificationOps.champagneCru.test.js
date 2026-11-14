/**
 * The Champagne write rule's half in the classification operations: a cru
 * form in the appellation becomes "Champagne" and the cru is ADDED to the
 * tiers the wine carries, through assignClassification. The rows a wine
 * holds are kept by id, so a tier whose name the string splitter would cut
 * ("Cru Classé (Provence)") survives the move. The taxonomy is primed in
 * memory: no database.
 */
jest.mock('../models/Classification', () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn(), estimatedDocumentCount: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));

const ops = require('./classificationOps');

const FR = 'c'.repeat(23) + '1';
const ROWS = [
  { _id: 'gc', name: 'Grand Cru', kind: 'vineyard_rank', country: FR, synonyms: [] },
  { _id: 'pc', name: 'Premier Cru', kind: 'vineyard_rank', country: FR, synonyms: ['1er Cru'] },
  { _id: 'ov', name: 'Old Vines', kind: 'other', country: null, synonyms: ['Vieilles Vignes'] },
  { _id: 'odd', name: 'Cru Classé (Provence)', kind: 'vineyard_rank', country: FR, synonyms: [] },
  { _id: 'gcc', name: 'Grand Cru Classé', kind: 'vineyard_rank', country: FR, synonyms: ['Cru Classé'] },
];

afterEach(() => ops.primeClassificationCache(null));

describe('moveChampagneCru', () => {
  beforeEach(() => ops.primeClassificationCache(ROWS));

  test('a cru form: appellation Champagne, the cru as a tier', async () => {
    const wine = { appellation: 'Champagne Grand Cru', classification: null, classifications: [], country: FR };
    expect(await ops.moveChampagneCru(wine)).toEqual({ moved: true, cru: 'Grand Cru' });
    expect(wine).toMatchObject({ appellation: 'Champagne', classification: 'Grand Cru', classifications: ['gc'] });
  });

  test('"1er Cru" is the tier Premier Cru', async () => {
    const wine = { appellation: 'champagne 1er cru', country: FR };
    await ops.moveChampagneCru(wine);
    expect(wine).toMatchObject({ appellation: 'Champagne', classification: 'Premier Cru', classifications: ['pc'] });
  });

  test('the tiers the wine holds stay, by id, in kind order', async () => {
    const wine = { appellation: 'Champagne Premier Cru', classification: 'Old Vines', classifications: ['ov'], country: FR };
    await ops.moveChampagneCru(wine);
    expect(wine).toMatchObject({ classification: 'Premier Cru, Old Vines', classifications: ['pc', 'ov'] });
  });

  test('a held tier whose name the splitter would cut is not re-read from its name', async () => {
    const wine = { appellation: 'Champagne Grand Cru', classification: 'Cru Classé (Provence)', classifications: ['odd'], country: FR };
    await ops.moveChampagneCru(wine);
    expect(wine.classifications.sort()).toEqual(['gc', 'odd']);
    expect(wine.classification).toContain('Cru Classé (Provence)');
    expect(wine.classification).not.toContain('Grand Cru Classé');
  });

  test('any other appellation is left alone: Cognac, a named village, Champagne itself', async () => {
    for (const appellation of ['Grande Champagne', 'Petite Champagne', 'Fine Champagne', 'Champagne Grand Cru (Bouzy)', 'Champagne', 'Chablis Grand Cru', null, undefined]) {
      const wine = { appellation, classification: 'Old Vines', classifications: ['ov'], country: FR };
      expect(await ops.moveChampagneCru(wine)).toEqual({ moved: false, cru: null });
      expect(wine).toEqual({ appellation, classification: 'Old Vines', classifications: ['ov'], country: FR });
    }
  });
});

describe('addClassificationTier', () => {
  test('a wine that holds only text gets the tier beside what resolves of it', async () => {
    ops.primeClassificationCache(ROWS);
    const wine = { classification: 'Vieilles Vignes', classifications: [], country: FR };
    await ops.addClassificationTier(wine, 'Grand Cru');
    expect(wine).toMatchObject({ classification: 'Grand Cru, Old Vines', classifications: ['gc', 'ov'] });
  });

  test('with no taxonomy loaded the tier is appended to the string', async () => {
    const wine = { classification: 'Vieilles Vignes', classifications: [] };
    await ops.addClassificationTier(wine, 'Grand Cru');
    expect(wine.classification).toBe('Vieilles Vignes, Grand Cru');
    const bare = {};
    await ops.addClassificationTier(bare, 'Premier Cru');
    expect(bare.classification).toBe('Premier Cru');
  });
});
