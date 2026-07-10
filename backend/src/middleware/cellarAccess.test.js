jest.mock('../models/Cellar', () => ({
  findById: jest.fn(),
}));

const Cellar = require('../models/Cellar');
const { requireCellarAccess } = require('./cellarAccess');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Valid 24-hex ObjectId strings
const CELLAR_ID = '64b000000000000000000001';
const QUERY_ID  = '64b000000000000000000002';
const BODY_ID   = '64b000000000000000000003';
const BODY_ID2  = '64b000000000000000000004';
const OWNER_ID  = '64b000000000000000000005';
const OTHER_ID  = '64b000000000000000000006';

function makeReq({ params = {}, query = {}, body = {}, userId = OWNER_ID } = {}) {
  return { params, query, body, user: { id: userId } };
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

// ─── Cellar-ID extraction precedence ─────────────────────────────────────────

describe('requireCellarAccess — cellar-ID extraction precedence', () => {
  beforeEach(() => Cellar.findById.mockResolvedValue(makeCellar()));

  test('req.params.cellarId wins over query and body — a body-supplied ID cannot override the route param', async () => {
    const req = makeReq({
      params: { cellarId: CELLAR_ID },
      query: { cellar: QUERY_ID },
      body: { cellar: BODY_ID, cellarId: BODY_ID2 },
    });
    await requireCellarAccess('viewer')(req, makeRes(), jest.fn());
    expect(Cellar.findById).toHaveBeenCalledWith(CELLAR_ID);
  });

  test('req.query.cellar wins over body when no route param is present', async () => {
    const req = makeReq({
      query: { cellar: QUERY_ID },
      body: { cellar: BODY_ID, cellarId: BODY_ID2 },
    });
    await requireCellarAccess('viewer')(req, makeRes(), jest.fn());
    expect(Cellar.findById).toHaveBeenCalledWith(QUERY_ID);
  });

  test('req.body.cellar wins over req.body.cellarId', async () => {
    const req = makeReq({ body: { cellar: BODY_ID, cellarId: BODY_ID2 } });
    await requireCellarAccess('viewer')(req, makeRes(), jest.fn());
    expect(Cellar.findById).toHaveBeenCalledWith(BODY_ID);
  });

  test('req.body.cellarId is the last fallback', async () => {
    const req = makeReq({ body: { cellarId: BODY_ID2 } });
    await requireCellarAccess('viewer')(req, makeRes(), jest.fn());
    expect(Cellar.findById).toHaveBeenCalledWith(BODY_ID2);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe('requireCellarAccess — validation', () => {
  test('400 when no cellar id is supplied anywhere', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cellar ID is required' });
    expect(Cellar.findById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('400 for a malformed (non-ObjectId) id — DB is never queried', async () => {
    const req = makeReq({ params: { cellarId: 'not-an-object-id' } });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cellar ID is required' });
    expect(Cellar.findById).not.toHaveBeenCalled();
  });
});

// ─── Access branches ─────────────────────────────────────────────────────────

describe('requireCellarAccess — access branches', () => {
  test('404 when the cellar does not exist', async () => {
    Cellar.findById.mockResolvedValue(null);
    const req = makeReq({ params: { cellarId: CELLAR_ID } });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cellar not found' });
    expect(next).not.toHaveBeenCalled();
  });

  test('404 when the cellar is soft-deleted — same response as missing (no existence oracle)', async () => {
    Cellar.findById.mockResolvedValue(makeCellar({ deletedAt: new Date() }));
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OWNER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cellar not found' });
  });

  test('404 (not 403) when the user has no role on the cellar', async () => {
    Cellar.findById.mockResolvedValue(makeCellar());
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('viewer')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cellar not found' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when the user role is below minRole (viewer vs editor)', async () => {
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'viewer' }] })
    );
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('editor')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not authorized for this cellar' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when an editor tries an owner-only action', async () => {
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'editor' }] })
    );
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('owner')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('success: attaches req.cellar and req.cellarRole and calls next()', async () => {
    const cellar = makeCellar();
    Cellar.findById.mockResolvedValue(cellar);
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OWNER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('owner')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.cellar).toBe(cellar);
    expect(req.cellarRole).toBe('owner');
  });

  test('editor member passes an editor gate', async () => {
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'editor' }] })
    );
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('editor')(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.cellarRole).toBe('editor');
  });

  test('defaults minRole to viewer — a viewer member passes with no explicit arg', async () => {
    Cellar.findById.mockResolvedValue(
      makeCellar({ members: [{ user: OTHER_ID, role: 'viewer' }] })
    );
    const req = makeReq({ params: { cellarId: CELLAR_ID }, userId: OTHER_ID });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.cellarRole).toBe('viewer');
  });

  test('forwards unexpected errors to next(err)', async () => {
    const boom = new Error('db down');
    Cellar.findById.mockRejectedValue(boom);
    const req = makeReq({ params: { cellarId: CELLAR_ID } });
    const res = makeRes();
    const next = jest.fn();

    await requireCellarAccess('viewer')(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
  });
});
