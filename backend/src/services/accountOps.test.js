/**
 * Self-service account operations — the ONE implementation behind the REST
 * routes (users preferences/profile, support, wine-requests) AND the MCP
 * self-service tools. These tests pin the validation contract both surfaces
 * rely on: allow-lists, length caps, HTML stripping, the notifications leaf
 * allow-list, the SSRF-aware source-URL check, and the exact $set updates.
 */

jest.mock('../models/User', () => ({ findByIdAndUpdate: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findOne: jest.fn() }));
jest.mock('../models/SupportTicket', () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/WineRequest', () => jest.fn().mockImplementation(function (doc) {
  Object.assign(this, doc);
  this._id = 'wr1';
  this.save = jest.fn().mockResolvedValue(undefined);
}));

const User = require('../models/User');
const Cellar = require('../models/Cellar');
const SupportTicket = require('../models/SupportTicket');
const WineRequest = require('../models/WineRequest');
const {
  buildPreferencesUpdate, updatePreferences,
  buildProfileUpdate, updateProfile,
  createSupportTicket, createWineRequest, validateSourceUrl,
} = require('./accountOps');

const UID = 'u1';
const OID = 'a'.repeat(24);

beforeEach(() => jest.clearAllMocks());

describe('buildPreferencesUpdate', () => {
  test('uppercases a valid currency and rejects an unknown one', async () => {
    expect((await buildPreferencesUpdate(UID, { currency: 'eur' })).update).toEqual({ 'preferences.currency': 'EUR' });
    expect((await buildPreferencesUpdate(UID, { currency: 'ZZZ' })).error.status).toBe(400);
  });

  test('validates language, rating scale, rack nav and restock scope against their allow-lists', async () => {
    expect((await buildPreferencesUpdate(UID, { language: 'sv' })).update).toEqual({ 'preferences.language': 'sv' });
    expect((await buildPreferencesUpdate(UID, { language: 'de' })).error.status).toBe(400);
    // numeric ratingScale is coerced to the string enum
    expect((await buildPreferencesUpdate(UID, { ratingScale: 100 })).update).toEqual({ 'preferences.ratingScale': '100' });
    expect((await buildPreferencesUpdate(UID, { ratingScale: '7' })).error.status).toBe(400);
    expect((await buildPreferencesUpdate(UID, { rackNavigation: 'room' })).update).toEqual({ 'preferences.rackNavigation': 'room' });
    expect((await buildPreferencesUpdate(UID, { rackNavigation: 'nope' })).error.status).toBe(400);
    expect((await buildPreferencesUpdate(UID, { restockScope: 'cellar' })).update).toEqual({ 'preferences.restockScope': 'cellar' });
    expect((await buildPreferencesUpdate(UID, { restockScope: 'some' })).error.status).toBe(400);
  });

  test('only the allow-listed notification leaves are set — arbitrary keys are ignored', async () => {
    const { update } = await buildPreferencesUpdate(UID, {
      notifications: {
        drinkWindow: { enabled: false, push: true },
        communityReply: { email: true },
        evil: { hacked: true },              // ignored: not a known category
        communityFollow: { email: true },    // ignored: follow has no email leaf
      },
    });
    expect(update).toEqual({
      'preferences.notifications.drinkWindow.enabled': false,
      'preferences.notifications.drinkWindow.push': true,
      'preferences.notifications.communityReply.email': true,
    });
    expect(Object.keys(update).some((k) => k.includes('evil') || k.includes('hacked'))).toBe(false);
  });

  test('defaultCellarId: null clears, bad id rejected, foreign cellar rejected, owned cellar accepted', async () => {
    expect((await buildPreferencesUpdate(UID, { defaultCellarId: null })).update)
      .toEqual({ 'preferences.defaultCellarId': null });
    expect((await buildPreferencesUpdate(UID, { defaultCellarId: 'not-an-id' })).error.status).toBe(400);

    Cellar.findOne.mockResolvedValueOnce(null); // not owned / not a member
    expect((await buildPreferencesUpdate(UID, { defaultCellarId: OID })).error.message).toMatch(/not found or not accessible/);

    Cellar.findOne.mockResolvedValueOnce({ _id: OID });
    expect((await buildPreferencesUpdate(UID, { defaultCellarId: OID })).update)
      .toEqual({ 'preferences.defaultCellarId': OID });
    // The accessibility query is scoped to the caller.
    expect(Cellar.findOne).toHaveBeenLastCalledWith(expect.objectContaining({
      _id: OID, deletedAt: null,
      $or: [{ user: UID }, { 'members.user': UID }],
    }));
  });

  test('an empty patch is a 400 (nothing to change)', async () => {
    expect((await buildPreferencesUpdate(UID, {})).error.status).toBe(400);
  });
});

