/**
 * Classification rides the commit into the mint (ticket 6a8162c5).
 *
 * The scan prompt now extracts the printed classification line ("Grand Cru
 * Classé en 1855") into its own field — before this it had no slot and landed
 * in the NAME (the Giscours case). The client threads it through the newWine
 * payload invisibly; these tests pin that the commit passes it to
 * findOrCreateWine and that the request-validation cap covers it (the payload
 * is machine-generated, same rationale as region).
 */

jest.mock('../models/BottleImage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const { findOrCreateWine } = require('./findOrCreateWine');
const { resolveOrMintWine, validateNewWineFields, MAX_WINE_FIELD } = require('./wineCommit');

const USER = '1'.repeat(24);
const req = { user: { id: USER } };

beforeEach(() => jest.clearAllMocks());

test('classification is passed through to findOrCreateWine', async () => {
  findOrCreateWine.mockResolvedValue({
    wine: {
      _id: 'wine-1', name: 'Château Giscours', producer: 'Château Giscours',
      classification: 'Grand Cru Classé en 1855',
      scanImage: null, scanImageBack: null, pendingIdentity: false, createdBy: USER,
      save: jest.fn().mockResolvedValue(undefined),
    },
    created: true,
  });

  await resolveOrMintWine({
    name: 'Château Giscours', producer: 'Château Giscours', country: 'France',
    appellation: 'Margaux', classification: 'Grand Cru Classé en 1855', type: 'red',
  }, req);

  expect(findOrCreateWine.mock.calls[0][0].classification).toBe('Grand Cru Classé en 1855');
});

test('the request cap covers classification like the other identity fields', () => {
  const err = validateNewWineFields({
    name: 'X', producer: 'Y', country: 'France',
    classification: 'c'.repeat(MAX_WINE_FIELD + 1),
  });
  expect(err).toMatch(/classification must be/);
});

test('an absent classification stays valid', () => {
  expect(validateNewWineFields({ name: 'X', producer: 'Y', country: 'France' })).toBeNull();
});
