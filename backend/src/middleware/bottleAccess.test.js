jest.mock('../models/Bottle', () => ({
  findById: jest.fn(),
}));
jest.mock('../models/Cellar', () => ({
  findById: jest.fn(),
}));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { requireBottleAccess } = require('./bottleAccess');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Valid 24-hex ObjectId strings (isValidId uses real mongoose validation)
const BOTTLE_ID = '64a000000000000000000001';
const CELLAR_ID = '64a000000000000000000002';
const OWNER_ID  = '64a000000000000000000003';
const OTHER_ID  = '64a000000000000000000004';

function makeReq({ id = BOTTLE_ID, userId = OWNER_ID } = {}) {
  return { params: { id }, user: { id: userId } };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function makeCellar(overrides = {}) {
  return { _id: CELLAR_ID, user: OWNER_ID, members: [], ...overrides };
}

beforeEach(() => jest.clearAllMocks());

// ─── requireBottleAccess ─────────────────────────────────────────────────────

describe('requireBottleAccess', () => {
  test('400 for an invalid (non-ObjectId) bottle id — DB is never queried', async () => {
    const req = makeReq({ id: 'not-an-object-id' });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid ID' });
    expect(Bottle.findById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('400 when the id is a non-string (query-injection shape)', async () => {
    const req = makeReq({ id: { $gt: '' } });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(Bottle.findById).not.toHaveBeenCalled();
  });

  test('404 when the bottle does not exist', async () => {
    Bottle.findById.mockResolvedValue(null);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(Bottle.findById).toHaveBeenCalledWith(BOTTLE_ID);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bottle not found' });
    expect(next).not.toHaveBeenCalled();
  });

  test('404 when the parent cellar is missing (getCellarRole(null) → null)', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(null);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bottle not found' });
  });

  test('404 when the cellar is soft-deleted — even for its owner (no existence oracle)', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(makeCellar({ deletedAt: new Date() }));
    const req = makeReq({ userId: OWNER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bottle not found' });
    expect(next).not.toHaveBeenCalled();
  });

  test('404 (not 403) when the user has no role on the cellar — same body as bottle-not-found', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(makeCellar());
    const req = makeReq({ userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Bottle not found' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when the user role is below minRole (viewer vs editor)', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'viewer' }] })
    );
    const req = makeReq({ userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('editor')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authorized to modify this bottle' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when editor tries an owner-only action', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'editor' }] })
    );
    const req = makeReq({ userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('owner')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('success: attaches req.bottle, req.cellar, req.cellarRole and calls next()', async () => {
    const bottle = { _id: BOTTLE_ID, cellar: CELLAR_ID };
    const cellar = makeCellar();
    Bottle.findById.mockResolvedValue(bottle);
    Cellar.findById.mockResolvedValue(cellar);
    const req = makeReq({ userId: OWNER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('owner')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.bottle).toBe(bottle);
    expect(req.cellar).toBe(cellar);
    expect(req.cellarRole).toBe('owner');
    expect(Cellar.findById).toHaveBeenCalledWith(CELLAR_ID);
  });

  test('editor member passes an editor gate (role attached as "editor")', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'editor' }] })
    );
    const req = makeReq({ userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('editor')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.cellarRole).toBe('editor');
  });

  test('defaults minRole to viewer — a viewer member passes with no explicit arg', async () => {
    Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID });
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'viewer' }] })
    );
    const req = makeReq({ userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.cellarRole).toBe('viewer');
  });

  test('forwards unexpected errors to next(err)', async () => {
    const boom = new Error('db down');
    Bottle.findById.mockRejectedValue(boom);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireBottleAccess('viewer')(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
  });
});