describe('updatePreferences', () => {
  test('persists the built update and returns the changed keys', async () => {
    User.findByIdAndUpdate.mockResolvedValue({ toJSON: () => ({}), preferences: { currency: 'EUR' } });
    const res = await updatePreferences(UID, { currency: 'eur' });
    expect(res.error).toBeUndefined();
    expect(res.changed).toEqual(['preferences.currency']);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(UID, { $set: { 'preferences.currency': 'EUR' } }, { new: true });
  });

  test('a validation error short-circuits before any DB write', async () => {
    const res = await updatePreferences(UID, { currency: 'ZZZ' });
    expect(res.error.status).toBe(400);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('a missing user surfaces as 404', async () => {
    User.findByIdAndUpdate.mockResolvedValue(null);
    expect((await updatePreferences(UID, { currency: 'eur' })).error.status).toBe(404);
  });
});

describe('buildProfileUpdate', () => {
  test('strips HTML and enforces the length caps', () => {
    expect(buildProfileUpdate({ displayName: 'Jo <b>Wine</b>' }).update).toEqual({ displayName: 'Jo Wine' });
    expect(buildProfileUpdate({ displayName: 'x'.repeat(51) }).error.status).toBe(400);
    expect(buildProfileUpdate({ bio: 'y'.repeat(501) }).error.status).toBe(400);
    // empty string clears the field to null
    expect(buildProfileUpdate({ bio: '' }).update).toEqual({ bio: null });
  });

  test('validates visibility and rejects an empty patch', () => {
    expect(buildProfileUpdate({ profileVisibility: 'private' }).update).toEqual({ profileVisibility: 'private' });
    expect(buildProfileUpdate({ profileVisibility: 'secret' }).error.status).toBe(400);
    expect(buildProfileUpdate({}).error.status).toBe(400);
  });
});

describe('updateProfile', () => {
  test('persists and reports the changed keys', async () => {
    User.findByIdAndUpdate.mockResolvedValue({ _id: UID, username: 'jo' });
    const res = await updateProfile(UID, { bio: 'Loves Barolo' });
    expect(res.changed).toEqual(['bio']);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(UID, { $set: { bio: 'Loves Barolo' } }, { new: true });
  });
});

describe('createSupportTicket', () => {
  test('rejects a bad category, missing subject/message, and oversize text', async () => {
    expect((await createSupportTicket(UID, { category: 'rant', subject: 's', message: 'm' })).error.status).toBe(400);
    expect((await createSupportTicket(UID, { category: 'bug', subject: '  ', message: 'm' })).error.message).toMatch(/Subject/);
    expect((await createSupportTicket(UID, { category: 'bug', subject: 's', message: '' })).error.message).toMatch(/Message/);
    expect((await createSupportTicket(UID, { category: 'bug', subject: 'x'.repeat(201), message: 'm' })).error.status).toBe(400);
    expect((await createSupportTicket(UID, { category: 'bug', subject: 's', message: 'm'.repeat(5001) })).error.status).toBe(400);
    expect(SupportTicket.create).not.toHaveBeenCalled();
  });

  test('creates with HTML stripped from subject and message', async () => {
    SupportTicket.create.mockResolvedValue({ _id: 't1', category: 'help', status: 'open' });
    const res = await createSupportTicket(UID, { category: 'help', subject: 'Hi <i>there</i>', message: 'Need <b>help</b>' });
    expect(res.error).toBeUndefined();
    expect(SupportTicket.create).toHaveBeenCalledWith({
      user: UID, category: 'help', subject: 'Hi there', message: 'Need help',
    });
  });
});

describe('validateSourceUrl', () => {
  test('accepts a public https URL and rejects junk, non-http, and private targets', () => {
    expect(validateSourceUrl('https://www.systembolaget.se/produkt/123')).toBeNull();
    expect(validateSourceUrl('')).toMatch(/required/);
    expect(validateSourceUrl('ftp://example.com')).toMatch(/http/);
    expect(validateSourceUrl('http://127.0.0.1/x')).toMatch(/private\/internal/);
    expect(validateSourceUrl('http://169.254.169.254/latest')).toMatch(/private\/internal/);
    expect(validateSourceUrl('http://192.168.1.1/x')).toMatch(/private\/internal/);
    expect(validateSourceUrl('not a url')).toMatch(/valid URL/);
  });

  // Security audit L-1: the structural classifier closes forms the old lexical
  // regex missed. WHATWG `new URL` canonicalizes decimal/hex/octal IPv4, and
  // isPrivateAddress catches IPv6 loopback/ULA/link-local + v4-mapped.
  test('rejects private targets in canonicalized-IPv4 and IPv6 forms', () => {
    expect(validateSourceUrl('http://2130706433/')).toMatch(/private\/internal/);   // decimal 127.0.0.1
    expect(validateSourceUrl('http://0x7f000001/')).toMatch(/private\/internal/);   // hex 127.0.0.1
    expect(validateSourceUrl('http://[::1]/')).toMatch(/private\/internal/);        // IPv6 loopback
    expect(validateSourceUrl('http://[fc00::1]/')).toMatch(/private\/internal/);    // IPv6 ULA
    expect(validateSourceUrl('http://[fe80::1]/')).toMatch(/private\/internal/);    // IPv6 link-local
    expect(validateSourceUrl('http://[::ffff:169.254.169.254]/')).toMatch(/private\/internal/); // v4-mapped metadata
    expect(validateSourceUrl('http://100.64.0.1/')).toMatch(/private\/internal/);   // CGNAT
    expect(validateSourceUrl('http://sub.localhost/')).toMatch(/private\/internal/); // localhost subdomain
    // A genuine public host still passes.
    expect(validateSourceUrl('https://www.vivino.com/wine/1')).toBeNull();
  });
});

describe('createWineRequest', () => {
  test('requires a wine name and a valid public source URL', async () => {
    expect((await createWineRequest(UID, { sourceUrl: 'https://x.com' })).error.status).toBe(400);
    expect((await createWineRequest(UID, { wineName: 'X', sourceUrl: 'http://10.0.0.1' })).error.message).toMatch(/private\/internal/);
    expect((await createWineRequest(UID, { wineName: 'x'.repeat(301), sourceUrl: 'https://x.com' })).error.status).toBe(400);
    expect((await createWineRequest(UID, { wineName: 'X', sourceUrl: 'https://x.com', image: 'd'.repeat(500001) })).error.status).toBe(400);
  });

  test('creates a pending new_wine request, trimming the name', async () => {
    const res = await createWineRequest(UID, { wineName: '  Barolo Riserva  ', sourceUrl: 'https://vivino.com/w/1' });
    expect(res.error).toBeUndefined();
    expect(WineRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestType: 'new_wine', wineName: 'Barolo Riserva', sourceUrl: 'https://vivino.com/w/1',
      image: null, user: UID, status: 'pending',
    }));
    expect(res.wineRequest.save).toHaveBeenCalled();
  });
});

