import { createApiFetch, isApiTarget } from './apiFetch';

// jsdom's document origin is http://localhost:3000; API_URL is '' in tests, so
// the API origin is the page origin.
const okRes = { status: 200, ok: true };
const unauthorizedRes = { status: 401, ok: false };

describe('apiFetch only ever sends credentials to the API origin (audit 2026-09 F03-3 / S7-1)', () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn().mockResolvedValue(okRes); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  test('isApiTarget accepts same-origin /api/ paths, relative or absolute', () => {
    expect(isApiTarget('/api/cellars')).toBe(true);
    expect(isApiTarget('/api/images/1/file?size=s')).toBe(true);
    expect(isApiTarget(`${window.location.origin}/api/cellars`)).toBe(true);
  });

  test('isApiTarget refuses everything that resolves elsewhere or outside /api/', () => {
    for (const bad of [
      '//evil.example/api/x', 'https://evil.example/api/x', 'http://localhost:3001/api/x',
      '\\\\evil.example/api/x', '/\\evil.example/api/x', '/api/../uploads/x', '/uploads/x',
      'javascript:alert(1)', '', null, undefined,
    ]) {
      expect(isApiTarget(bad)).toBe(false);
    }
  });

  test('a same-origin API path carries the bearer and the cookie', async () => {
    const apiFetch = createApiFetch(() => 'tok-123', vi.fn(), vi.fn());
    await apiFetch('/api/cellars');
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer tok-123');
    expect(options.credentials).toBe('include');
  });

  test('a protocol-relative or third-party URL gets neither bearer nor cookie', async () => {
    const apiFetch = createApiFetch(() => 'tok-123', vi.fn(), vi.fn());
    for (const url of ['//evil.example/a.png', 'https://evil.example/a.png', '\\evil.example/a.png']) {
      await apiFetch(url, { headers: { Accept: 'image/*' } });
      const [calledUrl, options] = fetchMock.mock.calls.at(-1);
      expect(calledUrl).toBe(url);
      expect(options.headers).toEqual({ Accept: 'image/*' });
      expect(options.credentials).toBe('omit');
    }
  });

  test('a 401 from a non-API target never refreshes or logs out', async () => {
    fetchMock.mockResolvedValue(unauthorizedRes);
    const onRefresh = vi.fn();
    const onLogout = vi.fn();
    const apiFetch = createApiFetch(() => 'tok-123', onRefresh, onLogout);
    const res = await apiFetch('https://evil.example/a.png');
    expect(res).toBe(unauthorizedRes);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
