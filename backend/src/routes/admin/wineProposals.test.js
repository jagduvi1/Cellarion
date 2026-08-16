/**
 * /api/admin/wine-proposals — the somm correction-proposal review contract.
 *
 * Pins: the pending-first list envelope with the per-field LIVE diff; the
 * atomic approve claim (double-decide → 409); field_correction apply with the
 * admin-PUT semantics (trim, normalizeAppellation, key regen, E11000 → 409
 * "merge instead", resolve-only country) and the claim REVERT on apply
 * failure; merge delegating to the extracted performWineMerge; non_wine
 * setting the flag AND clearing only PENDING maturity rows; reject requiring
 * a reason. Mock style follows wines.fragmentation.test.js.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../models/WineCorrectionProposal', () => ({
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
  populate: jest.fn(),
  exists: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../../models/WineVintageProfile', () => ({ deleteMany: jest.fn() }));
jest.mock('../../models/Bottle', () => ({ distinct: jest.fn() }));
jest.mock('../../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn(), bulkIndexBottles: jest.fn() }));
jest.mock('../../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/enrichmentJob', () => ({
  reenrichAfterRecordEdit: jest.fn(),
  // Faithful-enough mirror of the real snapshot (unit-tested in
  // enrichmentJob.test.js) — the route only ever compares two of these.
  profileInputsSnapshot: jest.fn((w) => JSON.stringify({
    name: w.name || '', producer: w.producer || '',
    country: String(w.country || ''), region: String(w.region || ''),
    appellation: w.appellation || '', classification: w.classification || '',
    type: w.type || '', grapes: (w.grapes || []).map(String).sort(),
  })),
}));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateRegion: jest.fn() }));
// Identity by default so the tier-strip assertions below still read the
// normalizeAppellation output; the curated-registry test overrides it.
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
// The extracted merge helper — the whole point of the extraction is that this
// route invokes IT rather than re-implementing the machinery.
jest.mock('./wines', () => ({ performWineMerge: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineCorrectionProposal = require('../../models/WineCorrectionProposal');
const WineDefinition = require('../../models/WineDefinition');
const WineVintageProfile = require('../../models/WineVintageProfile');
const Bottle = require('../../models/Bottle');
const Country = require('../../models/Country');
const { performWineMerge } = require('./wines');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const searchService = require('../../services/search');
const { generateWineKey } = require('../../utils/normalize');
const adminWineProposalsRouter = require('./wineProposals');

const ADMIN_ID = '64b000000000000000000001';
const adminToken = () => jwt.sign({ id: ADMIN_ID, roles: ['admin'] }, 'test-secret');

const P1 = '64b0000000000000000000a1';
const W1 = '64b0000000000000000000b1';
const W2 = '64b0000000000000000000b2';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wine-proposals', adminWineProposalsRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  WineCorrectionProposal.populate.mockResolvedValue(undefined); // rows arrive pre-shaped below
  WineCorrectionProposal.updateOne.mockResolvedValue({});
  Bottle.distinct.mockResolvedValue([]);
});

const get = (qs = '') => fetch(`${baseUrl}/api/admin/wine-proposals${qs}`, {
  headers: { Authorization: `Bearer ${adminToken()}` },
});
const post = (path, body) => fetch(`${baseUrl}/api/admin/wine-proposals${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminToken()}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe('GET / (list)', () => {
  test('pending-first envelope with the per-field diff computed from LIVE wine values', async () => {
    // The wine's producer changed since the proposal was filed (snapshot says
    // 'Pira') — the diff must show the LIVE value, the snapshot rides along.
    WineCorrectionProposal.aggregate.mockResolvedValue([{
      _id: P1, kind: 'field_correction', status: 'pending',
      proposer: { _id: ADMIN_ID, username: 'somm1' },
      wineDefinition: {
        _id: W1, name: 'Barolo', producer: 'Pira Luigi', appellation: 'Barolo',
        classification: null, type: 'red', nonWine: false,
        country: { name: 'Italy' }, region: { name: 'Piedmont' },
      },
      proposedFields: { producer: 'E. Pira e Figli', country: 'Italy' },
      currentSnapshot: { producer: 'Pira', name: 'Barolo', appellation: 'Barolo', region: 'Piedmont', country: 'Italy', classification: null },
      evidenceUrl: 'https://pira-barolo.example',
      reason: 'Producer verified on the estate website.',
      createdAt: '2026-08-09T00:00:00.000Z',
    }]);
    WineCorrectionProposal.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(3);

    const res = await get('?status=pending');
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(data.pages).toBe(1);
    expect(data.pendingCount).toBe(3); // cheap toolbar-badge meta
    const row = data.proposals[0];
    expect(row.diff).toEqual({
      producer: { current: 'Pira Luigi', proposed: 'E. Pira e Figli' },
      country: { current: 'Italy', proposed: 'Italy' },
    });
    expect(row.currentSnapshot.producer).toBe('Pira'); // drift is client-visible
    expect(row.proposer.username).toBe('somm1');
    expect(row.evidenceUrl).toBe('https://pira-barolo.example');

    // The status filter is a literal from the static array, and the sort key
    // is the derived pending-first field.
    const pipeline = WineCorrectionProposal.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { status: 'pending' } });
    expect(pipeline.some(s => s.$sort && s.$sort._pendingFirst === 1)).toBe(true);
  });
});

describe('POST /:id/approve', () => {
  const claim = (proposal) => WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(proposal);

  test('field_correction: applies with PUT semantics — trim, normalizeAppellation, key regen — then indexes', async () => {
    claim({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { producer: '  E. Pira e Figli  ', appellation: 'Barolo DOCG' } });
    const wine = { _id: W1, name: 'Barolo', producer: 'Pira', appellation: 'Barolo', country: 'c1', save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('approved');
    expect(data.appliedNote).toMatch(/producer/);
    expect(data.appliedNote).toMatch(/appellation/);

    // The atomic claim: only a still-pending row can be approved.
    expect(WineCorrectionProposal.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ status: 'pending' });

    expect(wine.producer).toBe('E. Pira e Figli');
    expect(wine.appellation).toBe('Barolo'); // tier stripped by normalizeAppellation
    // The dedup key follows name/producer/appellation, exactly like the PUT.
    expect(wine.normalizedKey).toBe(generateWineKey('Barolo', 'E. Pira e Figli', 'Barolo'));
    expect(wine.save).toHaveBeenCalled();
    expect(searchService.indexWine).toHaveBeenCalledWith(W1);
    // IndexNow parity with the PUT: an approved identity fix changes the
    // public wine page and must ping crawlers the same way (audit 2026-08-10).
    expect(require('../../services/indexNow').submitUrls).toHaveBeenCalledWith(`/wines/${W1}`);
    // The receipt lands on the row.
    const noteSet = WineCorrectionProposal.updateOne.mock.calls.at(-1);
    expect(noteSet[1].$set.appliedNote).toMatch(/Applied/);
  });

  // Parity with the admin PUT (gap found live 2026-08-16: approving
  // "Fabelhaft" → "Niepoort" left the négociant-fiction profile attached
  // until a manual force re-enrich): an approved change to a profile-feeding
  // field hands the wine to the re-enrich follow-through — and ONLY a real
  // change does.
  test('field_correction: a real producer change triggers the re-enrich follow-through', async () => {
    claim({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { producer: 'Niepoort' } });
    const wine = { _id: W1, name: 'Douro Tinto', producer: 'Fabelhaft', appellation: 'Douro', country: 'c1', save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(200);
    const { reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
    expect(reenrichAfterRecordEdit).toHaveBeenCalledWith(wine, true);
  });

  test('field_correction: values identical to the record do NOT regenerate the profile', async () => {
    claim({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { producer: 'Niepoort' } });
    const wine = { _id: W1, name: 'Douro Tinto', producer: 'Niepoort', appellation: 'Douro', country: 'c1', save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(200);
    const { reenrichAfterRecordEdit } = require('../../services/enrichmentJob');
    expect(reenrichAfterRecordEdit).toHaveBeenCalledWith(wine, false);
  });

  // The "Yecla DO" case (prod, 2026-08-12): approving a proposal used to store
  // the tier-stripped string directly, so a decoration normalizeAppellation
  // deliberately cannot strip survived onto the wine. The stored value must
  // now come from the curated-registry resolver, not from the normalizer.
  test('field_correction: the STORED appellation is the resolver\'s canonical spelling', async () => {
    resolveCanonicalAppellation.mockResolvedValueOnce('Yecla');
    claim({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { appellation: ' Yecla DO ' } });
    const wine = { _id: W1, name: 'Barrica', producer: 'Castaño', appellation: null, country: 'c1', save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(200);
    // Trimmed + tier-stripped on the way IN, canonical spelling on the way OUT.
    expect(resolveCanonicalAppellation).toHaveBeenCalledWith('Yecla DO');
    expect(wine.appellation).toBe('Yecla');
    expect(wine.normalizedKey).toBe(generateWineKey('Barrica', 'Castaño', 'Yecla'));
  });

  test('field_correction E11000 → 409 "merge instead" and the claim is REVERTED (no half-approved state)', async () => {
    claim({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { name: 'Barolo' } });
    const wine = { _id: W1, name: 'Barolo Riserva', producer: 'Pira', appellation: null, save: jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 })) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/merge proposal instead/);
    // Revert: the row goes back to pending with the decision fields cleared.
    const revert = WineCorrectionProposal.updateOne.mock.calls.find(c => c[1]?.$set?.status === 'pending');
    expect(revert).toBeTruthy();
    expect(revert[0]).toMatchObject({ _id: P1, status: 'approved' });
    expect(revert[1].$set).toEqual({ status: 'pending', decidedBy: null, decidedAt: null });
    expect(searchService.indexWine).not.toHaveBeenCalled();
  });

  test('field_correction with an unresolvable country → 400, never a minted Country, claim reverted', async () => {
    claim({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { country: 'Atlantis' } });
    WineDefinition.findById.mockResolvedValue({ _id: W1, name: 'Barolo', producer: 'Pira', country: 'c1', save: jest.fn() });
    Country.findOne.mockResolvedValue(null);

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Atlantis/);
    const revert = WineCorrectionProposal.updateOne.mock.calls.find(c => c[1]?.$set?.status === 'pending');
    expect(revert).toBeTruthy();
  });

  test('merge: invokes the EXTRACTED performWineMerge with source=proposal wine, target=mergeTargetId', async () => {
    claim({ _id: P1, kind: 'merge', wineDefinition: W1, mergeTargetId: W2 });
    performWineMerge.mockResolvedValue({ bottlesMoved: 3, imageAction: 'none', source: {}, target: { name: 'Barolo', producer: 'E. Pira e Figli' } });

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(performWineMerge).toHaveBeenCalledTimes(1);
    expect(performWineMerge.mock.calls[0][0]).toBe(W1);
    expect(performWineMerge.mock.calls[0][1]).toBe(W2);
    expect(data.appliedNote).toMatch(/Merged into E\. Pira e Figli — Barolo/);
    expect(data.appliedNote).toMatch(/3 bottle/);
  });

  test('merge helper error (target gone) propagates its status and reverts the claim', async () => {
    claim({ _id: P1, kind: 'merge', wineDefinition: W1, mergeTargetId: W2 });
    performWineMerge.mockResolvedValue({ error: { status: 404, message: 'Target wine not found' } });

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(404);
    const revert = WineCorrectionProposal.updateOne.mock.calls.find(c => c[1]?.$set?.status === 'pending');
    expect(revert).toBeTruthy();
  });

  test('non_wine: sets the quarantine flag and clears only PENDING maturity rows', async () => {
    claim({ _id: P1, kind: 'non_wine', wineDefinition: W1 });
    const wine = { _id: W1, name: 'Somerset Cider', producer: 'Orchard Co', nonWine: false, save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);
    WineVintageProfile.deleteMany.mockResolvedValue({ deletedCount: 2 });

    const res = await post(`/${P1}/approve`);
    expect(res.status).toBe(200);
    expect(wine.nonWine).toBe(true);
    expect(wine.save).toHaveBeenCalled();
    // Reviewed windows are curated data and stay — only pending stubs go.
    expect(WineVintageProfile.deleteMany).toHaveBeenCalledWith({ wineDefinition: W1, status: 'pending' });
    expect((await res.json()).appliedNote).toMatch(/2 pending/);
    expect(searchService.indexWine).toHaveBeenCalledWith(W1);
  });

  test('a second decide is a clean 409 (claim already taken), a bogus id is 404', async () => {
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(null);
    WineCorrectionProposal.exists.mockResolvedValueOnce({ _id: P1 }).mockResolvedValueOnce(null);

    let res = await post(`/${P1}/approve`);
    expect(res.status).toBe(409);
    res = await post(`/${P1}/approve`);
    expect(res.status).toBe(404);
    expect(WineDefinition.findById).not.toHaveBeenCalled();
  });
});

describe('POST /:id/reject', () => {
  test('requires a reason of at least 5 characters — nothing decided without one', async () => {
    let res = await post(`/${P1}/reject`, {});
    expect(res.status).toBe(400);
    res = await post(`/${P1}/reject`, { reason: 'no' });
    expect(res.status).toBe(400);
    expect(WineCorrectionProposal.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('rejects with the stored reason via the same atomic claim; double-decide → 409', async () => {
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValueOnce({ _id: P1, kind: 'merge', wineDefinition: W1 });
    let res = await post(`/${P1}/reject`, { reason: 'Target is a different cuvée — not a duplicate.' });
    expect(res.status).toBe(200);
    const [filter, update] = WineCorrectionProposal.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ status: 'pending' });
    expect(update.$set).toMatchObject({ status: 'rejected', rejectReason: 'Target is a different cuvée — not a duplicate.' });

    WineCorrectionProposal.findOneAndUpdate.mockResolvedValueOnce(null);
    WineCorrectionProposal.exists.mockResolvedValueOnce({ _id: P1 });
    res = await post(`/${P1}/reject`, { reason: 'Late second opinion.' });
    expect(res.status).toBe(409);
  });
});

/**
 * Bulk decisions (ticket 6a8162c5 ask #3 — the middle road): each id runs the
 * EXACT single-decision machinery, so what these pin is the batch envelope —
 * per-row outcomes, one row's failure never blocking the rest, dedupe, and
 * the bounds/reason gates deciding NOTHING when they fail.
 */
