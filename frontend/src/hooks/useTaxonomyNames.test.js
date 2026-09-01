/**
 * Fetching the taxonomy display-name map.
 *
 * The failure this guards is quiet in both directions: too many requests (a
 * list of bottle cards each fetching the same map) or a failed request turning
 * into a crash on a page that only wanted to render a region name. Neither is
 * visible in a screenshot, so both are pinned here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

let language = 'fr';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { get language() { return language; } } }),
}));

import useTaxonomyNames, { __resetTaxonomyNameCache } from './useTaxonomyNames';

const BODY = {
  lang: 'fr',
  byId: { r1: 'Vallée du Rhône' },
  byName: { 'Rhône Valley': 'Vallée du Rhône' },
};

beforeEach(() => {
  __resetTaxonomyNameCache();
  language = 'fr';
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(BODY) }));
});
afterEach(() => vi.restoreAllMocks());

describe('useTaxonomyNames', () => {
  it('fetches the map for the active language', async () => {
    const { result } = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(result.current.byId.r1).toBe('Vallée du Rhône'));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('lang=fr'));
  });

  it('starts empty, so the first paint renders canonical names rather than nothing', async () => {
    const { result } = renderHook(() => useTaxonomyNames());
    expect(result.current).toEqual({ byId: {}, byName: {} });
    await waitFor(() => expect(result.current.byId.r1).toBeDefined());
  });

  it('fetches once however many components ask', async () => {
    // The reason the cache lives in module scope: a list of twenty bottle cards
    // must not become twenty identical requests.
    const a = renderHook(() => useTaxonomyNames());
    const b = renderHook(() => useTaxonomyNames());
    const c = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(a.result.current.byId.r1).toBeDefined());
    await waitFor(() => expect(b.result.current.byId.r1).toBeDefined());
    await waitFor(() => expect(c.result.current.byId.r1).toBeDefined());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('never asks the server about English — the canonical name IS the English one', async () => {
    language = 'en';
    const { result } = renderHook(() => useTaxonomyNames());
    expect(result.current).toEqual({ byId: {}, byName: {} });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reduces a regional variant to its base language', async () => {
    language = 'fr-CA';
    renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('lang=fr')));
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('fr-CA'));
  });

  it('a failed request leaves names canonical instead of throwing', async () => {
    // Localisation is worth having; it is not worth a blank page.
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(result.current).toEqual({ byId: {}, byName: {} });
  });

  it('a non-OK response is handled the same way', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.reject(new Error('no body')) }));
    const { result } = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(result.current).toEqual({ byId: {}, byName: {} });
  });

  it('a failure is not cached — the next mount tries again', async () => {
    // A network blip must not condemn the tab to English for the session.
    global.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    const first = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    first.unmount();

    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(BODY) }));
    const second = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(second.result.current.byId.r1).toBe('Vallée du Rhône'));
  });
});

describe('when a component suite mocks react-i18next down to just `t`', () => {
  it('falls back to English instead of throwing', async () => {
    // This is not hypothetical: adopting the hook in WineRecordSection broke
    // eight of that component's existing tests exactly this way. A hook that
    // costs a test edit in every component it touches does not get adopted.
    language = undefined;
    const { result } = renderHook(() => useTaxonomyNames());
    expect(result.current).toEqual({ byId: {}, byName: {} });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('a non-OK response', () => {
  it('is not cached either — a 503 during a deploy must not stick for the session', async () => {
    // Found by the pre-merge audit: the reject path refused to cache but the
    // HTTP-error path quietly cached the empty map, so the two disagreed.
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.reject(new Error('no body')) }));
    const first = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    first.unmount();

    const BODY2 = { lang: 'fr', byId: { r1: 'Vallée du Rhône' }, byName: { 'Rhône Valley': 'Vallée du Rhône' } };
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(BODY2) }));
    const second = renderHook(() => useTaxonomyNames());
    await waitFor(() => expect(second.result.current.byId.r1).toBe('Vallée du Rhône'));
  });
});
