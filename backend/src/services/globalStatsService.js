const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const BridgeKey = require('../models/BridgeKey');
const WineDefinition = require('../models/WineDefinition');
const AuditLog = require('../models/AuditLog');
const { PLAN_NAMES } = require('../config/plans');

// ── Helpers ──────────────────────────────────────────────────────────────────

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const pct = (count, total) => total > 0 ? round((count / total) * 100, 1) : 0;

// Retention ladder: how many distinct days a user has to show up on to land in
// each tier. 2 = came back at all, 4 = a habit forming, 7 = committed. Add a
// tier here and both the API payload and the dashboard pick it up — nothing
// else to change.
//
// It stops at 7 because BOTH ladders have to be able to reach the top tier,
// and the presence ladder sees only the audit TTL window (90 days). The
// bottle ladder runs over all history and could take a longer tier; the
// presence ladder could not, and two ladders with different rungs would be
// worse than one rung fewer. Adding a tier is a product call, not a free one.
const DAY_TIERS = [2, 4, 7];

// $group accumulators counting users at or above each tier, e.g. { t2: {…}, t4: {…} }.
const tierAccumulators = (dayField) => Object.fromEntries(
  DAY_TIERS.map(n => [`t${n}`, { $sum: { $cond: [{ $gte: [dayField, n] }, 1, 0] } }]),
);

// …and back out again into a payload the UI can map over without knowing the tiers.
const tierRows = (row, total) => DAY_TIERS.map(n => ({
  days:  n,
  users: row[`t${n}`] || 0,
  pct:   pct(row[`t${n}`] || 0, total),
}));

// How far back presence can be asked about. Read from the model so it tracks
// the TTL index rather than restating 90 where it can silently disagree.
const AUDIT_TTL_DAYS = AuditLog.TTL_DAYS || 90;

// Actions that mean "this person arrived", written BEFORE the request is
// authenticated. Both are needed: password sign-in and single sign-on write
// different action names, and matching only the first silently drops every
// SSO-only account. auth.demo_login is deliberately absent — demo accounts are
// not customers, and they are excluded by id as well.
const SIGNIN_ACTIONS = ['auth.login.success', 'auth.oauth.success'];

// Connection bookkeeping, written by machines rather than done by people, and
// therefore NOT presence.
//
// token.used is written once an hour per API token by whatever is holding it.
// Production tokens are named "Home Assistant", "Homeassistant" and "Climate
// device: Kallaren": integrations that poll around the clock and would mark
// their owner present every single day, for ever. Measured on 2026-09-09 they
// inflated the 7-or-more-days tier from 44 users to 63 — a 43% overstatement,
// concentrated exactly where the most engaged people are supposed to be.
// oauth.token_refreshed is a background token rotation and never a person.
//
// The token's origin ('personal' PAT vs 'oauth' connected AI) is NOT used to
// tell machines from people, because it does not: production has personal
// tokens named "claude" and OAuth tokens that could equally be automated.
// The rule that survives contact with the data is simpler and explains itself
// in one sentence — presence counts things a person DID, plus signing in.
//
// What this costs MCP users: nothing, measured rather than assumed. Dropping
// these two actions removed NOBODY from the page — all 255 people seen stayed
// seen — because anyone using MCP for something real writes an audited action
// of their own (15 of the 16 accounts with MCP writes in the window remained
// present; the 16th is an excluded admin). Only the hourly heartbeat goes: 7
// users leave the 2-or-more tier and 19 leave the 7-or-more one, which is the
// machine inflation being removed, not people being hidden.
//
// A read-only MCP session does now leave no trace here. That is consistent
// rather than unfair: reading leaves no trace for anybody, since browsing the
// site is not audited either. Presence is a floor for every kind of user.
const MACHINE_ACTIONS = ['token.used', 'oauth.token_refreshed'];

// Days a user was PRESENT, whether or not they touched a bottle.
//
// The bottle ladder alongside this one answers "did they use their cellar".
// This one answers the question that comes first: did they come back at all.
// Someone who signs in, reads their drink window and leaves is a returning
// user by any honest reading, and the bottle ladder cannot see them.
//
// ⚠️ The trap that makes this non-obvious. A sign-in row is written before the
// request is authenticated, so its actor is anonymous — `actor.userId` is NULL
// on every login row in the collection, and the account is in `resource.id`
// instead. Grouping on actor.userId alone therefore counts sign-ins as nobody.
// Every other action carries actor.userId normally. The $project below
// coalesces the two into one "who was here" field, and the exclusion $match
// runs AFTER it, so a demo or admin sign-in is dropped by the resolved id
// rather than slipping through as an anonymous row.
//
// Bounded by the audit TTL (AUDIT_TTL_DAYS, 90 by default) — unlike the bottle
// ladder, which spans all history. The payload reports the window so the page
// can say so rather than inviting a comparison of two different questions.
// The rows that mean "this person was here", with the account resolved and the
// excluded cohorts dropped. Shared by the ladder and the window counts below,
// so the two can never come to disagree about who was present.
const presenceStages = ({ since, excludedIds = [] }) => [
  { $match: {
    timestamp: { $gte: since },
    action: { $nin: MACHINE_ACTIONS },
    $or: [{ 'actor.userId': { $ne: null } }, { action: { $in: SIGNIN_ACTIONS } }],
  }},
  { $project: {
    day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
    at: '$timestamp',
    who: { $cond: [{ $in: ['$action', SIGNIN_ACTIONS] }, '$resource.id', '$actor.userId'] },
  }},
  { $match: { who: { $nin: [...excludedIds, null] } } },
];

