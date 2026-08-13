/**
 * Where a REFUSED producer string goes.
 *
 * The mint-time cross-field gate (services/findOrCreateWine) never stores a
 * producer its rules say is not a producer — the row keys pending with producer
 * ''. That is right, and it is also how the evidence disappears: the pending
 * queue has no field for a rejected value, so without this the curator sees one
 * fewer clue than the user had on screen ("Pays d'Oc Organic Wine" was at least
 * READ off a label).
 *
 * The commit's own audit entry is where it survives. Pinned here because it is
 * the only place the string exists after the mint, and because a curator
 * following a wine.create entry has to be able to find it.
 */

jest.mock('../models/BottleImage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const { logAudit } = require('./audit');
const { findOrCreateWine } = require('./findOrCreateWine');
const { resolveOrMintWine } = require('./wineCommit');

const USER = '1'.repeat(24);
const req = { user: { id: USER } };

const pendingWine = () => ({
  _id: 'wine-1', name: 'Chardonnay Reserve', producer: '',
  scanImage: null, scanImageBack: null, scanFieldConflicts: [],
  pendingIdentity: true, createdBy: USER,
  save: jest.fn().mockResolvedValue(undefined),
});

const payload = { name: 'Chardonnay Reserve', producer: "Pays d'Oc Organic Wine", country: 'France' };

beforeEach(() => jest.clearAllMocks());

describe('a producer refused by the cross-field rules', () => {
  test('the string and the rule land on the wine.create audit entry', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: pendingWine(),
      created: true,
      pendingIdentity: true,
      producerRejected: {
        producer: "Pays d'Oc Organic Wine",
        check: 'producer-is-appellation.v1',
        detail: "Pays d'Oc",
      },
    });

    const out = await resolveOrMintWine(payload, req);

    expect(out.pendingIdentity).toBe(true);
    expect(logAudit).toHaveBeenCalledWith(
      req, 'wine.create', { type: 'wine', id: 'wine-1' },
      expect.objectContaining({
        pendingIdentity: true,
        // The row itself stores '' — this entry is the only record of what the
        // scan actually read.
        producer: null,
        rejectedProducer: "Pays d'Oc Organic Wine",
        rejectedByCheck: 'producer-is-appellation.v1',
      }),
    );
  });

  test('an ordinary mint carries neither key — the audit stream stays one shape', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: { ...pendingWine(), producer: 'Domaine Gayda', pendingIdentity: false },
      created: true,
    });

    await resolveOrMintWine({ ...payload, producer: 'Domaine Gayda' }, req);

    const detail = logAudit.mock.calls[0][3];
    expect(detail).not.toHaveProperty('rejectedProducer');
    expect(detail).not.toHaveProperty('rejectedByCheck');
    expect(detail.producer).toBe('Domaine Gayda');
  });

  test('the user still gets their wine — a refused producer is never a 400 here', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: pendingWine(), created: true, pendingIdentity: true,
      producerRejected: { producer: 'Syrah', check: 'producer-is-grape.v1', detail: 'Syrah' },
    });

    const out = await resolveOrMintWine({ ...payload, producer: 'Syrah' }, req);

    expect(out.error).toBeUndefined();
    expect(out.created).toBe(true);
  });
});