describe('POST /bulk-approve and /bulk-reject', () => {
  const P2 = '64b0000000000000000000a2';
  const claimSeq = (...proposals) => {
    for (const p of proposals) WineCorrectionProposal.findOneAndUpdate.mockResolvedValueOnce(p);
  };

  test('bulk-approve: per-row outcomes; a 409 on one row never blocks the rest', async () => {
    claimSeq(
      { _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { producer: 'Niepoort' } },
      null, // second claim fails → decided-elsewhere path
    );
    WineCorrectionProposal.exists.mockResolvedValueOnce(true); // → 409 for the second id
    const wine = { _id: W1, name: 'Douro Tinto', producer: 'Fabelhaft', appellation: 'Douro', country: 'c1', save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post('/bulk-approve', { ids: [P1, P2] });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.approved).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.results[0]).toMatchObject({ proposalId: P1, ok: true, status: 200 });
    expect(data.results[0].appliedNote).toMatch(/producer/);
    expect(data.results[1]).toMatchObject({ proposalId: P2, ok: false, status: 409 });
    // The applied row went through the real machinery: claim + apply + index.
    expect(wine.save).toHaveBeenCalled();
    expect(searchService.indexWine).toHaveBeenCalledWith(W1);
  });

  test('bulk-approve: duplicate ids dedupe to one decision', async () => {
    claimSeq({ _id: P1, kind: 'field_correction', wineDefinition: W1, proposedFields: { producer: 'X' } });
    const wine = { _id: W1, name: 'N', producer: 'P', appellation: null, country: 'c1', save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const res = await post('/bulk-approve', { ids: [P1, P1] });
    const data = await res.json();
    expect(data.results).toHaveLength(1);
    expect(WineCorrectionProposal.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('bulk-approve bounds: empty, invalid and oversize id arrays are 400 with NOTHING decided', async () => {
    for (const body of [
      {},
      { ids: [] },
      { ids: ['not-an-id'] },
      { ids: Array.from({ length: 51 }, () => P1) }, // length gate fires before dedupe
    ]) {
      const res = await post('/bulk-approve', body);
      expect(res.status).toBe(400);
    }
    expect(WineCorrectionProposal.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('bulk-reject: one shared reason, per-row claims; a vanished row reports 404', async () => {
    claimSeq(
      { _id: P1, kind: 'field_correction', wineDefinition: W1 },
      null,
    );
    WineCorrectionProposal.exists.mockResolvedValueOnce(false); // → 404 for the second id

    const res = await post('/bulk-reject', { ids: [P1, P2], reason: 'Duplicate wave from one import session' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.rejected).toBe(1);
    expect(data.results[0]).toMatchObject({ proposalId: P1, ok: true, status: 200 });
    expect(data.results[1]).toMatchObject({ proposalId: P2, ok: false, status: 404 });
    // The reason landed via the same claim write the single route uses.
    expect(WineCorrectionProposal.findOneAndUpdate.mock.calls[0][1].$set.rejectReason)
      .toBe('Duplicate wave from one import session');
  });

  test('bulk-reject: a bad shared reason is 400 and decides NOTHING', async () => {
    const res = await post('/bulk-reject', { ids: [P1], reason: 'x' });
    expect(res.status).toBe(400);
    expect(WineCorrectionProposal.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
