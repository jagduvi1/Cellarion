/**
 * Import-time wine requests (support ticket 2026-09-05): a request is reused
 * across imports for the same user + wine + producer, and it carries the
 * file's country / region / appellation / type as hints for the curator.
 */
jest.mock('../models/WineRequest', () => {
  const ctor = jest.fn().mockImplementation(function (doc) {
    Object.assign(this, doc);
    this._id = 'new-' + (ctor.mock.instances.length);
    this.save = jest.fn().mockResolvedValue(this);
  });
  ctor.findOne = jest.fn();
  return ctor;
});

const WineRequest = require('../models/WineRequest');
const { findOrCreatePendingRequest, pickImportHints, hasHints } = require('./wineRequestIntake');

const UID = 'u1';
beforeEach(() => { jest.clearAllMocks(); WineRequest.findOne.mockResolvedValue(null); });

describe('pickImportHints', () => {
  test('keeps the four geography/type fields, trimmed, capped, type lowercased', () => {
    expect(pickImportHints({ country: ' France ', region: 'Burgundy', appellation: 'Chablis Premier Cru', type: 'White', producer: 'x' }))
      .toEqual({ country: 'France', region: 'Burgundy', appellation: 'Chablis Premier Cru', type: 'white' });
    expect(pickImportHints({ country: 'x'.repeat(200) }).country).toHaveLength(100);
  });
  test('null when the row says nothing', () => {
    expect(pickImportHints({ wineName: 'X' })).toBeNull();
    expect(pickImportHints(null)).toBeNull();
  });
});

describe('findOrCreatePendingRequest', () => {
  test('creates a pending request with hints when none exists', async () => {
    const { wineRequest, reused } = await findOrCreatePendingRequest({
      userId: UID, wineName: ' Magari ', producer: "Ca' Marcanda", suggestedGrapes: ['Merlot'],
      hints: { country: 'Italy', region: 'Tuscany', appellation: 'Toscana', type: 'red' },
    });
    expect(reused).toBe(false);
    expect(WineRequest.findOne).toHaveBeenCalledWith(expect.objectContaining({ user: UID, requestType: 'new_wine', status: 'pending' }));
    expect(wineRequest).toMatchObject({ wineName: 'Magari', producer: "Ca' Marcanda", suggestedGrapes: ['Merlot'], hints: { country: 'Italy', type: 'red' } });
    expect(wineRequest.save).toHaveBeenCalledTimes(1);
  });

  test('reuses the existing pending request — case-insensitive on name and producer — and learns hints it lacked', async () => {
    const existing = { _id: 'req-1', wineName: 'Magari', producer: "ca' marcanda", hints: undefined, save: jest.fn().mockResolvedValue(undefined) };
    WineRequest.findOne.mockResolvedValue(existing);
    const { wineRequest, reused } = await findOrCreatePendingRequest({
      userId: UID, wineName: 'MAGARI', producer: "Ca' Marcanda", hints: { country: 'Italy' },
    });
    expect(reused).toBe(true);
    expect(wineRequest).toBe(existing);
    expect(WineRequest).not.toHaveBeenCalled();
    const filter = WineRequest.findOne.mock.calls[0][0];
    expect(filter.wineName.test('magari')).toBe(true);
    expect(filter.producer.test("CA' MARCANDA")).toBe(true);
    expect(filter.wineName.test('Magari Riserva')).toBe(false);
    expect(existing.hints).toEqual({ country: 'Italy' });
    expect(existing.save).toHaveBeenCalledTimes(1);
  });

  test('does not overwrite hints the request already has', async () => {
    const existing = { _id: 'req-2', hints: { country: 'Spain' }, save: jest.fn() };
    WineRequest.findOne.mockResolvedValue(existing);
    await findOrCreatePendingRequest({ userId: UID, wineName: 'X', producer: 'Y', hints: { country: 'France' } });
    expect(existing.hints).toEqual({ country: 'Spain' });
    expect(existing.save).not.toHaveBeenCalled();
  });

  test('a producer-less row matches a producer-less request, not a producer\'s', async () => {
    await findOrCreatePendingRequest({ userId: UID, wineName: 'Hereford Tempranillo', producer: '' });
    expect(WineRequest.findOne.mock.calls[0][0].producer).toEqual({ $in: [null, ''] });
  });

  test('regex metacharacters in a name are matched literally', async () => {
    await findOrCreatePendingRequest({ userId: UID, wineName: 'Cuvée (Spéciale) + Réserve [1er]', producer: 'P.' });
    const f = WineRequest.findOne.mock.calls[0][0];
    expect(f.wineName.test('Cuvée (Spéciale) + Réserve [1er]')).toBe(true);
    expect(f.wineName.test('Cuvée Spéciale + Réserve 1er')).toBe(false);
    expect(f.producer.test('P.')).toBe(true);
    expect(f.producer.test('Px')).toBe(false);
  });

  test('the per-run cache short-circuits the second row of the same wine', async () => {
    const cache = new Map();
    const a = await findOrCreatePendingRequest({ userId: UID, wineName: 'X', producer: 'Y', cache });
    const b = await findOrCreatePendingRequest({ userId: UID, wineName: 'x', producer: 'y', cache });
    expect(b.wineRequest).toBe(a.wineRequest);
    expect(b.reused).toBe(true);
    expect(WineRequest.findOne).toHaveBeenCalledTimes(1);
  });
});

test('hasHints', () => {
  expect(hasHints({ hints: { country: 'Italy' } })).toBe(true);
  expect(hasHints({ hints: {} })).toBe(false);
  expect(hasHints({})).toBe(false);
});
