const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { generateWineKey, generateWineSlug, normalizeString, normalizeAppellation, normalizeAppellationKey, resolveCountryName, isRecognizedCountry, isUnknownName, sanitizeTaxonomyName } = require('../../utils/normalize');
const { canonicalizeWineName } = require('../../utils/producerPrefix');
const { computeCanonicalKey } = require('../../utils/wineIdentity');
const WineDefinition = require('../../models/WineDefinition');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Appellation = require('../../models/Appellation');
const { logAudit } = require('../../services/audit');
const { resolveCanonicalAppellation } = require('../../services/appellationResolve');
const searchService = require('../../services/search');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// Dedicated multer instance: memory storage, 100 MB limit, CSV only
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(ok ? null : new Error('Only CSV files are allowed'), ok);
  },
});

// ── Type mapping ─────────────────────────────────────────────────────────────

/**
 * Map raw colour / sub-type / wineType column values to the WineDefinition
 * type enum: red | white | rosé | sparkling | dessert | fortified
 */
function mapType(colour, subType, wineTypeCol) {
  if (wineTypeCol) {
    const t = wineTypeCol.toLowerCase().trim();
    if (t === 'rose') return 'rosé';
    if (['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'].includes(t)) return t;
  }
  if ((subType || '').toLowerCase().trim() === 'sparkling') return 'sparkling';
  const col = (colour || '').toLowerCase().trim();
  if (col === 'white') return 'white';
  if (col === 'red') return 'red';
  if (col === 'rosé' || col === 'rose') return 'rosé';
  return 'red';
}

// ── Format detection & row mapping ───────────────────────────────────────────

/**
 * Detect whether the CSV is in the full LWIN format or the simple format
 * based on header column names.
 */
function detectFormat(headers) {
  if (headers.includes('PRODUCER_NAME') || headers.includes('COLOUR')) return 'lwin';
  return 'simple';
}

/**
 * Normalise a raw NA-sentinel value from LWIN exports to null.
 */
function lwinVal(v) {
  if (!v) return null;
  const t = v.trim();
  return t === '' || t === 'NA' ? null : t;
}

/**
 * Map a parsed CSV row to a uniform wine object regardless of input format.
 * Returns null fields for anything missing or not applicable.
 */
function mapRow(row, format) {
  if (format === 'lwin') {
    let producer = lwinVal(row.PRODUCER_NAME);
    let name     = lwinVal(row.WINE);

    // Fallback: when PRODUCER_NAME or WINE is NA, parse DISPLAY_NAME.
    // LWIN DISPLAY_NAME format: "ProducerTitle ProducerName, SubRegion, WineName"
    // e.g. "G.D. Vajra, Barolo, Albe" → producer="G.D. Vajra", name="Albe"
    //
    // parts[0] is only trusted as the producer with THREE OR MORE parts —
    // matching the documented format. A two-part display is as often
    // "SubRegion, WineName" as "Producer, WineName", and trusting it wrote
    // "Bordeaux" / "California" / "Tuscany" into the producer field ~45 times
    // across four import waves (registry audit 2026-07-26, RC-2; the same
    // split also truncated "…Côtes de Bordeaux" names mid-appellation). A row
    // left without a producer fails the required-fields check downstream and
    // lands in the import error report — visible beats corrupted.
    if (!producer || !name) {
      const display = lwinVal(row.DISPLAY_NAME);
      if (display) {
        const parts = display.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 3) {
          if (!producer) producer = parts[0];
          if (!name)     name     = parts[parts.length - 1];
        } else if (parts.length === 2) {
          if (!name) name = parts[1];
        } else if (parts.length === 1) {
          if (!name) name = parts[0];
        }
      }
    }

    return {
      lwin7: lwinVal(row.LWIN),
      producer,
      name,
      country: lwinVal(row.COUNTRY),
      region: lwinVal(row.REGION),
      // Same tier-strip as the simple format below and findOrCreateWine —
      // LWIN SUB_REGION carries "… DOCG"/"DO …" forms too (audit RC-4).
      appellation: normalizeAppellation(lwinVal(row.SUB_REGION)),
      type: mapType(row.COLOUR, row.SUB_TYPE, null),
      classification: lwinVal(row.CLASSIFICATION),
      status: (row.STATUS || '').trim() || 'Live',
      rowType: (row.TYPE || '').trim() || 'Wine',
    };
  }

  // Simple format: Producer,Wine,Country,Region,Appellation,WineType,Classification,LWIN7
  return {
    lwin7: (row.LWIN7 || '').trim() || null,
    producer: (row.Producer || '').trim() || null,
    name: (row.Wine || '').trim() || null,
    country: (row.Country || '').trim() || null,
    region: (row.Region || '').trim() || null,
    appellation: normalizeAppellation((row.Appellation || '').trim()) || null,
    type: mapType(null, null, row.WineType),
    classification: (row.Classification || '').trim() || null,
    status: 'Live',
    rowType: 'Wine',
  };
}

