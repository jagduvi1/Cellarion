/**
 * The Other category rides the commit into the mint: a newWine payload with
 * category "other" (a cider, a beer, a spirit) is minted outside the shared
 * wine registry (findOrCreateWine's nonWine option), and the only other
 * accepted value is the default "wine".
 */

jest.mock('../models/BottleImage', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));

const { findOrCreateWine } = require('./findOrCreateWine');
const { resolveOrMintWine, validateNewWineFields } = require('./wineCommit');

const USER = '1'.repeat(24);
const req = { user: { id: USER } };

const minted = () => findOrCreateWine.mockResolvedValue({
  wine: {
    _id: 'wine-1', name: 'Vintage Cider', producer: 'Example Orchard', nonWine: true, type: null,
    scanImage: null, scanImageBack: null, pendingIdentity: false, createdBy: USER,
    save: jest.fn().mockResolvedValue(undefined),
  },
  created: true,
});

beforeEach(() => jest.clearAllMocks());

test('category "other" mints with the non-wine option', async () => {
  minted();
  await resolveOrMintWine({ name: 'Vintage Cider', producer: 'Example Orchard', country: 'England', category: 'other' }, req);
  expect(findOrCreateWine.mock.calls[0][2].nonWine).toBe(true);
});

test('no category, or "wine", mints an ordinary registry wine', async () => {
  minted();
  await resolveOrMintWine({ name: 'Blanc', producer: 'Example Estate', country: 'France', type: 'white' }, req);
  expect(findOrCreateWine.mock.calls[0][2].nonWine).toBe(false);
  jest.clearAllMocks();
  minted();
  await resolveOrMintWine({ name: 'Blanc', producer: 'Example Estate', country: 'France', type: 'white', category: 'wine' }, req);
  expect(findOrCreateWine.mock.calls[0][2].nonWine).toBe(false);
});

test('any other category is a client fault, not a silent wine', () => {
  expect(validateNewWineFields({ name: 'X', producer: 'Y', country: 'France', category: 'beer' })).toMatch(/category must be/);
  expect(validateNewWineFields({ name: 'X', producer: 'Y', country: 'France', category: 'other' })).toBeNull();
});
