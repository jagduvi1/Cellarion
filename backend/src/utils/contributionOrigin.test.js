/**
 * utils/contributionOrigin — where a contribution came from, recorded on the
 * record rather than only in the audit log.
 *
 * WHY THIS EXISTS: a rights holder can tell us a registry wine is theirs. The
 * question that follows is "who gave it to us, and what else did they give
 * us?", and until this shipped the answer lived only in audit rows that expire
 * after 90 days. These are small fields, so the pins are about the two rules
 * that are easy to get wrong: a bridge request is 'bridge' whatever the caller
 * claims, and absence is never 'ui'.
 */
const { originFrom, VIA } = require('./contributionOrigin');

const bridgeReq = (over = {}) => ({
  bridge: { key: { id: 'k1', name: 'Home NAS', instanceHost: 'cellar.example.org', ...over } },
});

describe('originFrom', () => {
  test('a bridge-authenticated request is bridge, with its key and install', () => {
    expect(originFrom(bridgeReq(), 'bridge')).toEqual({
      via: 'bridge', bridgeKey: 'k1', instanceHost: 'cellar.example.org',
    });
  });

  test('the credential wins over what the caller declares', () => {
    // The bridge is a fact about the credential, not a claim by the code path:
    // a route that forgot to say so must not launder a contribution as web.
    expect(originFrom(bridgeReq(), 'web').via).toBe('bridge');
    expect(originFrom(bridgeReq(), undefined).via).toBe('bridge');
  });

  test("'web' is stored as 'ui', matching the registry's own createdVia word", () => {
    // The browser routes audit themselves as 'web'; WineDefinition.createdVia
    // calls the same surface 'ui'. One vocabulary on the records.
    expect(originFrom({}, 'web')).toEqual({ via: 'ui', bridgeKey: null, instanceHost: null });
    expect(originFrom({}, 'ui').via).toBe('ui');
  });

  test('an unknown or missing surface is null, never a guess', () => {
    // Absence is the honest unknown — rows written before this shipped carry
    // no via, and reading that as 'ui' would invent provenance.
    expect(originFrom({}, 'undo').via).toBeNull();
    expect(originFrom(undefined, undefined)).toEqual({ via: null, bridgeKey: null, instanceHost: null });
    expect(originFrom(null, 'mcp').via).toBe('mcp');
  });

  test('a bridge key with no reported host still records the key', () => {
    expect(originFrom(bridgeReq({ instanceHost: null }))).toEqual({
      via: 'bridge', bridgeKey: 'k1', instanceHost: null,
    });
  });

  test('the surfaces it knows about', () => {
    expect(VIA).toEqual(['ui', 'mcp', 'bridge', 'import']);
  });
});