// ── Taxonomy helpers with in-memory caching ──────────────────────────────────

/**
 * Find or create a Country document by name.
 * Results are cached in `cache` (Map) to avoid repeated DB round-trips.
 */
async function getOrCreateCountry(name, userId, cache) {
  // "Unknown"/placeholder values must not become a Country document; the row
  // fails WineDefinition validation (country required) and is counted as an error.
  if (isUnknownName(name)) return null;
  const key = name.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key);

  // Alias → canonical ("USA" → "United States", "Tyskland" → "Germany") so a
  // CSV in another language can't mint a duplicate Country document.
  const canonicalName = resolveCountryName(name);
  const normalized = normalizeString(canonicalName);
  // Mint gate, same as findOrCreateCountry (#836): a CSV cell that is not a
  // recognized real-world country must not become a Country document. THROWS
  // rather than returning null — the flush uses bulkWrite, which bypasses the
  // `country: required` validator, so a null here would insert a countryless
  // wine instead of skipping the row. The throw is caught per-row and lands
  // in the import error report. An EXISTING doc (matched below by upsert
  // filter) still resolves — matching is not minting.
  if (!isRecognizedCountry(canonicalName)) {
    const existing = await Country.findOne({ normalizedName: normalized }).select('_id').lean();
    if (!existing) {
      throw new Error(`Unrecognized country "${String(name).trim().slice(0, 80)}"`);
    }
    cache.set(key, existing._id);
    return existing._id;
  }
  const doc = await Country.findOneAndUpdate(
    { normalizedName: normalized },
    { $setOnInsert: { name: canonicalName.trim(), normalizedName: normalized, createdBy: userId } },
    { upsert: true, new: true }
  );
  cache.set(key, doc._id);
  return doc._id;
}

/**
 * Find or create a Region document by name + country.
 * Returns null when name is falsy.
 */
async function getOrCreateRegion(name, countryId, userId, cache) {
  if (!name || isUnknownName(name) || !countryId) return null;
  const key = `${countryId}:${name.toLowerCase().trim()}`;
  if (cache.has(key)) return cache.get(key);

  const normalized = normalizeString(name);
  const doc = await Region.findOneAndUpdate(
    { country: countryId, normalizedName: normalized },
    {
      $setOnInsert: {
        name: sanitizeTaxonomyName(name),
        normalizedName: normalized,
        country: countryId,
        createdBy: userId,
      },
    },
    { upsert: true, new: true }
  );
  cache.set(key, doc._id);
  return doc._id;
}

/**
 * Find or create an Appellation document by name + country.
 * The taxonomy entry is created as a side effect so it appears in the
 * admin dropdowns; WineDefinition still stores the appellation as a plain string.
 * Returns null when name is falsy.
 */
async function getOrCreateAppellation(name, countryId, regionId, userId, cache) {
  if (!name || isUnknownName(name) || !countryId) return null;
  const key = `${countryId}:${name.toLowerCase().trim()}`;
  if (cache.has(key)) return cache.get(key);

  // normalizeAppellationKey, NOT normalizeString (release-audit F1/MEDIUM-1,
  // both auditors independently): every other Appellation creator and every
  // lookup — the resolver, taxonomyReview, the backfill script — keys with
  // the hyphen-folding form. normalizeString deletes hyphens without a space
  // ("Nuits-Saint-Georges" → 'nuitssaintgeorges'), so keying here with it
  // MISSED every hyphenated curated doc and upserted an invisible twin —
  // which got worse, not better, once line ~445 started resolving spellings
  // to their canonical (hyphenated) forms. Country/Region above keep
  // normalizeString: that IS their collections' convention.
  const normalized = normalizeAppellationKey(name);
  const doc = await Appellation.findOneAndUpdate(
    { country: countryId, normalizedName: normalized },
    {
      $setOnInsert: {
        name: name.trim(),
        normalizedName: normalized,
        country: countryId,
        region: regionId || null,
        createdBy: userId,
      },
    },
    { upsert: true, new: true }
  );
  cache.set(key, doc._id);
  return doc._id;
}

