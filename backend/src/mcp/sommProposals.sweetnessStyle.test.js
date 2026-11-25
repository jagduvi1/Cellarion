/**
 * propose_wine_correction — a proposed sweetness style.
 *
 * WHY THIS TEST EXISTS:
 * The curator's tool spells the style sweetness_style { term, source,
 * source_url }; the proposal stores sweetnessStyle { term, source, url }, as
 * the member path does, and approval applies both with the same rule. The
 * tool must translate in both directions, say at filing what the write rule
 * would refuse at approval, and apply on filing only a style the rule would
 * write as filed on a wine that has none (services/proposalDirectApply — the
 * real one here, since which styles apply is what is pinned).
 *
 * The sweetness terms are primed in memory from the seed table; the models
 * are mocked.
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

const WineDefinition = require('../models/WineDefinition');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { approveProposal } = require('../services/wineProposalDecisionOps');
const sweetness = require('../services/sweetnessOps');
const seed = require('../data/sweetness-terms.json');
const { allTools } = require('./registry');
require('./tools/somm');

const oid = (c) => c.repeat(24);
const hex = (n) => n.toString(16).padStart(24, '0');
const ROWS = seed.map((r, i) => ({ _id: hex(i + 1), country: null, ...r }));
const termId = (name, scale = 'still') => ROWS.find((r) => r.name === name && r.scale === scale)._id;
const ME = oid('a');
const WINE_ID = oid('f');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };
const REASON = 'Two merchants list this cuvée as feinherb.';
const TRADE_URL = 'https://merchant.example/riesling-kabinett';

const tool = () => allTools().find((t) => t.name === 'propose_wine_correction');
const parse = (res) => JSON.parse(res.content[0].text);
const propose = async (proposed_fields, extra = {}) => parse(await tool().handler(
  { wine_id: WINE_ID, kind: 'field_correction', proposed_fields, reason: REASON, ...extra }, SOMM_CTX));
const filed = () => WineCorrectionProposal.create.mock.calls[0][0];

const mkWine = (over = {}) => {
  WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Riesling Kabinett', producer: 'Weingut Beispiel', type: 'white', appellation: 'Mosel',
    classification: null, country: { _id: oid('3'), name: 'Germany' }, region: { name: 'Mosel' },
    labelSweetness: null, sweetnessStyle: null, sweetnessReview: null, ...over,
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
  sweetness.primeSweetnessCache(ROWS);
  WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-s' });
  approveProposal.mockResolvedValue({ status: 200, body: { appliedNote: 'Applied: sweetness style' } });
  mkWine();
});

afterAll(() => sweetness.primeSweetnessCache(null));

test('a style is filed as sweetnessStyle { term, source, url } under the table\'s spelling, and applies on a wine that has none', async () => {
  const body = await propose({ sweetness_style: { term: 'Feinherb', source: 'trade', source_url: TRADE_URL } });
  expect(filed().proposedFields).toEqual({ sweetnessStyle: { term: 'feinherb', source: 'trade', url: TRADE_URL } });
  expect(filed().currentSnapshot.sweetnessStyle).toBeNull();
  expect(approveProposal).toHaveBeenCalledWith('prop-s', SOMM_CTX.req);
  expect(body.data).toMatchObject({
    status: 'approved', applied_note: 'Applied: sweetness style',
    proposed_fields: { sweetness_style: { term: 'feinherb', source: 'trade', source_url: TRADE_URL } },
  });
  expect(body.data.proposed_fields).not.toHaveProperty('sweetnessStyle');
});

test('evidence_url names the page when the style carries no link; with neither, nothing is filed', async () => {
  await propose({ sweetness_style: { term: 'feinherb', source: 'trade' } }, { evidence_url: TRADE_URL });
  expect(filed().proposedFields.sweetnessStyle.url).toBe(TRADE_URL);

  WineCorrectionProposal.create.mockClear();
  const body = await propose({ sweetness_style: { term: 'feinherb', source: 'trade' } });
  expect(body.error.code).toBe('invalid_input');
  expect(body.error.message).toMatch(/needs source_url \(or evidence_url\)/);
  expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
});

test('a term with a legal definition from the trade is refused at filing, in the tool\'s own field name', async () => {
  const body = await propose({ sweetness_style: { term: 'halbtrocken', source: 'trade', source_url: TRADE_URL } });
  expect(body.error.code).toBe('invalid_input');
  expect(body.error.message).toMatch(/^proposed_fields\.sweetness_style: /);
  expect(body.error.message).toMatch(/only the producer names it/);
  expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
});

test('a style the label\'s own term contradicts is refused at filing', async () => {
  mkWine({ labelSweetness: termId('trocken') });
  const body = await propose({ sweetness_style: { term: 'feinherb', source: 'trade', source_url: TRADE_URL } });
  expect(body.error.message).toMatch(/the label states "trocken"/);
  expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
});

test('a different style on a wine that has one is filed for an admin, with the recorded one in the snapshot', async () => {
  mkWine({ sweetnessStyle: { term: { _id: termId('fruchtsüß'), name: 'fruchtsüß' }, source: 'trade', url: 'https://critic.example/note' } });
  const body = await propose({ sweetness_style: { term: 'feinherb', source: 'producer', source_url: TRADE_URL } });
  expect(approveProposal).not.toHaveBeenCalled();
  expect(filed().currentSnapshot.sweetnessStyle).toBe('fruchtsüß (trade)');
  expect(body.data).toMatchObject({ status: 'pending' });
  expect(body.data.why_reviewed).toMatch(/sweetnessStyle already has a value/);
});

test('the description says a style on a wine that has none applies immediately', () => {
  expect(tool().description).toMatch(/So does a sweetness_style on a wine that has none/);
});