const buildPresencePipeline = (opts) => [
  ...presenceStages(opts),
  { $group: { _id: { user: '$who', day: '$day' } } },      // dedupe user×day
  { $group: { _id: '$_id.user', activeDays: { $sum: 1 } } }, // days per user
  { $group: {
    _id: null,
    usersSeen: { $sum: 1 },
    ...tierAccumulators('$activeDays'),
  }},
];

// "How many people were here in the last 24h / 7d / 30d / 90d", answered in a
// SINGLE pass rather than one scan per window: reduce to each user's most
// recent moment, then count how many of those fall inside each window. Adding
// a window costs nothing extra.
//
// The widest window can be no wider than the audit TTL — rows older than that
// are gone — so the caller passes windows it can actually see.
const buildPresenceWindowPipeline = ({ since, excludedIds = [], windows }) => [
  ...presenceStages({ since, excludedIds }),
  { $group: { _id: '$who', lastSeen: { $max: '$at' } } },
  { $group: {
    _id: null,
    ...Object.fromEntries(Object.entries(windows).map(([label, from]) => [
      label, { $sum: { $cond: [{ $gte: ['$lastSeen', from] }, 1, 0] } },
    ])),
  }},
];

/**
 * Turn raw `{_id: plan, count}` groups into the distribution the page renders.
 *
 * Extracted so it is TESTED rather than re-implemented in a test file — a copy
 * of the rule next to the rule passes even when the two drift apart, which is
 * the one thing a regression test must not do.
 *
 * Two rules, each fixing a way a number could vanish:
 *   • every CONFIGURED tier appears, at 0 if nobody is on it — $group only
 *     emits values that exist, so `benefactor` was absent from the table
 *     entirely and "nobody chose it" read as "it doesn't exist"
 *   • a plan value NOT in the config is kept and flagged, never dropped — a
 *     retired or hand-set tier is still real users
 *
 * Ordered by the config ladder, because the ladder is the price order.
 */
const buildPlanDistribution = (planCounts) => {
  const countByPlan = new Map(planCounts.map((r) => [r._id, r.count]));
  return [
    ...PLAN_NAMES.map((plan) => ({ plan, count: countByPlan.get(plan) || 0 })),
    ...planCounts
      .filter((r) => !PLAN_NAMES.includes(r._id))
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ plan: r._id, count: r.count, unconfigured: true })),
  ];
};

// Signup cohorts: "of the people who joined N weeks ago, how many came back?"
const COHORT_WINDOW_DAYS = 7;   // what "came back" means, and the cohort width
const COHORT_SPAN_DAYS = 28;    // how far back cohorts go

/**
 * Bucket users by signup age and count who was active in the window.
 *
 * ⚠️ THE NEWEST COHORT IS NOT ASKED. Its members are "active in the last 7
 * days" because they SIGNED UP in the last 7 days — measured live that reads
 * ~97%, which is a tautology, not retention. It returns { returned: null,
 * pct: null, tooNew: true } so the caller can show the intake without
 * inviting the false reading, and the headline percentage skips it.
 *
 * `now` is injected so the test can pin time instead of racing the clock.
 */
const buildSignupCohorts = (users, activeIds, now) => {
  const out = [];
  for (let start = 0; start < COHORT_SPAN_DAYS; start += COHORT_WINDOW_DAYS) {
    const end = start + COHORT_WINDOW_DAYS;
    const from = new Date(now - end * 86400000);
    // Buckets are [now-end, now-start) so each user lands in exactly one. The
    // NEWEST bucket has no upper bound at all rather than `< now`: a user
    // created at the query instant would otherwise fall out of every bucket
    // and silently vanish from the intake count, and clock skew between the
    // app and Mongo puts a createdAt fractionally in the future within reach.
    const to = start === 0 ? null : new Date(now - start * 86400000);
    const members = users.filter((u) => u.createdAt >= from && (to === null || u.createdAt < to));
    const tooNew = start === 0;
    const returned = tooNew ? null : members.filter((u) => activeIds.has(String(u._id))).length;
    out.push({
      daysAgoFrom: start,
      daysAgoTo: end,
      signedUp: members.length,
      returned,
      pct: returned == null ? null : pct(returned, members.length),
      tooNew,
    });
  }
  return out;
};

const safeAggregate = async (model, pipeline) => {
  try { return await model.aggregate(pipeline); }
  catch (err) {
    console.error(`Aggregate failed on ${model.modelName}:`, err.message);
    return [];
  }
};