describe('replyToTicket', () => {
  const { replyToTicket, TICKET_REPLY_CAP } = require('./accountOps');
  const TID = 'f'.repeat(24);
  const openTicket = (over = {}) => ({
    _id: TID, user: UID, status: 'in_progress', replies: [], save: jest.fn().mockResolvedValue(undefined), ...over,
  });

  test('rejects a malformed id (404, no cast-500), empty and oversize messages', async () => {
    expect((await replyToTicket(UID, 'not-an-id', 'hi')).error.status).toBe(404);
    SupportTicket.findOne.mockResolvedValue(openTicket());
    expect((await replyToTicket(UID, TID, '   ')).error.message).toMatch(/Message/);
    expect((await replyToTicket(UID, TID, 'x'.repeat(5001))).error.status).toBe(400);
  });

  test('404s a foreign/missing ticket (user-scoped query), 409s a closed one', async () => {
    SupportTicket.findOne.mockResolvedValue(null);
    expect((await replyToTicket(UID, TID, 'hi')).error.status).toBe(404);
    expect(SupportTicket.findOne).toHaveBeenCalledWith({ _id: TID, user: UID });
    SupportTicket.findOne.mockResolvedValue(openTicket({ status: 'closed' }));
    const closed = await replyToTicket(UID, TID, 'hi');
    expect(closed.error.status).toBe(409);
    expect(closed.error.message).toMatch(/closed/i);
  });

  test('caps the thread length', async () => {
    SupportTicket.findOne.mockResolvedValue(openTicket({
      replies: Array.from({ length: TICKET_REPLY_CAP }, () => ({ author: 'user', by: UID, message: 'x' })),
    }));
    expect((await replyToTicket(UID, TID, 'one more')).error.status).toBe(400);
  });

  test('appends the stripped reply as author:user and flips status back to open', async () => {
    const ticket = openTicket();
    SupportTicket.findOne.mockResolvedValue(ticket);
    const res = await replyToTicket(UID, TID, 'Still <b>broken</b> on Firefox');
    expect(res.error).toBeUndefined();
    expect(ticket.replies).toHaveLength(1);
    expect(ticket.replies[0]).toMatchObject({ author: 'user', by: UID, message: 'Still broken on Firefox' });
    expect(ticket.status).toBe('open');
    expect(ticket.save).toHaveBeenCalled();
  });
});
