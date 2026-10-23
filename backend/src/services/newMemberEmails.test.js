/**
 * services/newMemberEmails — the one email a new member gets two days after
 * joining, if they have not come back since their first day.
 *
 * WHY THIS TEST EXISTS:
 * Members who come back on a second day in their first week stay several
 * times as often as those who don't, and nothing reached the rest. These
 * emails must go once, ever, only to the right accounts, only to accounts
 * created after an admin turned them on, and the backtest must run exactly
 * the selection the job runs.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('./mailgun', () => ({
  EMAIL_VERIFICATION_ENABLED: true,
  sendNewMemberCellarEmail: jest.fn(async () => {}),
  sendNewMemberEmptyEmail: jest.fn(async () => {}),
}));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/maturityUtils', () => ({
  buildProfileMap: jest.fn(async () => new Map()),
  classifyMaturity: jest.fn(() => null),
}));

const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const AuditLog = require('../models/AuditLog');
const SiteConfig = require('../models/SiteConfig');
const mailgun = require('./mailgun');
const { logAudit } = require('./audit');
const { classifyMaturity } = require('../utils/maturityUtils');
const {
  chooseEmail, findCandidates, runNewMemberEmails, cellarSummary, setEnabled, getSettings,
} = require('./newMemberEmails');

const DAY = 24 * 60 * 60 * 1000;
// The job runs at 17:00 UTC; on 2026-10-23 it looks at accounts created on
// 2026-10-20 and 2026-10-21.
const RUN = new Date('2026-10-23T17:00:00Z');

const newUser = (o = {}) => ({
  _id: 'u1', email: 'a@example.com', emailVerified: true, emailOptOutAt: null, isDemo: false,
  roles: ['user'], deletionScheduledFor: null, createdAt: new Date('2026-10-21T10:00:00Z'),
  username: 'anna', displayName: null, sessions: [], newMemberEmailSentAt: null, ...o,
});
const facts = (o = {}) => ({ cameBack: false, bottles: 0, member: false, ...o });

// Model.find(...).select(...).lean() and similar chains.
const chain = (value) => {
  const q = { select: () => q, populate: () => q, lean: () => Promise.resolve(value), then: (r, j) => Promise.resolve(value).then(r, j) };
  return q;
};

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('chooseEmail', () => {
  test('bottles and not back → "cellar"; nothing and not back → "empty"', () => {
    expect(chooseEmail(newUser(), facts({ bottles: 4 }))).toBe('cellar');
    expect(chooseEmail(newUser(), facts())).toBe('empty');
  });

  test('anyone who came back gets nothing', () => {
    expect(chooseEmail(newUser(), facts({ bottles: 4, cameBack: true }))).toBe('skip:cameBack');
    expect(chooseEmail(newUser(), facts({ cameBack: true }))).toBe('skip:cameBack');
  });

  test('a household member of another cellar, with no bottles of their own, gets nothing', () => {
    expect(chooseEmail(newUser(), facts({ member: true }))).toBe('skip:member');
    // …but someone with their own bottles still gets theirs
    expect(chooseEmail(newUser(), facts({ member: true, bottles: 2 }))).toBe('cellar');
  });

  test.each([
    ['skip:sent', { newMemberEmailSentAt: new Date() }],
    ['skip:demo', { isDemo: true }],
    ['skip:admin', { roles: ['user', 'admin'] }],
    ['skip:deleting', { deletionScheduledFor: new Date() }],
    ['skip:unverified', { emailVerified: false }],
    ['skip:unverified', { email: '' }],
    ['skip:unsubscribed', { emailOptOutAt: new Date() }],
  ])('%s', (expected, override) => {
    expect(chooseEmail(newUser(override), facts({ bottles: 3 }))).toBe(expected);
  });

  test('the backtest ignores the sent stamp', () => {
    expect(chooseEmail(newUser({ newMemberEmailSentAt: new Date() }), facts(), { ignoreSent: true })).toBe('empty');
  });
});

describe('findCandidates', () => {
  function stubFacts({ activity = null, cellars = [], member = null, bottles = 0 } = {}) {
    jest.spyOn(AuditLog, 'exists').mockResolvedValue(activity);
    jest.spyOn(Cellar, 'distinct').mockResolvedValue(cellars);
    jest.spyOn(Cellar, 'exists').mockResolvedValue(member);
    return jest.spyOn(Bottle, 'countDocuments').mockResolvedValue(bottles);
  }

  test('looks at accounts created two or three UTC days before the run, not yet emailed', async () => {
    const find = jest.spyOn(User, 'find').mockReturnValue(chain([]));
    await findCandidates({ runAt: RUN });
    expect(find).toHaveBeenCalledWith({
      createdAt: { $gte: new Date('2026-10-20T00:00:00Z'), $lt: new Date('2026-10-22T00:00:00Z') },
      newMemberEmailSentAt: null,
    });
  });

  test('never reaches back before the moment the emails were turned on', async () => {
    const find = jest.spyOn(User, 'find').mockReturnValue(chain([]));
    const since = new Date('2026-10-21T08:00:00Z');
    await findCandidates({ runAt: RUN, since });
    expect(find.mock.calls[0][0].createdAt.$gte).toEqual(since);

    // turned on after the whole window: nobody at all, no query
    find.mockClear();
    expect(await findCandidates({ runAt: RUN, since: new Date('2026-10-22T09:00:00Z') })).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  test('"came back" = activity from the day after signing up until the run, people not machines', async () => {
    jest.spyOn(User, 'find').mockReturnValue(chain([newUser()]));
    stubFacts({ activity: { _id: 'a' } });
    const [c] = await findCandidates({ runAt: RUN });
    expect(c.choice).toBe('skip:cameBack');
    const filter = AuditLog.exists.mock.calls[0][0];
    expect(filter.timestamp).toEqual({ $gte: new Date('2026-10-22T00:00:00Z'), $lt: RUN });
    expect(filter.$or[0]).toEqual({ 'actor.userId': 'u1', action: { $nin: ['token.used', 'oauth.token_refreshed', 'bridge.key.used'] } });
    expect(filter.$or[1]).toEqual({ 'resource.id': 'u1', action: { $in: ['auth.login.success', 'auth.oauth.success'] } });
  });

  test('a device session used after the sign-up day counts as coming back (live only)', async () => {
    const lookedYesterday = newUser({ sessions: [{ lastUsedAt: new Date('2026-10-22T20:00:00Z') }] });
    jest.spyOn(User, 'find').mockReturnValue(chain([lookedYesterday]));
    stubFacts();
    expect((await findCandidates({ runAt: RUN }))[0].choice).toBe('skip:cameBack');
    // the backtest cannot use it (a session keeps only its latest use)
    expect((await findCandidates({ runAt: RUN, live: false }))[0].choice).toBe('empty');
  });

  test('live counts bottles in the cellar now; the backtest counts what was added by the run', async () => {
    jest.spyOn(User, 'find').mockReturnValue(chain([newUser()]));
    const count = stubFacts({ cellars: ['c1'], bottles: 5 });

    const [live] = await findCandidates({ runAt: RUN });
    expect(live.choice).toBe('cellar');
    expect(count).toHaveBeenLastCalledWith({ cellar: { $in: ['c1'] }, createdAt: { $lt: RUN }, status: { $in: ['active', 'ordered'] } });

    await findCandidates({ runAt: RUN, live: false });
    expect(count).toHaveBeenLastCalledWith({ cellar: { $in: ['c1'] }, createdAt: { $lt: RUN } });
    expect(User.find.mock.calls[1][0]).not.toHaveProperty('newMemberEmailSentAt');
  });

  test('no own cellar: no bottle count, and membership elsewhere decides', async () => {
    jest.spyOn(User, 'find').mockReturnValue(chain([newUser()]));
    const count = stubFacts({ member: { _id: 'other' } });
    expect((await findCandidates({ runAt: RUN }))[0].choice).toBe('skip:member');
    expect(count).not.toHaveBeenCalled();
  });
});

describe('runNewMemberEmails', () => {
  const settings = (value) => jest.spyOn(SiteConfig, 'findOne').mockReturnValue(chain(value ? { value } : null));

  test('sends nothing until an admin turns it on', async () => {
    settings(null);
    const find = jest.spyOn(User, 'find');
    expect(await runNewMemberEmails({ now: RUN })).toEqual({ sent: 0 });
    expect(find).not.toHaveBeenCalled();
  });

  test('claims the stamp, then sends the right email once and audits it', async () => {
    settings({ enabled: true, since: '2026-10-01T00:00:00Z' });
    jest.spyOn(User, 'find').mockReturnValue(chain([newUser({ _id: 'u1' }), newUser({ _id: 'u2', displayName: 'Bo' })]));
    jest.spyOn(AuditLog, 'exists').mockResolvedValue(null);
    jest.spyOn(Cellar, 'exists').mockResolvedValue(null);
    // u1 has a cellar with bottles, u2 has none
    jest.spyOn(Cellar, 'distinct').mockImplementation(async (field, q) => (String(q.user) === 'u1' ? ['c1'] : []));
    jest.spyOn(Bottle, 'countDocuments').mockResolvedValue(2);
    jest.spyOn(Bottle, 'find').mockReturnValue(chain([]));
    const claim = jest.spyOn(User, 'findOneAndUpdate').mockImplementation(() => chain({ _id: 'x' }));

    expect(await runNewMemberEmails({ now: RUN })).toEqual({ sent: 2 });

    expect(claim).toHaveBeenCalledWith(
      { _id: 'u1', newMemberEmailSentAt: null },
      { $set: { newMemberEmailSentAt: RUN, newMemberEmailKind: 'cellar' } },
    );
    expect(mailgun.sendNewMemberCellarEmail).toHaveBeenCalledWith('a@example.com', 'anna', 'u1', expect.objectContaining({ cellarPath: '/cellars' }));
    expect(mailgun.sendNewMemberEmptyEmail).toHaveBeenCalledWith('a@example.com', 'Bo', 'u2');
    expect(logAudit).toHaveBeenCalledWith(null, 'user.new_member_email_sent', { type: 'user', id: 'u1' }, { kind: 'cellar' });
    expect(logAudit).toHaveBeenCalledWith(null, 'user.new_member_email_sent', { type: 'user', id: 'u2' }, { kind: 'empty' });
  });

  test('a stamp someone else already claimed means no second email', async () => {
    settings({ enabled: true, since: '2026-10-01T00:00:00Z' });
    jest.spyOn(User, 'find').mockReturnValue(chain([newUser()]));
    jest.spyOn(AuditLog, 'exists').mockResolvedValue(null);
    jest.spyOn(Cellar, 'exists').mockResolvedValue(null);
    jest.spyOn(Cellar, 'distinct').mockResolvedValue([]);
    jest.spyOn(User, 'findOneAndUpdate').mockImplementation(() => chain(null));

    expect(await runNewMemberEmails({ now: RUN })).toEqual({ sent: 0 });
    expect(mailgun.sendNewMemberEmptyEmail).not.toHaveBeenCalled();
  });

  test('a failed send is not retried and does not stop the run', async () => {
    settings({ enabled: true, since: '2026-10-01T00:00:00Z' });
    jest.spyOn(User, 'find').mockReturnValue(chain([newUser({ _id: 'u1' }), newUser({ _id: 'u2' })]));
    jest.spyOn(AuditLog, 'exists').mockResolvedValue(null);
    jest.spyOn(Cellar, 'exists').mockResolvedValue(null);
    jest.spyOn(Cellar, 'distinct').mockResolvedValue([]);
    jest.spyOn(User, 'findOneAndUpdate').mockImplementation(() => chain({ _id: 'x' }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mailgun.sendNewMemberEmptyEmail.mockRejectedValueOnce(new Error('mailgun down'));

    expect(await runNewMemberEmails({ now: RUN })).toEqual({ sent: 1 });
    expect(mailgun.sendNewMemberEmptyEmail).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });
});

describe('cellarSummary', () => {
  test('one line per wine and vintage, most urgent first, at most three, and the fullest cellar', async () => {
    jest.spyOn(Cellar, 'distinct').mockResolvedValue(['c1', 'c2']);
    const wd = (id, producer, name) => ({ _id: id, producer, name });
    const b = (cellar, w, vintage, status = 'active') => ({ cellar, wineDefinition: w, vintage, status });
    const musar = wd('w1', 'Château Musar', 'Château Musar Rouge');
    const bay = wd('w2', 'Cloudy Bay', 'Sauvignon Blanc');
    const rioja = wd('w3', 'López de Heredia', 'Viña Tondonia');
    const barolo = wd('w4', 'Vietti', 'Castiglione');
    const young = wd('w5', 'Penfolds', 'Grange');
    jest.spyOn(Bottle, 'find').mockReturnValue(chain([
      b('c2', bay, 2023), b('c2', bay, 2023), b('c2', bay, 2023),
      b('c2', musar, 2008), b('c2', rioja, 2010), b('c1', barolo, 2019), b('c1', young, 2020),
      b('c2', bay, 2023, 'ordered'),
    ]));
    const status = { w1: 'declining', w2: 'peak', w3: 'late', w4: 'peak', w5: 'not-ready' };
    classifyMaturity.mockImplementation((bottle) => status[bottle.wineDefinition._id]);

    const s = await cellarSummary('u1');

    expect(s.bottles).toBe(8);
    expect(s.readyCount).toBe(6);
    expect(s.readyWines).toBe(4);
    expect(s.cellarPath).toBe('/cellars/c2');
    expect(s.ready).toEqual([
      { wine: 'Château Musar Rouge', vintage: 2008, count: 1 },
      { wine: 'López de Heredia Viña Tondonia', vintage: 2010, count: 1 },
      { wine: 'Cloudy Bay Sauvignon Blanc', vintage: 2023, count: 3 },
    ]);
  });
});

describe('the admin switch', () => {
  test('turning it on starts a new "since"; turning it off keeps the last one', async () => {
    const SiteConfigUpdate = jest.spyOn(SiteConfig, 'findOneAndUpdate').mockResolvedValue({});
    jest.spyOn(SiteConfig, 'findOne').mockReturnValue(chain({ value: { enabled: false, since: null } }));
    const on = await setEnabled(true, 'admin1');
    expect(on.enabled).toBe(true);
    expect(on.since).toBeInstanceOf(Date);
    expect(SiteConfigUpdate.mock.calls[0][1].$set.value).toEqual(on);

    SiteConfig.findOne.mockReturnValue(chain({ value: { enabled: true, since: '2026-10-20T00:00:00Z' } }));
    const off = await setEnabled(false, 'admin1');
    expect(off).toEqual({ enabled: false, since: new Date('2026-10-20T00:00:00Z') });
  });

  test('saving the same state again writes nothing', async () => {
    const update = jest.spyOn(SiteConfig, 'findOneAndUpdate');
    jest.spyOn(SiteConfig, 'findOne').mockReturnValue(chain({ value: { enabled: true, since: '2026-10-20T00:00:00Z' } }));
    expect(await setEnabled(true, 'admin1')).toEqual(await getSettings());
    expect(update).not.toHaveBeenCalled();
  });
});
