/**
 * The registry scripts that rebuild a wine's normalizedKey with
 * generateWineKey select only rows whose key lives in the public key space.
 *
 * A pending-identity row keys as `pending~<creator>` and a draft as
 * `draft~<creator>`: rebuilt with generateWineKey, either would move into the
 * public key space while still private, where its key can collide with (or be
 * taken by) a registry wine. A canary is a seeded tripwire whose fields must
 * stay as seeded. Each script's CANDIDATES therefore excludes all three, with
 * `$ne: true` so a row that has no such field still matches.
 */
// The meilisearch package is ESM and Jest cannot load it; the scripts only
// need the handles.
jest.mock('../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('./lib/scriptSearch', () => ({ initSearch: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ unpolluteEstateName: jest.fn() }));

const PRIVATE_ROWS_OUT = {
  pendingIdentity: { $ne: true },
  draft: { $ne: true },
  canary: { $ne: true },
};

const scripts = {
  'fix-classification-polluted-names': { producer: { $nin: [null, ''] }, nonWine: { $ne: true } },
  'normalize-appellation-tiers': { appellation: { $nin: [null, ''] } },
  'strip-name-vintages': { name: { $regex: /(?:19[5-9]\d|20[0-4]\d)\)?$/ } },
};

describe.each(Object.entries(scripts))('%s', (script, ownClauses) => {
  const { CANDIDATES } = require(`./${script}`);

  it('never selects a pending-identity row, a draft or a canary', () => {
    expect(CANDIDATES).toMatchObject(PRIVATE_ROWS_OUT);
  });

  it('keeps its own selection', () => {
    expect(CANDIDATES).toEqual({ ...ownClauses, ...PRIVATE_ROWS_OUT });
  });
});
