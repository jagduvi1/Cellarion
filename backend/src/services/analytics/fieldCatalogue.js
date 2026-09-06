/**
 * The analytics field catalogue (#987 Phase 0).
 *
 * Every analysable attribute is declared here EXACTLY ONCE; the query engine,
 * the /api/analytics/catalogue endpoint, the table's column picker and the
 * CSV export all read this single declaration. A new attribute becomes
 * available on every surface the moment it is declared — that property is the
 * entire reason the catalogue exists, so never special-case a field in a
 * consumer that this file could describe instead.
 *
 * Shape of an entry:
 *   key          stable id ('wine.producer', 'personal.<keyId>') — the wire name
 *   label        English display name (frontend may i18n-override by key)
 *   domain       grouping for the column picker
 *   type         personalDataTypes TYPES ('text'|'integer'|'decimal'|'boolean'|'date'|'enum')
 *   unit         display unit ('currency' is special: converted per query)
 *   role         'dimension' | 'measure' | 'both'
 *   aggregations measures only: subset of count|sum|avg|min|max
 *   sortable     server-side sortable in rows mode (KV + computed fields are
 *                honestly false until the $lookup work in R-B)
 *   groupable    usable as a grouped-mode dimension
 *   filterable   accepts filters (nearly everything)
 *   enumOptions  enum type only
 *   source       'bottle'   — a plain path on Bottle
 *                'wine'     — a path on the joined WineDefinition
 *                'taxonomy' — a ref on WineDefinition resolved by name
 *                             (taxonomyModel names the collection)
 *                'computed' — derived per page row after hydration
 *                'personal' | 'registry' — typed key/value (dynamic entries)
 *   path         the Mongo path the source reads ('wd.' prefix = joined wine)
 *
 * Dynamic domains: composeCatalogue(userId) appends the caller's own
 * PersonalDataKeys and the ACCEPTED RegistryDataKeys. Their `key` embeds the
 * Mongo id ('personal.6a…', 'registry.6a…'), which is stable, collision-free
 * and needs no name-slug rules.
 */

const PersonalDataKey = require('../../models/PersonalDataKey');
const RegistryDataKey = require('../../models/RegistryDataKey');

