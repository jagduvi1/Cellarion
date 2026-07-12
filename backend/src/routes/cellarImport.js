/**
 * Cellar-export import routes (Cellarion format) — mounted at /api/cellar-import.
 *
 * Additive sibling of routes/import.js (the multi-format CSV importer); this one
 * ingests a Cellarion export (the `cellarion-export@1` JSON, or the ZIP that
 * also carries the user's own image files) and rebuilds the cellar(s). It never
 * touches the existing importer.
 *
 *   POST /api/cellar-import/preview  — parse only; report cellars + create/overwrite
 *   POST /api/cellar-import          — run the import (per-cellar name policy)
 */
const express = require('express');
const multer = require('multer');
const yauzl = require('yauzl');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const { logAudit } = require('../services/audit');
const {
  parseCellarExport,
  resolveTargets,
  importCellar,
} = require('../services/cellarImport');

const router = express.Router();
// requireNonDemo: importing a file into a demo would re-create registry wines
// verbatim (the known cellar-import registry-pollution vector), drive heavy DB
// work, and — for the CT path — spend AI. Demo users can't import; "sign up to
// import your collection".
router.use(requireAuth, requireNonDemo);

// The ZIP can hold many images; cap generously but bound memory (entries are
// buffered). A data-only JSON is tiny; the cap mainly guards the image ZIP.
// Any real export with images beyond this belongs behind the (prod) nginx
// 50 MB body cap anyway — 64 MB bounds a directly-exposed backend too.
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MB
// data.json alone (uploaded raw or extracted from the ZIP) is byte-capped
// BEFORE JSON.parse: a 50k-bottle export is ~30 MB of JSON, so 32 MB is
// generous while keeping the synchronous parse (event-loop block) bounded.
const MAX_DATA_JSON_BYTES = 32 * 1024 * 1024; // 32 MB
const MAX_TARGET_NAME = 100;
// Bound the number of buffered ZIP entries (alongside the total-byte cap) so a
// crafted archive with a huge count of tiny files can't blow up the entries Map.
const MAX_ZIP_ENTRIES = 20000;

// ── Import-parse concurrency gate ────────────────────────────────────────────
// JSON.parse of a multi-MB export blocks the event loop and the buffered file
// sits in memory for the whole request; don't let concurrent uploads stack.
// Tiny in-process gate: at most MAX_GLOBAL_IMPORTS import/preview requests in
// flight overall, and 1 per user. Excess requests get an immediate 429 (with a
// retry hint) rather than queueing forever. In-process state is fine here: the
// backend runs as a single container/process.
const MAX_GLOBAL_IMPORTS = 2;
let globalImports = 0;
const userImports = new Set(); // user ids with an import/preview in flight

function acquireImportSlot(userId) {
  if (userImports.has(userId) || globalImports >= MAX_GLOBAL_IMPORTS) return null;
  userImports.add(userId);
  globalImports++;
  return () => { userImports.delete(userId); globalImports--; };
}

function importBusy(res) {
  res.set('Retry-After', '10');
  return res.status(429).json({
    error: 'Another import is already being processed — please retry in a few seconds',
  });
}

// Gate BEFORE multer buffers the upload (audit BUG 8): acquiring the slot only
// inside the route handler let N concurrent uploads each buffer up to 64 MB into
// memory before N−2 were 429'd — the exact stacking the gate exists to prevent.
// Placed ahead of handleUpload so an over-limit request is rejected before its
// body is read. The slot is released once, on whichever response event fires
// first (finish on success, close on client abort), covering the multer-400,
// handler-throw, and disconnect paths uniformly.
function gateImport(req, res, next) {
  const release = acquireImportSlot(req.user.id);
  if (!release) return importBusy(res);
  let released = false;
  const releaseOnce = () => { if (!released) { released = true; release(); } };
  res.on('finish', releaseOnce);
  res.on('close', releaseOnce);
  next();
}

const uploadImport = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.json') || name.endsWith('.zip')) return cb(null, true);
    // Fall back to mimetype for clients that don't send a useful filename.
    const okMime = ['application/json', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
    if (okMime.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Upload a Cellarion export (.json or .zip)'));
  },
});

// Wrap multer so its errors become 400s instead of bubbling to the 500 handler.
function handleUpload(req, res, next) {
  uploadImport.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 64 MB)' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    next();
  });
}

/**
 * Read the relevant entries of an export ZIP buffer into a Map (entry name →
 * Buffer). Only `data.json` and `images/*` are kept; total size is bounded.
 * We never write files using the archive paths (the importer generates fresh
 * UUID filenames), so there is no zip-slip exposure.
 */
function readExportZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(Object.assign(new Error('Could not read ZIP archive'), { status: 400 }));
      const entries = new Map();
      let total = 0;
      let kept = 0;
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

      zip.on('error', () => fail(Object.assign(new Error('Corrupt ZIP archive'), { status: 400 })));
      zip.on('end', () => { if (!settled) { settled = true; resolve(entries); } });
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name)) return zip.readEntry(); // directory
        if (name !== 'data.json' && !name.startsWith('images/')) return zip.readEntry();
        if (++kept > MAX_ZIP_ENTRIES) {
          return fail(Object.assign(new Error('Archive has too many files'), { status: 400 }));
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e) return fail(Object.assign(new Error('Corrupt ZIP entry'), { status: 400 }));
          const chunks = [];
          stream.on('data', (c) => {
            total += c.length;
            if (total > MAX_UPLOAD_BYTES) { stream.destroy(); return fail(Object.assign(new Error('Archive contents too large'), { status: 400 })); }
            chunks.push(c);
          });
          stream.on('error', () => fail(Object.assign(new Error('Corrupt ZIP entry'), { status: 400 })));
          stream.on('end', () => { entries.set(name, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

// data.json must be byte-capped BEFORE the synchronous JSON.parse — the
// count caps inside parseCellarExport only run after a parse has already
// paid the memory + event-loop cost (SECURITY_AUDIT_2026-07-08 L-12).
function assertDataJsonSize(byteLength) {
  if (byteLength > MAX_DATA_JSON_BYTES) {
    throw Object.assign(
      new Error(`Export data is too large (${Math.round(byteLength / (1024 * 1024))} MB of JSON; max 32 MB)`),
      { status: 413 }
    );
  }
}

// Returns { parsed, getFileBuffer, hasImageFiles } from the uploaded file.
async function loadUpload(file) {
  const isZip = file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b; // 'PK'
  if (isZip) {
    const entries = await readExportZip(file.buffer);
    const dataJson = entries.get('data.json');
    if (!dataJson) throw Object.assign(new Error('Archive has no data.json (not a Cellarion export ZIP)'), { status: 400 });
    assertDataJsonSize(dataJson.length);
    const parsed = parseCellarExport(dataJson.toString('utf8'));
    const hasImageFiles = [...entries.keys()].some((k) => k.startsWith('images/'));
    return { parsed, getFileBuffer: (p) => entries.get(p) || null, hasImageFiles };
  }
  assertDataJsonSize(file.buffer.length);
  const parsed = parseCellarExport(file.buffer.toString('utf8'));
  return { parsed, getFileBuffer: () => null, hasImageFiles: false };
}

async function activeCellarNamesLc(userId) {
  const cellars = await Cellar.find({ user: userId, deletedAt: null }).select('name').lean();
  return new Set(cellars.map((c) => c.name.toLowerCase()));
}

// POST /api/cellar-import/preview — parse only, report what would happen.
router.post('/preview', gateImport, handleUpload, async (req, res) => {
  try {
    const { parsed, hasImageFiles } = await loadUpload(req.file);
    const existing = await activeCellarNamesLc(req.user.id);
    const targets = resolveTargets(parsed.cellars, existing);

    const cellars = parsed.cellars.map((c, i) => {
      const imageCount = (c.bottles || []).reduce((n, b) => n + (Array.isArray(b.images) ? b.images.length : 0), 0);
      // Distinct wine+vintage maturity windows carried in the file (the export
      // denormalises one onto every bottle of the same wine+vintage).
      const matKeys = new Set();
      for (const b of c.bottles || []) {
        if (b.maturity && typeof b.maturity === 'object') {
          matKeys.add(`${(b.wineName || '').toLowerCase()}|${(b.producer || '').toLowerCase()}|${b.vintage || ''}`);
        }
      }
      return {
        sourceName: targets[i].sourceName,
        defaultTargetName: targets[i].targetName,
        willOverwrite: targets[i].collides,
        bottleCount: (c.bottles || []).length,
        rackCount: (c.racks || []).length,
        imageCount,
        maturityCount: matKeys.size,
      };
    });

    res.json({ cellars, hasImageFiles });
  } catch (err) {
    if (err.status === 400 || err.status === 413) return res.status(err.status).json({ error: err.message });
    console.error('Cellar import preview error:', err);
    res.status(500).json({ error: 'Failed to read export' });
  }
});

// POST /api/cellar-import — run the import.
// Body (multipart text field): targets = JSON { [sourceName]: { targetName, confirmOverwrite } }
router.post('/', gateImport, handleUpload, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('preferences.currency');
    const { parsed, getFileBuffer } = await loadUpload(req.file);

    let overridesRaw = {};
    if (req.body.targets) {
      try { overridesRaw = JSON.parse(req.body.targets); } catch { return res.status(400).json({ error: 'Invalid targets' }); }
    }
    const nameOverrides = {};
    for (const [src, v] of Object.entries(overridesRaw)) {
      if (v && typeof v === 'object' && typeof v.targetName === 'string') nameOverrides[src] = v.targetName;
    }

    const existing = await activeCellarNamesLc(req.user.id);
    const targets = resolveTargets(parsed.cellars, existing, nameOverrides);

    // Validate target names + confirm overwrites + no dup target within batch.
    const seenTargets = new Set();
    for (const t of targets) {
      if (!t.targetName) return res.status(400).json({ error: `A cellar name is required (for "${t.sourceName}")` });
      if (t.targetName.length > MAX_TARGET_NAME) return res.status(400).json({ error: `Cellar name too long: "${t.targetName}"` });
      const lc = t.targetName.toLowerCase();
      if (seenTargets.has(lc)) return res.status(400).json({ error: `Two cellars would import to the same name "${t.targetName}"` });
      seenTargets.add(lc);
      if (t.mode === 'overwrite') {
        const conf = overridesRaw[t.sourceName];
        if (!conf || conf.confirmOverwrite !== true) {
          return res.status(409).json({ error: `Overwrite of "${t.targetName}" not confirmed`, needsConfirm: t.targetName });
        }
      }
    }

    const defaultCurrency = user?.preferences?.currency || 'USD';
    const results = [];
    for (let i = 0; i < parsed.cellars.length; i++) {
      const r = await importCellar(req.user.id, parsed.cellars[i], {
        targetName: targets[i].targetName,
        mode: targets[i].mode,
        getFileBuffer,
        defaultCurrency,
      });
      results.push(r);
    }

    logAudit(req, 'cellar.import', { type: 'user', id: req.user.id }, {
      cellars: results.length,
      bottles: results.reduce((n, r) => n + r.bottlesCreated, 0),
      overwrites: results.filter((r) => r.mode === 'overwrite').length,
    });

    res.json({ results });
  } catch (err) {
    if (err.status === 400 || err.status === 413) return res.status(err.status).json({ error: err.message });
    console.error('Cellar import error:', err);
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
