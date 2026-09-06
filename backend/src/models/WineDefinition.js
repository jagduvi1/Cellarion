const crypto = require('crypto');
const mongoose = require('mongoose');
const { generateWineSlug, isIdentitySentinel, isImplausibleIdentity } = require('../utils/normalize');
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
    // Conditionally required: a pendingIdentity row is EXACTLY the row whose
    // producer could not be established, and it stores '' (see the field note
    // on pendingIdentity below). Every other row keeps the hard requirement,
    // so no ordinary write path can drop a producer by accident.
    required: [function () { return this.pendingIdentity !== true; }, 'Producer is required'],
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
    // NO default (somm ticket 6a85ad44, HIGH): defaulting to 'red' stamped
    // every thin-data mint as a red wine — 4/4 in one import burst were
    // white, and the wrong type drives filtering, serving guidance and
    // drink-window shape. Unknown colour is stored as ABSENT; a null prompts
    // a curator to look, a wrong value closes the question.
    type: String,
    enum: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
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
    // The model recognises the producer as a REAL winery name but cannot
    // place it — so the profile is an appellation-level estimate rather than
    // knowledge of that house. Split out of producerSuspect on 2026-08-17.
    //
    // The two were one flag, and that conflated "this field is wrong"
    // (Fabelhaft — a Niepoort label sold as a producer) with "I don't know
    // this house" (Château Hautes Graves — a real Saint-Émilion property).
    // Only the first justifies withholding the profile, but the hold fired on
    // both, so most of the world's small estates lost their tasting note:
    // measured on prod, ~47% of a 250-wine enrichment run was held, and the
    // held rows blocked the sommelier's maturity queue because a held profile
    // shows no tasting note to judge a drink window against.
    //
    // Ticket 6a6f94e5 asked that a description calling the producer
    // undocumented must agree with a flag — that requirement now lands here,
    // where it belongs, instead of on producerSuspect.
    producerUnknown: { type: Boolean, default: false },
    producerNote:    { type: String,  default: null, trim: true },
    // The verdict on producerSuspect, and ONLY that verdict (somm ticket
    // 6a85f5e8, 2026-08-19). It used to be inferred from profileReviewedAt,
    // which is the wrong signal for two reasons:
    //   - applyProfilePatch stamps profileReviewedAt on ANY curator profile
    //     write, so fixing a wine's grapes silently dropped it out of the
    //     suspect queue without anyone judging the producer. 23 prod rows had
    //     left that way against ONE genuine uphold.
    //   - upheld-count is the number the scaling review reads as "wines the
    //     registry genuinely cannot identify". Sharing a field with routine
    //     curation deflated exactly the rows a curator looked hardest at.
    // Now: 'upheld' (flag is right, keep it and stop asking) | 'confirmed'
    // (flag was wrong, cleared). null = still awaiting judgement, whatever
    // else has been written to the row.
    suspectDecision:   { type: String, default: null, trim: true },
    suspectDecidedAt:  { type: Date,   default: null },
    // Which deterministic rule cleared producerSuspect, when one did — see
    // utils/producerSuspectCheck DOWNGRADE_RULES. Requested by the sommelier
    // (6a86baca): a rule that moves rows out of the queue must leave them
    // queryable as a set, so a rule that turns out to be wrong can be found
    // and reversed without re-deriving which rows it touched. Distinct from
    // suspectDecision, which records a HUMAN verdict.
    suspectDowngradedBy: { type: String, default: null, trim: true },
    model:        { type: String, default: null, trim: true }, // model that produced it
    generatedAt:  { type: Date,   default: null },             // when it was generated
    // The identity fields this profile was generated FROM, as
    // enrichmentJob.profileInputsSnapshot() renders them. Compare against the
    // record's current values to know — exactly, not heuristically — whether
    // the stored profile still describes this wine.
    //
    // WHY (somm ticket 6a86bb3b, 2026-08-20). reenrichAfterRecordEdit already
    // fires on the three deliberate curation surfaces, but a BULK SCRIPT
    // writing straight to the collection bypasses all of them. The 08-11
    // cross-field triage did exactly that, and left two Friuli benchmarks —
    // Le Vigne di Zamò and Venica & Venica — carrying a suspect flag and a
    // note about "Giuli Ballarin", the wine those rows used to be. The note
    // was never wrong; the row stopped being the wine it described.
    //
    // Storing the inputs makes staleness a property of the DATA rather than
    // of whether a code path remembered to call a hook, so the next bulk edit
    // is caught whoever writes it.
    inputsSnapshot: { type: String, default: null },
    // Generation ran but PUBLICATION was withheld: the model flagged the
    // producer as suspect (a brand/range sold as a producer, a place, a
    // label term), so describing "this producer's style" would be confident
    // fiction about a company that may not exist (ticket 6a8162c5 —
    // "Fabelhaft" got a négociant biography). A held profile stores only the
    // doubt (confidence/producerSuspect/producerNote); description and the
    // structured descriptors stay null, which is what keeps every read
    // surface (bottle page, MCP, embeddings) naturally silent. Cleared by:
    // a curator profile write, an admin identity edit (re-enrich under the
    // corrected identity), or profile-reviewed (human overrides the doubt →
    // forced publish). Guards in enrichmentJob treat heldAt as "already
    // decided" so neither the per-add hook nor incremental batches loop on it.
    heldAt:       { type: Date,   default: null },
    // WHY the hold fired — 'producer_suspect' | 'low_confidence' |
    // 'unknown_low_confidence' | 'producer_claim' (enrichmentJob.
    // shouldHoldProfile) | 'taxonomy_conflict' (grapeStyleTypicals cross-
    // check, 6a8464ea phase 2) | 'grape_colour_conflict' (utils/
    // grapeColourCheck: the record's own type disagrees with every grape's
    // curated colour, 6a85ad44). Plain String on purpose: held rows from
    // before 2026-08-18 predate the field (null = producer_suspect era), and
    // a future gate reason must not need a schema change.
    heldReason:   { type: String, default: null, trim: true },
    // This generation used the web-search rescue (pilot 2026-08-19). The
    // pilot's three numbers all derive from this flag: rescue rate
    // (searchUsed ∧ published vs held), searched-profile quality (curator
    // overwrites on searchUsed rows), and spend (searchUsed per day).
    searchUsed:   { type: Boolean, default: false },
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
  // the migration runs.
  //
  // REGENERATED when the name changes — and the old slug is kept in
  // previousSlugs below, which every :idOrSlug lookup also resolves. The old
  // rule was "never regenerate, URLs are stable forever", and it produced the
  // Magnien row: corrected from a misread "Coeur de Roi" to "Nuits-Saint-
  // Georges Premier Cru Cœur de Roches", still served at /wines/coeur-de-roi.
  // A URL that states a name the wine does not have is not stability, it is a
  // second wrong record — one search engines index and users copy. Stability is
  // now what previousSlugs provides: no existing URL ever breaks.
  slug: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
    index: true
  },
  // Every slug this wine has ever had, oldest first. A :idOrSlug lookup
  // resolves these too, so an old link, bookmark or backlink keeps working
  // after a rename — and findFreeSlug refuses a candidate that appears here on
  // ANY wine, so one old URL can never come to mean two different wines.
  //
  // Multikey index: the lookup queries { $or: [{slug}, {previousSlugs: s}] }.
  // Bounded (PREVIOUS_SLUG_LIMIT) — a row renamed dozens of times is churn —
  // but the ORIGINAL slug is never the one dropped, because a slug that falls
  // out of this array becomes claimable by another wine (see
  // boundPreviousSlugs for the full argument and the residual). undefined on
  // rows that have never been renamed, so nothing needs backfilling.
  previousSlugs: {
    type: [String],
    default: undefined,
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
  // WHICH SOURCE SUPPLIED EACH IDENTITY FIELD. createdVia says which surface
  // minted the row; this says, field by field, whether a human stated the
  // value or a model supplied it.
  //
  // Why it exists (somm ticket 6a958dbc, 2026-08-31): a 205-row import whose
  // file carried appellation on every row and grapes on none produced 89 wines
  // whose grapes were inferred BY THE MODEL FROM THE APPELLATION — all eight
  // Montlouis wines got Chenin Blanc, including a pétillant naturel that is
  // mostly Menu Pineau. The values were wrong, self-consistent and
  // indistinguishable from researched ones, so the curator had to stop: a
  // profile written onto a misidentified record marks it verified forever.
  // Nothing on the record said "this grape is a guess". Now it does.
  //
  // Sparse by design — a field absent from the map means "not recorded",
  // which is what every row predating this carries. Never treat absence as
  // 'file': it is the honest unknown.
  identityProvenance: {
    type: Map,
    of: {
      type: String,
      enum: ['file', 'model', 'curator', 'scan', 'user'],
    },
    default: undefined,
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
  // Canary (registry lockdown 2026-09-06, L4): a plausible wine that does not
  // exist, seeded by scripts/seed-canary-wines.js. The rule is "on every path
  // a thief walks, off every path a customer walks": present in the sitemap
  // (page served with noindex), in deep taxonomy pages and on direct fetches
  // by id/slug; excluded from registry search (Meilisearch membership and the
  // Mongo fallback), similar-wines, the first taxonomy pages, embedding and
  // enrichment. A copy that surfaces elsewhere carrying one of these can only
  // have come from here. Never exposed in a public payload.
  canary: {
    type: Boolean,
    default: false
  },
  // Pending identity: this row was minted at bottle-commit from an INCOMPLETE
  // identity — no producer, a sentinel producer ("Unknown", "N/A"), or a
  // geography typed into the producer box. The bottle saves instantly (that is
  // the whole point — an add must never be harder), and the shared registry is
  // protected by hiding the row from everyone except its creator and curation
  // until a sommelier completes it. Every exclusion nonWine has, this has too:
  // Meilisearch, public /api/wines reads, MCP registry tools, embeddings, the
  // maturity queue, sitemap/OG, taxonomy listings and the admin scan pools.
  //
  // MISSING-PRODUCER REPRESENTATION (deliberate, do not "fix"): the stored
  // producer is the EMPTY STRING, never a sentinel and never absent, and the
  // normalizedKey's producer segment is `pending~<createdBy>` (see
  // services/findOrCreateWine.pendingProducerKey). Three properties follow:
  //   1. normalizeString() output is [a-z0-9 ] only — it strips '~' — so no
  //      real producer can ever produce a segment containing '~'. The pending
  //      namespace is provably disjoint from every non-pending key, and the
  //      unique index on normalizedKey therefore cannot collide across them.
  //   2. Two pending rows by different creators with the SAME name get
  //      different keys (different creator ids) — no cross-creator E11000, so
  //      one user's bottle can never be silently attached to another's
  //      pending row.
  //   3. The SAME creator re-submitting the same identity keys identically and
  //      resolves to their own existing row — retry storms mint once, not N
  //      times.
  // On promotion the key is regenerated from the real producer by the normal
  // generateWineKey path, so a promoted row lands in the ordinary namespace and
  // the unique index re-checks it there.
  pendingIdentity: {
    type: Boolean,
    default: false,
    index: true
  },
  // "This label genuinely prints NO producer." Retailer own-label bottles,
  // négociant clean-skins and bin-end relabels exist, and two are in the queue
  // now. A curator must be able to stop them from occupying a queue that is a
  // list of WORK — but the one thing they must not do is promote them:
  // producer is 45% of the composite duplicate score, so a producerless row in
  // the shared registry would attract every other producerless wine to itself.
  //
  // So this is a QUEUE disposition, NOT a promotion. pendingIdentity stays
  // TRUE and every exclusion it carries stays in force — Meilisearch, public
  // reads, MCP registry tools, embeddings, enrichment, the maturity queue,
  // sitemap/OG, the admin scan pools. The row's owner still sees their bottle
  // exactly as before. All that changes is that the curation queue stops
  // listing it by default (services/pendingWineOps: a filter shows them again).
  //
  // REVERSIBLE by construction — it is one boolean, cleared by the same PATCH
  // that set it, and cleared automatically if the row ever does promote (the
  // pre-validate hook below), because a wine WITH a producer cannot be a wine
  // whose producer is unavailable.
  //
  // LAST RESORT, and the surfaces say so: ask_bottle_owner works on pending
  // wines (#941), and the owner is holding the bottle. This is for when they
  // have answered "there is no producer on it", or cannot be reached.
  identityUnavailable: {
    type: Boolean,
    default: false,
    index: true
  },
  // The original label photo this wine was minted from, kept so a curator can
  // READ the label instead of guessing (the whole point of the pending queue).
  // Curation-visible only — never public, never in a bottle gallery; the
  // BottleImage carries kind:'label-scan' + visibility:'private'.
  //
  // GDPR: this introduces NO new consent category. Bottle photos are already a
  // category the user consents to on upload, stored in the same collection with
  // the same EXIF-stripping pipeline; this is one more image of the same kind,
  // exported with the others in GET /api/users/me/export, deleted with the
  // account (the pointer is nulled, never left dangling), and expired after
  // 30 days when it was scanned but never committed to a wine.
  scanImage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BottleImage',
    default: null
  },
  // The BACK label of the same bottle, when the front scan came back incomplete
  // and the user took the optional rescue photo. Everything true of `scanImage`
  // above is true of this field — same collection, same kind:'label-scan' +
  // visibility:'private' row, same EXIF-stripping pipeline, same export, same
  // account-deletion pointer-nulling, same two retention sweeps (7-day promoted
  // expiry / 30-day unattached). NO new GDPR consent category: it is one more
  // photo of the same bottle, taken for the same purpose.
  //
  // A SECOND POINTER rather than an array because the two frames are not
  // interchangeable: the curator surfaces label them ("front says X, back says
  // Y") and the merge that produced the wine's fields is asymmetric — the front
  // label wins every contested scalar.
  scanImageBack: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BottleImage',
    default: null
  },
  // What the two labels DISAGREED about, recorded at the moment the back scan
  // was merged into the front extraction. Curation evidence, not wine data: the
  // merge always kept the front value, so a curator seeing "producer: front
  // 'Ch. Musar', back 'Musar SAL'" can tell at a glance whether the stored
  // value is the label name or the corporate entity — the single most common
  // reason a scanned identity reads wrong.
  //
  // Written under EXACTLY the conditions the scan images are (pending mint, or
  // the creator's own pending row): on a fully-identified wine there is no
  // identity to correct and therefore no purpose to justify storing it. Cleared
  // together with the scan pointers when the retention sweep expires the photos
  // — evidence that outlives the images it refers to is unverifiable.
  scanFieldConflicts: {
    type: [{
      _id: false,
      field: { type: String },
      front: { type: String },
      back: { type: String },
    }],
    default: []
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
  // Cross-field clearances (ticket analysis 2026-08-10, Tier-2 item 5): rule
  // ids from utils/crossFieldChecks.js an admin has read this wine against
  // and confirmed the flagged value really belongs in its field. Deliberately
  // a SIBLING of verifiedChecks, not more entries in it: verifiedChecks'
  // scope rule (name+producer-only verdicts) is what makes its two-field
  // invalidation complete, and cross-field rules break it by design — they
  // read the wine's placement fields against the taxonomy collections. Same
  // per-rule-id design (a new or id-bumped rule has no clearances anywhere,
  // so it surfaces every row by construction), same undefined-on-legacy-rows
  // semantics under .lean(), same never-bulk-set-from-a-script rule; the
  // clearing admin is recorded in AuditLog, not here (mirrors verifiedChecks).
  //
  // INVARIANT for this field: only a rule whose verdict reads nothing but
  // this wine's name / producer / appellation / region / country / grapes /
  // type plus the Appellation/Region/Country/Grape reference collections may
  // consult it. The pre-validate hook below invalidates it when ANY of those
  // seven fields changes — broader than verifiedChecks because the rules read
  // all seven. (`type` joined with colour-contradiction.v2; the DB-backed
  // cuvee-near-miss.v2 reads `name` + `producer`, both already watched, plus
  // OTHER wines — a sibling renamed elsewhere writes nothing here, the same
  // taxonomy-rename residual as (a) below.) Residuals, stated honestly: (a) renaming a TAXONOMY doc writes
  // nothing here, so a clearance can outlive the taxonomy state it was
  // judged against until the wine itself is edited (the scan's audit view
  // exists to re-examine); (b) the taxonomy-merge service re-points
  // region/country/grapes ids via updateMany, bypassing the hook —
  // acceptable because a merge preserves the semantic value the admin
  // cleared against.
  crossChecksCleared: {
    type: [String],
    default: undefined
  },
  // When the most recent cross-field clearance was recorded. Same contract as
  // verifiedAt: display and forensics only, never a scan filter.
  crossChecksClearedAt: {
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
  // AUTO-PROMOTE. A pending row exists only because its identity was
  // incomplete; the moment producer AND name are both real (present, not a
  // sentinel like "Unknown"/"N/A", and PLAUSIBLY SHAPED) the reason to hide it
  // is gone, so it leaves the queue by itself.
  //
  // "Not a sentinel" alone was not enough (live bug): a row with producer
  // "Increíble" AND name "Increíble" — the label's one readable word echoed
  // into both boxes — satisfied it, left the queue, and reached the maturity
  // queue as public registry data, at which point its label photo was no longer
  // reachable. isImplausibleIdentity adds the shape test; it is deliberately
  // synchronous and DB-free because a pre-validate hook must not do I/O, so the
  // taxonomy-dependent half of the same question (producer-is-a-place / a
  // grape) is enforced where a DB read is allowed — the mint gate in
  // services/findOrCreateWine and services/pendingWineOps.applyPendingFix.
  //
  // Deliberately a hook, not a line in the somm route:
  // every write path that completes the identity — the REST fix, the MCP fix, a
  // future admin PUT, a backfill script using .save() — promotes identically
  // and none of them can forget. Runs BEFORE the `required` validator on
  // producer, whose condition reads this same flag.
  //
  // Index membership does NOT ride along here: mirroring nonWine, the caller
  // that completes the identity calls searchService.indexWine(), which owns
  // add-vs-remove. A promoting caller must also re-embed (the row was skipped
  // by the embedding pipeline while pending) and re-seed its maturity rows.
  if (this.pendingIdentity === true &&
      !isIdentitySentinel(this.producer) && !isIdentitySentinel(this.name) &&
      !isImplausibleIdentity(this.producer, this.name)) {
    this.pendingIdentity = false;
    // A wine WITH a producer cannot be one whose producer is unavailable. The
    // disposition is a statement about a row in the queue; the row has left.
    this.identityUnavailable = false;
    // Remember the TRANSITION for the post('save') hook below. $locals (not a
    // schema path) because this is per-save bookkeeping, never stored — and
    // isModified() is not readable in post('save'), where the stamp must run.
    this.$locals.promotedFromPending = true;
  }
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
  // crossChecksCleared watches all SIX identity fields — its rules judge the
  // wine's placement fields against the taxonomy collections (see the field
  // comment), so any of the six changing may change a verdict. Save-based
  // writes only, same as above; the taxonomy-merge updateMany residual is
  // documented on the field.
  // `type` joined the set with colour-contradiction.v2 (a name whose colour
  // word contradicts the stored type) — the one rule in the family whose
  // verdict is about the wine's own colour rather than a reference list, and a
  // clearance of it must not survive the type being changed.
  if (!this.isNew && (
    this.isModified('name') || this.isModified('producer') ||
    this.isModified('appellation') || this.isModified('region') ||
    this.isModified('country') || this.isModified('grapes') ||
    this.isModified('type')
  )) {
    this.crossChecksCleared = undefined;
    this.crossChecksClearedAt = null;
  }
  next();
});