/**
 * Adopt the curated display spelling for an imported appellation string,
 * memoized per import run. Falsy in / falsy out, and the resolver itself never
 * throws — an unknown CSV spelling passes through verbatim and lands in the
 * admin unmatched queue, exactly like every other write surface.
 */
async function resolveImportAppellation(name, cache) {
  if (!name) return name;
  if (cache.has(name)) return cache.get(name);
  const resolved = await resolveCanonicalAppellation(name);
  cache.set(name, resolved);
  return resolved;
}

const BATCH_SIZE = 500;

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/import/wines
 *
 * Accepts a CSV file (multipart field name: "file").
 * Supports two formats:
 *   - LWIN format  (;-delimited, columns: LWIN, PRODUCER_NAME, WINE, COUNTRY, …)
 *   - Simple format (,-delimited, columns: Producer, Wine, Country, Region, …)
 *
 * Response: { ok: true, stats: { total, created, updated, skipped, errors[] } }
 */
router.post('/wines', csvUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file is required (multipart field name: file)' });
  }

  const userId = req.user.id;
  const stats = {
    total: 0, created: 0, updated: 0, skipped: 0,
    skippedReasons: { delisted: 0, notWine: 0, missingFields: 0, other: 0 },
    errors: [],
  };

  const countryCache = new Map();
  const regionCache = new Map();
  const appellationCache = new Map();
  const appellationSpellingCache = new Map();

  // Auto-detect delimiter and whether a header row is present.
  // Strip BOM before inspecting — some LWIN exports include a UTF-8 BOM.
  const firstLine = req.file.buffer
    .toString('utf8', 0, 2048)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)[0];
  const delimiter = firstLine.includes(';') ? ';' : ',';

  // If the first field is a pure number it's a LWIN data row, not a header.
  const firstField = firstLine.split(delimiter)[0].trim();
  const hasHeader = !/^\d+$/.test(firstField);

  // Standard LWIN column order used when the file has no header row.
  // relax_column_count handles files with fewer or more columns gracefully.
  const LWIN_COLUMNS = [
    'LWIN', 'STATUS', 'DISPLAY_NAME', 'PRODUCER_TITLE', 'PRODUCER_NAME',
    'WINE', 'COUNTRY', 'REGION', 'SUB_REGION', 'SITE', 'PARCEL',
    'COLOUR', 'TYPE', 'SUB_TYPE', 'CLASSIFICATION',
    'VINTAGE_CONFIG', 'FIRST_VINTAGE', 'FINAL_VINTAGE',
    'DATE_ADDED', 'DATE_UPDATED',
  ];

  const columns = hasHeader ? true : LWIN_COLUMNS;

  let format = null;
  let batch = [];
  let rowIndex = 0;
  const mintedIds = [];

  // Reusable flush closure with userId in scope. Never throws: an UNORDERED
  // bulkWrite commits every non-failing op even when the promise rejects
  // (e.g. two rows normalizing to the same unique normalizedKey — common in
  // LWIN dumps), so both failure shapes are absorbed here instead of letting
  // a whole-batch rejection be misattributed to one row by the per-row catch:
  //   - MongoBulkWriteError → credit the ops that DID land (stats + mintedIds,
  //     so finalizeMintedWines still repairs them) and report only the
  //     failing ops as row errors (applyBulkWriteError);
  //   - hard failure (connection drop) → report the whole batch as row errors,
  //     so the stats of every earlier batch still reach the response and the
  //     audit log instead of a bare 500.
  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];

    const ops = rows.map(({ mapped, countryId, regionId, normalizedKey, legacyKey }) => {
      const filter = buildUpsertFilter({ normalizedKey, legacyKey, lwin7: mapped.lwin7 });

      // Wrap user-derived CSV values in $literal: in an aggregation update
      // pipeline a string beginning with '$' is otherwise evaluated as a field
      // path / system variable (the code itself relies on $$NOW), so a crafted
      // cell like "$createdBy" could copy another field's value into name/etc.
      const setFields = {
        name: { $ifNull: ['$name', { $literal: mapped.name }] },
        producer: { $ifNull: ['$producer', { $literal: mapped.producer }] },
        country: { $ifNull: ['$country', countryId] },
        type: { $ifNull: ['$type', { $literal: mapped.type }] },
        normalizedKey: { $ifNull: ['$normalizedKey', { $literal: normalizedKey }] },
        createdBy: { $ifNull: ['$createdBy', userId] },
        createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
        updatedAt: '$$NOW',
      };

      if (regionId) setFields.region = { $ifNull: ['$region', regionId] };
      if (mapped.appellation) setFields.appellation = { $ifNull: ['$appellation', { $literal: mapped.appellation }] };
      if (mapped.classification) setFields.classification = { $ifNull: ['$classification', { $literal: mapped.classification }] };
      if (mapped.lwin7) setFields['lwin.lwin7'] = { $ifNull: ['$lwin.lwin7', { $literal: mapped.lwin7 }] };

      return {
        updateOne: {
          filter,
          update: [{ $set: setFields }],
          upsert: true,
        },
      };
    });

    let result;
    try {
      result = await WineDefinition.bulkWrite(ops, { ordered: false });
    } catch (err) {
      result = applyBulkWriteError(err, rows, stats);
      if (!result) return; // whole batch failed hard — already reported as row errors
    }
    stats.created += result.upsertedCount || 0;
    stats.updated += result.modifiedCount || 0;
    // bulkWrite bypasses every mongoose hook, so rows minted here would be
    // born without the identity invariants (canonicalKey, slug, createdVia)
    // every other write path guarantees — the one hole the 2026-07-29
    // registry strategy found in the write paths. Collect the ids of the
    // rows this flush actually INSERTED and finalize them after the import.
    for (const id of Object.values(result.upsertedIds || {})) {
      mintedIds.push(id);
    }
  };

  try {
    const parser = parse(req.file.buffer, {
      delimiter,
      columns,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,        // allow literal " characters inside unquoted fields
      skip_records_with_error: false,
    });

    for await (const row of parser) {
      rowIndex++;

      // Detect format once from the first row's headers
      if (!format) {
        format = detectFormat(Object.keys(row));
      }

      const mapped = mapRow(row, format);

      // Skip non-wine items (spirits, beer, sake, etc. present in LWIN).
      // Delisted / retired wines are intentionally kept — users may own bottles
      // of wines that are no longer produced.
      if (mapped.rowType !== 'Wine') {
        stats.skipped++;
        stats.skippedReasons.notWine++;
        continue;
      }

      // Skip rows that are missing required fields. Country must also be a real
      // value, not a placeholder like "Unknown"/"N/A" — getOrCreateCountry maps
      // those to null, and because the flush uses bulkWrite (which bypasses the
      // `country: required` validator) a placeholder would otherwise be inserted
      // as a country=null WineDefinition and mis-counted as `created`.
      if (!mapped.producer || !mapped.name || !mapped.country || isUnknownName(mapped.country)) {
        stats.skipped++;
        stats.skippedReasons.missingFields++;
        if (stats.errors.length < 100) {
          const missing = [
            !mapped.producer && 'producer',
            !mapped.name     && 'name',
            (!mapped.country || isUnknownName(mapped.country)) && 'country',
          ].filter(Boolean).join(', ');
          stats.errors.push({ row: rowIndex, reason: `Missing: ${missing}` });
        }
        continue;
      }

      stats.total++;

      try {
        // Step-0 name canon, same as findOrCreateWine: this path bulkWrites
        // directly, so without it a producer-embedded name ("Vajra Albe" /
        // producer "Vajra") mints the producer-in-name shape the admin tool
        // then has to clean up (registry audit 2026-07-26).
        mapped.name = canonicalizeWineName(mapped.name, mapped.producer);
        // Curated-registry resolve, same reason as the name canon: parseRow is
        // sync so it can only tier-strip, and this path bulkWrites directly
        // instead of going through findOrCreateWine — so without the resolver a
        // CSV column spelling both lands on the wine AND mints a duplicate
        // Appellation doc through getOrCreateAppellation below. Cached like
        // every other taxonomy lookup here: LWIN dumps repeat a few thousand
        // appellation strings across hundreds of thousands of rows.
        const preResolveAppellation = mapped.appellation;
        mapped.appellation = await resolveImportAppellation(mapped.appellation, appellationSpellingCache);

        const countryId = await getOrCreateCountry(mapped.country, userId, countryCache);
        const regionId = await getOrCreateRegion(mapped.region, countryId, userId, regionCache);
        await getOrCreateAppellation(mapped.appellation, countryId, regionId, userId, appellationCache);
        const normalizedKey = generateWineKey(mapped.name, mapped.producer, mapped.appellation || '');
        // Resolution moves the dedup key ("… Yecla DO" → "… Yecla"), so a
        // re-import of a file whose rows this import minted BEFORE the
        // resolver existed would miss them and upsert twins (release-audit
        // F3). The pre-resolve key rides into the upsert filter's $or so the
        // old rows still match; findOrCreateWine's sibling net gives every
        // other path this protection, but the bulkWrite has only its filter.
        const legacyKey = mapped.appellation !== preResolveAppellation
          ? generateWineKey(mapped.name, mapped.producer, preResolveAppellation || '')
          : null;

        batch.push({ mapped, countryId, regionId, normalizedKey, legacyKey, rowIndex });

        if (batch.length >= BATCH_SIZE) {
          await flush();
        }
      } catch (err) {
        stats.total--;
        stats.skipped++;
        stats.skippedReasons.other++;
        if (stats.errors.length < 100) {
          stats.errors.push({ row: rowIndex, reason: err.message });
        }
      }
    }

    // Trailing batch. flush() absorbs its own failures (see above), so a
    // tail-batch failure can no longer discard the accumulated stats or skip
    // the audit log below.
    await flush();

    // Give the freshly minted rows the invariants the bulkWrite skipped.
    // Only rows this import INSERTED — existing rows were $ifNull-protected
    // and must not be touched (their keys/slugs/provenance are already right,
    // and stamping createdVia would misattribute pre-import rows).
    stats.finalized = await finalizeMintedWines(mintedIds);

    logAudit(req, 'admin.import.wines', {}, {
      total: stats.total,
      created: stats.created,
      updated: stats.updated,
      skipped: stats.skipped,
      finalized: stats.finalized,
      errorCount: stats.errors.length,
    });

    // Kick off a full Meilisearch re-sync in the background.
    // The response is returned immediately; indexing continues server-side.
    searchService.fullSync().catch(err =>
      console.error('Meilisearch post-import sync failed:', err.message)
    );

    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Wine import error:', err);
    res.status(500).json({ error: 'Import failed', details: err.message });
  }
});