// Bridge-only = holds a bridge account and owns no bottle on this instance.
// Derived on every read rather than stored, because it is not a property of
// the account: the day a bridge user adds their first bottle here they stop
// being bridge-only, and nothing has to be migrated for that to be true.
//
// Clamped at zero because the two inputs come from separate queries. Between
// them a bottle can be added, which would otherwise report a negative count.
const buildBridgeSummary = ({ accounts = 0, ownersWithBottles = 0, liveKeyOwners = 0, everKeyOwners = 0 }) => ({
  accounts,
  bridgeOnly: Math.max(0, accounts - ownersWithBottles),
  liveKeys: liveKeyOwners,
  everConnected: everKeyOwners,
});

// Activation asks "of the people who could put a bottle in a cellar here, how
// many did". Bridge-only accounts could not — their cellar lives on their own
// server — so dividing by totalUsers would count a working self-hosted install
// as a failed signup, and would sink the figure further with every install the
// beta adds. Divide by the people the question is actually about.
const buildActivation = ({ totalUsers = 0, usersWithBottles = 0, bridgeOnlyUsers = 0 }) => {
  const cellarUsers = Math.max(0, totalUsers - bridgeOnlyUsers);
  return {
    cellarUsers,
    activationPct: cellarUsers > 0 ? Math.round((usersWithBottles / cellarUsers) * 100) : 0,
  };
};

// ── Main ─────────────────────────────────────────────────────────────────────

// ── In-memory cache ──────────────────────────────────────────────────────────
// A dozen aggregations per call against MongoDB. Admin-only traffic so the
// load is low, but caching keeps the page snappy and avoids hammering Mongo if
// an admin holds Cmd-R. TTL is short enough that the page never feels stale.
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();  // key: excludeAdmins flag ('true' | 'false') → { at, data }

/**
 * Compute platform-wide aggregate statistics across all users.
 * Returns an anonymised payload safe to surface to admins.
 *
 * @param {object}  [options]
 * @param {boolean} [options.excludeAdmins=true]
 *        When true (the default), all per-user data (bottles, cellars, user
 *        counts, plans, engagement, retention) is filtered to exclude any user
 *        with the 'admin' role — so the dashboard reflects real customers, not
 *        our own test/admin accounts. Pass false explicitly to include admins.
 *        Demo accounts and accounts pending deletion are excluded either way;
 *        the payload's `excluded` block reports how many of each.
 * @param {boolean} [options.force=false]
 *        When true, bypass the in-memory cache and recompute fresh.
 * @returns {Promise<object>}
 */
async function computeGlobalStats({ excludeAdmins = true, force = false } = {}) {
  const cacheKey = String(!!excludeAdmins);
  if (!force) {
    const hit = _cache.get(cacheKey);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
      return { ...hit.data, fromCache: true, cachedAt: new Date(hit.at).toISOString() };
    }
  }
  const data = await _computeGlobalStatsUncached({ excludeAdmins });
  _cache.set(cacheKey, { at: Date.now(), data });
  return { ...data, fromCache: false };
}