/**
 * Does this document get a slug on THIS save?
 *
 * A static (not an inline condition) so the rule can be tested without a live
 * connection — the audit's M-5 was a rule nobody could see fire.
 *
 * - Never overwrite an existing slug HERE. A rename is a different question,
 *   answered by shouldRegenerateSlug below (which preserves the old URL).
 * - A pendingIdentity row gets NO slug — SLUG SQUATTING (security audit M-5).
 *   The slug is derived from name+producer, and a pending row's producer is ''
 *   — so a row minted from a half-read "Cloudy Bay Sauvignon Blanc" label took
 *   /wines/cloudy-bay-sauvignon-blanc and served a 404 there to everyone
 *   (pending rows are excluded from every public read), while the REAL wine was
 *   pushed onto `-2`. Nothing ever reclaimed it: the old guard also returned
 *   early for every non-new doc, so promotion never regenerated.
 * - Create, or the save that PROMOTES a pending row — which is exactly when the
 *   wine first deserves a public URL. pre-validate has already flipped the flag
 *   by the time the save hook runs, so isModified is how promotion is spotted.
 * - A slugless LEGACY row is left alone: backfilling those belongs to the
 *   migration script, not to whatever write happens to touch them next.
 */
wineDefinitionSchema.statics.shouldAssignSlug = function (doc) {
  if (doc.slug) return false;
  if (doc.pendingIdentity === true) return false;
  return Boolean(doc.isNew || doc.isModified('pendingIdentity'));
};

