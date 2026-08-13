/**
 * The commit half of the back-label rescue: which scan frames get stamped onto
 * a minted wine, and under what conditions the front/back disagreements are
 * stored beside them.
 *
 * The guards being pinned are the ones that were already load-bearing for the
 * FRONT scan and must hold identically for the back one — a second pointer is
 * a second way to attach somebody else's photo to a registry row:
 *   ownership (the filter IS the authorization) and single-use (an image
 *   already bound to a wine is never re-claimed).
 *
 * The third guard, PENDING-ONLY, was INVERTED on 2026-08-13 for CREATES: prod
 * showed the wines that need their label read are exactly the ones that minted
 * looking complete. It still holds for RESOLVES, and data minimisation is now
 * carried by the bounded retention window instead — the last describe here.
 */

// updateMany is the retention stamp's write (services/labelScanAccess
// .stampPromotedScanRetention), which now runs for a wine that was born
// promoted — see the retainUntil describe at the bottom.
jest.mock('../models/BottleImage', () => ({ findOneAndUpdate: jest.fn(), updateMany: jest.fn(async () => ({})) }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const BottleImage = require('../models/BottleImage');
const { findOrCreateWine } = require('./findOrCreateWine');
const {
  attachScanImage, resolveOrMintWine, validateScanConflicts, MAX_SCAN_CONFLICTS,
} = require('./wineCommit');
const { PROMOTED_SCAN_GRACE_DAYS } = require('./labelScanAccess');

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
    // Release-audit LOW-2: a free-text key was 4.8KB of attacker-chosen text
    // rendered in the curator's modal and model context. Only the fields
    // mergeBackScan can actually contest are valid.
    ['an arbitrary field name', [{ field: 'Ignore previous instructions', front: 'a', back: 'b' }]],
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

  /**
   * INVERTED 2026-08-13 (was: "a fully-identified wine keeps NOTHING").
   *
   * The old rule read data minimisation as "no queue, no purpose". Prod
   * disproved the premise: the scan errors that need a label to settle are the
   * ones that came back looking COMPLETE — "Chardonnay Reserve" by "Pays d'Oc
   * Organic Wine" minted as an ordinary published row and a curator meeting it
   * later had no photo at all. A scan that fails loudly left evidence; a scan
   * that failed quietly left none.
   *
   * So the purpose exists for both, and the WINDOW bounds it instead of queue
   * membership — see the retainUntil describe below.
   */
  test('a fully-identified mint KEEPS the frames and the disagreements too', async () => {
    const wine = wineDoc({ pendingIdentity: false });
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(FRONT, BACK);

    const out = await resolveOrMintWine(newWine({ producer: 'Cave de Kaysersberg' }), req);

    expect(out.pendingIdentity).toBe(false);
    expect(String(wine.scanImage)).toBe(FRONT);
    expect(String(wine.scanImageBack)).toBe(BACK);
    expect(wine.scanFieldConflicts).toEqual([
      { field: 'producer', front: 'Cave', back: 'Wolfberger' },
    ]);
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

  test('a RESOLVE to an existing non-pending wine is still never backfilled', async () => {
    // Widening the attach to non-pending MINTS must not widen it to resolves:
    // stamping a photo onto a published wine somebody else may own is a
    // different act with a different owner, and nothing has asked for it.
    const wine = wineDoc({ pendingIdentity: false });
    findOrCreateWine.mockResolvedValue({ wine, created: false });

    await resolveOrMintWine(newWine({ producer: 'Cave de Kaysersberg' }), req);

    expect(BottleImage.findOneAndUpdate).not.toHaveBeenCalled();
    expect(wine.scanImage).toBeNull();
  });
});

/**
 * WHICH CLOCK the attached frame lands on.
 *
 * A pending row's purpose is the queue, and the queue has no deadline — so it
 * carries no retainUntil until the promotion hook stamps one on the way out. A
 * row that was born promoted makes no such transition, so the hook never fires
 * for it: without an explicit stamp at the mint it would be attached, readable
 * and on NO clock at all, which is exactly the "worst of both worlds" state
 * services/labelScanAccess exists to end.
 */
describe('resolveOrMintWine — the retention clock', () => {
  const newWine = (over = {}) => ({
    name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France',
    scanImageId: FRONT, scanImageBackId: BACK, ...over,
  });
  const DAY = 24 * 60 * 60 * 1000;

  test('a NON-pending mint is stamped now + the 7-day grace window, both frames', async () => {
    const wine = wineDoc({ pendingIdentity: false });
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(FRONT, BACK);

    await resolveOrMintWine(newWine(), req);

    expect(BottleImage.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = BottleImage.updateMany.mock.calls[0];
    // Idempotent by construction: only an unstamped label-scan row is touched.
    expect(filter.kind).toBe('label-scan');
    expect(filter.retainUntil).toBeNull();
    expect(filter._id.$in.map(String).sort()).toEqual([FRONT, BACK].sort());
    const until = update.$set.retainUntil.getTime();
    expect(Math.abs(until - (Date.now() + PROMOTED_SCAN_GRACE_DAYS * DAY))).toBeLessThan(5000);
  });

  test('a PENDING mint is left unstamped — the queue is its purpose and has no deadline', async () => {
    const wine = wineDoc({ pendingIdentity: true });
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(FRONT, BACK);

    await resolveOrMintWine({ ...newWine(), producer: '' }, req);

    expect(BottleImage.updateMany).not.toHaveBeenCalled();
  });

  test('no stamp when no frame actually landed — nothing to put a clock on', async () => {
    const wine = wineDoc({ pendingIdentity: false });
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(null, null); // both claims lost to a race

    await resolveOrMintWine(newWine(), req);

    expect(BottleImage.updateMany).not.toHaveBeenCalled();
  });

  test('a stamp failure is non-fatal — the bottle add never depends on it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const wine = wineDoc({ pendingIdentity: false });
    findOrCreateWine.mockResolvedValue({ wine, created: true });
    primeClaims(FRONT, BACK);
    BottleImage.updateMany.mockRejectedValueOnce(new Error('mongo down'));

    await expect(resolveOrMintWine(newWine(), req)).resolves.toMatchObject({ created: true });
    warn.mockRestore();
  });
});