/**
 * Fold a rejected flush bulkWrite into the running stats.
 *
 * An unordered bulkWrite that rejects with MongoBulkWriteError has still
 * committed every non-failing op; the error carries the partial
 * BulkWriteResult (`err.result`) plus one WriteError per failing op. Each
 * failing op is charged to ITS OWN CSV row (mirroring the per-row catch:
 * total--, skipped++, capped error entry) and the partial result is returned
 * so the caller credits the surviving ops. Any other error shape (connection
 * drop mid-batch) has no reliable partial result — every row in the batch is
 * reported as failed and null is returned.
 *
 * @param {Error} err    rejection from WineDefinition.bulkWrite
 * @param {Array} rows   the batch rows, in op order ({ rowIndex, ... })
 * @param {object} stats running import stats (mutated)
 * @returns {object|null} the partial BulkWriteResult to credit, or null
 */
/**
 * The upsert filter for one import row. Three identities may name an existing
 * row: the current dedup key, the PRE-RESOLVE key (release-audit F3 — the
 * curated-spelling resolve moved keys, and a re-import of a file whose rows
 * were minted before the resolver must still match them rather than upsert
 * twins), and the LWIN7 (stable across every spelling change). Pure and
 * exported for tests.
 */
function buildUpsertFilter({ normalizedKey, legacyKey, lwin7 }) {
  const orKeys = [{ normalizedKey }];
  if (legacyKey) orKeys.push({ normalizedKey: legacyKey });
  if (lwin7) orKeys.push({ 'lwin.lwin7': lwin7 });
  return orKeys.length > 1 ? { $or: orKeys } : { normalizedKey };
}

