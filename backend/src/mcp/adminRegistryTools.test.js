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

  // Every appellation writer has to reach the curated-registry resolver. This
  // one reaches it by DELEGATION: the appellation goes to findOrCreateWine
  // untouched, and that chokepoint tier-strips + resolves before keying and
  // storing. The pin is that this tool never canonicalizes on its own — a
  // second copy of the rule here is exactly how the surfaces drift apart.
  test('the appellation is handed to the resolving chokepoint RAW, not pre-normalized', async () => {
    findOrCreateWine.mockResolvedValue({ wine: WINE, created: true });
    await tool('admin_add_registry_wine').handler(
      { name: 'Barrica', producer: 'Castaño', country: 'Spain', appellation: 'Yecla DO', type: 'red' }, ADMIN_CTX
    );
    expect(findOrCreateWine).toHaveBeenCalledWith(
      expect.objectContaining({ appellation: 'Yecla DO' }), oid('a'), expect.anything()
    );
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
    // The pipeline gates + sanitises the credit; the tool reports the STORED value.
    attachOfficialWineImage.mockResolvedValue({ image: { _id: oid('9'), status: 'approved', credit: 'Photo: Systembolaget' } });
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

// ─── Taxonomy review queues over MCP (strategy 2026-07-29 R2/R3) ─────────────

jest.mock('../services/taxonomyReview', () => ({
  listPendingRegions: jest.fn(),
  listUnmatchedAppellations: jest.fn(),
  appellationRefsError: jest.fn(), // resolves undefined → guard passes
  dismissUnmatchedAppellation: jest.fn(),
  restoreDismissedAppellation: jest.fn(),
  listDismissedAppellations: jest.fn(),
}));
jest.mock('../models/Region', () => ({ findById: jest.fn() }));
jest.mock('../models/Appellation', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'ap-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  return M;
});

const {
  listPendingRegions, listUnmatchedAppellations, appellationRefsError,
  dismissUnmatchedAppellation, restoreDismissedAppellation, listDismissedAppellations,
} = require('../services/taxonomyReview');
const Region = require('../models/Region');
const Appellation = require('../models/Appellation');

describe('taxonomy review tools', () => {
  test('all six are admin-only and correctly scoped', () => {
    for (const [name, scope] of [
      ['list_region_review_queue', 'read'], ['approve_region', 'write'],
      ['list_unmatched_appellations', 'read'], ['promote_appellation', 'write'],
      ['dismiss_appellation', 'write'], ['restore_appellation', 'write'],
    ]) {
      expect(tool(name)).toBeDefined();
      expect(tool(name).requireRole).toEqual(['admin']);
      expect(tool(name).scope).toBe(scope);
    }
    // Structural invisibility for non-admins — same guarantee as the somm tools.
    const plain = toolsForScopes(['read', 'write'], ['user']).map((t) => t.name);
    for (const n of ['list_region_review_queue', 'approve_region', 'list_unmatched_appellations', 'promote_appellation', 'dismiss_appellation', 'restore_appellation']) {
      expect(plain).not.toContain(n);
    }
  });

  test('list_region_review_queue returns the shared service view', async () => {
    listPendingRegions.mockResolvedValue([{ _id: 'r1', name: 'Toscana', country: 'Italy', wineCount: 3, createdAt: new Date('2026-07-29') }]);
    const body = parse(await tool('list_region_review_queue').handler({}, ADMIN_CTX));
    expect(body.data[0]).toMatchObject({ region_id: 'r1', name: 'Toscana', wine_count: 3 });
  });

  test('approve_region stamps the review once, is idempotent, audits via mcp', async () => {
    const r = { _id: oid('1'), name: 'Etna', createdByUser: true, reviewedAt: null, save: jest.fn().mockResolvedValue(undefined) };
    Region.findById.mockResolvedValue(r);
    let body = parse(await tool('approve_region').handler({ region_id: oid('1') }, ADMIN_CTX));
    expect(r.reviewedAt).toBeTruthy();
    expect(r.createdByUser).toBe(true); // provenance survives the review
    expect(r.save).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(ADMIN_CTX.req, 'admin.taxonomy.approveRegion',
      expect.anything(), expect.objectContaining({ via: 'mcp' }));

    // Second call: nothing to do, no second save.
    r.save.mockClear();
    body = parse(await tool('approve_region').handler({ region_id: oid('1') }, ADMIN_CTX));
    expect(body.data.already).toBe(true);
    expect(r.save).not.toHaveBeenCalled();
  });

  test('promote_appellation creates the doc with the appellation key and synonyms', async () => {
    const body = parse(await tool('promote_appellation').handler(
      { name: 'Châteauneuf-du-Pape', country_id: oid('c'), synonyms: ['Chateauneuf du Pape'] }, ADMIN_CTX));
    expect(body.error).toBeUndefined();
    const doc = Appellation.mock.calls[0][0];
    // Hyphen-folded key — the whole point of normalizeAppellationKey.
    expect(doc.normalizedName).toBe('chateauneuf du pape');
    expect(doc.synonyms).toEqual(['Chateauneuf du Pape']);
    expect(doc.createdBy).toBe(ADMIN_CTX.user.id);
  });

  test('promote_appellation surfaces the per-country unique conflict as conflict, not a crash', async () => {
    Appellation.mockImplementationOnce(function () { this.save = jest.fn().mockRejectedValue({ code: 11000 }); });
    const body = parse(await tool('promote_appellation').handler(
      { name: 'Alsace', country_id: oid('c') }, ADMIN_CTX));
    expect(body.error.code).toBe('conflict');
  });

  test('promote_appellation runs the shared ref guard — "must belong to the same country" is now enforced, not documented (audit 2026-07-30)', async () => {
    appellationRefsError.mockResolvedValueOnce('Region "Rioja" belongs to a different country than the appellation');
    const body = parse(await tool('promote_appellation').handler(
      { name: 'Somontano', country_id: oid('c'), region_id: oid('d') }, ADMIN_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/different country/);
    expect(appellationRefsError).toHaveBeenCalledWith(oid('c'), oid('d'));
    expect(Appellation).not.toHaveBeenCalled();
  });

  // ── dismiss / restore — the queue's terminal state (ticket 6a842d5e) ──────

  test('dismiss_appellation records the skip via the shared service and audits like the REST twin', async () => {
    dismissUnmatchedAppellation.mockResolvedValue({ key: 'qualitatswein', name: 'Qualitätswein', created: true });
    const body = parse(await tool('dismiss_appellation').handler(
      { name: 'Qualitätswein', reason: 'German quality tier, not an appellation' }, ADMIN_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.already).toBe(false);
    expect(dismissUnmatchedAppellation).toHaveBeenCalledWith(
      { name: 'Qualitätswein', reason: 'German quality tier, not an appellation', userId: ADMIN_CTX.user.id });
    expect(logAudit).toHaveBeenCalledWith(ADMIN_CTX.req, 'admin.taxonomy.appellationDismiss',
      expect.anything(), expect.objectContaining({ key: 'qualitatswein', via: 'mcp' }));
  });

  test('a second dismissal of the same string is idempotent, not an error', async () => {
    dismissUnmatchedAppellation.mockResolvedValue({ key: 'qualitatswein', name: 'Qualitätswein', created: false });
    const body = parse(await tool('dismiss_appellation').handler(
      { name: 'Qualitätswein', reason: 'German quality tier, not an appellation' }, ADMIN_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.already).toBe(true);
  });

  test('dismiss_appellation surfaces service validation as invalid_input', async () => {
    dismissUnmatchedAppellation.mockResolvedValue({ error: 'A reason of at least 5 characters is required — it is the record of why this was rejected' });
    const body = parse(await tool('dismiss_appellation').handler(
      { name: 'Qualitätswein', reason: 'nope!' }, ADMIN_CTX));
    expect(body.error.code).toBe('invalid_input');
  });

  test('restore_appellation lifts a dismissal; an unknown string is not_found', async () => {
    restoreDismissedAppellation.mockResolvedValueOnce({ key: 'qualitatswein', restored: true });
    let body = parse(await tool('restore_appellation').handler({ name: 'Qualitätswein' }, ADMIN_CTX));
    expect(body.error).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(ADMIN_CTX.req, 'admin.taxonomy.appellationRestore',
      expect.anything(), expect.objectContaining({ key: 'qualitatswein', via: 'mcp' }));

    restoreDismissedAppellation.mockResolvedValueOnce({ key: 'never dismissed', restored: false });
    body = parse(await tool('restore_appellation').handler({ name: 'Never Dismissed' }, ADMIN_CTX));
    expect(body.error.code).toBe('not_found');
  });

  test('list_unmatched_appellations include_dismissed returns open + dismissed, and stays a bare array without the flag', async () => {
    listUnmatchedAppellations.mockResolvedValue([{ name: 'Heathcote', wineCount: 2, countryName: null, countryId: null, regionName: null, regionId: null }]);
    listDismissedAppellations.mockResolvedValue([{ key: 'qualitatswein', name: 'Qualitätswein', reason: 'quality tier', dismissedBy: 'johan', dismissedAt: new Date('2026-08-18') }]);

    let body = parse(await tool('list_unmatched_appellations').handler({}, ADMIN_CTX));
    expect(Array.isArray(body.data)).toBe(true);
    expect(listDismissedAppellations).not.toHaveBeenCalled();

    body = parse(await tool('list_unmatched_appellations').handler({ include_dismissed: true }, ADMIN_CTX));
    expect(body.data.open[0].name).toBe('Heathcote');
    expect(body.data.dismissed[0]).toMatchObject({ name: 'Qualitätswein', reason: 'quality tier' });
  });
});
