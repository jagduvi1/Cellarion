/**
 * services/trustedContributions — what a server that does not review
 * contributions does with a member's photo or field correction.
 *
 * WHY THIS TEST EXISTS:
 * A household on its own install (discussion #1778) waited on itself: every
 * photo sat in Admin → Image Review (and a pending photo is the uploader's
 * only, so the other member did not see it), every fix and value in a queue.
 * With review switched off each contribution must be applied through the
 * code an admin's approval runs — and only then: review on (the default and
 * cellarion.app) changes nothing, a relay from another server over the
 * Registry Bridge always waits, a label scan is never published, and a
 * correction the approval leaves to a human (a producer spelled two ways)
 * stays pending.
 */
jest.mock('../models/BottleImage', () => ({ findById: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('./imageModerationOps', () => ({ approveImage: jest.fn() }));
jest.mock('../routes/admin/wineProposals', () => ({ approveProposal: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const WineDefinition = require('../models/WineDefinition');
const { approveImage } = require('./imageModerationOps');
const { approveProposal } = require('../routes/admin/wineProposals');
const contributionReview = require('../config/contributionReview');
const { appliesDirectly, approvePhotoIfTrusted, applyCorrectionIfTrusted } = require('./trustedContributions');

const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v });
const PHOTO = { _id: 'i1', status: 'processed', kind: 'bottle', bottle: 'b1', wineDefinition: null, uploadedBy: 'u1' };

beforeEach(() => {
  jest.clearAllMocks();
  contributionReview.set({ enabled: false });
  approveImage.mockResolvedValue({ ok: true });
});
afterAll(() => contributionReview.set({ enabled: true }));

describe('appliesDirectly', () => {
  test('only with review off, and never for a relay from another server', () => {
    expect(appliesDirectly('web')).toBe(true);
    expect(appliesDirectly('mcp')).toBe(true);
    expect(appliesDirectly(undefined)).toBe(true);
    expect(appliesDirectly('bridge')).toBe(false);
    contributionReview.set({ enabled: true });
    expect(appliesDirectly('web')).toBe(false);
  });
});

describe('approvePhotoIfTrusted', () => {
  test('a ready photo on a bottle is published, the wine\'s picture when it has none, nobody notified', async () => {
    BottleImage.findById.mockReturnValue(lean(PHOTO));
    expect(await approvePhotoIfTrusted('i1')).toBe(true);
    expect(approveImage).toHaveBeenCalledWith({
      imageId: 'i1', actorId: 'u1', visibility: 'public', official: 'auto', notify: false, via: 'unreviewed',
    });
  });

  test('left alone: review on, a label scan, a photo not processed yet, a photo on no bottle or wine', async () => {
    contributionReview.set({ enabled: true });
    expect(await approvePhotoIfTrusted('i1')).toBe(false);
    expect(BottleImage.findById).not.toHaveBeenCalled();
    contributionReview.set({ enabled: false });
    for (const over of [{ kind: 'label-scan' }, { status: 'uploaded' }, { status: 'approved' }, { bottle: null, wineDefinition: null }]) {
      BottleImage.findById.mockReturnValue(lean({ ...PHOTO, ...over }));
      expect(await approvePhotoIfTrusted('i1')).toBe(false);
    }
    expect(approveImage).not.toHaveBeenCalled();
  });

  test('a failure is logged, never thrown: the upload stands and waits for an admin', async () => {
    BottleImage.findById.mockReturnValue(lean(PHOTO));
    approveImage.mockRejectedValue(new Error('disk'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(approvePhotoIfTrusted('i1')).resolves.toBe(false);
    err.mockRestore();
  });
});

describe('applyCorrectionIfTrusted', () => {
  const filed = { ok: true, amended: false, proposal: { _id: 'p1', wineDefinition: 'w1' }, wine: { _id: 'w1', name: 'Old' } };

  test('applied through approveProposal, decided by the member who filed it; the answer carries the corrected wine', async () => {
    approveProposal.mockResolvedValue({ status: 200, body: { appliedNote: 'Applied: name' } });
    WineCorrectionProposal.findById.mockReturnValue(lean({ _id: 'p1', status: 'approved' }));
    WineDefinition.findById.mockReturnValue(lean({ _id: 'w1', name: 'New' }));

    const out = await applyCorrectionIfTrusted(filed, 'u1', { via: 'web' });

    expect(approveProposal).toHaveBeenCalledWith('p1', { user: { id: 'u1' } });
    expect(out).toMatchObject({ ok: true, applied: true, appliedNote: 'Applied: name', proposal: { status: 'approved' }, wine: { name: 'New' } });
  });

  test('the express request is used as the decider when there is one', async () => {
    approveProposal.mockResolvedValue({ status: 200, body: {} });
    WineCorrectionProposal.findById.mockReturnValue(lean(null));
    WineDefinition.findById.mockReturnValue(lean(null));
    const req = { user: { id: 'u1', roles: ['user'] } };
    await applyCorrectionIfTrusted(filed, 'u1', { via: 'web', req });
    expect(approveProposal).toHaveBeenCalledWith('p1', req);
  });

  test('stays pending: a choice left to a human (409), review on, a bridge relay, a failed filing', async () => {
    approveProposal.mockResolvedValue({ status: 409, body: { code: 'producer_spelling_split' } });
    expect(await applyCorrectionIfTrusted(filed, 'u1', { via: 'web' })).toBe(filed);

    approveProposal.mockClear();
    expect(await applyCorrectionIfTrusted(filed, 'u1', { via: 'bridge' })).toBe(filed);
    contributionReview.set({ enabled: true });
    expect(await applyCorrectionIfTrusted(filed, 'u1', { via: 'web' })).toBe(filed);
    contributionReview.set({ enabled: false });
    const failed = { ok: false, code: 'invalid' };
    expect(await applyCorrectionIfTrusted(failed, 'u1', {})).toBe(failed);
    expect(approveProposal).not.toHaveBeenCalled();
  });
});
