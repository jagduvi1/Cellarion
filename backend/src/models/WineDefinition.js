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
    model:        { type: String, default: null, trim: true }, // model that produced it
    generatedAt:  { type: Date,   default: null },             // when it was generated
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

// Keep canonicalKey in sync with the identity fields. pre-validate (not
// pre-save) so plain doc.validate() computes it too. Covers every save-based
// write path (create, admin PUT rename, strip-producer); scripted updateOne
// callers must set it themselves (backfill-canonical-key.js does).
wineDefinitionSchema.pre('validate', function(next) {
  if (!this.canonicalKey || this.isModified('name') || this.isModified('producer') || this.isModified('appellation')) {
    this.canonicalKey = computeCanonicalKey(this.name, this.producer, this.appellation);
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
