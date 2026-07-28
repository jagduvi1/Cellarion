const mongoose = require('mongoose');
const { generateWineSlug } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const wineDefinitionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Wine name is required'],
    trim: true,
    index: true
  },
  producer: {
    type: String,
    required: [true, 'Producer is required'],
    trim: true,
    index: true
  },
  productNumber: {
    type: String,
    trim: true,
    sparse: true,
    index: true
  },
  productNumberShort: {
    type: String,
    trim: true,
    sparse: true,
    index: true
  },
  country: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Country',
    required: [true, 'Country is required'],
    index: true
  },
  region: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Region',
    default: null,
    index: true
  },
  appellation: {
    type: String,
    trim: true
  },
  classification: {
    type: String,
    trim: true,
    default: null
  },
  lwin: {
    lwin7: {
      type: String,
      trim: true,
      sparse: true,
      index: true
    }
  },
  grapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Grape'
  }],
  type: {
    type: String,
    enum: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
    default: 'red'
  },
  image: {
    type: String,
    default: null
  },
  imageCredit: {
    type: String,
    default: null,
    trim: true
  },
  communityRating: {
    averageNormalized: {
      type: Number,
      default: null
    },
    reviewCount: {
      type: Number,
      default: 0
    }
  },
  // AI-generated tasting/style profile. Vintage-neutral (describes the wine's
  // general character). Produced by the enrichment job (services/enrichmentJob.js)
  // via Claude. Used two ways: (1) the structured descriptors are folded into the
  // embedding text (services/embedding.js) so similarity search understands taste,
  // not just identity; (2) `description` is shown on the bottle page. Clearly
  // labelled AI-generated in the UI and gated on confidence.
  aiProfile: {
    body:         { type: String, default: null, trim: true },  // light | medium | full
    tannin:       { type: String, default: null, trim: true },  // low | medium | high (reds)
    acidity:      { type: String, default: null, trim: true },  // low | medium | high
    sweetness:    { type: String, default: null, trim: true },  // dry | off-dry | sweet
    flavors:      { type: [String], default: [] },              // e.g. ['dark cherry', 'tar']
    foodPairings: { type: [String], default: [] },              // e.g. ['braised beef']
    description:  { type: String, default: null, trim: true },  // short PLAIN-TEXT prose; markdown stripped at write (enrichmentJob)
    confidence:   { type: Number, default: null },             // 0..1 — how sure the AI is
    // The model's doubt about the producer FIELD itself — set true when it
    // recognises the "producer" as a range/brand of another house, a place,
    // a retailer or a label term ("Arcane" = Xavier Vignon's range — the row
    // every string gate and 49 audit agents missed). producerNote carries the
    // suggested real producer when the model is sure of it. Feeds the admin
    // low-confidence review queue; never shown to end users.
    producerSuspect: { type: Boolean, default: false },
    producerNote:    { type: String,  default: null, trim: true },
    model:        { type: String, default: null, trim: true }, // model that produced it
    generatedAt:  { type: Date,   default: null },             // when it was generated
    // Provenance. 'ai' = written by enrichmentJob; 'curator' = a sommelier or
    // admin corrected it by hand (routes/somm/wineProfile.js or the MCP
    // set_wine_profile tool). The distinction is load-bearing, not cosmetic:
    // enrichmentJob's FULL mode re-generates every wine and would otherwise
    // overwrite the correction, so it filters curator rows out. (Incremental
    // mode was already safe — it only picks up rows with a null description.)
    // Support ticket 2026-07-28: the generator emits confident fiction on
    // wines it only half-knows, and a curator researching a drink window is
    // the person best placed to fix it, so curation is the upgrade path.
    source:       { type: String, default: 'ai', enum: ['ai', 'curator'] },
    verifiedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt:   { type: Date, default: null },
  },
  // When an admin last reviewed this wine in the low-confidence queue and
  // judged its data correct. The clearance is SELF-INVALIDATING by comparison,
  // not by hook: the queue shows rows where profileReviewedAt is null OR older
  // than aiProfile.generatedAt — so a re-enriched wine (new profile, new
  // doubt) re-surfaces automatically, and nothing needs to watch field edits
  // (editing the wine re-enriches → new generatedAt → re-surfaces if still
  // low-confidence). Deliberately NOT part of verifiedChecks: that record is
  // scoped to name+producer string rules its pre-validate hook can fully
  // invalidate; this one's verdict lives in aiProfile, which the hook must
  // not watch (see the verifiedChecks scope rule above).
  profileReviewedAt: {
    type: Date,
    default: null
  },
  // Normalized key for deduplication
  normalizedKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Canonical identity for duplicate PREVENTION (utils/wineIdentity.js):
  // collapses producer variants, producer-in-name embeds and appellation
  // tiers. Deliberately NON-unique — distinct wineries can share a key
  // (Domaine vs Bodegas Chandon); collisions feed the admin review queue.
  // Maintained by the pre-validate hook; null only on rows predating the
  // field that haven't been saved or backfilled yet.
  canonicalKey: {
    type: String,
    index: true,
    default: null
  },
  // Vintage-neutral, human-readable slug used in public URLs (/wines/:slug).
  // Sparse so older docs without a slug don't violate the unique index until
  // the migration runs. Once set, never auto-regenerated on rename — URLs are
  // stable forever; renames must be a deliberate admin action.
  slug: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Provenance: which surface minted this registry entry ('mcp' = a connected
  // AI via the MCP write tools). Lets admins review AI-created wines as a
  // class (registry-integrity plan §5.1). null for rows predating the field
  // and for surfaces that haven't adopted it yet; actor detail stays in
  // AuditLog (wine.create).
  createdVia: {
    type: String,
    enum: ['ui', 'import', 'mcp', 'ai', null],
    default: null
  },
  // Non-wine quarantine (registry audit 2026-07-26; policy decided by Johan:
  // KEEP, HIDE). Spirits/cider/sake rows imported by users stay in the
  // registry — their owners' bottles keep working, direct wine pages render —
  // but flagged rows are excluded from the Meilisearch index (registry
  // search + type facets), public taxonomy/OG/sitemap listings, and the
  // admin duplicate-scan pools. Exact-key resolution still matches them, so
  // re-adding the same bottle attaches instead of minting a twin. Toggled via
  // POST /api/admin/wines/:id/non-wine (admin only, audited).
  nonWine: {
    type: Boolean,
    default: false
  },
  // Human data-quality review (support ticket 2026-07-26): the registry's
  // false-positive whitelist AND its skip-on-rescan record. Each entry is a
  // RULE ID from utils/nameChecks.js that an admin has read this wine and
  // confirmed it passes — deliberately NOT a bare `verified` boolean: a rule
  // id nobody has cleared appears in no wine's array, so a NEW rule (or a
  // REFINED one, whose id is bumped in the same commit) surfaces all ~4.3k
  // rows by construction, where a bare flag would have silently suppressed
  // every rule added after it was set.
  //
  // Cleared automatically when `name` or `producer` changes (pre-validate hook
  // below). SCOPE RULE: only a rule whose verdict reads NOTHING but
  // name + producer may consult this field — a rule reading country/region/
  // grapes must check the taxonomy collections instead (renaming a Country
  // writes nothing here, so no hook could ever invalidate it).
  //
  // Absent on rows predating the field; .lean() applies no defaults, so reads
  // treat undefined as "nothing cleared" (also why no backfill is needed).
  // Never bulk-set from a script — a machine asserting human review is what
  // would make the record worthless.
  verifiedChecks: {
    type: [String],
    default: undefined
  },
  // When the most recent clearance above was recorded. DISPLAY AND FORENSICS
  // ONLY — never filter a scan on this: suppression is always per rule id, so
  // a rule added tomorrow can't be pre-cleared by a timestamp set against
  // yesterday's rule set. null on rows never reviewed.
  verifiedAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Text index for search
wineDefinitionSchema.index({ name: 'text', producer: 'text' });

// Compound indexes for common filter combinations
wineDefinitionSchema.index({ country: 1, type: 1 });
wineDefinitionSchema.index({ country: 1, region: 1 });
wineDefinitionSchema.index({ type: 1, createdAt: -1 });

// Public taxonomy discovery pages filter by one taxon and sort by name —
// without these, mongod blocking-sorts every matching wine per page view.
// The grapes index is multikey; its prefix also serves the taxonomy
// count queries ({ grapes: id }).
wineDefinitionSchema.index({ country: 1, name: 1 });
wineDefinitionSchema.index({ region: 1, name: 1 });
wineDefinitionSchema.index({ grapes: 1, name: 1 });
wineDefinitionSchema.index({ type: 1, name: 1 });

// Update timestamp on save
wineDefinitionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Keep canonicalKey in sync with the identity fields, and drop the human-review
// record when the reviewed strings change. pre-validate (not pre-save) so plain
// doc.validate() computes it too. Covers every save-based write path (create,
// admin PUT rename, strip-producer); scripted updateOne callers must set
// canonicalKey themselves (backfill-canonical-key.js does).
//
// verifiedChecks/verifiedAt watch ONLY name + producer, and unlike canonicalKey
// they have NO scripted-caller blind spot: enumerated 2026-07-26, no updateOne/
// updateMany/bulkWrite/findByIdAndUpdate caller in the codebase mutates either
// field on an existing row (admin LWIN import wraps both in $ifNull, so it can
// only fill them on upsert-insert).
wineDefinitionSchema.pre('validate', function(next) {
  if (!this.canonicalKey || this.isModified('name') || this.isModified('producer') || this.isModified('appellation')) {
    this.canonicalKey = computeCanonicalKey(this.name, this.producer, this.appellation);
  }
  // !isNew: on a create both fields count as "modified" and the defaults are
  // already empty — being explicit keeps a future born-verified admin-create
  // flow from being silently undone here.
  if (!this.isNew && (this.isModified('name') || this.isModified('producer'))) {
    this.verifiedChecks = undefined;
    this.verifiedAt = null;
  }
  next();
});

// Auto-generate slug for new wines when missing. On collision the caller (the
// findOrCreateWine flow) appends a -2/-3 suffix; the migration script does the
// same when backfilling. Existing slugs are never overwritten — URL stability.
wineDefinitionSchema.pre('save', async function(next) {
  if (this.slug || !this.isNew) return next();
  const base = generateWineSlug(this.name, this.producer);
  if (!base) return next();
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const collision = await this.constructor.findOne({ slug: candidate }).select('_id').lean();
    if (!collision) break;
    candidate = `${base}-${i}`;
  }
  this.slug = candidate;
  next();
});

module.exports = mongoose.model('WineDefinition', wineDefinitionSchema);
