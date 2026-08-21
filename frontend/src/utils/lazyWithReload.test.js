/**
 * A deploy replaces every hashed chunk filename. A tab open across one still
 * holds the old module graph, so navigating to a not-yet-loaded route requests
 * a file that no longer exists — and a rejected lazy import is thrown, not
 * caught, so it propagates past Suspense to the root ErrorBoundary and takes
 * the whole app down rather than one route.
 *
 * Observed live on 2026-08-21:
 *   GET /assets/AdminSupportTickets-DK3bBmQy.js -> 404
 * and, hours earlier and undiagnosed because the symptom is silent, as a user
 * reporting "the dashboard is blank".
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { withReload, RETRY_KEY } from './lazyWithReload';

let reload;

beforeEach(() => {
  window.sessionStorage.clear();
  reload = vi.fn();
  // jsdom's location.reload is non-writable; replace the whole object.
  delete window.location;
  window.location = { reload, href: 'https://cellarion.app/admin/support' };
});
afterEach(() => vi.restoreAllMocks());

const ok = (mod) => withReload(() => Promise.resolve(mod));
const chunk404 = () => withReload(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));

describe('withReload', () => {
  test('passes a successful import straight through', async () => {
    const mod = { default: () => null };
    await expect(ok(mod)()).resolves.toBe(mod);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a failed chunk reloads the page once', async () => {
    const pending = chunk404()();
    // Deliberately never settles — resolving would render a route from the
    // module graph we just declared stale.
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(window.sessionStorage.getItem(RETRY_KEY)).toBe('1');
  });

  test('the SECOND failure rethrows instead of looping forever', async () => {
    // The guard is the load-bearing part: a chunk missing for any other reason
    // — bad build, offline client, proxy eating the request — would otherwise
    // reload, fail, reload, forever.
    window.sessionStorage.setItem(RETRY_KEY, '1');
    await expect(chunk404()()).rejects.toThrow(/dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a later success clears the flag, so the NEXT deploy gets its own retry', async () => {
    window.sessionStorage.setItem(RETRY_KEY, '1');
    await ok({ default: () => null })();
    expect(window.sessionStorage.getItem(RETRY_KEY)).toBeNull();
  });

  test('survives sessionStorage being unavailable, and still cannot loop', async () => {
    // Safari private mode throws on setItem. A recovery path must not itself
    // be the thing that breaks — and with no storage there is no flag, so the
    // reload happens once per document rather than repeatedly within one.
    const spy = vi.spyOn(window.sessionStorage.__proto__, 'setItem')
      .mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const getSpy = vi.spyOn(window.sessionStorage.__proto__, 'getItem')
      .mockImplementation(() => { throw new Error('SecurityError'); });

    chunk404()();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    getSpy.mockRestore();
  });

  test('does not swallow a non-chunk error on the retried path', async () => {
    window.sessionStorage.setItem(RETRY_KEY, '1');
    const boom = new Error('module threw during evaluation');
    await expect(withReload(() => Promise.reject(boom))()).rejects.toBe(boom);
  });
});
