/**
 * list_wine_drafts / update_wine_draft / publish_wine — the connector's half
 * of private draft wines (support ticket 2026-09-12). The service is mocked:
 * this pins scopes, delegation with the caller's identity, the arg → patch
 * mapping, and the service-code → MCP-code mapping (duplicate/similar →
 * conflict carrying the match/candidates; invalid_identity → invalid_input;
 * attach_to → attachDraftBottles).
 */

jest.mock('../services/wineDraftOps', () => ({
  PUBLISH_BATCH_MAX: 24,
  listDrafts: jest.fn(),
  loadOwnDraft: jest.fn(),
  validateDraftPatch: jest.fn((p) => ({ ok: true, clean: p })),
  updateDraft: jest.fn(),
  publishDraft: jest.fn(),
  publishDrafts: jest.fn(),
  attachDraftBottles: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const ops = require('../services/wineDraftOps');
const { logAudit } = require('../services/audit');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');
const TARGET = oid('c');
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const draft = (o = {}) => ({ _id: WINE, name: 'Kaefferkopf', producer: 'Cave', draft: true, draftExpiresAt: new Date('2026-09-19T00:00:00Z'), ...o });

beforeEach(() => jest.clearAllMocks());

describe('registration', () => {
  test('list is read scope; update and publish are write scope; none is destructive', () => {
    expect(tool('list_wine_drafts').scope).toBe('read');
    expect(tool('update_wine_draft').scope).toBe('write');
    expect(tool('publish_wine').scope).toBe('write');
    expect(tool('publish_wine').annotations.destructiveHint).toBe(false);
  });
});

describe('list_wine_drafts', () => {
  test('delegates with the caller id and reshapes the rows', async () => {
    ops.listDrafts.mockResolvedValue({ ok: true, drafts: [{ _id: WINE, name: 'Kaefferkopf', producer: '', appellation: null, classification: null, type: 'white', country: 'France', region: null, grapes: [], bottleCount: 2, draftExpiresAt: '2026-09-19T00:00:00.000Z', createdAt: 'x' }] });
    const body = parse(await tool('list_wine_drafts').handler({}, CTX));
    expect(ops.listDrafts).toHaveBeenCalledWith(ME);
    expect(body.data.drafts[0]).toMatchObject({ wine_id: WINE, producer: null, bottle_count: 2, draft_expires_at: '2026-09-19T00:00:00.000Z' });
    expect(body.data.guidance).toMatch(/publish_wine/);
  });
});

describe('update_wine_draft', () => {
  test('a stranger (not_found from the ops) is not_found; args map onto the service patch names', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: false, code: 'not_found', message: 'No draft with that id.' });
    expect(parse(await tool('update_wine_draft').handler({ wine_id: WINE, name: 'X' }, CTX)).error.code).toBe('not_found');

    const w = draft();
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: w });
    ops.updateDraft.mockResolvedValue({ ok: true, wine: { ...w, name: 'X' }, diff: { name: { from: 'Kaefferkopf', to: 'X' } } });
    const body = parse(await tool('update_wine_draft').handler({ wine_id: WINE, name: 'X', country: 'France', region: 'Alsace', grapes: ['Riesling'], producer: '' }, CTX));
    expect(ops.validateDraftPatch).toHaveBeenCalledWith({ name: 'X', producer: '', countryName: 'France', regionName: 'Alsace', grapeNames: ['Riesling'] });
    expect(ops.updateDraft).toHaveBeenCalledWith(w, expect.objectContaining({ name: 'X' }), ME);
    expect(body.data.changed).toEqual({ name: { from: 'Kaefferkopf', to: 'X' } });
    expect(logAudit).toHaveBeenCalledWith(CTX.req, 'wine.draft_edit', { type: 'wine', id: WINE }, expect.objectContaining({ via: 'mcp' }));
  });

  test('a validation refusal and an unknown-taxonomy refusal are invalid_input; a key clash is conflict', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: draft() });
    ops.validateDraftPatch.mockReturnValueOnce({ ok: false, error: 'Nothing to change' });
    expect(parse(await tool('update_wine_draft').handler({ wine_id: WINE }, CTX)).error.code).toBe('invalid_input');
    ops.updateDraft.mockResolvedValueOnce({ ok: false, code: 'invalid_input', message: 'Unknown country' });
    expect(parse(await tool('update_wine_draft').handler({ wine_id: WINE, country: 'Atlantis' }, CTX)).error.code).toBe('invalid_input');
    ops.updateDraft.mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'already have a draft' });
    expect(parse(await tool('update_wine_draft').handler({ wine_id: WINE, name: 'Dup' }, CTX)).error.code).toBe('conflict');
  });
});