/** How many superseded slugs one wine keeps alive. */
const PREVIOUS_SLUG_LIMIT = 10;

/**
 * Bound previousSlugs — keeping the ORIGINAL slug whatever else is dropped.
 *
 * The hole a plain `.slice(-LIMIT)` leaves (audit M-5): a dropped slug becomes
 * invisible to findFreeSlug, so the 11th rename FREES the wine's first URL for
 * another wine to mint — and that URL is the one with the most external life
 * (search index, bookmarks, backlinks, the /wines/<slug> a user copied a year
 * ago). Losing the newest superseded slug costs an internal redirect; losing
 * the oldest hands someone else's wine an address the internet still points at
 * this one.
 *
 * So index 0 is pinned and the bound is spent on the most recent LIMIT-1.
 *
 * RESIDUAL, stated rather than hidden: a wine renamed more than 10 times still
 * drops slugs from the MIDDLE of its history, and those are reclaimable exactly
 * as before. Closing that needs storage this schema does not have (a global
 * retired-slug collection); 10+ renames of one registry row is a curation
 * problem before it is a routing one.
 */
const boundPreviousSlugs = (list) => {
  if (list.length <= PREVIOUS_SLUG_LIMIT) return list;
  return [list[0], ...list.slice(-(PREVIOUS_SLUG_LIMIT - 1))];
};

