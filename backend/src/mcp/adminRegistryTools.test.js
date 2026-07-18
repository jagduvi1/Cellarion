/**
 * admin_add_registry_wine — admin curation over MCP.
 *
 * Pins: STRUCTURAL role gating (unregistered for non-admins, exactly like the
 * somm tools), dedup-candidate flow through the same findOrCreateWine
 * chokepoint, the official-image one-shot via attachOfficialWineImage with
 * credit, and the existing_wine_id image-only path.
 */

jest.mock('../models/Bottle', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Rack', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => ({ deleteOne: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(), indexWine: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 900000 }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn(), attachOfficialWineImage: jest.fn() }));
jest.mock('../utils/safeImageFetch', () => ({ safeFetchImage: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('../services/registryGc', () => ({ gcOrphanMintedWine: jest.fn() }));

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { attachOfficialWineImage } = require('../services/imageOps');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { logAudit } = require('../services/audit');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ADMIN_CTX = { user: { id: oid('a'), roles: ['admin'] }, scopes: ['read', 'consume', 'write'], req: { user: { id: oid('a') }, headers: {} } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const WINE = { _id: new mongoose.Types.ObjectId(oid('e')), name: 'Barolo', producer: 'Bartolo Mascarello', populate: jest.fn().mockResolvedValue(undefined) };

beforeEach(() => jest.clearAllMocks());

describe('structural role gating', () => {
  test('registered, write-scoped, admin-only', () => {
    expect(tool('admin_add_registry_wine')).toBeDefined();
    expect(tool('admin_add_registry_wine').requireRole).toEqual(['admin']);
  });

  test('invisible without the admin role — even with full scopes', () => {
    const userNames = toolsForScopes(['read', 'consume', 'write'], ['user']).map((t) => t.name);
    expect(userNames).not.toContain('admin_add_registry_wine');
    const sommNames = toolsForScopes(['read', 'consume', 'write'], ['sommelier']).map((t) => t.name);
    expect(sommNames).not.toContain('admin_add_registry_wine');
    const adminNames = toolsForScopes(['read', 'consume', 'write'], ['admin']).map((t) => t.name);
    expect(adminNames).toContain('admin_add_registry_wine');
  });
});

describe('creation through the shared dedup chokepoint', () => {
  test('creates via findOrCreateWine and audits wine.create with admin provenance', async () => {
    findOrCreateWine.mockResolvedValue({ wine: WINE, created: true });
    const res = await tool('admin_add_registry_wine').handler(
      { name: 'Barolo', producer: 'Bartolo Mascarello', country: 'Italy', type: 'red' }, ADMIN_CTX
    );
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(body.data.created).toBe(true);
    expect(findOrCreateWine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Barolo', producer: 'Bartolo Mascarello' }),
      oid('a'),
      expect.objectContaining({ confirmCreate: false, skipSiblingMatch: false, createdVia: 'mcp' })
    );
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(),
      expect.objectContaining({ via: 'mcp', admin: true }));
  });

  test('soft-zone candidates → conflict listing ids, nothing created', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, candidates: [{ wine: WINE, score: 0.89 }] });
    const res = await tool('admin_add_registry_wine').handler(
      { name: 'Barolo', producer: 'Cantina Bartolo Mascarello', country: 'Italy', type: 'red' }, ADMIN_CTX
    );
    const { error } = parse(res);
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('existing_wine_id');
    expect(error.message).toContain(String(WINE._id));
    expect(attachOfficialWineImage).not.toHaveBeenCalled();
  });
});

describe('official image + credit', () => {
  test('image_url path fetches through the SSRF guard and one-shots the official image with credit', async () => {
    findOrCreateWine.mockResolvedValue({ wine: WINE, created: true });
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('img') });
    attachOfficialWineImage.mockResolvedValue({ image: { _id: oid('9'), status: 'approved' } });
    const res = await tool('admin_add_registry_wine').handler({
      name: 'Barolo', producer: 'Bartolo Mascarello', country: 'Italy', type: 'red',
      image_url: 'https://cdn.example.com/label.webp', image_credit: 'Photo: Systembolaget',
    }, ADMIN_CTX);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(safeFetchImage).toHaveBeenCalledWith('https://cdn.example.com/label.webp');
    expect(attachOfficialWineImage).toHaveBeenCalledWith(
      expect.objectContaining({ wineDefinitionId: WINE._id, credit: 'Photo: Systembolaget', userId: oid('a') }),
      ADMIN_CTX.req
    );
    expect(body.data.official_image).toMatchObject({ status: 'approved', credit: 'Photo: Systembolaget' });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'admin.wine.image.set', expect.anything(),
      expect.objectContaining({ via: 'mcp', credit: 'Photo: Systembolaget' }));
  });

  test('existing_wine_id sets the image WITHOUT creating anything', async () => {
    WineDefinition.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({ ...WINE, populate: undefined }) });
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('img') });
    attachOfficialWineImage.mockResolvedValue({ image: { _id: oid('9'), status: 'approved' } });
    const res = await tool('admin_add_registry_wine').handler({
      name: 'x', producer: 'x', country: 'x', type: 'red',
      existing_wine_id: String(WINE._id), image_url: 'https://cdn.example.com/label.webp',
    }, ADMIN_CTX);
    expect(parse(res).error).toBeUndefined();
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(parse(res).data.created).toBe(false);
  });

  test('a failed image reports the created wine_id so the admin can retry image-only', async () => {
    findOrCreateWine.mockResolvedValue({ wine: WINE, created: true });
    safeFetchImage.mockRejectedValue(new Error('HTTP 404'));
    const res = await tool('admin_add_registry_wine').handler({
      name: 'Barolo', producer: 'Bartolo Mascarello', country: 'Italy', type: 'red',
      image_url: 'https://cdn.example.com/missing.webp',
    }, ADMIN_CTX);
    const { error } = parse(res);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(String(WINE._id));
  });
});
