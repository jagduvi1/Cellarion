/**
 * PUT /api/somm/maturity/:id — a curator sets a vintage's drink window.
 *
 * Pins today's contract before the write path moves into services/maturityOps:
 *   - every phase field sent is stored (null clears), a field not sent is left
 *     as it was, the note is trimmed, the row becomes reviewed with the
 *     curator's stamp, relative is false for a year vintage
 *   - an NV row takes offsets 0–100 and becomes relative
 *   - a non-number, an out-of-range year or an out-of-order pair is a 400 and
 *     nothing is saved; the order is checked on the window the row would hold
 *     after the patch, stored values included, as the MCP tool checks it
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

// The window is checked as the row would hold it after the patch, like the
// MCP set_vintage_maturity: a value that is not sent still counts.
test.each([
  ['a new until below a stored from', { peakFrom: 2030 }, { peakUntil: 2026 }, /Peak "until" must be after peak "from"/],
  ['a new peak start before a stored early start', { earlyFrom: 2028 }, { peakFrom: 2026 }, /Peak phase cannot start before early phase/],
  ['a new late start before a stored peak start', { peakFrom: 2030 }, { lateFrom: 2027 }, /Late phase cannot start before peak phase/],
])('%s is a 400 and nothing is saved', async (_label, stored, body, message) => {
  const doc = profileDoc(stored);
  WineVintageProfile.findById.mockResolvedValue(doc);
  const res = await put(body);
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(message);
  expect(doc.save).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test('a partial patch that stays in order against the stored values is saved', async () => {
  const doc = profileDoc({ peakFrom: 2026, peakUntil: 2030 });
  WineVintageProfile.findById.mockResolvedValue(doc);
  const res = await put({ peakUntil: 2034 });
  expect(res.status).toBe(200);
  expect(doc).toMatchObject({ peakFrom: 2026, peakUntil: 2034 });
});

// An NV row that still holds calendar years would have them reread as
// "2024 years after purchase" once the save marks it relative.
test('an NV row whose stored values are calendar years must be rewritten whole: a partial patch is a 409, all six fields are saved', async () => {
  const doc = profileDoc({ vintage: 'NV', peakFrom: 2024, peakUntil: 2029 });
  WineVintageProfile.findById.mockResolvedValue(doc);
  const partial = await put({ earlyFrom: 0 });
  expect(partial.status).toBe(409);
  expect(partial.body.error).toMatch(/stored peakFrom \(2024\).*Send all six fields/);
  expect(doc.save).not.toHaveBeenCalled();

  const whole = await put({ earlyFrom: 0, earlyUntil: 1, peakFrom: 2, peakUntil: 5, lateFrom: null, lateUntil: null });
  expect(whole.status).toBe(200);
  expect(doc).toMatchObject({ earlyFrom: 0, earlyUntil: 1, peakFrom: 2, peakUntil: 5, relative: true });
});

test.each([
  ['a year with a trailing word', '2026abc'],
  ['a decimal', 2026.5],
  ['a decimal as text', '2026.5'],
  ['a boolean', true],
])('%s is not a year: 400, nothing saved', async (_label, value) => {
  const doc = profileDoc();
  WineVintageProfile.findById.mockResolvedValue(doc);
  const res = await put({ peakFrom: value });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Invalid value for peakFrom/);
  expect(doc.save).not.toHaveBeenCalled();
});

test('a note over the stored limit is a 400 and nothing is saved', async () => {
  const doc = profileDoc();
  WineVintageProfile.findById.mockResolvedValue(doc);
  const res = await put({ peakFrom: 2026, peakUntil: 2030, sommNotes: 'x'.repeat(2001) });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/too long/i);
  expect(doc.save).not.toHaveBeenCalled();
});

test('a row removed from the queue while its window was being saved is a 409, with no bump and no audit row', async () => {
  const doc = profileDoc({ save: jest.fn().mockRejectedValue(Object.assign(new Error('gone'), { name: 'DocumentNotFoundError' })) });
  WineVintageProfile.findById.mockResolvedValue(doc);
  const res = await put({ peakFrom: 2026, peakUntil: 2030 });
  expect(res.status).toBe(409);
  expect(bumpWineOwners).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test('an unknown profile is 404, a bad id 400 and a plain member 403', async () => {
  WineVintageProfile.findById.mockResolvedValue(null);
  expect((await put({ peakFrom: 2026 })).status).toBe(404);
  expect((await put({ peakFrom: 2026 }, { id: 'nope' })).status).toBe(400);
  expect((await put({ peakFrom: 2026 }, { roles: ['user'] })).status).toBe(403);
  expect(bumpWineOwners).not.toHaveBeenCalled();
});
