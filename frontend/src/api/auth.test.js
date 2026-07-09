import { changePassword } from './auth';

describe('changePassword', () => {
  test('POSTs credentials as JSON to /api/auth/change-password', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ ok: true });

    await changePassword(apiFetch, {
      currentPassword: 'OldPassw0rd!abc',
      newPassword: 'NewPassw0rd!abc'
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/auth/change-password');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      currentPassword: 'OldPassw0rd!abc',
      newPassword: 'NewPassw0rd!abc'
    });
  });

  test('does not leak extra fields into the request body', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ ok: true });

    await changePassword(apiFetch, {
      currentPassword: 'a',
      newPassword: 'b',
      confirmNewPassword: 'b'
    });

    const [, options] = apiFetch.mock.calls[0];
    expect(Object.keys(JSON.parse(options.body)).sort()).toEqual([
      'currentPassword',
      'newPassword'
    ]);
  });
});
