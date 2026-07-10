import { createApiFetch } from './apiFetch';

const okRes = { status: 200, ok: true, body: 'fine' };
const unauthorizedRes = { status: 401, ok: false };

describe('createApiFetch', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('injects Authorization header when a token is present', async () => {
    fetchMock.mockResolvedValue(okRes);
    const apiFetch = createApiFetch(() => 'tok-123', vi.fn(), vi.fn());

    await apiFetch('/api/cellars', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/cellars');
    expect(options.method).toBe('GET');
    expect(options.headers['Authorization']).toBe('Bearer tok-123');
  });

  test('sends no Authorization header when there is no token', async () => {
    fetchMock.mockResolvedValue(okRes);
    const apiFetch = createApiFetch(() => null, vi.fn(), vi.fn());

    await apiFetch('/api/wines');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  test('preserves caller-supplied headers alongside the auth header', async () => {
    fetchMock.mockResolvedValue(okRes);
    const apiFetch = createApiFetch(() => 'tok-123', vi.fn(), vi.fn());

    await apiFetch('/api/bottles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-123',
    });
    expect(options.body).toBe('{}');
  });

  test("always sets credentials: 'include' so the refresh cookie is sent", async () => {
    fetchMock.mockResolvedValue(okRes);
    const apiFetch = createApiFetch(() => 'tok-123', vi.fn(), vi.fn());

    await apiFetch('/api/cellars');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.credentials).toBe('include');
  });

  test('returns a successful response untouched without refreshing', async () => {
    fetchMock.mockResolvedValue(okRes);
    const onRefresh = vi.fn();
    const onLogout = vi.fn();
    const apiFetch = createApiFetch(() => 'tok-123', onRefresh, onLogout);

    const res = await apiFetch('/api/cellars');

    expect(res).toBe(okRes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  test('on 401, refreshes and retries exactly once with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(unauthorizedRes)
      .mockResolvedValueOnce(okRes);
    const onRefresh = vi.fn().mockResolvedValue('new-token');
    const onLogout = vi.fn();
    const apiFetch = createApiFetch(() => 'stale-token', onRefresh, onLogout);

    const res = await apiFetch('/api/cellars', { method: 'GET' });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [retryUrl, retryOptions] = fetchMock.mock.calls[1];
    expect(retryUrl).toBe('/api/cellars');
    expect(retryOptions.headers['Authorization']).toBe('Bearer new-token');
    expect(retryOptions.credentials).toBe('include');
    expect(res).toBe(okRes);
    expect(onLogout).not.toHaveBeenCalled();
  });

  test('retries only once: a 401 on the retry is returned without another refresh', async () => {
    fetchMock.mockResolvedValue(unauthorizedRes);
    const onRefresh = vi.fn().mockResolvedValue('new-token');
    const onLogout = vi.fn();
    const apiFetch = createApiFetch(() => 'stale-token', onRefresh, onLogout);

    const res = await apiFetch('/api/cellars');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(res).toBe(unauthorizedRes);
    expect(onLogout).not.toHaveBeenCalled();
  });

  test('calls onLogout and returns the 401 when the refresh fails', async () => {
    fetchMock.mockResolvedValue(unauthorizedRes);
    const onRefresh = vi.fn().mockResolvedValue(null);
    const onLogout = vi.fn();
    const apiFetch = createApiFetch(() => 'stale-token', onRefresh, onLogout);

    const res = await apiFetch('/api/cellars');

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry without a new token
    expect(res).toBe(unauthorizedRes);
  });

  test('non-401 error responses pass through without refresh or logout', async () => {
    const serverError = { status: 500, ok: false };
    fetchMock.mockResolvedValue(serverError);
    const onRefresh = vi.fn();
    const onLogout = vi.fn();
    const apiFetch = createApiFetch(() => 'tok-123', onRefresh, onLogout);

    const res = await apiFetch('/api/cellars');

    expect(res).toBe(serverError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