function applyBulkWriteError(err, rows, stats) {
  const failRow = (rowIndex, reason) => {
    stats.total--;
    stats.skipped++;
    stats.skippedReasons.other++;
    if (stats.errors.length < 100) {
      stats.errors.push({ row: rowIndex ?? null, reason });
    }
  };

  if (err && err.name === 'MongoBulkWriteError' && err.result) {
    const writeErrors = Array.isArray(err.writeErrors)
      ? err.writeErrors
      : err.writeErrors ? [err.writeErrors] : [];
    for (const we of writeErrors) {
      failRow(rows[we.index]?.rowIndex, we.errmsg || err.message);
    }
    return err.result;
  }

  console.error('Wine import flush failed (batch dropped):', err?.message);
  for (const row of rows) {
    failRow(row.rowIndex, `Batch write failed: ${err?.message}`);
  }
  return null;
}

/**
 * Post-import invariant pass over the rows the bulkWrite INSERTED.
 *
 * bulkWrite runs no mongoose hooks, so without this the LWIN import was the
 * one write path that minted wines with no canonicalKey (invisible to the
 * duplicate-prevention lookup and the collision report), no slug (no public
 * wine page) and no createdVia (unreviewable as a class). Slug collision
 * handling mirrors the model's pre-save hook (-2/-3 suffix, never overwrite).
 *
 * Per-doc on purpose: only newly inserted rows are processed (a re-import of
 * an existing file inserts nothing), and the slug uniqueness probe is a
 * per-candidate indexed findOne — the same cost findOrCreateWine pays per
 * mint. Failures are per-row and non-fatal: a finalize error must not fail an
 * import whose data already landed.
 *
 * @returns {Promise<number>} rows finalized
 */
