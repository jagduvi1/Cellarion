/**
 * propose_wine_correction — a proposed classification follows the member
 * path's filing rules (services/wineProposalOps).
 *
 * Approval resolves a classification strictly: a regulatory mark applies as
 * nothing and a tier the registry does not list is refused. A curator has to
 * learn that while filing, not from a proposal that was approved and changed
 * nothing. So at filing:
 *   - a regulatory mark (DOCG, AOC …) is refused, and nothing else in the same
 *     call is filed either;
 *   - a tier is resolved against the classification list and recorded under
 *     its canonical name; one the list does not hold is refused;
 *   - a word two tier systems share is settled by the wine's country.
 *
 * The classification list is primed in memory; the models are mocked.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ create: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/wineProposalDecisionOps', () => ({ approveProposal: jest.fn() }));
jest.mock('../services/proposalDirectApply', () => ({
  classifyProposal: jest.fn(async () => ({ direct: false, reason: 'admin-reviewed' })),
}));
jest.mock('../services/producerSpelling', () => ({
  ...jest.requireActual('../services/producerSpelling'),
  otherProducerSpellings: jest.fn(async () => []),
}));

const WineDefinition = require('../models/WineDefinition');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { primeClassificationCache } = require('../services/classificationOps');
const { allTools } = require('./registry');
require('./tools/somm');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE_ID = oid('f');
const ITALY = oid('1');
const AUSTRIA = oid('2');
const GERMANY = oid('3');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };
const REASON = 'The back label and the estate site both state the tier.';

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const propose = async (proposed_fields) => parse(await tool('propose_wine_correction').handler(
  { wine_id: WINE_ID, kind: 'field_correction', proposed_fields, reason: REASON }, SOMM_CTX));
const filed = () => WineCorrectionProposal.create.mock.calls[0][0].proposedFields;

const mkWine = (country = { _id: ITALY, name: 'Italy' }) => {
  WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Barolo', producer: 'Pira', appellation: 'Barolo', classification: null, country, region: null,
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
  WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-c' });
  primeClassificationCache([
    { _id: 'c-riserva', name: 'Riserva', kind: 'ageing', country: ITALY, synonyms: ['Reserva'] },
    { _id: 'c-ort-at', name: 'Ortswein', kind: 'vineyard_rank', country: AUSTRIA, synonyms: [] },
    { _id: 'c-ort-de', name: 'VDP.Ortswein', kind: 'vineyard_rank', country: GERMANY, synonyms: ['Ortswein'] },
  ]);
});

afterAll(() => primeClassificationCache(null));

test('a regulatory mark is refused, and the other fields of the call are not filed without it', async () => {
  mkWine();
  const body = await propose({ classification: 'DOCG', appellation: 'Barolo Riserva' });
  expect(body.error.code).toBe('invalid_input');
  expect(body.error.message).toMatch(/"DOCG" is a regulatory mark, not a classification tier/);
  expect(WineDefinition.findById).not.toHaveBeenCalled();
  expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
});

test('a tier the classification list does not hold is refused at filing, naming what it does hold', async () => {
  mkWine();
  const body = await propose({ classification: 'Extra Special Selection' });
  expect(body.error.code).toBe('invalid_input');
  expect(body.error.message).toMatch(/"Extra Special Selection" is not in the registry's classification list/);
  expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
});

test('a listed tier is filed under its canonical name, whichever spelling was sent', async () => {
  mkWine();
  expect((await propose({ classification: ' reserva ' })).error).toBeUndefined();
  expect(filed()).toEqual({ classification: 'Riserva' });
});

test("a word two tier systems share is settled by the wine's country", async () => {
  mkWine({ _id: GERMANY, name: 'Germany' });
  expect((await propose({ classification: 'Ortswein' })).error).toBeUndefined();
  expect(filed()).toEqual({ classification: 'VDP.Ortswein' });

  jest.clearAllMocks();
  WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-c' });
  mkWine({ _id: AUSTRIA, name: 'Austria' });
  expect((await propose({ classification: 'Ortswein' })).error).toBeUndefined();
  expect(filed()).toEqual({ classification: 'Ortswein' });
});

test('with no classification list loaded, the cleaned tier is filed as sent', async () => {
  primeClassificationCache(null);
  mkWine();
  expect((await propose({ classification: 'Grand Cru' })).error).toBeUndefined();
  expect(filed()).toEqual({ classification: 'Grand Cru' });
});
