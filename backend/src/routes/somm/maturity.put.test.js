/**
 * PUT /api/somm/maturity/:id — a curator sets a vintage's drink window.
 *
 * Pins today's contract before the write path moves into services/maturityOps:
 *   - every phase field sent is stored (null clears), a field not sent is left
 *     as it was, the note is trimmed, the row becomes reviewed with the
 *     curator's stamp, relative is false for a year vintage
 *   - an NV row takes offsets 0–100 and becomes relative
 *   - a non-number, an out-of-range year or an out-of-order pair is a 400 and
 *     nothing is saved
 *   - the owners' data version moves once, after the save; the audit row is
 *     somm.maturity.review with the vintage and the relative flag
 *   - unknown id 404, plain member 403
 *
 * Real router + real requireAuth/requireSommOrAdmin (HS256 test tokens); the
 * model is mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));
jest.mock('../../services/labelScan', () => ({ suggestDrinkWindow: jest.fn() }));
jest.mock('../../models/WineVintageProfile', () => ({ findById: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineVintageProfile = require('../../models/WineVintageProfile');
const { logAudit } = require('../../services/audit');
const { bumpWineOwners } = require('../../services/dataVersion');
const maturityRouter = require('./maturity');

const SOMM_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000ee';
const PROFILE_ID = '64b0000000000000000000aa';
const PHASES = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];

const profileDoc = (over = {}) => ({
  _id: PROFILE_ID,
  wineDefinition: WINE_ID,
  vintage: '2018',
  status: 'pending',
  sommNotes: '',
  setBy: null,
  setAt: null,
  save: jest.fn().mockResolvedValue(undefined),
  populate: jest.fn().mockResolvedValue(undefined),
  ...over,
});

function put(body, { id = PROFILE_ID, roles = ['somm'] } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/somm/maturity', maturityRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const token = jwt.sign({ id: SOMM_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      const req = http.request(
        { port: server.address().port, path: `/api/somm/maturity/${id}`, method: 'PUT', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(JSON.stringify(body));
    });
  });
}

beforeEach(() => jest.clearAllMocks());

test('a full window is stored, the note trimmed, the row reviewed and stamped; owners bumped once after the save; audited', async () => {
  const doc = profileDoc();
  WineVintageProfile.findById.mockResolvedValue(doc);

  const res = await put({ earlyFrom: '2022', earlyUntil: 2025, peakFrom: 2026, peakUntil: 2032, lateFrom: 2033, lateUntil: 2040, sommNotes: '  Firm tannins.  ' });

  expect(res.status).toBe(200);
  expect(doc).toMatchObject({ earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2032, lateFrom: 2033, lateUntil: 2040 });
  expect(doc.sommNotes).toBe('Firm tannins.');
  expect(doc.status).toBe('reviewed');
  expect(doc.relative).toBe(false);
  expect(doc.setBy).toBe(SOMM_ID);
  expect(doc.setAt).toBeInstanceOf(Date);
  expect(doc.save).toHaveBeenCalledTimes(1);
  expect(bumpWineOwners).toHaveBeenCalledTimes(1);
  expect(bumpWineOwners).toHaveBeenCalledWith([WINE_ID]);
  expect(bumpWineOwners.mock.invocationCallOrder[0]).toBeGreaterThan(doc.save.mock.invocationCallOrder[0]);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'somm.maturity.review',
    { type: 'wine', id: WINE_ID }, { vintage: '2018', relative: false });
  expect(res.body.profile.status).toBe('reviewed');
});

test('a field not sent keeps its stored value; null clears a field; an empty note is stored empty', async () => {
  const doc = profileDoc({ status: 'reviewed', earlyFrom: 2020, earlyUntil: 2023, peakFrom: 2024, peakUntil: 2030, sommNotes: 'old' });
  WineVintageProfile.findById.mockResolvedValue(doc);

  const res = await put({ peakUntil: 2031, earlyUntil: null, sommNotes: '' });

  expect(res.status).toBe(200);
  expect(doc.earlyFrom).toBe(2020);
  expect(doc.earlyUntil).toBeUndefined();
  expect(doc.peakFrom).toBe(2024);
  expect(doc.peakUntil).toBe(2031);
  expect(doc.sommNotes).toBe('');
});

test('a note that is not sent is left alone', async () => {
  const doc = profileDoc({ sommNotes: 'keep me' });
  WineVintageProfile.findById.mockResolvedValue(doc);
  await put({ peakFrom: 2026 });
  expect(doc.sommNotes).toBe('keep me');
});

test('an NV row takes relative offsets, 0 included, and becomes relative', async () => {
  const doc = profileDoc({ vintage: 'NV' });
  WineVintageProfile.findById.mockResolvedValue(doc);

  const res = await put({ earlyFrom: 0, earlyUntil: 1, peakFrom: 1, peakUntil: 3 });

  expect(res.status).toBe(200);
  expect(doc).toMatchObject({ earlyFrom: 0, earlyUntil: 1, peakFrom: 1, peakUntil: 3, relative: true });
  expect(logAudit.mock.calls[0][3]).toEqual({ vintage: 'NV', relative: true });
});

test.each([
  ['a non-number', { peakFrom: 'soon' }, /Invalid value for peakFrom/],
  ['a year out of range', { peakFrom: 1850 }, /Year out of range for peakFrom/],
  ['an NV offset over 100', { peakFrom: 150 }, /peakFrom must be between 0 and 100 years/, 'NV'],
  ['an until before its from', { peakFrom: 2030, peakUntil: 2026 }, /Peak "until" must be after peak "from"/],
  ['a peak starting before early', { earlyFrom: 2030, peakFrom: 2026 }, /Peak phase cannot start before early phase/],
  ['a late phase starting before peak', { peakFrom: 2030, lateFrom: 2026 }, /Late phase cannot start before peak phase/],
])('%s is a 400 and nothing is saved, bumped or audited', async (_label, body, message, vintage = '2018') => {
  const doc = profileDoc({ vintage });
  WineVintageProfile.findById.mockResolvedValue(doc);

  const res = await put(body);

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(message);
  expect(doc.save).not.toHaveBeenCalled();
  expect(bumpWineOwners).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

// Today the web route checks ordering only among the fields SENT, unlike the
// MCP tool, which checks the merged window. A new until below a stored from
// is therefore accepted here. Pinned so that aligning the two is a deliberate,
// separately decided change.
test('ordering is checked only among the fields sent: a new until below a stored from is accepted', async () => {
  const doc = profileDoc({ peakFrom: 2030 });
  WineVintageProfile.findById.mockResolvedValue(doc);
  const res = await put({ peakUntil: 2026 });
  expect(res.status).toBe(200);
  expect(doc.peakFrom).toBe(2030);
  expect(doc.peakUntil).toBe(2026);
});

test('an unknown profile is 404, a bad id 400 and a plain member 403', async () => {
  WineVintageProfile.findById.mockResolvedValue(null);
  expect((await put({ peakFrom: 2026 })).status).toBe(404);
  expect((await put({ peakFrom: 2026 }, { id: 'nope' })).status).toBe(400);
  expect((await put({ peakFrom: 2026 }, { roles: ['user'] })).status).toBe(403);
  expect(bumpWineOwners).not.toHaveBeenCalled();
});