describe('publish_wine', () => {
  test('argument contract: one of wine_id / wine_ids; attach_to only with wine_id', async () => {
    expect(parse(await tool('publish_wine').handler({}, CTX)).error.code).toBe('invalid_input');
    expect(parse(await tool('publish_wine').handler({ wine_id: WINE, wine_ids: [WINE] }, CTX)).error.code).toBe('invalid_input');
    expect(parse(await tool('publish_wine').handler({ wine_ids: [WINE], attach_to: TARGET }, CTX)).error.code).toBe('invalid_input');
    expect(ops.publishDraft).not.toHaveBeenCalled();
  });

  test('published / pending_curation ride through as ok; confirm_similar becomes confirmCreate', async () => {
    const w = draft();
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: w });
    ops.publishDraft.mockResolvedValueOnce({ ok: true, wine: w, promoted: true, pendingCuration: false });
    let body = parse(await tool('publish_wine').handler({ wine_id: WINE, confirm_similar: true }, CTX));
    expect(ops.publishDraft).toHaveBeenCalledWith(w, expect.objectContaining({ userId: ME, confirmCreate: true }));
    expect(body.data).toMatchObject({ wine_id: WINE, status: 'published' });

    ops.publishDraft.mockResolvedValueOnce({ ok: true, wine: w, promoted: false, pendingCuration: true });
    body = parse(await tool('publish_wine').handler({ wine_id: WINE }, CTX));
    expect(body.data.status).toBe('pending_curation');
    expect(body.summary).toMatch(/curator/);
  });

  test('duplicate and similar are conflicts that carry the match / candidates; invalid_identity is invalid_input', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: draft() });
    ops.publishDraft.mockResolvedValueOnce({ ok: false, code: 'duplicate', message: 'The registry already holds this wine', match: { wine_id: TARGET, name: 'Kaefferkopf' } });
    let body = parse(await tool('publish_wine').handler({ wine_id: WINE }, CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain(TARGET);
    expect(body.error.message).toContain('"status":"duplicate"');

    ops.publishDraft.mockResolvedValueOnce({ ok: false, code: 'similar', message: 'look like this one', candidates: [{ wine_id: TARGET, score: 0.9 }] });
    body = parse(await tool('publish_wine').handler({ wine_id: WINE }, CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('"candidates"');

    ops.publishDraft.mockResolvedValueOnce({ ok: false, code: 'invalid_identity', message: 'not a usable producer' });
    body = parse(await tool('publish_wine').handler({ wine_id: WINE }, CTX));
    expect(body.error.code).toBe('invalid_input');
  });

  test('attach_to moves the bottles instead of publishing', async () => {
    const w = draft();
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: w });
    ops.attachDraftBottles.mockResolvedValue({ ok: true, bottlesMoved: 3, wine: { _id: TARGET, name: 'Kaefferkopf', producer: 'Cave' } });
    const body = parse(await tool('publish_wine').handler({ wine_id: WINE, attach_to: TARGET }, CTX));
    expect(ops.attachDraftBottles).toHaveBeenCalledWith(w, TARGET, expect.objectContaining({ userId: ME, roles: ['user'] }));
    expect(ops.publishDraft).not.toHaveBeenCalled();
    expect(body.data).toEqual({ wine_id: TARGET, bottles_moved: 3 });
  });

  test('a batch reports per wine_id with guidance', async () => {
    ops.publishDrafts.mockResolvedValue({ ok: true, results: [{ id: WINE, status: 'published' }, { id: TARGET, status: 'duplicate', error: 'dup', match: { wine_id: oid('9') } }] });
    const body = parse(await tool('publish_wine').handler({ wine_ids: [WINE, TARGET], confirm_similar: true }, CTX));
    expect(ops.publishDrafts).toHaveBeenCalledWith([WINE, TARGET], ME, expect.objectContaining({ confirmCreate: true }));
    expect(body.data.results).toEqual([
      expect.objectContaining({ wine_id: WINE, status: 'published' }),
      expect.objectContaining({ wine_id: TARGET, status: 'duplicate', match: { wine_id: oid('9') } }),
    ]);
    expect(body.summary).toMatch(/1 published, 1 duplicate/);
  });
});