/**
 * The filter for "the wine at this URL segment" — the CURRENT slug or any
 * superseded one. Every :idOrSlug lookup uses it (routes/wines.js public
 * detail / community-prices / discussions, routes/og.js) so a rename cannot
 * 404 a link from one surface while another still resolves it.
 *
 * Returns a bare `$or`, which callers spread alongside their own scalar
 * conditions (`{ ...WineDefinition.slugFilter(s), nonWine: { $ne: true } }`) —
 * implicit AND. A caller that already has its own `$or` must merge with `$and`;
 * none currently does.
 */
wineDefinitionSchema.statics.slugFilter = function (slug) {
  const s = String(slug).toLowerCase();
  return { $or: [{ slug: s }, { previousSlugs: s }] };
};

/**
 * First free slug for `base`, disambiguating with -2, -3, … as the
 * findOrCreateWine flow and the backfill migration do.
 *
 * "Free" includes SUPERSEDED slugs (previousSlugs) on purpose: handing a new
 * wine a URL that an older wine still answers to would make one link resolve to
 * two different wines, which is worse than the collision the -2 suffix exists
 * to avoid.
 *
 * The old loop `for (let i = 2; i < 100; i++)` fell through SILENTLY when all
 * 98 suffixes were taken: it assigned its last candidate without ever checking
 * it, i.e. a known-colliding slug against a unique index — a write failure at
 * the very end of a bottle add. A random suffix ends it in one step, and is
 * still checked, so every return from here carries the same guarantee.
 */