async function _computeGlobalStatsUncached({ excludeAdmins = true } = {}) {
  const currentYear = new Date().getFullYear();
  const since30 = new Date(Date.now() - 30 * 86400000);
  const since90 = new Date(Date.now() - 90 * 86400000);
  const since24h = new Date(Date.now() - 86400000);
  // Presence can only be seen as far back as audit rows are kept.
  const sinceAudit = new Date(Date.now() - AUDIT_TTL_DAYS * 86400000);
  const since7d  = new Date(Date.now() - 7 * 86400000);

  // ── Who counts as a customer ────────────────────────────────────────────
  // Three kinds of account are excluded from every figure on this page, and
  // the payload reports how many of each so the totals stay explainable.
  //
  //   admins            — our own data, not a customer's. Optional, on by
  //                       default, because looking at the real numbers is the
  //                       normal case; ?excludeAdmins=false opts back in.
  //   demo accounts     — ephemeral clones of a snapshot cellar with a
  //                       two-hour lifetime (config/rateLimits demo.ttlMs).
  //                       Counting them inflated signups and every bottle
  //                       figure with data nobody owns. ALWAYS excluded.
  //   pending deletion  — the account asked to be erased and is inside the
  //                       seven-day cooling-off window. ALWAYS excluded: they
  //                       are leaving, and their data is about to go.
  const alwaysExcluded = await User.find({
    $or: [{ isDemo: true }, { deletionScheduledFor: { $ne: null } }],
  }).select('_id isDemo deletionScheduledFor').lean();
  const demoCount = alwaysExcluded.filter(u => u.isDemo).length;
  const pendingDeletionCount = alwaysExcluded.filter(u => !u.isDemo && u.deletionScheduledFor).length;

  let adminIds = [];
  if (excludeAdmins) {
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    adminIds = admins.map(a => a._id);
  }
  // One list drives every per-collection filter below.
  const excludedIds = [...adminIds, ...alwaysExcluded.map(u => u._id)];
  // The admin condition stays a role test rather than an id list so a newly
  // promoted admin is excluded even if the id lookup above raced with it.
  const userMatch = {
    ...(excludeAdmins ? { roles: { $nin: ['admin'] } } : {}),
    isDemo: { $ne: true },
    deletionScheduledFor: null,
  };
  const bottleMatch = { user: { $nin: excludedIds } };
  const cellarMatch = { user: { $nin: excludedIds } };

  // ── Overview ────────────────────────────────────────────────────────────
  const [
    totalUsers,
    totalCellars,
    totalBottles,
    activeBottles,
    consumedBottles,
    drankBottles,
    giftedBottles,
    soldBottles,
    otherBottles,
    usersWithBottles,
    newUsers30,
    newUsers90,
    bottlesAdded30,
    bottlesAdded90,
    bottlesConsumed30,
    bottlesConsumed90,
  ] = await Promise.all([
    User.countDocuments(userMatch),
    Cellar.countDocuments(cellarMatch),
    Bottle.countDocuments(bottleMatch),
    Bottle.countDocuments({ ...bottleMatch, status: 'active' }),
    Bottle.countDocuments({ ...bottleMatch, status: { $ne: 'active' } }),
    Bottle.countDocuments({ ...bottleMatch, status: 'drank' }),
    Bottle.countDocuments({ ...bottleMatch, status: 'gifted' }),
    Bottle.countDocuments({ ...bottleMatch, status: 'sold' }),
    Bottle.countDocuments({ ...bottleMatch, status: 'other' }),
    Bottle.distinct('user', bottleMatch).then(ids => ids.length),
    User.countDocuments({ ...userMatch, createdAt: { $gte: since30 } }),
    User.countDocuments({ ...userMatch, createdAt: { $gte: since90 } }),
    Bottle.countDocuments({ ...bottleMatch, createdAt: { $gte: since30 } }),
    Bottle.countDocuments({ ...bottleMatch, createdAt: { $gte: since90 } }),
    Bottle.countDocuments({ ...bottleMatch, consumedAt: { $gte: since30 } }),
    Bottle.countDocuments({ ...bottleMatch, consumedAt: { $gte: since90 } }),
  ]);

  // ── Bridge installs ─────────────────────────────────────────────────────
  // A self-hoster who connects their own Cellarion to the shared registry
  // needs an account here, but their wines live on their server — so they
  // will never add a bottle to this instance, by design. Left inside
  // totalUsers they look like signups that failed to activate, and they drag
  // every activation figure down as the beta grows. Reported here as their
  // own line, and subtracted from the activation denominator below.
  //
  // The marker is registryTerms.accepted: it is written only when a bridge
  // key is issued, and unlike the key itself it survives revocation.
  const bridgeTermsMatch = { ...userMatch, 'registryTerms.accepted': true };
  const [bridgeAccounts, liveKeyOwners, everKeyOwners, bridgeUserIds] = await Promise.all([
    User.countDocuments(bridgeTermsMatch),
    BridgeKey.distinct('user', { revokedAt: null }).then(ids => ids.length),
    BridgeKey.distinct('user').then(ids => ids.length),
    User.find(bridgeTermsMatch).select('_id').lean().then(rows => rows.map(r => r._id)),
  ]);
  // Bridge-only = has a bridge account and owns no bottle here. Derived, never
  // stored: a bridge user who later adds a bottle stops being one.
  const bridgeOwnersWithBottles = bridgeUserIds.length
    ? (await Bottle.distinct('user', { ...bottleMatch, user: { $in: bridgeUserIds } })).length
    : 0;
  const bridge = buildBridgeSummary({
    accounts: bridgeAccounts,
    ownersWithBottles: bridgeOwnersWithBottles,
    liveKeyOwners,
    everKeyOwners,
  });

  // ── Engagement (active users 24h / 7d / 30d / 90d) ──────────────────────
  // "Active" = added a bottle or consumed a bottle within the window.
  const engagementWindow = async (since) => {
    const r = await safeAggregate(Bottle, [
      { $match: { ...bottleMatch, $or: [
        { createdAt:  { $gte: since } },
        { consumedAt: { $gte: since } },
      ]}},
      { $group: { _id: '$user' } },
      { $count: 'count' },
    ]);
    return r[0]?.count || 0;
  };

  const [activeUsers24h, activeUsers7d, activeUsers30d, activeUsers90d] = await Promise.all([
    engagementWindow(since24h),
    engagementWindow(since7d),
    engagementWindow(since30),
    engagementWindow(since90),
  ]);

  // The same four windows, counting presence instead of cellar changes: signed
  // in, or did anything the audit log records. Reliably the larger number —
  // reading your cellar is using the app, and the bottle count cannot see it.
  const presenceWindowsRaw = await safeAggregate(AuditLog, buildPresenceWindowPipeline({
    since: sinceAudit,
    excludedIds,
    windows: { w24h: since24h, w7d: since7d, w30d: since30, w90d: since90 },
  }));
  const presentWindows = presenceWindowsRaw[0] || {};

  // ── Retention / returning users ──────────────────────────────────────────
  // "Returning" = a genuine repeat user, not a sign-up who poked around once.
  // Derived RETROACTIVELY from activity so it works across all history: a user
  // is returning if they added or consumed bottles on >=2 distinct calendar
  // days (4+ days = "core"/power users; DAY_TIERS carries the full ladder).
  // Counting distinct days, not events, so adding 50 bottles in one sitting
  // still counts as a single session.
  //
  // This is the HEADLINE ladder because it spans all history. The presence
  // ladder computed just below answers a broader question — did they come
  // back at all — but only as far back as audit rows are kept. Two questions,
  // two windows, both labelled on the page.
  const returningRaw = await safeAggregate(Bottle, [
    { $match: bottleMatch },
    { $project: {
      user: 1,
      addedDay: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
      consumedDay: { $cond: [
        { $ne: ['$consumedAt', null] },
        { $dateToString: { format: '%Y-%m-%d', date: '$consumedAt' } },
        null,
      ]},
    }},
    // Distinct activity days per bottle (drop the null when not consumed).
    { $project: { user: 1, days: { $setDifference: [['$addedDay', '$consumedDay'], [null]] } } },
    { $unwind: '$days' },
    { $group: { _id: { user: '$user', day: '$days' } } },     // dedupe user×day
    { $group: { _id: '$_id.user', activeDays: { $sum: 1 } } }, // days per user
    { $group: {
      _id: null,
      usersWithActivity: { $sum: 1 },
      // Each DAY_TIERS threshold as its own count — nested subsets, so t4 ⊆ t2.
      ...tierAccumulators('$activeDays'),
    }},
  ]);
  const ret = returningRaw[0] || { usersWithActivity: 0 };
  const activityTiers = tierRows(ret, ret.usersWithActivity || 0);
  // Named aliases for the two headline tiers, kept for API back-compat.
  const returningUsers = ret.t2 || 0;   // 2+ distinct active days
  const coreUsers = ret.t4 || 0;        // 4+ — a stickier tier, subset of the above
  const singleSessionUsers = Math.max(0, ret.usersWithActivity - returningUsers);

  // The same ladder, over presence rather than bottles. One aggregation,
  // bounded by the audit TTL and served by the timestamp index — measured at
  // ~240 ms against 57k production rows, behind a 5-minute cache.
  const presenceRaw = await safeAggregate(AuditLog,
    buildPresencePipeline({ since: sinceAudit, excludedIds }));
  const pres = presenceRaw[0] || { usersSeen: 0 };
  const presenceTiers = tierRows(pres, pres.usersSeen || 0);

  // ── Signup cohorts: do new users come back? ─────────────────────────────
  //
  // "Of the people who signed up N weeks ago, how many used Cellarion in the
  // last 7 days." The activity ladder above measures the whole population at
  // once and so is dominated by whoever has been here longest; this asks the
  // question that actually tracks growth.
  //
  // ⚠️ THE MOST RECENT COHORT CANNOT BE ASKED. Someone who joined three days
  // ago is "active in the last 7 days" because of the session they signed up
  // in — measured live it reads 97%, which is not retention, it is a tautology.
  // That cohort is returned with returned/pct NULL and a tooNew flag so the UI
  // shows the intake without inviting the false reading. The headline
  // percentage covers the MATURE cohorts only.
  //
  // Cost: ONE audit query, bounded to 7 days and served by the timestamp
  // index, intersected in memory — not one query per cohort. Deliberately
  // modest, because the login retention removed above was the most expensive
  // thing on this page and replacing it with something worse would be a poor
  // trade.
  const cohortUsers = await User.find({
    ...userMatch,
    createdAt: { $gte: new Date(Date.now() - COHORT_SPAN_DAYS * 86400000) },
  }).select('_id createdAt').lean();

  // Anyone who did ANYTHING in the window. Deliberately not "logged in": the
  // refresh cookie keeps a session alive for 30 rotating days, so an active
  // user may not hit /login for weeks. Deliberately not "touched a bottle"
  // either — that measures activation, which is a different question and
  // already has its own figures.
  const activeIds = new Set(
    (await AuditLog.distinct('actor.userId', { timestamp: { $gte: since7d } }))
      .filter(Boolean).map(String),
  );

  const signupCohorts = buildSignupCohorts(cohortUsers, activeIds, Date.now());
  const mature = signupCohorts.filter((c) => !c.tooNew);
  const matureSignups = mature.reduce((s, c) => s + c.signedUp, 0);
  const matureReturned = mature.reduce((s, c) => s + c.returned, 0);

  // History worth keeping: a LOGIN-ONLY ladder lived here until 2026-08-21 and
  // was removed for good reasons. It counted sign-in events, and a rotating
  // 30-day refresh cookie means an active user may not sign in for weeks — so
  // it structurally undercounted, disagreed with the bottle ladder by design,
  // and invited exactly the comparison the docs had to warn against.
  //
  // The presence ladder above is NOT that metric returning. Measured against
  // production on 2026-09-09, sign-in events alone found 105 returning users
  // where presence found 130: a quarter of them were missed by counting logins.
  // Presence counts any recorded action, sign-ins included, so a long session
  // no longer hides anyone. It is one indexed aggregation (~240 ms over 57k
  // rows) behind the 5-minute cache, not the full scan the old one was.
  //
  // Two facts that cost real time to learn, kept here because nothing in the
  // schema hints at either: single sign-on writes its OWN audit action, so
  // matching only 'auth.login.success' silently drops every SSO-only account;
  // and a sign-in row is written before the request is authenticated, so its
  // actor.userId is NULL and the account is in resource.id instead. Both are
  // handled in buildPresencePipeline. See docs/admin-global-stats-architecture.md.

  // ── Plans / subscriptions ───────────────────────────────────────────────
  // Every CONFIGURED tier appears, including the ones nobody has chosen.
  //
  // Grouping alone only emits tiers that have at least one user, so a tier with
  // zero supporters vanished from the table entirely — and "nobody picked
  // benefactor" then looked identical to "benefactor does not exist". That is
  // precisely the question worth asking after a repricing, and the page could
  // not answer it (found 2026-08-21, benefactor absent since the tiers shipped
  // in v1.140).
  //
  // Ordered by the config ladder rather than by count, because the ladder IS
  // the price order and reading it that way is the point. Any plan value found
  // in the data but NOT in the config is appended rather than dropped: a
  // retired or hand-set tier still represents real users, and silently hiding
  // them would be the same bug in the other direction.
  const planCounts = await safeAggregate(User, [
    { $match: userMatch },
    { $group: { _id: '$plan', count: { $sum: 1 } } },
  ]);
  const planDistribution = buildPlanDistribution(planCounts);

  const in7d  = new Date(Date.now() + 7 * 86400000);
  const in30d = new Date(Date.now() + 30 * 86400000);
  const [
    paidUsers, expiringIn7d, expiringIn30d, withStripeCustomer,
    newSupporters30d, newSupporters90d, formerSupporters,
  ] = await Promise.all([
    User.countDocuments({ ...userMatch, plan: { $ne: 'free' } }),
    User.countDocuments({ ...userMatch, planExpiresAt: { $gte: new Date(), $lte: in7d } }),
    User.countDocuments({ ...userMatch, planExpiresAt: { $gte: new Date(), $lte: in30d } }),
    User.countDocuments({ ...userMatch, stripeCustomerId: { $ne: null } }),
    // planStartedAt is stamped when a tier is granted, so it dates the
    // support rather than the account.
    User.countDocuments({ ...userMatch, plan: { $ne: 'free' }, planStartedAt: { $gte: since30 } }),
    User.countDocuments({ ...userMatch, plan: { $ne: 'free' }, planStartedAt: { $gte: since90 } }),
    // Churn: a user on `free` whose planStartedAt is stamped had a tier
    // GRANTED at some point — that stamp is written only when support actually
    // starts, and it survives the downgrade.
    //
    // ⚠️ NOT stripeCustomerId, which this shipped as for a few hours
    // (audit 2026-08-21 H-1). Stripe customers are created at CHECKOUT-SESSION
    // time, before any payment — so that shape counted abandoned checkouts as
    // churned supporters. Measured on prod the day it shipped: the card said 7
    // former supporters and only 3 had ever paid. An overstated churn number
    // points the admin at a retention problem that does not exist.
    User.countDocuments({ ...userMatch, plan: 'free', planStartedAt: { $ne: null } }),
  ]);

  // ── Maturity (drink-window phase distribution) ──────────────────────────
  // Joins active bottles to reviewed WineVintageProfile and classifies each
  // bottle against the current year. NV bottles are EXCLUDED up front (same
  // filter as the vintage aggregations above): their reviewed profiles store
  // RELATIVE offsets from each bottle's purchase year (0–100), which cannot
  // be compared against absolute calendar years — including them misclassified
  // every somm-reviewed NV bottle as 'declining'. Bottles without a reviewed
  // profile fall into 'noProfile'.
  //
  // KNOWN DIVERGENCE from utils/maturityUtils.js#classifyMaturity: that function
  // gives a bottle's PERSONAL drink window (Bottle.drinkFrom/drinkTo) precedence
  // over the sommelier profile, and applies it even to NV / definition-less
  // bottles. This admin-only aggregation does NOT read the personal window — it
  // classifies purely from the sommelier profile — so a bottle whose per-user
  // window overrides its profile lands in a different phase here than on the
  // owner's Statistics page. Accepted: this is a global registry-health view
  // (low stakes), and personal windows are per-user data that don't belong in an
  // instance-wide roll-up. See statsService.js for the personal-window-aware path.
  const maturityRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', vintage: { $nin: ['NV', null, ''] } } },
    { $lookup: {
      from: 'winevintageprofiles',
      let: { wdId: '$wineDefinition', v: '$vintage' },
      pipeline: [
        { $match: { $expr: { $and: [
          { $eq: ['$wineDefinition', '$$wdId'] },
          { $eq: ['$vintage', '$$v'] },
          { $eq: ['$status', 'reviewed'] },
        ]}}},
        { $limit: 1 },
      ],
      as: 'profile',
    }},
    { $unwind: { path: '$profile', preserveNullAndEmptyArrays: true } },
    { $addFields: {
      maturity: {
        // Mirror utils/maturityUtils.js#classifyMaturity's PROFILE branch (the
        // personal drinkFrom/drinkTo window is intentionally not applied here —
        // see the KNOWN DIVERGENCE note above):
        //   - NV bottles return null there; here they are excluded by the
        //     pipeline's vintage $nin filter instead (their profiles hold
        //     purchase-relative offsets, not calendar years)
        //   - No profile, or a reviewed profile with no window boundaries
        //     defined, → 'noProfile' (NOT 'peak' — every window boundary in
        //     WineVintageProfile is optional, so partial profiles are real)
        //   - Fall-through default is 'early' (matches the JS function's
        //     final `return 'early'`)
        $cond: {
          if: {
            $or: [
              { $eq: [{ $ifNull: ['$profile', null] }, null] },
              { $and: [
                { $eq: [{ $ifNull: ['$profile.earlyFrom', null] }, null] },
                { $eq: [{ $ifNull: ['$profile.peakFrom',  null] }, null] },
                { $eq: [{ $ifNull: ['$profile.peakUntil', null] }, null] },
              ]},
            ],
          },
          then: 'noProfile',
          else: {
            $switch: {
              branches: [
                { case: { $and: [
                  { $ne: ['$profile.earlyFrom', null] },
                  { $lt: [currentYear, '$profile.earlyFrom'] },
                ]}, then: 'notReady' },
                { case: { $and: [
                  { $eq: ['$profile.earlyFrom', null] },
                  { $ne: ['$profile.peakFrom', null] },
                  { $lt: [currentYear, '$profile.peakFrom'] },
                ]}, then: 'notReady' },
                { case: { $and: [
                  { $ne: ['$profile.earlyUntil', null] },
                  { $lte: [currentYear, '$profile.earlyUntil'] },
                ]}, then: 'early' },
                { case: { $and: [
                  { $ne: ['$profile.peakFrom', null] },
                  { $lt: [currentYear, '$profile.peakFrom'] },
                ]}, then: 'early' },
                { case: { $and: [
                  { $ne: ['$profile.peakUntil', null] },
                  { $lte: [currentYear, '$profile.peakUntil'] },
                ]}, then: 'peak' },
                { case: { $and: [
                  { $ne: ['$profile.lateFrom', null] },
                  { $lt: [currentYear, '$profile.lateFrom'] },
                ]}, then: 'peak' },
                { case: { $and: [
                  { $ne: ['$profile.lateUntil', null] },
                  { $lte: [currentYear, '$profile.lateUntil'] },
                ]}, then: 'late' },
                { case: { $and: [
                  { $ne: ['$profile.lateUntil', null] },
                  { $gt: [currentYear, '$profile.lateUntil'] },
                ]}, then: 'declining' },
                { case: { $and: [
                  { $ne: ['$profile.peakUntil', null] },
                  { $gt: [currentYear, '$profile.peakUntil'] },
                  { $eq: ['$profile.lateFrom', null] },
                ]}, then: 'declining' },
                { case: { $and: [
                  { $ne: ['$profile.peakFrom', null] },
                  { $gte: [currentYear, '$profile.peakFrom'] },
                ]}, then: 'peak' },
              ],
              default: 'early',
            },
          },
        },
      },
    }},
    { $group: { _id: '$maturity', count: { $sum: 1 } } },
  ]);
  const maturity = { peak: 0, early: 0, late: 0, declining: 0, notReady: 0, noProfile: 0 };
  for (const m of maturityRaw) {
    if (m._id in maturity) maturity[m._id] = m.count;
  }
  const bottlesWithProfile = maturity.peak + maturity.early + maturity.late + maturity.declining + maturity.notReady;
  const maturityCoverage = pct(bottlesWithProfile, activeBottles);

  // ── Monthly trends (last 12 calendar months) ────────────────────────────
  const buildMonthlySeries = async (model, dateField, baseMatch = {}, extraMatch = {}) => {
    const since = new Date();
    since.setMonth(since.getMonth() - 11, 1);
    since.setHours(0, 0, 0, 0);
    const rows = await safeAggregate(model, [
      { $match: { ...baseMatch, [dateField]: { $gte: since }, ...extraMatch } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m', date: `$${dateField}` } },
        count: { $sum: 1 },
      }},
      { $sort: { _id: 1 } },
    ]);
    // Fill missing months with zero so the series is always exactly 12 entries.
    const series = [];
    const cursor = new Date(since);
    for (let i = 0; i < 12; i++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      const found = rows.find(r => r._id === key);
      series.push({ month: key, count: found ? found.count : 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return series;
  };

  const [trendBottlesAdded, trendBottlesConsumed, trendNewUsers, trendNewCellars] = await Promise.all([
    buildMonthlySeries(Bottle, 'createdAt',  bottleMatch),
    buildMonthlySeries(Bottle, 'consumedAt', bottleMatch, { status: { $ne: 'active' } }),
    buildMonthlySeries(User,   'createdAt',  userMatch),
    buildMonthlySeries(Cellar, 'createdAt',  cellarMatch),
  ]);

  // ── Registry size ──────────────────────────────────────────────────────
  // Shared reference data, deliberately unfiltered: the registry is one
  // catalogue for everyone rather than a per-user figure, so excluding a
  // cohort of accounts would not change what is in it.
  const totalWineDefinitions = await WineDefinition.countDocuments();

  // ── Assemble payload ────────────────────────────────────────────────────
  const avgBottlesPerUser = usersWithBottles > 0 ? Math.round(activeBottles / usersWithBottles) : 0;
  const avgBottlesPerCellar = totalCellars > 0 ? Math.round(activeBottles / totalCellars) : 0;
  const { cellarUsers, activationPct } = buildActivation({
    totalUsers,
    usersWithBottles,
    bridgeOnlyUsers: bridge.bridgeOnly,
  });

  return {
    generatedAt: new Date().toISOString(),
    excludeAdmins,
    adminsExcludedCount: excludeAdmins ? adminIds.length : 0,
    // What was left out of every figure above, so the totals can be explained
    // rather than merely trusted.
    excluded: {
      admins: excludeAdmins ? adminIds.length : 0,
      demo: demoCount,
      pendingDeletion: pendingDeletionCount,
    },
    // accounts  — everyone who accepted the Registry Data Terms
    // bridgeOnly — of those, the ones holding no bottle here
    // liveKeys / everConnected — installs connected now, and ever
    bridge,
    overview: {
      totalUsers,
      cellarUsers,
      activationPct,
      usersWithBottles,
      totalCellars,
      totalBottles,
      activeBottles,
      consumedBottles,
      drankBottles,
      giftedBottles,
      soldBottles,
      otherBottles,
      avgBottlesPerUser,
      avgBottlesPerCellar,
      totalWineDefinitions,
    },
    activity: {
      newUsers30,
      newUsers90,
      bottlesAdded30,
      bottlesAdded90,
      bottlesConsumed30,
      bottlesConsumed90,
    },
    engagement: {
      // Changed a cellar: added or consumed a bottle in the window.
      activeUsers24h,
      activeUsers7d,
      activeUsers30d,
      activeUsers90d,
      // Was here at all: signed in, or anything the audit log records. Bounded
      // by the audit TTL, which is why the window ships alongside — the 90-day
      // figure is the whole visible history, not a rolling quarter.
      present24h: presentWindows.w24h || 0,
      present7d:  presentWindows.w7d  || 0,
      present30d: presentWindows.w30d || 0,
      present90d: presentWindows.w90d || 0,
      presenceWindowDays: AUDIT_TTL_DAYS,
    },
    retention: {
      // Retroactive, activity-based (works across all history).
      returningUsers,
      coreUsers,
      singleSessionUsers,
      usersWithActivity: ret.usersWithActivity || 0,
      returningPct: pct(returningUsers, ret.usersWithActivity),
      corePct: pct(coreUsers, ret.usersWithActivity),
      // Full ladder: [{ days, users, pct }] for every DAY_TIERS threshold,
      // percentages over usersWithActivity.
      activityTiers,
      // "Of the people who signed up N weeks ago, how many used Cellarion in
      // the last 7 days." cohortReturnedPct covers the MATURE cohorts only —
      // the newest one cannot be asked, because its members are active in the
      // window by virtue of having signed up in it.
      signupCohorts,
      cohortWindowDays: COHORT_WINDOW_DAYS,
      cohortSignups: matureSignups,
      cohortReturned: matureReturned,
      cohortReturnedPct: pct(matureReturned, matureSignups),
      // The second ladder: days the user was PRESENT (signed in, or did
      // anything the audit log records) rather than days they changed a
      // cellar. Windowed by the audit TTL, which is why windowDays ships with
      // it — the page must say which question it is answering.
      presence: {
        usersSeen: pres.usersSeen || 0,
        returningUsers: pres.t2 || 0,
        coreUsers: pres.t4 || 0,
        returningPct: pct(pres.t2 || 0, pres.usersSeen),
        tiers: presenceTiers,
        windowDays: AUDIT_TTL_DAYS,
      },
    },
    plans: {
      distribution: planDistribution,
      paidUsers,
      expiringIn7d,
      expiringIn30d,
      withStripeCustomer,
      // Supporter signal the page was missing entirely (2026-08-21). The plan
      // distribution showed who pays TODAY and nothing else, so the two
      // questions worth asking had no answer: is anyone new, and did anyone
      // leave.
      //
      // formerSupporters is the churn number, and it is only visible because a
      // Stripe customer record outlives the subscription: 12 customers against
      // 4 paying users is 8 people who supported and stopped. Nothing else on
      // this page could have told you that.
      //
      // ⚠️ It is a FLOOR, not a count. A supporter who never reached Stripe
      // (comped, or granted by hand) leaves no customer record, and one who
      // resubscribes is counted as current, not as having churned.
      newSupporters30d,
      newSupporters90d,
      formerSupporters,
    },
    maturity: {
      ...maturity,
      bottlesWithProfile,
      coveragePct: maturityCoverage,
    },
    trends: {
      bottlesAdded:    trendBottlesAdded,
      bottlesConsumed: trendBottlesConsumed,
      newUsers:        trendNewUsers,
      newCellars:      trendNewCellars,
    },
  };
}

module.exports = {
  computeGlobalStats,
  // Exported for tests: the retention day-ladder and its two halves.
  __testing: {
    DAY_TIERS, tierAccumulators, tierRows,
    buildPlanDistribution, buildSignupCohorts, COHORT_WINDOW_DAYS, COHORT_SPAN_DAYS,
    buildBridgeSummary, buildActivation,
    buildPresencePipeline, buildPresenceWindowPipeline,
    SIGNIN_ACTIONS, MACHINE_ACTIONS, AUDIT_TTL_DAYS,
  },
};
