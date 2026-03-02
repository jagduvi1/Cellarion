const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { generateWineKey, normalizeString } = require('../../utils/normalize');
const WineDefinition = require('../../models/WineDefinition');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Appellation = require('../../models/Appellation');
const { logAudit } = require('../../services/audit');
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
    if (!producer || !name) {
      const display = lwinVal(row.DISPLAY_NAME);
      if (display) {
        const parts = display.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          if (!producer) producer = parts[0];
          if (!name)     name     = parts[parts.length - 1];
        } else if (parts.length === 1) {
          if (!producer) producer = parts[0];
          if (!name)     name     = parts[0];
        }
      }
    }

    return {
      lwin7: lwinVal(row.LWIN),
      producer,
      name,
      country: lwinVal(row.COUNTRY),
      region: lwinVal(row.REGION),
      appellation: lwinVal(row.SUB_REGION),
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
    appellation: (row.Appellation || '').trim() || null,
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
  const key = name.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key);

  const normalized = normalizeString(name);
  const doc = await Country.findOneAndUpdate(
    { normalizedName: normalized },
    { $setOnInsert: { name: name.trim(), normalizedName: normalized, createdBy: userId } },
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
  if (!name) return null;
  const key = `${countryId}:${name.toLowerCase().trim()}`;
  if (cache.has(key)) return cache.get(key);

  const normalized = normalizeString(name);
  const doc = await Region.findOneAndUpdate(
    { country: countryId, normalizedName: normalized },
    {
      $setOnInsert: {
        name: name.trim(),
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
  if (!name) return null;
  const key = `${countryId}:${name.toLowerCase().trim()}`;
  if (cache.has(key)) return cache.get(key);

  const normalized = normalizeString(name);
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

  // Reusable flush closure with userId in scope
  const flush = async () => {
    if (batch.length === 0) return;

    const ops = batch.map(({ mapped, countryId, regionId, normalizedKey }) => {
      const filter = mapped.lwin7
        ? { $or: [{ normalizedKey }, { 'lwin.lwin7': mapped.lwin7 }] }
        : { normalizedKey };

      const setFields = {
        name: { $ifNull: ['$name', mapped.name] },
        producer: { $ifNull: ['$producer', mapped.producer] },
        country: { $ifNull: ['$country', countryId] },
        type: { $ifNull: ['$type', mapped.type] },
        normalizedKey: { $ifNull: ['$normalizedKey', normalizedKey] },
        createdBy: { $ifNull: ['$createdBy', userId] },
        createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
        updatedAt: '$$NOW',
      };

      if (regionId) setFields.region = { $ifNull: ['$region', regionId] };
      if (mapped.appellation) setFields.appellation = { $ifNull: ['$appellation', mapped.appellation] };
      if (mapped.classification) setFields.classification = { $ifNull: ['$classification', mapped.classification] };
      if (mapped.lwin7) setFields['lwin.lwin7'] = { $ifNull: ['$lwin.lwin7', mapped.lwin7] };

      return {
        updateOne: {
          filter,
          update: [{ $set: setFields }],
          upsert: true,
        },
      };
    });

    const result = await WineDefinition.bulkWrite(ops, { ordered: false });
    stats.created += result.upsertedCount || 0;
    stats.updated += result.modifiedCount || 0;
    batch = [];
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

      // Skip rows that are missing required fields
      if (!mapped.producer || !mapped.name || !mapped.country) {
        stats.skipped++;
        stats.skippedReasons.missingFields++;
        if (stats.errors.length < 100) {
          const missing = [
            !mapped.producer && 'producer',
            !mapped.name     && 'name',
            !mapped.country  && 'country',
          ].filter(Boolean).join(', ');
          stats.errors.push({ row: rowIndex, reason: `Missing: ${missing}` });
        }
        continue;
      }

      stats.total++;

      try {
        const countryId = await getOrCreateCountry(mapped.country, userId, countryCache);
        const regionId = await getOrCreateRegion(mapped.region, countryId, userId, regionCache);
        await getOrCreateAppellation(mapped.appellation, countryId, regionId, userId, appellationCache);
        const normalizedKey = generateWineKey(mapped.name, mapped.producer, mapped.appellation || '');

        batch.push({ mapped, countryId, regionId, normalizedKey });

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

    await flush();

    logAudit(req, 'admin.import.wines', {}, {
      total: stats.total,
      created: stats.created,
      updated: stats.updated,
      skipped: stats.skipped,
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

module.exports = router;
