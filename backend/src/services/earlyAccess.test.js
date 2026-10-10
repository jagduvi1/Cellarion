/**
 * Early access — a flag's state change and the notices it sends
 * (services/earlyAccess).
 *
 * WHY THIS TEST EXISTS:
 * A super admin moves a flagged feature between off, beta and everyone
 * without a deploy. Entering beta tells the members who try new features
 * early; going out to everyone thanks whoever sent feedback on it. Each
 * notice goes out ONCE per feature: a flag moved back and forth while a
 * feature settles must not notify the same people again and again.
 */

jest.mock('../models/User', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/SupportTicket', () => ({ distinct: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn() }));
jest.mock('../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));
jest.mock('./notifications', () => ({ createNotifications: jest.fn() }));

const User = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const { updateSiteConfig } = require('../utils/siteConfig');
const { createNotifications } = require('./notifications');
const featureFlags = require('../config/featureFlags');
const { changeFlag, overview } = require('./earlyAccess');

const ADMIN = 'admin-1';

beforeEach(() => {
  jest.clearAllMocks();
  featureFlags.set({});
  updateSiteConfig.mockResolvedValue({});
  createNotifications.mockResolvedValue(undefined);
  User.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'u1' }, { _id: 'u2' }] }) });
  SupportTicket.distinct.mockResolvedValue(['u2', 'u3']);
});

const sentTypes = () => createNotifications.mock.calls.flatMap(([items]) => items.map((i) => `${i.type}:${i.userId}`));

describe('changeFlag', () => {
  test('off → beta announces the feature once to every early-access member (no demo accounts), and saves the flag', async () => {
    featureFlags.set({ vintagePage: { state: 'off' } });
    const res = await changeFlag('vintagePage', { state: 'beta' }, ADMIN);

    expect(res.error).toBeUndefined();
    expect(res.before.state).toBe('off');
    expect(res.after.state).toBe('beta');
    expect(res.notified).toEqual({ announced: 2, thanked: 0 });
    expect(User.find).toHaveBeenCalledWith({ 'preferences.earlyAccess': true, isDemo: { $ne: true } });
    expect(sentTypes()).toEqual(['early_access_new:u1', 'early_access_new:u2']);
    const item = createNotifications.mock.calls[0][0][0];
    expect(item.title).toBe('New in early access: One page per wine and vintage');
    expect(item.link).toBe('/settings#early-access');

    const [key, saved, by] = updateSiteConfig.mock.calls[0];
    expect(key).toBe('featureFlags');
    expect(by).toBe(ADMIN);
    expect(saved.vintagePage.state).toBe('beta');
    expect(saved.vintagePage.betaAt).toEqual(expect.any(String));
    expect(saved.vintagePage.betaNotifiedAt).toEqual(expect.any(String));
    // The in-memory copy every request reads moved with it.
    expect(featureFlags.get('vintagePage').state).toBe('beta');
  });

  test('beta → everyone thanks the feedback senders once and dates the release', async () => {
    const res = await changeFlag('vintagePage', { state: 'everyone' }, ADMIN);
    expect(res.notified).toEqual({ announced: 0, thanked: 2 });
    expect(SupportTicket.distinct).toHaveBeenCalledWith('user', { category: 'beta', feature: 'vintagePage' });
    expect(sentTypes()).toEqual(['early_access_released:u2', 'early_access_released:u3']);
    expect(res.after.releasedAt).toEqual(expect.any(String));
  });

  test('moving a flag back and forth never repeats a notice; taking it back clears the release date', async () => {
    featureFlags.set({ vintagePage: { state: 'off' } });
    await changeFlag('vintagePage', { state: 'beta' }, ADMIN);
    await changeFlag('vintagePage', { state: 'everyone' }, ADMIN);
    const back = await changeFlag('vintagePage', { state: 'beta' }, ADMIN);
    expect(back.after.releasedAt).toBeNull();
    await changeFlag('vintagePage', { state: 'off' }, ADMIN);
    await changeFlag('vintagePage', { state: 'beta' }, ADMIN);
    await changeFlag('vintagePage', { state: 'everyone' }, ADMIN);
    expect(sentTypes().filter((s) => s.startsWith('early_access_new')).length).toBe(2);
    expect(sentTypes().filter((s) => s.startsWith('early_access_released')).length).toBe(2);
  });

  test('a forum link alone saves without notices; an unknown key is a 404, an unknown state a 400', async () => {
    const res = await changeFlag('vintagePage', { forumPath: '/community/discussions/vintage-page' }, ADMIN);
    expect(res.after.forumPath).toBe('/community/discussions/vintage-page');
    expect(res.after.state).toBe('beta');
    expect(createNotifications).not.toHaveBeenCalled();

    expect((await changeFlag('noSuchFeature', { state: 'beta' }, ADMIN)).error.status).toBe(404);
    expect((await changeFlag('vintagePage', { state: 'later' }, ADMIN)).error.status).toBe(400);
  });

  test('a notice that cannot go out never undoes the saved change', async () => {
    featureFlags.set({ vintagePage: { state: 'off' } });
    User.find.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('db down'); } }) });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await changeFlag('vintagePage', { state: 'beta' }, ADMIN);
    expect(res.after.state).toBe('beta');
    expect(res.notified).toEqual({ announced: 0, thanked: 0 });
    err.mockRestore();
  });
});

describe('overview', () => {
  test('counts the early-access members and the beta feedback per feature', async () => {
    User.countDocuments.mockResolvedValue(7);
    SupportTicket.aggregate.mockResolvedValue([{ _id: 'vintagePage', total: 3, open: 1 }]);
    const o = await overview();
    expect(o.optedIn).toBe(7);
    expect(o.features).toEqual([expect.objectContaining({
      key: 'vintagePage', title: 'One page per wine and vintage', state: 'beta', feedback: { total: 3, open: 1 },
    })]);
    expect(User.countDocuments).toHaveBeenCalledWith({ 'preferences.earlyAccess': true, isDemo: { $ne: true } });
  });
});
