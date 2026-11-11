/**
 * The export side of the user-data registry: every list is capped, and a list
 * that hits its cap is named in the export's `_truncated` map.
 *
 * A member's export must not silently stop short. Each entry reads its rows
 * with `.limit(EXPORT_MAX)` (the activity log with AUDIT_MAX) and hands them to
 * markTrunc, which records the key in ctx.truncated when the cap was reached;
 * buildUserExport publishes that map as `_truncated`.
 */

// services/search.js eagerly requires the ESM-only `meilisearch` package,
// which Jest can't parse — mock it (same pattern as userDataRegistry.test.js).
jest.mock('./search', () => ({
  indexDiscussion: jest.fn(),
}));

const { REGISTRY, EXPORT_MAX } = require('./userDataRegistry');
const SavedDashboard = require('../models/SavedDashboard');
const RegistryReadDay = require('../models/RegistryReadDay');
const BridgeUsageDay = require('../models/BridgeUsageDay');
const PendingShare = require('../models/PendingShare');

const entryOf = (model) => REGISTRY.find((e) => e.model === model);

// A query stand-in: every chained call answers itself, `lean()` resolves to `rows`.
function chain(rows) {
  const c = {};
  for (const m of ['select', 'limit', 'sort', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(async () => rows);
  return c;
}

const rowsOf = (n, row) => Array.from({ length: n }, () => row);

afterEach(() => jest.restoreAllMocks());

describe('every exported list is capped and flagged', () => {
  test('each model read in an export has a cap, and each cap a truncation flag', () => {
    const uneven = [];
    for (const entry of REGISTRY) {
      if (!entry.exportFragment) continue;
      const source = String(entry.exportFragment);
      const reads = (source.match(/\b[A-Z]\w*\.find\(/g) || []).length;
      const caps = (source.match(/\.limit\((EXPORT_MAX|AUDIT_MAX)\)/g) || []).length;
      const flags = (source.match(/markTrunc\(/g) || []).length;
      if (reads !== caps || caps !== flags) {
        uneven.push(`${entry.model.modelName}: ${reads} read(s), ${caps} cap(s), ${flags} flag(s)`);
      }
    }
    expect(uneven).toEqual([]);
  });
});

describe.each([
  ['saved dashboards', SavedDashboard, 'analyticsDashboards', { name: 'Value by country' }],
  ['registry read counters', RegistryReadDay, 'registryReads', { day: '2026-01-01', count: 3, wines: ['a', 'b'] }],
  ['bridge usage counters', BridgeUsageDay, 'bridgeUsage', { day: '2026-01-01', searches: 1 }],
])('%s', (_label, Model, key, row) => {
  test('are read up to the cap, and flagged when they reach it', async () => {
    const query = chain(rowsOf(EXPORT_MAX, row));
    jest.spyOn(Model, 'find').mockReturnValue(query);
    const ctx = { userId: 'u1', truncated: {} };

    const fragment = await entryOf(Model).exportFragment(ctx);

    expect(query.limit).toHaveBeenCalledWith(EXPORT_MAX);
    expect(fragment[key]).toHaveLength(EXPORT_MAX);
    expect(ctx.truncated).toEqual({ [key]: EXPORT_MAX });
  });

  test('carry no flag below the cap', async () => {
    jest.spyOn(Model, 'find').mockReturnValue(chain(rowsOf(2, row)));
    const ctx = { userId: 'u1', truncated: {} };

    const fragment = await entryOf(Model).exportFragment(ctx);

    expect(fragment[key]).toHaveLength(2);
    expect(ctx.truncated).toEqual({});
  });
});

describe('cellar invites', () => {
  const invite = { email: 'guest@example.com', role: 'viewer', cellar: { name: 'Cellar' }, createdAt: 'c1' };

  test('the invites received are flagged at the cap, like the invites sent', async () => {
    jest.spyOn(PendingShare, 'find').mockImplementation((filter) => chain(
      filter.email ? rowsOf(EXPORT_MAX, invite) : rowsOf(1, invite),
    ));
    const ctx = { userId: 'u1', userEmail: 'me@example.com', truncated: {} };

    const fragment = await entryOf(PendingShare).exportFragment(ctx);

    expect(fragment.pendingCellarInvites).toHaveLength(1);
    expect(fragment.pendingCellarInvitesReceived).toHaveLength(EXPORT_MAX);
    expect(ctx.truncated).toEqual({ pendingSharesReceived: EXPORT_MAX });
  });

  test('an account without an e-mail address reads no received invites at all', async () => {
    const find = jest.spyOn(PendingShare, 'find').mockImplementation(() => chain([]));
    const ctx = { userId: 'u1', userEmail: undefined, truncated: {} };

    const fragment = await entryOf(PendingShare).exportFragment(ctx);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ invitedBy: 'u1' });
    expect(fragment.pendingCellarInvitesReceived).toEqual([]);
    expect(ctx.truncated).toEqual({});
  });
});
