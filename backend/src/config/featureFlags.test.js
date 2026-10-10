/**
 * Feature flags (config/featureFlags) — the states a super admin moves a
 * flagged feature through (off / beta / everyone), what a user sees for each
 * (one "Try new features early" switch for all of them), and the forum link
 * a beta feature can carry.
 *
 * WHY THIS TEST EXISTS:
 * The app decides which screens to show from this module. A flag with no
 * stored row must run in its default state, a corrupt row must not turn a
 * feature on for everyone, and the forum link is rendered as an in-app link,
 * so it may never point off-site.
 */

jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn() }));

const SiteConfig = require('../models/SiteConfig');
const featureFlags = require('./featureFlags');

const stored = (value) => SiteConfig.findOne.mockReturnValue({ lean: async () => (value ? { key: 'featureFlags', value } : null) });

beforeEach(() => {
  jest.clearAllMocks();
  featureFlags.set({});
});

describe('the registry', () => {
  test('every feature has a key, an English title, a valid default state and a start date', () => {
    expect(featureFlags.FEATURES.length).toBeGreaterThan(0);
    for (const f of featureFlags.FEATURES) {
      expect(f.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(typeof f.title).toBe('string');
      expect(featureFlags.STATES).toContain(f.defaultState);
      expect(Number.isNaN(new Date(f.since).getTime())).toBe(false);
    }
    expect(new Set(featureFlags.FEATURE_KEYS).size).toBe(featureFlags.FEATURE_KEYS.length);
  });

  test('a flag with no stored row runs in its default state, in beta since the day it entered the code', () => {
    const f = featureFlags.get('vintagePage');
    expect(f).toEqual(expect.objectContaining({ key: 'vintagePage', state: 'beta', releasedAt: null, forumPath: null }));
    expect(f.betaAt).toBe(new Date('2026-10-10').toISOString());
    expect(featureFlags.get('noSuchFeature')).toBeNull();
  });
});

describe('who sees what', () => {
  test('beta: only users with early access on; everyone: all users; off: nobody', () => {
    expect(featureFlags.enabledKeys(true)).toContain('vintagePage');
    expect(featureFlags.enabledKeys(false)).not.toContain('vintagePage');

    featureFlags.set({ vintagePage: { state: 'everyone' } });
    expect(featureFlags.enabledKeys(false)).toContain('vintagePage');

    featureFlags.set({ vintagePage: { state: 'off' } });
    expect(featureFlags.enabledKeys(true)).not.toContain('vintagePage');
  });

  test('only a real true opts in', () => {
    expect(featureFlags.enabledKeys('true')).not.toContain('vintagePage');
    expect(featureFlags.enabledKeys(undefined)).not.toContain('vintagePage');
  });
});

describe('load', () => {
  test('reads the stored rows, cleans them, and drops keys the code no longer knows', async () => {
    stored({
      vintagePage: { state: 'everyone', betaAt: '2026-10-11T08:00:00.000Z', releasedAt: '2026-11-01T08:00:00.000Z', forumPath: '/community/discussions/vintage-page' },
      retiredFeature: { state: 'beta' },
    });
    await featureFlags.load();
    expect(featureFlags.get('vintagePage')).toEqual(expect.objectContaining({
      state: 'everyone', betaAt: '2026-10-11T08:00:00.000Z', releasedAt: '2026-11-01T08:00:00.000Z',
      forumPath: '/community/discussions/vintage-page',
    }));
    expect(Object.keys(featureFlags.storedValue())).toEqual(featureFlags.FEATURE_KEYS);
  });

  test('a flag released straight from off was never in beta: no "in beta since" date', async () => {
    stored({ vintagePage: { state: 'everyone', releasedAt: '2026-11-01T08:00:00.000Z' } });
    await featureFlags.load();
    expect(featureFlags.get('vintagePage')).toEqual(expect.objectContaining({ state: 'everyone', betaAt: null, releasedAt: '2026-11-01T08:00:00.000Z' }));
    featureFlags.set({ vintagePage: { state: 'off' } });
    expect(featureFlags.get('vintagePage').betaAt).toBeNull();
  });

  test('a corrupt state falls back to the default, never to everyone', async () => {
    stored({ vintagePage: { state: 'EVERYBODY!', betaAt: 'not a date' } });
    await featureFlags.load();
    expect(featureFlags.get('vintagePage').state).toBe('beta');
    expect(featureFlags.get('vintagePage').betaAt).toBe(new Date('2026-10-10').toISOString());
  });

  test('a database error keeps the defaults', async () => {
    SiteConfig.findOne.mockReturnValue({ lean: async () => { throw new Error('db down'); } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await featureFlags.load();
    expect(featureFlags.get('vintagePage').state).toBe('beta');
    warn.mockRestore();
  });
});

describe('parseForumPath', () => {
  const OLD = process.env.FRONTEND_URL;
  afterEach(() => { process.env.FRONTEND_URL = OLD; });

  test('an in-app path is kept; empty clears', () => {
    expect(featureFlags.parseForumPath('/community/discussions/vintage-page')).toEqual({ ok: true, value: '/community/discussions/vintage-page' });
    expect(featureFlags.parseForumPath('  ')).toEqual({ ok: true, value: null });
    expect(featureFlags.parseForumPath(null)).toEqual({ ok: true, value: null });
  });

  test('a full link to this site becomes its path; another site is refused', () => {
    process.env.FRONTEND_URL = 'https://cellar.example.org';
    expect(featureFlags.parseForumPath('https://cellarion.app/community/discussions/x?page=2#r5'))
      .toEqual({ ok: true, value: '/community/discussions/x?page=2#r5' });
    expect(featureFlags.parseForumPath('https://cellar.example.org/community/discussions/y'))
      .toEqual({ ok: true, value: '/community/discussions/y' });
    expect(featureFlags.parseForumPath('https://evil.example.com/community').ok).toBe(false);
  });

  test('protocol-relative, relative, scripted and oversized values are refused', () => {
    expect(featureFlags.parseForumPath('//evil.example.com/x').ok).toBe(false);
    expect(featureFlags.parseForumPath('community/discussions/x').ok).toBe(false);
    expect(featureFlags.parseForumPath('javascript:alert(1)').ok).toBe(false);
    expect(featureFlags.parseForumPath('/a b').ok).toBe(false);
    expect(featureFlags.parseForumPath(`/${'x'.repeat(300)}`).ok).toBe(false);
    expect(featureFlags.parseForumPath(42).ok).toBe(false);
  });
});
