/**
 * listUnmatchedAppellations — the queue must see through decoration the same
 * way the resolver does (release-audit F2 on PR #951).
 *
 * The failure this pins: "Yecla DO" on wines, curated doc "Yecla". The exact
 * key 'yecla do' is not in the matched set, so the old code LISTED it — and
 * the tool description says "promote the real ones", so an admin promotes
 * "Yecla DO", minting a doc whose exact-match hit permanently beats the
 * resolver's stripped variant. Coverage must be judged on the resolver's
 * candidateKeys, so a decorated string governed by a curated doc never
 * reaches the queue at all.
 */

jest.mock('../models/WineDefinition', () => ({ aggregate: jest.fn() }));
jest.mock('../models/Appellation', () => ({ find: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const Appellation = require('../models/Appellation');
const Country = require('../models/Country');
const Region = require('../models/Region');
const { listUnmatchedAppellations } = require('./taxonomyReview');

const lean = (result) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) });

beforeEach(() => {
  jest.clearAllMocks();
  Country.find.mockReturnValue(lean([]));
  Region.find.mockReturnValue(lean([]));
});

test('a decorated string covered by a curated doc is NOT listed; the genuinely unknown is', async () => {
  Appellation.find.mockReturnValue(lean([{ normalizedName: 'yecla', normalizedSynonyms: [] }]));
  WineDefinition.aggregate.mockResolvedValue([
    { _id: { ap: 'Yecla DO', country: null, region: null }, n: 2 },
    { _id: { ap: 'Heathcote', country: null, region: null }, n: 15 },
  ]);

  const items = await listUnmatchedAppellations();

  expect(items.map((i) => i.name)).toEqual(['Heathcote']);
});

test('the AOC wrapper is coverage too — "Appellation Bordeaux Contrôlée" never asks to be promoted', async () => {
  Appellation.find.mockReturnValue(lean([{ normalizedName: 'bordeaux', normalizedSynonyms: [] }]));
  WineDefinition.aggregate.mockResolvedValue([
    { _id: { ap: 'Appellation Bordeaux Contrôlée', country: null, region: null }, n: 1 },
  ]);

  expect(await listUnmatchedAppellations()).toEqual([]);
});

test('an uncovered decorated string still lists — the gate is membership, not the decoration', async () => {
  Appellation.find.mockReturnValue(lean([]));
  WineDefinition.aggregate.mockResolvedValue([
    { _id: { ap: 'Somewhere DO', country: null, region: null }, n: 3 },
  ]);

  const items = await listUnmatchedAppellations();
  expect(items).toHaveLength(1);
  expect(items[0].wineCount).toBe(3);
});