wineDefinitionSchema.statics.findFreeSlug = async function (base) {
  const taken = async (slug) =>
    Boolean(await this.findOne(this.slugFilter(slug)).select('_id').lean());
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    if (!await taken(candidate)) return candidate;
    candidate = `${base}-${i}`;
  }
  if (!await taken(candidate)) return candidate;
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
};

/**
 * Does a RENAME make this document's slug wrong?
 *
 * The Magnien row: corrected from a misread "Coeur de Roi" to "Nuits-Saint-
 * Georges Premier Cru Cœur de Roches" and still served at /wines/coeur-de-roi.
 * A slug that states a name the wine does not have is a second wrong record.
 *
 * Narrow on purpose — this must fire on a real identity change and nothing else:
 *   - only when a slug already exists (assignment is shouldAssignSlug's job)
 *     and the doc is not new;
 *   - only when `name` or `producer` was modified. Producer matters just as
 *     much as name: the slug is derived from BOTH, and a re-attribution left
 *     the Trenza wine published at /wines/bodegas-juan-gil-… — the wrong
 *     winery in the URL itself (found 2026-08-12). A producer RESPELLING that
 *     folds to the same slug is caught by the base comparison below and never
 *     churns, which is what the old name-only guard wrongly assumed it had to
 *     protect against;
 *   - only when the slug would actually CHANGE. The current slug may be a
 *     disambiguated form of the same base ("cloudy-bay-2"), which is still the
 *     right slug for this name and must not be regenerated into "-3" on every
 *     unrelated save;
 *   - never for a pending row: it has no public URL to keep correct (M-5).
 */