// Filter operators per type — the whitelist the engine enforces. 'between'
// is compiled as gte+lte; 'in' takes an array of enum options. The FIRST op
// is what the filter builder preselects, so text leads with 'contains': a
// typed producer filter should find "Gaja" by "gaj", not demand the exact
// name (support ticket 2026-09-05).
const OPS_BY_TYPE = {
  text: ['contains', 'eq', 'neq'],
  integer: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  decimal: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  boolean: ['eq'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  enum: ['eq', 'neq', 'in'],
};

const dim = (over) => ({ role: 'dimension', aggregations: [], sortable: true, groupable: true, filterable: true, unit: null, enumOptions: undefined, ...over });
const measure = (over) => ({ role: 'measure', aggregations: ['count', 'sum', 'avg', 'min', 'max'], sortable: true, groupable: false, filterable: true, unit: null, enumOptions: undefined, ...over });

// ── The static core ────────────────────────────────────────────────────────
const STATIC_FIELDS = [
  // Wine identity (joined from WineDefinition — 'wd.' paths)
  dim({ key: 'wine.producer', label: 'Producer', domain: 'wine', type: 'text', source: 'wine', path: 'wd.producer' }),
  dim({ key: 'wine.name', label: 'Wine name', domain: 'wine', type: 'text', source: 'wine', path: 'wd.name' }),
  dim({ key: 'wine.type', label: 'Wine type', domain: 'wine', type: 'enum', source: 'wine', path: 'wd.type', enumOptions: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'] }),
  dim({ key: 'wine.appellation', label: 'Appellation', domain: 'wine', type: 'text', source: 'wine', path: 'wd.appellation' }),
  dim({ key: 'wine.classification', label: 'Classification', domain: 'wine', type: 'text', source: 'wine', path: 'wd.classification' }),
  // Taxonomy refs: the stored value is an ObjectId; sorting joins the name
  // (R-B). Filters resolve the typed name to ids first. taxonomyCollection is
  // the raw collection name the sort $lookup reads.
  dim({ key: 'wine.country', label: 'Country', domain: 'wine', type: 'text', source: 'taxonomy', path: 'wd.country', taxonomyModel: 'Country', taxonomyCollection: 'countries' }),
  dim({ key: 'wine.region', label: 'Region', domain: 'wine', type: 'text', source: 'taxonomy', path: 'wd.region', taxonomyModel: 'Region', taxonomyCollection: 'regions' }),
  // Grapes is an ARRAY ref — a filter means "has this grape". Neither sortable
  // nor groupable: $group on an array keys buckets by the whole combination
  // ("[Grenache, Syrah]" ≠ "Grenache"), which reads as data and lies. Per-grape
  // grouping needs an $unwind stage — a later slice, honestly flagged out.
  dim({ key: 'wine.grapes', label: 'Grapes', domain: 'wine', type: 'text', source: 'taxonomy', path: 'wd.grapes', taxonomyModel: 'Grape', sortable: false, groupable: false }),

  // Inventory
  dim({ key: 'bottle.vintage', label: 'Vintage', domain: 'inventory', type: 'text', source: 'bottle', path: 'vintage' }),
  dim({ key: 'bottle.size', label: 'Bottle size', domain: 'inventory', type: 'text', source: 'bottle', path: 'bottleSize' }),
  dim({ key: 'bottle.status', label: 'Status', domain: 'inventory', type: 'enum', source: 'bottle', path: 'status', enumOptions: ['active', 'drank', 'gifted', 'sold', 'other'] }),
  dim({ key: 'bottle.cellar', label: 'Cellar', domain: 'inventory', type: 'text', source: 'computed', path: 'cellar', sortable: false, groupable: true }),
  dim({ key: 'bottle.location', label: 'Rack location', domain: 'inventory', type: 'text', source: 'bottle', path: 'location' }),
  dim({ key: 'bottle.occasion', label: 'Occasion note', domain: 'inventory', type: 'text', source: 'bottle', path: 'occasion' }),
  dim({ key: 'bottle.reservedFor', label: 'Reserved for', domain: 'inventory', type: 'text', source: 'bottle', path: 'reservedFor' }),
  // Date fields are not groupable (audit 2026-08-19 F9): without calendar
  // bucketing, $group on a timestamp makes one bucket per bottle — 200 rows
  // of count:1 is a wall, not an answer. Month bucketing is the dashboards
  // slice's problem; until then the flag is honest.
  dim({ key: 'bottle.addedAt', label: 'Date added', domain: 'inventory', type: 'date', source: 'bottle', path: 'createdAt', groupable: false }),

  // Purchase
  measure({ key: 'purchase.price', label: 'Price', domain: 'purchase', type: 'decimal', unit: 'currency', source: 'bottle', path: 'price', aggregations: ['sum', 'avg', 'min', 'max'] }),
  dim({ key: 'purchase.currency', label: 'Currency', domain: 'purchase', type: 'text', source: 'bottle', path: 'currency' }),
  dim({ key: 'purchase.date', label: 'Purchase date', domain: 'purchase', type: 'date', source: 'bottle', path: 'purchaseDate', groupable: false }),
  dim({ key: 'purchase.location', label: 'Purchase location', domain: 'purchase', type: 'text', source: 'bottle', path: 'purchaseLocation' }),

  // Ratings live in ONE scale everywhere on this surface: stars (audit
  // 2026-08-19 F3). Values are stored per-bottle in '5'/'20'/'100' scales —
  // mixed after imports — so raw filter/sort/display made a 60-point Parker
  // outrank a 5-star bottle. Filters take stars, sort orders by the
  // star-converted expression, hydration returns stars, grouped measures
  // aggregate stars — all generated from the same ratingUtils anchor table.
  measure({ key: 'rating.current', label: 'My rating (stars)', domain: 'rating', type: 'decimal', source: 'bottle', path: 'rating', scalePath: 'ratingScale', normalized: true, aggregations: ['avg', 'min', 'max'] }),
  measure({ key: 'rating.consumed', label: 'Rating at consumption (stars)', domain: 'rating', type: 'decimal', source: 'bottle', path: 'consumedRating', scalePath: 'consumedRatingScale', normalized: true, aggregations: ['avg', 'min', 'max'] }),

  // Consumption
  dim({ key: 'consumption.date', label: 'Consumed date', domain: 'consumption', type: 'date', source: 'bottle', path: 'consumedAt', groupable: false }),
  dim({ key: 'consumption.reason', label: 'Consumed reason', domain: 'consumption', type: 'enum', source: 'bottle', path: 'consumedReason', enumOptions: ['drank', 'gifted', 'sold', 'other'] }),

  // Open bottles
  dim({ key: 'open.openedAt', label: 'Opened date', domain: 'open', type: 'date', source: 'bottle', path: 'openedAt', groupable: false }),
  dim({ key: 'open.preservation', label: 'Preservation', domain: 'open', type: 'enum', source: 'bottle', path: 'preservationMethod', enumOptions: ['coravin', 'inert-gas', 'vacuum', 'sparkling-stopper', 'recorked'] }),

  // Maturity — the user's own per-bottle window (integers, filter/sortable);
  // the derived drink status is computed per hydrated row and says so.
  dim({ key: 'maturity.drinkFrom', label: 'Drink from (year)', domain: 'maturity', type: 'integer', source: 'bottle', path: 'drinkFrom' }),
  dim({ key: 'maturity.drinkTo', label: 'Drink to (year)', domain: 'maturity', type: 'integer', source: 'bottle', path: 'drinkTo' }),
  // enumOptions mirror what classifyMaturity actually returns (audit F7) —
  // 'unknown' is this module's own fallback for rows with no window at all.
  dim({ key: 'maturity.status', label: 'Drink status', domain: 'maturity', type: 'enum', source: 'computed', path: null, sortable: false, groupable: false, filterable: false, enumOptions: ['not-ready', 'early', 'peak', 'late', 'declining', 'unknown'] }),
];

const STATIC_BY_KEY = new Map(STATIC_FIELDS.map((f) => [f.key, f]));

const KV_ID_RX = /^(personal|registry)\.([0-9a-f]{24})$/;

/** A dynamic KV key document → catalogue entry. */
function kvEntry(kind, doc) {
  const numeric = doc.type === 'integer' || doc.type === 'decimal';
  return {
    key: `${kind}.${String(doc._id)}`,
    label: doc.name,
    domain: kind, // 'personal' | 'registry'
    type: doc.type,
    unit: doc.unit || null,
    role: numeric ? 'both' : 'dimension',
    aggregations: numeric ? ['avg', 'min', 'max', 'sum'] : [],
    // Sort and non-numeric grouping join the entries collection (R-B).
    // Numeric KV stays measure-only as a dimension: every distinct reading
    // would be its own bucket — a wall, not an answer.
    sortable: true,
    groupable: !numeric,
    filterable: true,
    enumOptions: doc.enumOptions || undefined,
    source: kind,
    keyId: String(doc._id),
    keyDoc: { type: doc.type, enumOptions: doc.enumOptions || undefined },
  };
}

/**
 * The full catalogue for one caller: static core + their own personal keys +
 * the accepted public vocabulary. Two indexed queries; callers are expected
 * to hit this per page-load, not per keystroke.
 */
async function composeCatalogue(userId) {
  const [personalKeys, registryKeys] = await Promise.all([
    PersonalDataKey.find({ user: userId }).sort({ nameKey: 1 }).lean(),
    RegistryDataKey.find({ status: 'accepted' }).sort({ nameKey: 1 }).lean(),
  ]);
  return [
    ...STATIC_FIELDS,
    ...personalKeys.map((k) => kvEntry('personal', k)),
    ...registryKeys.map((k) => kvEntry('registry', k)),
  ];
}

/**
 * Resolve one field key for the engine. Static keys come from the map; KV
 * keys are fetched and OWNERSHIP-CHECKED (a personal key must belong to the
 * caller — another user's key id in a request resolves to null, exactly like
 * a key that does not exist).
 */
async function resolveField(key, userId) {
  if (typeof key !== 'string') return null;
  const staticHit = STATIC_BY_KEY.get(key);
  if (staticHit) return staticHit;
  const m = KV_ID_RX.exec(key);
  if (!m) return null;
  if (m[1] === 'personal') {
    const doc = await PersonalDataKey.findOne({ _id: m[2], user: userId }).lean();
    return doc ? kvEntry('personal', doc) : null;
  }
  const doc = await RegistryDataKey.findOne({ _id: m[2], status: 'accepted' }).lean();
  return doc ? kvEntry('registry', doc) : null;
}

function opsForType(type) {
  return OPS_BY_TYPE[type] || [];
}

module.exports = { STATIC_FIELDS, composeCatalogue, resolveField, opsForType, OPS_BY_TYPE };
