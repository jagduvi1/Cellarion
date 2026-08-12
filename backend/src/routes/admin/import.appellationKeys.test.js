/**
 * Import taxonomy keying + upsert identity (release-audit F1 + F3 on PR #951).
 *
 * F1: getOrCreateAppellation must key Appellation docs with
 * normalizeAppellationKey (hyphens → spaces), the convention every other
 * creator and every lookup uses. It keyed with normalizeString (hyphens
 * deleted), so a CSV mentioning any hyphenated curated name — most of
 * Burgundy — missed the curated doc and upserted an invisible twin. Both
 * release auditors found this independently.
 *
 * F3: the curated-spelling resolve moves dedup keys ("… Yecla DO" →
 * "… Yecla"), so the bulkWrite upsert filter must also match the PRE-RESOLVE
 * key or a re-import of an old file mints duplicate wines.
 */

jest.mock('../../services/search', () => ({ fullSync: jest.fn(), indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../../models/Country', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Region', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));

const Appellation = require('../../models/Appellation');
const { getOrCreateAppellation, buildUpsertFilter } = require('./import');

beforeEach(() => jest.clearAllMocks());

describe('getOrCreateAppellation — F1: the keying convention', () => {
  test('keys with the hyphen-folding form, so a curated "Nuits-Saint-Georges" is FOUND, not twinned', async () => {
    Appellation.findOneAndUpdate.mockResolvedValue({ _id: 'ap1' });

    await getOrCreateAppellation('Nuits-Saint-Georges', 'FR', null, 'u1', new Map());

    expect(Appellation.findOneAndUpdate).toHaveBeenCalledWith(
      { country: 'FR', normalizedName: 'nuits saint georges' },
      expect.anything(),
      expect.anything(),
    );
  });

  test('spaced and hyphenated spellings of one name produce the SAME key', async () => {
    Appellation.findOneAndUpdate.mockResolvedValue({ _id: 'ap1' });

    await getOrCreateAppellation('Chateauneuf du Pape', 'FR', null, 'u1', new Map());
    await getOrCreateAppellation('Châteauneuf-du-Pape', 'FR', null, 'u1', new Map());

    const keys = Appellation.findOneAndUpdate.mock.calls.map(([filter]) => filter.normalizedName);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe('buildUpsertFilter — F3: re-import identity', () => {
  test('a resolved row also matches its pre-resolve key', () => {
    expect(buildUpsertFilter({ normalizedKey: 'p:w:yecla', legacyKey: 'p:w:yecla do', lwin7: null }))
      .toEqual({ $or: [{ normalizedKey: 'p:w:yecla' }, { normalizedKey: 'p:w:yecla do' }] });
  });

  test('unresolved rows keep the plain single-key filter — no behavior change', () => {
    expect(buildUpsertFilter({ normalizedKey: 'p:w:barolo', legacyKey: null, lwin7: null }))
      .toEqual({ normalizedKey: 'p:w:barolo' });
  });

  test('LWIN7 still rides the $or alongside both keys', () => {
    expect(buildUpsertFilter({ normalizedKey: 'a', legacyKey: 'b', lwin7: '1234567' }))
      .toEqual({ $or: [{ normalizedKey: 'a' }, { normalizedKey: 'b' }, { 'lwin.lwin7': '1234567' }] });
  });
});
