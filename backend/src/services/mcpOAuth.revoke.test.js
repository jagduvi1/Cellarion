/**
 * revokeOAuthConnectionsForUser (security report 2026-08-27, second analysis).
 *
 * The correctness argument is the SCOPING: a password change/reset must revoke
 * the OAuth-consent connections a victim could have been phished into, but NOT
 * the user's own personal API tokens (HA integration, climate devices), which
 * carry a null oauthClientId and keep their deliberate PAT semantics. This
 * pins the exact query so a future refactor can't quietly widen or narrow it.
 */
jest.mock('../models/ApiToken', () => ({ updateMany: jest.fn() }));

const ApiToken = require('../models/ApiToken');
const { revokeOAuthConnectionsForUser } = require('./mcpOAuth');

beforeEach(() => jest.clearAllMocks());

describe('revokeOAuthConnectionsForUser', () => {
  const USER = 'u'.repeat(24);

  test('revokes only OAuth connections (oauthClientId set), never personal PATs', async () => {
    ApiToken.updateMany.mockResolvedValue({ modifiedCount: 3 });
    const n = await revokeOAuthConnectionsForUser(USER);

    expect(n).toBe(3);
    expect(ApiToken.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = ApiToken.updateMany.mock.calls[0];
    // The scoping that spares personal PATs: oauthClientId must be present.
    expect(filter).toMatchObject({ user: USER, oauthClientId: { $ne: null }, revokedAt: null });
    // Soft revoke (revokedAt) so the connection still shows as revoked in
    // Settings; the MCP auth middleware filters revokedAt:null.
    expect(update.$set.revokedAt).toBeInstanceOf(Date);
  });

  test('returns 0 when the user has no OAuth connections', async () => {
    ApiToken.updateMany.mockResolvedValue({ modifiedCount: 0 });
    expect(await revokeOAuthConnectionsForUser(USER)).toBe(0);
  });

  test('a driver result without modifiedCount coerces to 0, never undefined', async () => {
    ApiToken.updateMany.mockResolvedValue({});
    expect(await revokeOAuthConnectionsForUser(USER)).toBe(0);
  });
});