async function finalizeMintedWines(ids) {
  let done = 0;
  for (const id of ids) {
    try {
      const doc = await WineDefinition.findById(id).select('name producer appellation canonicalKey slug createdVia');
      if (!doc) continue;
      doc.canonicalKey = computeCanonicalKey(doc.name, doc.producer, doc.appellation);
      if (!doc.createdVia) doc.createdVia = 'import';
      // findFreeSlug, NOT a hand-rolled `findOne({ slug })` probe (audit M-5).
      // This was the FIFTH slug-assignment site and the only one still blind to
      // previousSlugs: a bare slug probe happily hands an import a slug that
      // another wine still ANSWERS TO after a rename, and then
      // `{ $or: [{slug}, {previousSlugs}] }` matches two documents and findOne
      // returns whichever the index reaches first — /wines/<slug> resolving
      // nondeterministically to two different wines. One helper, one definition
      // of "free" (models/WineDefinition.findFreeSlug), which also ends the
      // silent fall-through when all 98 suffixes are taken.
      let slugBase = null;
      if (!doc.slug) {
        slugBase = generateWineSlug(doc.name, doc.producer);
        if (slugBase) doc.slug = await WineDefinition.findFreeSlug(slugBase);
      }
      // save(): the pre-validate hook recomputes canonicalKey the same way
      // (idempotent) and the slug hook skips non-new docs, which is why the
      // slug is assigned by hand above. The slug probe is check-then-set, so
      // a concurrent import can win the race — on a unique-index collision,
      // ask findFreeSlug again (the winner is committed by now, so it returns
      // the next genuinely free slug) instead of abandoning the row unfinalized
      // (audit 2026-07-29 F3: an abandoned row is exactly the invariant hole
      // this function exists to close). Retry only when WE assigned the slug:
      // an 11000 on a row that already had one is a different collision
      // (normalizedKey), and mangling its URL would not fix it.
      let attempt = 0;
      for (;;) {
        try {
          await doc.save();
          break;
        } catch (err) {
          if (err.code === 11000 && slugBase && attempt < 5) {
            attempt += 1;
            const next = await WineDefinition.findFreeSlug(slugBase);
            // Unchanged means the collision was not the slug — retrying would
            // spin. Surface it to the per-row handler instead.
            if (next === doc.slug) throw err;
            doc.slug = next;
            continue;
          }
          throw err;
        }
      }
      done += 1;
    } catch (err) {
      console.warn(`[import] finalize failed for ${id} (non-fatal):`, err.message);
    }
  }
  return done;
}

module.exports = router;
// mapRow is exported for its unit tests (the DISPLAY_NAME fallback rules are
// load-bearing — audit RC-2); it is pure and DB-free.
module.exports.mapRow = mapRow;
// finalizeMintedWines exported for its unit tests — the invariant repair is
// load-bearing (strategy 2026-07-29 R4).
module.exports.finalizeMintedWines = finalizeMintedWines;
// applyBulkWriteError exported for its unit tests — the partial-success
// recovery keeps a mid-batch duplicate-key from discarding up to 499
// created wines' stats and invariants (audit 2026-08-03 H1).
module.exports.applyBulkWriteError = applyBulkWriteError;
// resolveImportAppellation exported for its unit tests — parseRow is sync and
// can only tier-strip, so this is the ONLY place the import adopts the curated
// registry spelling before it both stores the string and mints the taxonomy doc.
module.exports.resolveImportAppellation = resolveImportAppellation;
// Test seams for the release-audit F1/F3 fixes: the Appellation-doc keying
// convention and the legacy-key upsert filter are exactly the kind of quiet
// contract a refactor breaks without noticing.
module.exports.getOrCreateAppellation = getOrCreateAppellation;
module.exports.buildUpsertFilter = buildUpsertFilter;
