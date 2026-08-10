/**
 * SAME-WINE fragmentation detectors (curator ticket d4a0e96b). Pins the two
 * queue contracts: exact producer+appellation grouping with the
 * disjoint-vintage discriminator (a vintage shared across records ⇒ NOT
 * disjoint — the multi-cuvée signature), the empty-key and dismissed-group
 * suppressions, and for the pair scan: the 1..2 distance window, the ≥5-char
 * key guard, the (country, appellation) bucketing, the >200-wine bucket cap
 * being counted, and pagination applied only AFTER sorting.
 *
 * Producer/appellation keys and levenshteinDistance are the REAL
 * utils/normalize.js functions on purpose — the service must stay composed
 * through them, so these tests break if that composition is bypassed.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ aggregate: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/WineNotDuplicate', () => ({ find: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineNotDuplicate = require('../models/WineNotDuplicate');
const { sameProducerAppellationGroups, nearProducerPairs } = require('./registryFragmentation');

const leanChain = (rows) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(rows) }),
});

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.find.mockReturnValue(leanChain([]));
  Bottle.aggregate.mockResolvedValue([]);
  WineVintageProfile.find.mockReturnValue(leanChain([]));
  WineNotDuplicate.find.mockReturnValue(leanChain([]));
});

describe('sameProducerAppellationGroups', () => {
  const caronne = (over = {}) => ({
    producer: 'Château Caronne Sainte-Gemme', appellation: 'Haut-Médoc', ...over,
  });

  test('groups records on exact producer+appellation keys; disjoint vintages sort as strong candidates', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      caronne({ _id: 'w1', name: 'Haut-Médoc' }),
      caronne({ _id: 'w2', name: 'Cru Bourgeois Haut-Médoc' }),
      { _id: 'w3', name: 'Moulis', producer: 'Château Maucaillou', appellation: 'Moulis' },
    ]));
    Bottle.aggregate.mockResolvedValue([
      { _id: 'w1', count: 3, vintages: ['2016', '2018'] },
      { _id: 'w2', count: 1, vintages: ['2017'] },
    ]);

    const res = await sameProducerAppellationGroups({});
    expect(res.total).toBe(1); // Maucaillou has no key-partner
    expect(res.scannedCount).toBe(3);
    const [g] = res.groups;
    expect(g.producer).toBe('Château Caronne Sainte-Gemme');
    expect(g.appellation).toBe('Haut-Médoc');
    expect(g.disjoint).toBe(true); // no vintage on two records — fragment signature
    expect(g.wines).toEqual([
      { _id: 'w1', name: 'Haut-Médoc', producer: 'Château Caronne Sainte-Gemme', vintages: ['2016', '2018'], bottleCount: 3 },
      { _id: 'w2', name: 'Cru Bourgeois Haut-Médoc', producer: 'Château Caronne Sainte-Gemme', vintages: ['2017'], bottleCount: 1 },
    ]);
  });

  test('a vintage shared across two records makes the group NOT disjoint (multi-cuvée signature)', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      caronne({ _id: 'w1', name: 'A' }),
      caronne({ _id: 'w2', name: 'B' }),
    ]));
    Bottle.aggregate.mockResolvedValue([
      { _id: 'w1', count: 1, vintages: ['2018'] },
      { _id: 'w2', count: 1, vintages: ['2018', '2019'] },
    ]);

    const res = await sameProducerAppellationGroups({});
    expect(res.groups[0].disjoint).toBe(false);
  });

  test('WineVintageProfile vintages count as evidence and "Unknown" does not', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      caronne({ _id: 'w1', name: 'A' }),
      caronne({ _id: 'w2', name: 'B' }),
    ]));
    // Bottles only carry junk on both sides — excluded, so no overlap from them…
    Bottle.aggregate.mockResolvedValue([
      { _id: 'w1', count: 2, vintages: ['Unknown'] },
      { _id: 'w2', count: 1, vintages: ['Unknown', '2015'] },
    ]);
    // …but a curated profile puts 2015 on w1 too → shared → not disjoint.
    WineVintageProfile.find.mockReturnValue(leanChain([
      { wineDefinition: 'w1', vintage: '2015' },
    ]));

    const res = await sameProducerAppellationGroups({});
    const [g] = res.groups;
    expect(g.disjoint).toBe(false);
    expect(g.wines.find(w => w._id === 'w1').vintages).toEqual(['2015']); // Unknown dropped
  });

  test('empty appellation keys and all-stopword producer keys never group', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      { _id: 'w1', name: 'A', producer: 'Guigal', appellation: '' },
      { _id: 'w2', name: 'B', producer: 'Guigal', appellation: null },
      { _id: 'w3', name: 'C', producer: 'Domaine', appellation: 'Tavel' }, // key folds to ''
      { _id: 'w4', name: 'D', producer: 'Cantina', appellation: 'Tavel' }, // key folds to ''
    ]));

    const res = await sameProducerAppellationGroups({});
    expect(res.total).toBe(0);
    expect(res.groups).toEqual([]);
  });

  test('a group whose every pair was dismissed as not-a-duplicate stops resurfacing', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      caronne({ _id: 'a1', name: 'A' }),
      caronne({ _id: 'a2', name: 'B' }),
    ]));
    WineNotDuplicate.find.mockReturnValue(leanChain([{ wineA: 'a1', wineB: 'a2' }]));

    const res = await sameProducerAppellationGroups({});
    expect(res.total).toBe(0);
  });

  test('sorts disjoint-first then size desc, and paginates AFTER sorting', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      // Group P1 ×2 — overlapping vintages (not disjoint)
      { _id: 'p1a', name: 'A', producer: 'Producer One', appellation: 'Barolo' },
      { _id: 'p1b', name: 'B', producer: 'Producer One', appellation: 'Barolo' },
      // Group P2 ×3 — overlapping vintages (not disjoint), bigger
      { _id: 'p2a', name: 'A', producer: 'Producer Two', appellation: 'Barolo' },
      { _id: 'p2b', name: 'B', producer: 'Producer Two', appellation: 'Barolo' },
      { _id: 'p2c', name: 'C', producer: 'Producer Two', appellation: 'Barolo' },
      // Group P3 ×2 — disjoint, must sort first despite being smaller
      { _id: 'p3a', name: 'A', producer: 'Producer Three', appellation: 'Barolo' },
      { _id: 'p3b', name: 'B', producer: 'Producer Three', appellation: 'Barolo' },
    ]));
    Bottle.aggregate.mockResolvedValue([
      { _id: 'p1a', count: 1, vintages: ['2019'] },
      { _id: 'p1b', count: 1, vintages: ['2019'] },
      { _id: 'p2a', count: 1, vintages: ['2020'] },
      { _id: 'p2b', count: 1, vintages: ['2020'] },
      { _id: 'p2c', count: 1, vintages: ['2020'] },
      { _id: 'p3a', count: 1, vintages: ['2018'] },
      { _id: 'p3b', count: 1, vintages: ['2019'] },
    ]);

    const all = await sameProducerAppellationGroups({});
    expect(all.groups.map(g => g.producer)).toEqual(['Producer Three', 'Producer Two', 'Producer One']);

    const page = await sameProducerAppellationGroups({ limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0].producer).toBe('Producer Two'); // second after sorting, not second by insertion
  });
});

describe('nearProducerPairs', () => {
  test('reports producer keys 1–2 edits apart inside one (country, appellation) bucket', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      { _id: 'w1', name: 'Tavel Rosé', producer: 'Pierre Charau', appellation: 'Tavel', country: 'c-fr' },
      { _id: 'w2', name: 'Tavel 2001', producer: 'Pierre Chanau', appellation: 'Tavel', country: 'c-fr' },
      // Same spellings in a DIFFERENT country → different bucket, no pair.
      { _id: 'w3', name: 'X', producer: 'Pierre Charau', appellation: 'Tavel', country: 'c-us' },
      // 3 edits away → outside the window.
      { _id: 'w4', name: 'Y', producer: 'Pierre Chirent', appellation: 'Tavel', country: 'c-fr' },
    ]));

    const res = await nearProducerPairs({});
    expect(res.total).toBe(1);
    expect(res.skippedBuckets).toBe(0);
    const [pair] = res.pairs;
    expect(pair.distance).toBe(1);
    expect(pair.appellation).toBe('Tavel');
    expect(pair.producers.map(p => p.producer).sort()).toEqual(['Pierre Chanau', 'Pierre Charau']);
    expect(pair.producers[0].recordCount).toBe(1);
    expect(pair.producers[0].sampleNames).toHaveLength(1);
  });

  test('equal keys are detector 1\'s job: spelling variants folding to one key never pair', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      // Corp suffix is stripped by normalizeProducerKey → both fold to 'goisot'.
      { _id: 'w1', name: 'A', producer: 'Goisot', appellation: 'Saint-Bris', country: 'c-fr' },
      { _id: 'w2', name: 'B', producer: 'Goisot SARL', appellation: 'Saint-Bris', country: 'c-fr' },
    ]));

    const res = await nearProducerPairs({});
    expect(res.total).toBe(0);
  });

  test('keys shorter than 5 chars never pair — an edit inside a short key is a different word', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      { _id: 'w1', name: 'A', producer: 'Faiveley', appellation: 'Rully', country: 'c-fr' },
      { _id: 'w2', name: 'B', producer: 'Faiveley', appellation: 'Rully', country: 'c-fr' },
      { _id: 'w3', name: 'C', producer: 'Abcd', appellation: 'Rully', country: 'c-fr' },
      { _id: 'w4', name: 'D', producer: 'Abce', appellation: 'Rully', country: 'c-fr' },
    ]));

    const res = await nearProducerPairs({});
    expect(res.total).toBe(0);
  });

  test('buckets over 200 wines are skipped and counted; other buckets still scan', async () => {
    const bigBucket = Array.from({ length: 201 }, (_, i) => ({
      _id: `big${i}`, name: `N${i}`, producer: `Producer Number ${i}`, appellation: 'Bordeaux', country: 'c-fr',
    }));
    WineDefinition.find.mockReturnValue(leanChain([
      ...bigBucket,
      { _id: 'w1', name: 'A', producer: 'Vignoble Guillaume', appellation: 'Franches-Comté', country: 'c-fr' },
      { _id: 'w2', name: 'B', producer: 'Vignoble Guilaume', appellation: 'Franches-Comté', country: 'c-fr' },
      { _id: 'w3', name: 'C', producer: 'No Appellation Here', appellation: '', country: 'c-fr' },
    ]));

    const res = await nearProducerPairs({});
    expect(res.skippedBuckets).toBe(1); // the empty-appellation rows are out of scope, not "skipped"
    expect(res.total).toBe(1);
    expect(res.pairs[0].producers.map(p => p.producer).sort())
      .toEqual(['Vignoble Guilaume', 'Vignoble Guillaume']);
  });

  test('sorts distance asc then most records, samples cap at 3, and paginates AFTER sorting', async () => {
    WineDefinition.find.mockReturnValue(leanChain([
      // distance 2 pair, 4+1 records
      { _id: 'g1', name: 'Blanc de Blancs', producer: 'Goisot', appellation: 'Chablis', country: 'c-fr' },
      { _id: 'g2', name: 'Vieilles Vignes', producer: 'Goisot', appellation: 'Chablis', country: 'c-fr' },
      { _id: 'g3', name: 'Cuvée Prestige', producer: 'Goisot', appellation: 'Chablis', country: 'c-fr' },
      { _id: 'g4', name: 'Réserve', producer: 'Goisot', appellation: 'Chablis', country: 'c-fr' },
      { _id: 'g5', name: 'Grande Réserve', producer: 'Gosset', appellation: 'Chablis', country: 'c-fr' },
      // distance 1 pair — must sort first despite fewer records
      { _id: 'p1', name: 'Tavel', producer: 'Pierre Charau', appellation: 'Tavel', country: 'c-fr' },
      { _id: 'p2', name: 'Tavel', producer: 'Pierre Chanau', appellation: 'Tavel', country: 'c-fr' },
    ]));

    const all = await nearProducerPairs({});
    expect(all.total).toBe(2);
    expect(all.pairs.map(p => p.distance)).toEqual([1, 2]);
    const goisotSide = all.pairs[1].producers[0]; // most records first within the pair
    expect(goisotSide.producer).toBe('Goisot');
    expect(goisotSide.recordCount).toBe(4);
    expect(goisotSide.sampleNames).toHaveLength(3);

    const page = await nearProducerPairs({ limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.pairs).toHaveLength(1);
    expect(page.pairs[0].distance).toBe(2); // second after sorting
  });
});
