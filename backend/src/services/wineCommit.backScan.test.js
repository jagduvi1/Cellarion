/**
 * The commit half of the back-label rescue: which scan frames get stamped onto
 * a minted wine, and under what conditions the front/back disagreements are
 * stored beside them.
 *
 * The guards being pinned are the ones that were already load-bearing for the
 * FRONT scan and must hold identically for the back one — a second pointer is
 * a second way to attach somebody else's photo to a registry row:
 *   ownership (the filter IS the authorization), single-use (an image already
 *   bound to a wine is never re-claimed), and PENDING-ONLY (a fully-identified
 *   wine has no identity to correct, so retaining the user's original frame
 *   against it stores a personal photo with no purpose — audit L-5).
 */

jest.mock('../models/BottleImage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { findOrCreateWine } = require('./findOrCreateWine');
const {
  attachScanImage, resolveOrMintWine, validateScanConflicts, MAX_SCAN_CONFLICTS,
} = require('./wineCommit');

const oid = (c) => c.repeat(24);
const USER = oid('1');
const OTHER = oid('2');
const FRONT = oid('5');
const BACK = oid('6');

const req = { user: { id: USER } };
const wineDoc = (over = {}) => ({
  _id: 'wine-1', scanImage: null, scanImageBack: null, scanFieldConflicts: [],
  pendingIdentity: true, createdBy: USER, save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

/** Claim outcomes, in call order. `null` = the filter matched nothing. */
const primeClaims = (...results) => {
  BottleImage.findOneAndUpdate.mockReset();
  for (const r of results) {
    BottleImage.findOneAndUpdate.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue(r ? { _id: r } : null),
    });
  }
};

beforeEach(() => jest.clearAllMocks());

describe('attachScanImage — two frames, one save', () => {
  test('claims both atomically and sets both pointers with a single save', async () => {
    primeClaims(FRONT, BACK);
    const w = wineDoc();

    await attachScanImage(w, { scanImageId: FRONT, scanImageBackId: BACK }, req);

    expect(BottleImage.findOneAndUpdate).toHaveBeenCalledTimes(2);
    for (const id of [FRONT, BACK]) {
      expect(BottleImage.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: id, uploadedBy: USER, kind: 'label-scan', wineDefinition: null },
        { $set: { wineDefinition: 'wine-1', updatedAt: expect.any(Date) } },
        { new: true },
      );
    }
    expect(String(w.scanImage)).toBe(FRONT);
    expect(String(w.scanImageBack)).toBe(BACK);
    // ONE save: two frames of one bottle are one write, not two.
    expect(w.save).toHaveBeenCalledTimes(1);
  });

  test('a back scan alone is attached — the front 422\'d and its frame was abandoned', async () => {
    primeClaims(BACK);
    const w = wineDoc();

    await attachScanImage(w, { scanImageBackId: BACK }, req);

    expect(w.scanImage).toBeNull();
    expect(String(w.scanImageBack)).toBe(BACK);
    expect(w.save).toHaveBeenCalledTimes(1);
  });

  test('another user\'s back-scan id is a no-op — the filter IS the authorization', async () => {
    primeClaims(null);
    const w = wineDoc();

    await attachScanImage(w, { scanImageBackId: BACK }, { user: { id: OTHER } });

    expect(BottleImage.findOneAndUpdate.mock.calls[0][0].uploadedBy).toBe(OTHER);
    expect(w.scanImageBack).toBeNull();
    expect(w.save).not.toHaveBeenCalled();
  });

  test('an already-bound image is not re-claimed — single use, and it is also what keeps the 30-day sweep honest', async () => {
    // wineDefinition: null in the filter is the single-use guard; a bound row
    // simply does not match.
    primeClaims(null, null);
    const w = wineDoc();

    await attachScanImage(w, { scanImageId: FRONT, scanImageBackId: BACK }, req);

    expect(w.scanImage).toBeNull();
    expect(w.scanImageBack).toBeNull();
    expect(w.save).not.toHaveBeenCalled();
  });

  test('one frame lost to a race does not lose the other', async () => {
    primeClaims(null, BACK);
    const w = wineDoc();

    await attachScanImage(w, { scanImageId: FRONT, scanImageBackId: BACK }, req);

    expect(w.scanImage).toBeNull();
    expect(String(w.scanImageBack)).toBe(BACK);
    expect(w.save).toHaveBeenCalledTimes(1);
  });

  test('a junk back id never reaches the database', async () => {
    await attachScanImage(wineDoc(), { scanImageBackId: 'not-an-id' }, req);
    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('no ids at all is a no-op', async () => {
    await attachScanImage(wineDoc(), {}, req);
    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('it stays best-effort — a database failure must never fail the bottle add', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    BottleImage.findOneAndUpdate.mockImplementation(() => { throw new Error('mongo down'); });

    await expect(attachScanImage(wineDoc(), { scanImageId: FRONT }, req)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('validateScanConflicts', () => {
  const one = { field: 'producer', front: 'Cave', back: 'Wolfberger' };

  test('accepts a well-formed list', () => {
    expect(validateScanConflicts([one])).toEqual([one]);
  });

  test('rejects more than the merge could ever produce', () => {
    expect(validateScanConflicts(Array(MAX_SCAN_CONFLICTS + 1).fill(one))).toBeNull();
  });

  test('rejects oversized strings — same cap as the identity fields they describe', () => {
    expect(validateScanConflicts([{ ...one, back: 'x'.repeat(201) }])).toBeNull();
  });

  test.each([
    ['a non-array', { field: 'producer' }],
    ['a non-object entry', ['producer']],
    ['a non-string member', [{ field: 'producer', front: 1, back: 'x' }]],
    ['an empty field name', [{ field: '  ', front: 'a', back: 'b' }]],
    ['an empty list', []],
  ])('rejects %s', (_label, input) => {
    expect(validateScanConflicts(input)).toBeNull();
  });
});

describe('resolveOrMintWine — the evidence gate', () => {
  const newWine = (over = {}) => ({
    name: 'Kaefferkopf', producer: '', country: 'France',
    scanImageId: FRONT, scanImageBackId: BACK,
    scanConflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
    ...over,
  });

  test('a fresh PENDING mint stores both frames and the disagreements', async () => {
    const wine = wineDoc();
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(FRONT, BACK);

    const out = await resolveOrMintWine(newWine(), req);

    expect(out.pendingIdentity).toBe(true);
    expect(String(wine.scanImage)).toBe(FRONT);
    expect(String(wine.scanImageBack)).toBe(BACK);
    expect(wine.scanFieldConflicts).toEqual([
      { field: 'producer', front: 'Cave', back: 'Wolfberger' },
    ]);
  });

  test('a fully-identified wine keeps NOTHING — no purpose, so no personal photo and no note (audit L-5)', async () => {
    const wine = wineDoc({ pendingIdentity: false });
    findOrCreateWine.mockResolvedValue({ wine, created: true });

    await resolveOrMintWine(newWine({ producer: 'Cave de Kaysersberg' }), req);

    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
    expect(wine.scanImage).toBeNull();
    expect(wine.scanImageBack).toBeNull();
    expect(wine.scanFieldConflicts).toEqual([]);
  });

  test('a SECOND bottle can supply the frames the first add did not have — but only on the creator\'s own row', async () => {
    const wine = wineDoc();
    findOrCreateWine.mockResolvedValue({ wine, created: false });
    primeClaims(FRONT, BACK);

    await resolveOrMintWine(newWine(), req);

    expect(String(wine.scanImage)).toBe(FRONT);
    expect(String(wine.scanImageBack)).toBe(BACK);
  });

  test('somebody else\'s pending row is never backfilled', async () => {
    const wine = wineDoc({ createdBy: OTHER });
    findOrCreateWine.mockResolvedValue({ wine, created: false });

    await resolveOrMintWine(newWine(), req);

    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
    expect(wine.scanFieldConflicts).toEqual([]);
  });

  test('a row that already HAS evidence is not overwritten by a later add', async () => {
    const wine = wineDoc({
      scanImage: oid('7'),
      scanFieldConflicts: [{ field: 'name', front: 'A', back: 'B' }],
    });
    findOrCreateWine.mockResolvedValue({ wine, created: false });

    await resolveOrMintWine(newWine(), req);

    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
    expect(wine.scanFieldConflicts).toEqual([{ field: 'name', front: 'A', back: 'B' }]);
  });

  test('malformed conflicts are DROPPED, never a 400 — a bad extra must not cost the user their bottle', async () => {
    const wine = wineDoc();
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(FRONT, BACK);

    const out = await resolveOrMintWine(newWine({ scanConflicts: 'not an array' }), req);

    expect(out.wine).toBe(wine);
    expect(wine.scanFieldConflicts).toEqual([]);
    // …and the photos still landed.
    expect(String(wine.scanImageBack)).toBe(BACK);
  });

  test('conflicts without any surviving frame are not stored — a note about photos nobody has cannot be checked', async () => {
    const wine = wineDoc();
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(null, null); // both claims lost

    await resolveOrMintWine(newWine(), req);

    expect(wine.scanFieldConflicts).toEqual([]);
  });
});
