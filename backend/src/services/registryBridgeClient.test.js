/**
 * Registry Bridge client transport (self-hosted side, protocol v1).
 *
 * WHY THIS TEST EXISTS:
 * The client sits inside the add-bottle path of every self-hosted install, so
 * its failure mode has to be "local only", never a 500: off without a key,
 * off when pointed at itself, null on network trouble, and backing off after
 * a quota or key refusal instead of hammering the hosted side. Searches are
 * cached briefly because the SPA re-queries on every keystroke and each call
 * spends quota.
 */
const client = require('./registryBridgeClient');

const KEY = 'cbr_' + 'a'.repeat(64);
const jsonRes = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(body) });

beforeEach(() => {
  client._reset();
  process.env.REGISTRY_BRIDGE_KEY = KEY;
  process.env.REGISTRY_BRIDGE_URL = 'https://cellarion.app/';
  process.env.FRONTEND_URL = 'https://cellar.example.org';
  global.fetch = jest.fn();
});
afterEach(() => { delete global.fetch; });

describe('config', () => {
  test('enabled only with a cbr_ key that does not point at this install', () => {
    expect(client.config()).toMatchObject({ enabled: true, url: 'https://cellarion.app', keyPrefix: KEY.slice(0, 12), instanceHost: 'cellar.example.org', reason: null });
    process.env.REGISTRY_BRIDGE_KEY = '';
    expect(client.config()).toMatchObject({ enabled: false, reason: 'no_key' });
    process.env.REGISTRY_BRIDGE_KEY = 'cel_' + 'a'.repeat(64);
    expect(client.config()).toMatchObject({ enabled: false, reason: 'bad_key' });
    process.env.REGISTRY_BRIDGE_KEY = KEY;
    process.env.FRONTEND_URL = 'https://cellarion.app';
    expect(client.config()).toMatchObject({ enabled: false, reason: 'self_target' });
  });

  test('every call is a no-op (null / empty) while disabled', async () => {
    process.env.REGISTRY_BRIDGE_KEY = '';
    expect(await client.request('/me')).toBeNull();
    expect(await client.search('salmos')).toEqual([]);
    expect(await client.fetchWine('a'.repeat(24))).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('request', () => {
  test('sends the key, the instance host and JSON; returns the parsed body', async () => {
    global.fetch.mockResolvedValue(jsonRes(200, { protocol: 'v1' }));
    const r = await client.request('/me');
    expect(r).toEqual({ ok: true, status: 200, body: { protocol: 'v1' } });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://cellarion.app/api/bridge/v1/me');
    expect(opts.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'X-Cellarion-Instance': 'cellar.example.org' });
    expect(opts.signal).toBeDefined();
  });

  test('a refusal is returned as a code, and 401 / 429 start a backoff that later calls respect', async () => {
    global.fetch.mockResolvedValue(jsonRes(429, { error: 'quota', code: 'quota' }));
    expect(await client.request('/search?q=x')).toMatchObject({ ok: false, status: 429, code: 'quota' });
    expect(client.transportState().blocked).toMatchObject({ reason: 'quota' });
    global.fetch.mockClear();
    expect(await client.request('/search?q=y')).toMatchObject({ ok: false, code: 'quota' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('network trouble is a soft failure, not an exception', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await client.request('/me')).toMatchObject({ ok: false, status: 0, code: 'network' });
    expect(client.transportState().lastError).toMatchObject({ code: 'network', message: 'ECONNREFUSED' });
  });
});

describe('search / fetchWine / changes', () => {
  test('search returns the identities and caches the query for a minute', async () => {
    global.fetch.mockResolvedValue(jsonRes(200, { wines: [{ id: 'a'.repeat(24), name: 'Salmos' }] }));
    expect(await client.search('Salmos')).toEqual([{ id: 'a'.repeat(24), name: 'Salmos' }]);
    expect(await client.search('salmos')).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(await client.search('s')).toEqual([]);
  });

  test('fetchWine returns the wine, a removed marker on 404, null otherwise', async () => {
    global.fetch.mockResolvedValueOnce(jsonRes(200, { wine: { id: 'a'.repeat(24), name: 'Salmos' } }));
    expect(await client.fetchWine('a'.repeat(24))).toEqual({ id: 'a'.repeat(24), name: 'Salmos' });
    global.fetch.mockResolvedValueOnce(jsonRes(404, { code: 'not_found' }));
    expect(await client.fetchWine('a'.repeat(24))).toEqual({ removed: true });
    global.fetch.mockRejectedValueOnce(new Error('down'));
    expect(await client.fetchWine('a'.repeat(24))).toBeNull();
    expect(await client.fetchWine('nope')).toBeNull();
  });

  test('changes chunks at 5,000 ids and merges the answers', async () => {
    const ids = Array.from({ length: 5001 }, (_, i) => String(i).padStart(24, '0'));
    global.fetch
      .mockResolvedValueOnce(jsonRes(200, { changed: [{ id: ids[0], updatedAt: 'x' }], removed: [], checked: 5000 }))
      .mockResolvedValueOnce(jsonRes(200, { changed: [], removed: [ids[5000]], checked: 1 }));
    const r = await client.changes(ids, '2026-09-01T00:00:00Z');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).ids).toHaveLength(5000);
    expect(r).toMatchObject({ changed: [{ id: ids[0], updatedAt: 'x' }], removed: [ids[5000]], checked: 5001, failed: false });
  });
});
