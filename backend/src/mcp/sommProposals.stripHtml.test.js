/**
 * propose_wine_correction — proposed identity fields are plain text.
 *
 * The member path (services/wineProposalOps) strips HTML from every proposed
 * text field; the curator's MCP tool must do the same, because a field it
 * files can reach the wine itself on self-apply without an admin reading it.
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
// The self-apply route is mocked: this suite pins what the TOOL files, and
// the apply itself is covered by the admin route's own suite.
jest.mock('../routes/admin/wineProposals', () => ({ approveProposal: jest.fn() }));
jest.mock('../services/proposalDirectApply', () => ({
  classifyProposal: jest.fn(async () => ({ direct: false, reason: 'admin-reviewed' })),
}));
jest.mock('../services/producerSpelling', () => ({
  ...jest.requireActual('../services/producerSpelling'),
  otherProducerSpellings: jest.fn(async () => []),
}));

const WineDefinition = require('../models/WineDefinition');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { classifyProposal } = require('../services/proposalDirectApply');
const { allTools } = require('./registry');
require('./tools/somm');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE_ID = oid('f');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };
const REASON = 'Producer verified on the estate website — the registry row misspells it.';

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const mkWine = () => {
  WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Barolo', producer: 'Pira', appellation: 'Barolo',
    classification: 'DOCG', country: { name: 'Italy' }, region: { name: 'Piedmont' },
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('propose_wine_correction strips HTML from proposed fields', () => {
  test('markup in identity fields is stripped before the proposal is filed and classified', async () => {
    mkWine();
    WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-h' });

    const body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'field_correction',
      proposed_fields: { producer: '<b>Ch. X</b>', classification: '<i>Grand Cru</i> ' },
      reason: REASON,
    }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    const expected = { producer: 'Ch. X', classification: 'Grand Cru' };
    expect(WineCorrectionProposal.create.mock.calls[0][0].proposedFields).toEqual(expected);
    // The self-apply decision sees the same plain text that would be written.
    expect(classifyProposal).toHaveBeenCalledWith(expect.anything(), 'field_correction', expected);
  });

  test('a field that is only markup counts as empty', async () => {
    mkWine();

    const body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'field_correction',
      proposed_fields: { classification: '<i></i>' },
      reason: REASON,
    }, SOMM_CTX));

    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/at least one non-empty field/);
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });
});
