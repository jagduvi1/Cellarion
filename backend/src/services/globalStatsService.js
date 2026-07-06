const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineRequest = require('../models/WineRequest');
const BottleImage = require('../models/BottleImage');
const Rack = require('../models/Rack');
const AuditLog = require('../models/AuditLog');

// How far back the audit log retains entries (auth.login.success included).
// Login-based retention figures are bounded by this window. Mirrors the TTL in
// models/AuditLog.js so the UI can caption "within the last N days".
const AUDIT_WINDOW_DAYS = parseInt(process.env.AUDIT_TTL_DAYS || '90', 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const pct = (count, total) => total > 0 ? round((count / total) * 100, 1) : 0;

const safeAggregate = async (model, pipeline) => {
  try { return await model.aggregate(pipeline); }
  catch (err) {
    console.error(`Aggregate failed on ${model.modelName}:`, err.message);
    return [];
  }
};

// ── Main ─────────────────────────────────────────────────────────────────────

// ── In-memory cache ──────────────────────────────────────────────────────────
// ~20 aggregations per call against MongoDB, plus an in-memory median sort
// per currency. Admin-only traffic so the load is low, but caching keeps the
// page snappy and avoids hammering Mongo if an admin holds Cmd-R. TTL is
// short enough that the page never feels stale.
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();  // key: excludeAdmins flag ('true' | 'false') → { at, data }

/**
 * Compute platform-wide aggregate statistics across all users.
 * Returns an anonymised payload safe to surface to admins.
 *
 * @param {object}  [options]
 * @param {boolean} [options.excludeAdmins=true]
 *        When true (the default), all per-user data (bottles, cellars, user
 *        counts, plans, engagement, retention, image uploads, wine requests,
 *        racks) is filtered to exclude any user with the 'admin' role — so the
 *        dashboard reflects real customers, not our own test/admin accounts.
 *        Pass false explicitly to include admins.
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
  const since7d  = new Date(Date.now() - 7 * 86400000);

  // ── Admin-exclusion filters ─────────────────────────────────────────────
  // When excludeAdmins=true, we filter every per-user collection to drop
  // admin-owned data. For Rack (which has no `user` field — it belongs to a
  // Cellar that belongs to a User) we have to resolve the chain by first
  // collecting admin cellar IDs.
  let adminIds = [];
  let adminCellarIds = [];
  if (excludeAdmins) {
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    adminIds = admins.map(a => a._id);
    if (adminIds.length > 0) {
      adminCellarIds = await Cellar.find({ user: { $in: adminIds } }).distinct('_id');
    }
  }
  const userMatch     = excludeAdmins ? { roles: { $nin: ['admin'] } } : {};
  const bottleMatch   = excludeAdmins ? { user: { $nin: adminIds } }   : {};
  const cellarMatch   = excludeAdmins ? { user: { $nin: adminIds } }   : {};
  const imageMatch    = excludeAdmins ? { uploadedBy: { $nin: adminIds } } : {};
  const requestMatch  = excludeAdmins ? { user: { $nin: adminIds } }       : {};
  const rackMatch     = excludeAdmins ? { cellar: { $nin: adminCellarIds } } : {};

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

  // ── Country / region / grape / producer breakdowns ──────────────────────
  const topCountries = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $lookup: { from: 'countries', localField: 'wd.country', foreignField: '_id', as: 'country' } },
    { $unwind: { path: '$country', preserveNullAndEmptyArrays: true } },
    { $group: { _id: { name: '$country.name', code: '$country.code' }, count: { $sum: 1 } } },
    { $match: { '_id.name': { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id.name', code: '$_id.code', count: 1 } },
  ]);

  const topRegions = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $lookup: { from: 'regions', localField: 'wd.region', foreignField: '_id', as: 'region' } },
    { $unwind: { path: '$region', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$region.name', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id', count: 1 } },
  ]);

  const topGrapes = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $unwind: { path: '$wd.grapes', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'grapes', localField: 'wd.grapes', foreignField: '_id', as: 'grape' } },
    { $unwind: { path: '$grape', preserveNullAndEmptyArrays: true } },
    { $group: { _id: '$grape.name', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: '$_id', count: 1 } },
  ]);

  // Producer rollup — collapses minor casing/whitespace variants of the
  // same producer name (e.g. "Château Margaux " vs "château margaux") so
  // they rank as one entry. Keeps an example display spelling via $first.
  const topProducers = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $match: { 'wd.producer': { $ne: null } } },
    { $addFields: { producerKey: { $toLower: { $trim: { input: '$wd.producer' } } } } },
    { $group: { _id: '$producerKey', name: { $first: '$wd.producer' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
    { $project: { _id: 0, name: 1, count: 1 } },
  ]);

  // ── Wine types ──────────────────────────────────────────────────────────
  const byType = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $group: { _id: '$wd.type', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, type: '$_id', count: 1 } },
  ]);

  // ── Vintage stats ───────────────────────────────────────────────────────
  const vintageRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', vintage: { $nin: ['NV', null, ''] } } },
    { $addFields: { yr: { $convert: { input: '$vintage', to: 'int', onError: null, onNull: null } } } },
    { $match: { yr: { $gt: 1800, $lte: currentYear } } },
    { $group: {
      _id: null,
      avgAge:  { $avg: { $subtract: [currentYear, '$yr'] } },
      oldest:  { $min: '$yr' },
      newest:  { $max: '$yr' },
      count:   { $sum: 1 },
    }},
  ]);
  const vintage = vintageRaw[0] || { avgAge: null, oldest: null, newest: null, count: 0 };

  const byDecade = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', vintage: { $nin: ['NV', null, ''] } } },
    { $addFields: { yr: { $convert: { input: '$vintage', to: 'int', onError: null, onNull: null } } } },
    { $match: { yr: { $gt: 1800, $lte: currentYear } } },
    { $addFields: { decade: { $multiply: [{ $floor: { $divide: ['$yr', 10] } }, 10] } } },
    { $group: { _id: '$decade', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, decade: '$_id', count: 1 } },
  ]);

  // ── Price (grouped by currency — avoids cross-rate noise) ───────────────
  const priceByCurrency = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', price: { $gt: 0 } } },
    { $group: {
      _id: '$currency',
      count:      { $sum: 1 },
      avgPrice:   { $avg: '$price' },
      totalValue: { $sum: '$price' },
      maxPrice:   { $max: '$price' },
    }},
    { $sort: { count: -1 } },
    { $project: { _id: 0, currency: '$_id', count: 1, avgPrice: { $round: ['$avgPrice', 2] }, totalValue: { $round: ['$totalValue', 2] }, maxPrice: 1 } },
  ]);

  // ── Holding time (purchase → consumption) ───────────────────────────────
  // NOTE: $bucket OMITS empty buckets, so we map results by _id (the bucket's
  // lower boundary) rather than by array index — otherwise an empty middle
  // bucket would shift every label downward and silently mislabel real data.
  const HOLDING_BUCKETS = [
    { id: 0,      label: '<1yr'  },
    { id: 365,    label: '1–2yr' },
    { id: 730,    label: '2–5yr' },
    { id: 1825,   label: '5–10yr'},
    { id: 3650,   label: '10+yr' },
    { id: 'over', label: 'over'  },
  ];
  const holdingRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: { $ne: 'active' }, consumedAt: { $ne: null }, purchaseDate: { $ne: null } } },
    { $addFields: { daysHeld: { $divide: [{ $subtract: ['$consumedAt', '$purchaseDate'] }, 86400000] } } },
    { $bucket: {
      groupBy: '$daysHeld',
      boundaries: [0, 365, 730, 1825, 3650, 100000],
      default: 'over',
      output: { count: { $sum: 1 } },
    }},
  ]);
  const totalHeld = holdingRaw.reduce((s, h) => s + h.count, 0);
  const holdingTime = HOLDING_BUCKETS.map(({ id, label }) => {
    const row = holdingRaw.find(h => h._id === id);
    const count = row?.count || 0;
    return { bucket: label, count, pct: pct(count, totalHeld) };
  });

  // ── Bottle-size distribution ────────────────────────────────────────────
  // Bottle-size rollup — collapses minor variants of the same physical
  // size. Users have entered "750ml", "750ml (Standard)", and the CJK
  // fullwidth-paren "750ml（標準）" as three different strings; this
  // groups them into one entry. Pattern:
  //   1. Replace fullwidth '（' with ASCII '(' so the split below catches both
  //   2. Split on '(' and take the first piece (drops any "(...)" suffix)
  //   3. Trim + lowercase to canonicalise
  //   4. Keep the most popular original spelling as the display name via $first
  const byBottleSize = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active' } },
    { $addFields: {
      sizeKey: {
        $toLower: {
          $trim: {
            input: {
              $arrayElemAt: [
                { $split: [
                  { $replaceAll: { input: { $ifNull: ['$bottleSize', ''] }, find: '（', replacement: '(' } },
                  '(',
                ]},
                0,
              ],
            },
          },
        },
      },
    }},
    { $sort: { bottleSize: 1 } },  // deterministic $first pick for tie-breaks
    { $group: { _id: '$sizeKey', size: { $first: '$bottleSize' }, count: { $sum: 1 } } },
    { $match: { _id: { $ne: '' } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, size: 1, count: 1 } },
  ]);

  // ── Cellar-size distribution ────────────────────────────────────────────
  // Same _id-keyed mapping as holdingTime — defensive against empty buckets.
  const CELLAR_BUCKETS = [
    { id: 1,       label: '1–9'      },
    { id: 10,      label: '10–24'    },
    { id: 25,      label: '25–49'    },
    { id: 50,      label: '50–99'    },
    { id: 100,     label: '100–249'  },
    { id: 250,     label: '250–499'  },
    { id: 500,     label: '500+'     },
    { id: 'other', label: 'other'    },
  ];
  const bottlesPerCellar = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active' } },
    { $group: { _id: '$cellar', count: { $sum: 1 } } },
    { $bucket: {
      groupBy: '$count',
      boundaries: [1, 10, 25, 50, 100, 250, 500, 100000],
      default: 'other',
      output: { count: { $sum: 1 } },
    }},
  ]);
  const cellarSizeDistribution = CELLAR_BUCKETS.map(({ id, label }) => {
    const row = bottlesPerCellar.find(b => b._id === id);
    return { bucket: label, cellars: row?.count || 0 };
  });

  // ── Top wine definitions (most-collected wines) ─────────────────────────
  const topWines = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', wineDefinition: { $ne: null } } },
    { $group: { _id: '$wineDefinition', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'winedefinitions', localField: '_id', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $project: { _id: 0, name: '$wd.name', producer: '$wd.producer', type: '$wd.type', count: 1 } },
  ]);

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

  // ── Retention / returning users ──────────────────────────────────────────
  // "Returning" = a genuine repeat user, not a sign-up who poked around once.
  // Derived RETROACTIVELY from activity so it works across all history: a user
  // is returning if they added or consumed bottles on >=2 distinct calendar
  // days (4+ days = "core"/power users). Counting distinct days, not events, so
  // adding 50 bottles in one sitting still counts as a single session. The
  // login-based figures further below are derived from the audit log (no new
  // per-user field stored) and so are likewise retroactive — bounded only by
  // the audit TTL window. The activity metric is the headline because it spans
  // all history and isn't undercounted by long-lived refresh-token sessions.
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
      returningUsers:    { $sum: { $cond: [{ $gte: ['$activeDays', 2] }, 1, 0] } },
      // Power users: active on 4+ distinct days — a stickier engagement tier
      // (subset of returningUsers).
      coreUsers:         { $sum: { $cond: [{ $gte: ['$activeDays', 4] }, 1, 0] } },
    }},
  ]);
  const ret = returningRaw[0] || { usersWithActivity: 0, returningUsers: 0, coreUsers: 0 };
  const returningUsers = ret.returningUsers;
  const coreUsers = ret.coreUsers;
  const singleSessionUsers = Math.max(0, ret.usersWithActivity - returningUsers);

  // Login-based signals, derived from the AUDIT LOG (action 'auth.login.success')
  // rather than a per-user field — so we store NO new personal data for this
  // feature (data minimisation) and the numbers are retroactive. Login audit
  // entries record the user in `resource.id` (actor is anonymous at login time,
  // pre-auth). Bounded by the audit TTL (AUDIT_WINDOW_DAYS), so "repeat logins"
  // means within that window. Persistent refresh-token sessions don't re-hit
  // /login, so these undercount the most loyal users by design — the
  // activity-based metric above is the headline for exactly that reason.
  const loginAuditMatch = {
    action: 'auth.login.success',
    'resource.id': excludeAdmins && adminIds.length
      ? { $ne: null, $nin: adminIds }
      : { $ne: null },
  };
  const loginAgg = await safeAggregate(AuditLog, [
    { $match: loginAuditMatch },
    { $group: { _id: '$resource.id', logins: { $sum: 1 }, lastAt: { $max: '$timestamp' } } },
    { $group: {
      _id: null,
      loginUsers:       { $sum: 1 },
      repeatLoginUsers: { $sum: { $cond: [{ $gte: ['$logins', 2] }, 1, 0] } },
      loggedIn30d:      { $sum: { $cond: [{ $gte: ['$lastAt', since30] }, 1, 0] } },
      loggedIn7d:       { $sum: { $cond: [{ $gte: ['$lastAt', since7d] }, 1, 0] } },
    }},
  ]);
  const login = loginAgg[0] || { loginUsers: 0, repeatLoginUsers: 0, loggedIn30d: 0, loggedIn7d: 0 };

  // ── Plans / subscriptions ───────────────────────────────────────────────
  const planDistribution = await safeAggregate(User, [
    { $match: userMatch },
    { $group: { _id: '$plan', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, plan: '$_id', count: 1 } },
  ]);

  const in7d  = new Date(Date.now() + 7 * 86400000);
  const in30d = new Date(Date.now() + 30 * 86400000);
  const [paidUsers, expiringIn7d, expiringIn30d, withStripeCustomer] = await Promise.all([
    User.countDocuments({ ...userMatch, plan: { $ne: 'free' } }),
    User.countDocuments({ ...userMatch, planExpiresAt: { $gte: new Date(), $lte: in7d } }),
    User.countDocuments({ ...userMatch, planExpiresAt: { $gte: new Date(), $lte: in30d } }),
    User.countDocuments({ ...userMatch, stripeCustomerId: { $ne: null } }),
  ]);

  // ── Maturity (drink-window phase distribution) ──────────────────────────
  // Joins active bottles to reviewed WineVintageProfile and classifies each
  // bottle against the current year. NV bottles are EXCLUDED up front (same
  // filter as the vintage aggregations above): their reviewed profiles store
  // RELATIVE offsets from each bottle's purchase year (0–100), which cannot
  // be compared against absolute calendar years — including them misclassified
  // every somm-reviewed NV bottle as 'declining'. Bottles without a reviewed
  // profile fall into 'noProfile'.
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
        // Mirror utils/maturityUtils.js#classifyMaturity exactly:
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

  // ── Ratings ─────────────────────────────────────────────────────────────
  // Normalize all ratings to 0–100 (5-star * 20, 20-pt Davis * 5, 100-pt as-is).
  const normRatingExpr = {
    $switch: {
      branches: [
        { case: { $eq: ['$ratingScale', '5']   }, then: { $multiply: ['$rating', 20] } },
        { case: { $eq: ['$ratingScale', '20']  }, then: { $multiply: ['$rating', 5]  } },
        { case: { $eq: ['$ratingScale', '100'] }, then: '$rating' },
      ],
      default: { $multiply: ['$rating', 20] },
    },
  };

  const [ratingOverallRaw, ratingDistRaw, ratingByTypeRaw] = await Promise.all([
    safeAggregate(Bottle, [
      { $match: { ...bottleMatch, rating: { $ne: null, $gt: 0 } } },
      { $addFields: { norm: normRatingExpr } },
      { $group: { _id: null, avg: { $avg: '$norm' }, count: { $sum: 1 } } },
    ]),
    safeAggregate(Bottle, [
      { $match: { ...bottleMatch, rating: { $ne: null, $gt: 0 } } },
      { $addFields: { norm: normRatingExpr } },
      { $bucket: {
        groupBy: '$norm',
        boundaries: [0, 20, 40, 60, 80, 101],
        default: 'other',
        output: { count: { $sum: 1 } },
      }},
    ]),
    safeAggregate(Bottle, [
      { $match: { ...bottleMatch, rating: { $ne: null, $gt: 0 }, wineDefinition: { $ne: null } } },
      { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
      { $unwind: '$wd' },
      { $addFields: { norm: normRatingExpr } },
      { $group: { _id: '$wd.type', avg: { $avg: '$norm' }, count: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, type: '$_id', avg: { $round: ['$avg', 1] }, count: 1 } },
    ]),
  ]);

  const ratingOverall = ratingOverallRaw[0] || { avg: null, count: 0 };
  // Map by lower-boundary _id rather than array index — $bucket omits empty
  // buckets, so an empty middle band would otherwise mislabel everything.
  const RATING_BUCKETS = [
    { id: 0,  band: '0–20'   },
    { id: 20, band: '21–40'  },
    { id: 40, band: '41–60'  },
    { id: 60, band: '61–80'  },
    { id: 80, band: '81–100' },
  ];
  const totalRated = ratingDistRaw.reduce((s, r) => s + r.count, 0);
  const ratingDistribution = RATING_BUCKETS.map(({ id, band }) => {
    const row = ratingDistRaw.find(r => r._id === id);
    const count = row?.count || 0;
    return { band, count, pct: pct(count, totalRated) };
  });

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

  // ── Most expensive bottles ──────────────────────────────────────────────
  // On platforms with very few users, showing the wine + producer + vintage
  // of the single most expensive bottle could let one user infer it's theirs
  // (or someone else's). When the user base is small we band the price and
  // suppress the identifying fields. Threshold matches the same guard used
  // for the "anonymised aggregate" framing on the blog data piece.
  const EXPENSIVE_REDACT_THRESHOLD_USERS = 25;
  const shouldRedactExpensive = usersWithBottles < EXPENSIVE_REDACT_THRESHOLD_USERS;
  const topExpensiveBottlesRaw = await safeAggregate(Bottle, [
    { $match: { ...bottleMatch, status: 'active', price: { $gt: 0 }, wineDefinition: { $ne: null } } },
    { $sort: { price: -1 } },
    { $limit: 10 },
    { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
    { $unwind: '$wd' },
    { $project: {
      _id: 0,
      name:     '$wd.name',
      producer: '$wd.producer',
      vintage:  1,
      price:    1,
      currency: 1,
    }},
  ]);
  const topExpensiveBottles = topExpensiveBottlesRaw.map(b => shouldRedactExpensive
    ? { name: null, producer: null, vintage: null, price: b.price, currency: b.currency, redacted: true }
    : { ...b, redacted: false }
  );

  // ── Library health ──────────────────────────────────────────────────────
  // WineDefinition + WineVintageProfile are shared platform reference data
  // (admin-curated by design), so they remain unfiltered. Racks belong to
  // cellars which belong to users, so they DO honour excludeAdmins via
  // rackMatch (resolved earlier via the admin cellar IDs).
  const [
    totalRacks,
    profilesTotal,
    profilesReviewed,
    profilesPending,
    pendingWineRequests,
    pendingImageReviews,
    totalImages,
    wineDefinitionsWithBottles,
    totalWineDefinitions,
  ] = await Promise.all([
    Rack.countDocuments(rackMatch),
    WineVintageProfile.countDocuments(),
    WineVintageProfile.countDocuments({ status: 'reviewed' }),
    WineVintageProfile.countDocuments({ status: 'pending' }),
    WineRequest.countDocuments({ ...requestMatch, status: 'pending' }),
    BottleImage.countDocuments({ ...imageMatch, status: { $in: ['uploaded', 'processing', 'processed'] } }),
    BottleImage.countDocuments(imageMatch),
    Bottle.distinct('wineDefinition', bottleMatch).then(ids => ids.filter(Boolean).length),
    WineDefinition.countDocuments(),
  ]);

  // ── Median bottle price per currency (in-memory percentile) ─────────────
  // Mongo $percentile needs 7.0+; safer to compute from a small sorted list.
  const priceByCurrencyWithMedian = await Promise.all(priceByCurrency.map(async (p) => {
    const prices = await Bottle.find({ ...bottleMatch, status: 'active', price: { $gt: 0 }, currency: p.currency })
      .select('price').sort({ price: 1 }).lean();
    const median = prices.length
      ? prices[Math.floor(prices.length / 2)].price
      : null;
    return { ...p, medianPrice: median };
  }));

  // ── Assemble payload ────────────────────────────────────────────────────
  const avgBottlesPerUser = usersWithBottles > 0 ? Math.round(activeBottles / usersWithBottles) : 0;
  const avgBottlesPerCellar = totalCellars > 0 ? Math.round(activeBottles / totalCellars) : 0;

  return {
    generatedAt: new Date().toISOString(),
    excludeAdmins,
    adminsExcludedCount: excludeAdmins ? adminIds.length : 0,
    overview: {
      totalUsers,
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
      activeUsers24h,
      activeUsers7d,
      activeUsers30d,
      activeUsers90d,
    },
    retention: {
      // Retroactive, activity-based (works across all history).
      returningUsers,
      coreUsers,
      singleSessionUsers,
      usersWithActivity: ret.usersWithActivity,
      returningPct: pct(returningUsers, ret.usersWithActivity),
      corePct: pct(coreUsers, ret.usersWithActivity),
      // Login-based, from the audit log — bounded by the audit TTL window.
      // null when the TTL is disabled (AUDIT_TTL_DAYS<=0): the audit log is then
      // retained indefinitely, so the figures cover all recorded history.
      loginWindowDays:  AUDIT_WINDOW_DAYS > 0 ? AUDIT_WINDOW_DAYS : null,
      loginUsers:       login.loginUsers,
      repeatLoginUsers: login.repeatLoginUsers,
      loggedIn30d:      login.loggedIn30d,
      loggedIn7d:       login.loggedIn7d,
    },
    plans: {
      distribution: planDistribution,
      paidUsers,
      expiringIn7d,
      expiringIn30d,
      withStripeCustomer,
    },
    maturity: {
      ...maturity,
      bottlesWithProfile,
      coveragePct: maturityCoverage,
    },
    ratings: {
      avgNormalized: ratingOverall.avg != null ? round(ratingOverall.avg, 1) : null,
      ratedCount:    ratingOverall.count,
      distribution:  ratingDistribution,
      byType:        ratingByTypeRaw,
    },
    vintage: {
      avgAge: vintage.avgAge != null ? Math.round(vintage.avgAge) : null,
      oldest: vintage.oldest,
      newest: vintage.newest,
      withVintageCount: vintage.count,
      byDecade,
    },
    trends: {
      bottlesAdded:    trendBottlesAdded,
      bottlesConsumed: trendBottlesConsumed,
      newUsers:        trendNewUsers,
      newCellars:      trendNewCellars,
    },
    library: {
      totalWineDefinitions,
      wineDefinitionsWithBottles,
      profilesTotal,
      profilesReviewed,
      profilesPending,
      pendingWineRequests,
      pendingImageReviews,
      totalImages,
      totalRacks,
    },
    byType,
    topCountries,
    topRegions,
    topGrapes,
    topProducers,
    topWines,
    topExpensiveBottles,
    priceByCurrency: priceByCurrencyWithMedian,
    holdingTime,
    byBottleSize,
    cellarSizeDistribution,
  };
}

module.exports = { computeGlobalStats };
