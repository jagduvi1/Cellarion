import { clearApiCaches } from './serviceWorkerRegistration';

describe('clearApiCaches', () => {
  afterEach(() => { delete globalThis.caches; });

  it('deletes every API cache (per-account and the old shared one) and keeps the app shell', async () => {
    const names = new Set(['cellarion-v4', 'cellarion-api-v1', 'cellarion-api-v2-aaaaaaaaaaaaaaaaaaaaaaaa']);
    globalThis.caches = {
      keys: async () => [...names],
      delete: async (name) => names.delete(name),
    };
    await clearApiCaches();
    expect([...names]).toEqual(['cellarion-v4']);
  });

  it('resolves quietly where the Cache API is missing or throws', async () => {
    await expect(clearApiCaches()).resolves.toBeUndefined();
    globalThis.caches = { keys: async () => { throw new Error('SecurityError'); } };
    await expect(clearApiCaches()).resolves.toBeUndefined();
  });
});