wineDefinitionSchema.statics.shouldRegenerateSlug = function (doc) {
  if (!doc.slug || doc.isNew) return false;
  if (doc.pendingIdentity === true) return false;
  if (!doc.isModified('name') && !doc.isModified('producer')) return false;
  const base = generateWineSlug(doc.name, doc.producer);
  if (!base || doc.slug === base) return false;
  if (doc.slug.startsWith(`${base}-`)) {
    // …but only a DISAMBIGUATOR counts as "the same base" — "-2" or the random
    // hex tail. "coeur-de-roi-premier-cru" is a different slug, not a suffix.
    const tail = doc.slug.slice(base.length + 1);
    if (/^(\d{1,3}|[0-9a-f]{8})$/.test(tail)) return false;
  }
  return true;
};

// Assign the slug when the rules above say this save earns one, or REGENERATE
// it on a rename — keeping the outgoing slug alive in previousSlugs, which
// every :idOrSlug lookup resolves. Regeneration is checked first: a doc that
// has a slug can only ever be in that branch.
wineDefinitionSchema.pre('save', async function(next) {
  if (this.constructor.shouldRegenerateSlug(this)) {
    const outgoing = this.slug;
    const base = generateWineSlug(this.name, this.producer);
    this.slug = await this.constructor.findFreeSlug(base);
    const kept = (this.previousSlugs || []).filter((s) => s !== outgoing && s !== this.slug);
    // Oldest first, newest-kept last, bounded — and the ORIGINAL slug survives
    // the bound whatever else is dropped (see boundPreviousSlugs).
    this.previousSlugs = boundPreviousSlugs([...kept, outgoing]);
    return next();
  }
  if (!this.constructor.shouldAssignSlug(this)) return next();
  const base = generateWineSlug(this.name, this.producer);
  if (!base) return next();
  this.slug = await this.constructor.findFreeSlug(base);
  next();
});

