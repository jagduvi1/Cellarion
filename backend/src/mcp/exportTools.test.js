/**
 * MCP export tools — export_cellar / get_account_export.
 *
 * Pins the scope split (read vs write), the owner-only guard on a specific
 * cellar_id, and that the tool returns a LINK envelope (never inlined bytes)
 * and audit-logs the export. The link lifecycle itself is covered by
 * services/exportLinks.test.js; here the service is mocked so we test the
 * tool's own decisions.
 */

jest.mock('../services/exportLinks', () => ({
  mintExportLink: jest.fn(async () => ({ url: 'https://cellarion.app/api/mcp/export/celx_' + 'a'.repeat(64), expiresAt: new Date(Date.now() + 3600000) })),
  LINK_TTL_MS: 60 * 60 * 1000,
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn(), logger: { info: jest.fn() } }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));

const Cellar = require('../models/Cellar');
const { mintExportLink } = require('../services/exportLinks');
const { logAudit } = require('../services/audit');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const CELLAR = oid('c');
const CTX = { user: { id: ME }, scopes: ['read', 'write'], req: { apiToken: { id: 't1' } } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe('registration + scope split', () => {
  test('export_cellar is read-scoped and read-only', () => {
    const t = tool('export_cellar');
    expect(t).toBeDefined();
    expect(t.scope).toBe('read');
    expect(t.annotations.readOnlyHint).toBe(true);
  });

  test('get_account_export is WRITE-scoped (account PII above the read tier)', () => {
    const t = tool('get_account_export');
    expect(t).toBeDefined();
    // Deliberately NOT read: a leaked read-only token must never exfiltrate the
    // full account export (email, audit history). See tool + ApiToken model.
    expect(t.scope).toBe('write');
    expect(t.annotations.readOnlyHint).toBe(true);
  });
});

describe('export_cellar', () => {
  test('default exports ALL owned cellars as JSON, returns a link, audits', async () => {
    const res = await tool('export_cellar').handler({}, CTX);
    const { data } = parse(res);

    expect(mintExportLink).toHaveBeenCalledWith(expect.objectContaining({
      userId: ME, kind: 'cellar_json', cellarScope: 'all', tokenId: 't1',
    }));
    expect(data.download_url).toContain('/api/mcp/export/celx_');
    expect(data.format).toBe('json');
    expect(data.scope).toBe('all_owned_cellars');
    expect(logAudit).toHaveBeenCalledWith(CTX.req, 'user.cellar_data_export', expect.any(Object), expect.objectContaining({ via: 'mcp' }));
    expect(Cellar.findById).not.toHaveBeenCalled(); // 'all' needs no per-cellar check
  });

  test('include_images mints a ZIP link', async () => {
    const res = await tool('export_cellar').handler({ include_images: true }, CTX);
    expect(mintExportLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cellar_zip' }));
    expect(parse(res).data.format).toBe('zip');
  });

  test('a specific OWNED cellar is exportable', async () => {
    Cellar.findById.mockResolvedValue({ _id: CELLAR, user: ME, deletedAt: null });
    const res = await tool('export_cellar').handler({ cellar_id: CELLAR }, CTX);
    expect(mintExportLink).toHaveBeenCalledWith(expect.objectContaining({ cellarScope: CELLAR }));
    expect(parse(res).data.scope).toBe(CELLAR);
  });

  test('a cellar the caller does NOT own → not_found, nothing minted', async () => {
    Cellar.findById.mockResolvedValue({ _id: CELLAR, user: STRANGER, members: [], deletedAt: null });
    const res = await tool('export_cellar').handler({ cellar_id: CELLAR }, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
    expect(mintExportLink).not.toHaveBeenCalled();
  });

  test('a mere MEMBER (editor) cannot export someone else\'s cellar', async () => {
    Cellar.findById.mockResolvedValue({ _id: CELLAR, user: STRANGER, members: [{ user: ME, role: 'editor' }], deletedAt: null });
    const res = await tool('export_cellar').handler({ cellar_id: CELLAR }, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
    expect(mintExportLink).not.toHaveBeenCalled();
  });
});

describe('get_account_export', () => {
  test('mints an account_json link and audits', async () => {
    const res = await tool('get_account_export').handler({}, CTX);
    const { data } = parse(res);
    expect(mintExportLink).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account_json', userId: ME, tokenId: 't1' }));
    expect(data.download_url).toContain('/api/mcp/export/celx_');
    expect(data.note).toMatch(/email/i); // warns PII is in the file
    expect(logAudit).toHaveBeenCalledWith(CTX.req, 'user.account_export', expect.any(Object), expect.objectContaining({ via: 'mcp' }));
  });
});