/**
 * The one thing a pending→promoted transition must do on EVERY write path:
 * start the label scan's retention clock.
 *
 * A hook, not a line in each route, because "every promoting caller runs the
 * follow-through" was false (audit M-4). The admin PUT (routes/admin/wines.js)
 * and POST /:id/strip-producer both set a producer and save(); the pre-validate
 * hook above cleared pendingIdentity and nothing stamped BottleImage
 * .retainUntil. The scan then became UNREADABLE (curation access is gated on
 * pending-or-within-grace) and UNSWEEPABLE (the expiry job excludes
 * retainUntil: null) — the file kept forever with no purpose and no way to read
 * it, the exact state the 7-day window was built to end.
 *
 * Only the STAMP lives here. The rest of the follow-through (search index,
 * embeddings, enrichment, maturity seeding, IndexNow) stays in
 * services/pendingWineOps.runPromotionFollowThrough: those are curation-queue
 * side effects with their own budget and failure semantics, and a model hook is
 * the wrong place to fan them out. A promotion through the admin PUT therefore
 * still relies on the admin route's own indexWine call — unchanged, and out of
 * scope here; the retention stamp is the one that had no owner at all.
 *
 * Non-fatal by construction: stampPromotedScanRetention swallows its own
 * errors, and the flag is cleared first so a re-save cannot re-run it.
 */
/**
 * Did the pre-validate hook PROMOTE this document on this pass?
 *
 * A static rather than an inline condition, for the reason shouldAssignSlug is
 * one: a rule nobody can see fire is a rule nobody can test. This one is only
 * readable between validate() and the end of save(), which is exactly the
 * window the post-save hook runs in.
 */
wineDefinitionSchema.statics.promotedOnThisSave = function (doc) {
  return Boolean(doc && doc.$locals && doc.$locals.promotedFromPending === true);
};

wineDefinitionSchema.post('save', async function (doc) {
  if (!doc.constructor.promotedOnThisSave(doc)) return;
  doc.$locals.promotedFromPending = false;
  const { stampPromotedScanRetention } = require('../services/labelScanAccess');
  await stampPromotedScanRetention(doc);
});

module.exports = mongoose.model('WineDefinition', wineDefinitionSchema);
