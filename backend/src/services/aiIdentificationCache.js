/**
 * The import lookup's answer memory (2026-09-25).
 *
 * routes/import.js asks the model to identify every wine the registry does not
 * already know. Before this, the same question was paid for again whenever an
 * import was re-run, a batch was retried after a timeout (Cloudflare's 100 s
 * origin limit is shorter than a slow batch, and the client retries 5xx), or a
 * second person imported the same not-yet-registered wine. A remembered answer
 * costs nothing: no call, and no debit from the user's daily AI budget.
 *
 * What is remembered, and for how long:
 *   - an identification (data present), or the model's definite "I don't know
 *     this wine" (reason ai_unknown) — never a transport error, a parse failure
 *     or anything else a fresh call might answer differently;
 *   - keyed on the EXACT text the prompt receives (cleaned the same way), plus
 *     the model and a fingerprint of the prompt template, so a changed model or
 *     prompt never serves an answer the current configuration would not give;
 *   - the vintage is not part of the key, matching the import's own
 *     one-lookup-per-wine dedup (the answer is a vintage-neutral identity);
 *   - 90 days (TTL index on the model).
 *
 * The registry still comes first: the import's registry cascade runs before any
 * lookup, and a remembered answer goes through the same registry resolution a
 * fresh one does. The user's explicit "Look up" (forceAi) always asks afresh.
 *
 * Never throws, and does nothing without a live database connection (unit tests
 * with mocked models, a brief Mongo outage) — the import then simply calls the
 * model, as it always did.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const AiIdentificationCache = require('../models/AiIdentificationCache');
const aiConfig = require('../config/aiConfig');
const { recordReusedAnswer } = require('./aiCostLedger');

const RETENTION_DAYS = 90;
const FEATURE = 'import_identify';
const MAX_RAW = 4000;
// Bump to forget every remembered answer at once.
const KEY_VERSION = 1;

let isDbReady = () => mongoose.connection.readyState === 1;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The cleaning services/labelScan's field() applies before the text reaches the
// prompt — the key is the text the model would actually see.
const clean = (v) => String(v ?? '')
  .replace(/\p{C}/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 200);

function keyFor({ name, producer, country, appellation, region } = {}) {
  const { importLookupModel, importLookupPrompt } = aiConfig.get();
  return sha256(JSON.stringify({
    v: KEY_VERSION,
    name: clean(name),
    producer: clean(producer),
    country: clean(country),
    appellation: clean(appellation),
    region: clean(region),
    model: String(importLookupModel || ''),
    template: sha256(String(importLookupPrompt || '')),
  }));
}

/** Only a completed, definite answer is worth remembering. */
const isRememberable = (result) => !!result
  && (result.data || (typeof result.debugReason === 'string' && result.debugReason.startsWith('ai_unknown')));

/**
 * The remembered answer for this input, shaped exactly like
 * identifyWineFromText's { data, debugRaw, debugReason }, or null.
 */
async function lookupIdentification(input) {
  if (!isDbReady()) return null;
  try {
    const doc = await AiIdentificationCache.findOne({ key: keyFor(input), expiresAt: { $gt: new Date() } }).lean();
    if (!doc) return null;
    recordReusedAnswer({ feature: FEATURE, model: aiConfig.get().importLookupModel });
    return { data: doc.data ?? null, debugRaw: doc.debugRaw ?? null, debugReason: doc.debugReason ?? null };
  } catch (err) {
    console.warn('[aiIdentificationCache] lookup failed (non-fatal):', err.message);
    return null;
  }
}

/** Remember a fresh answer (fire-and-forget). */
async function rememberIdentification(input, result) {
  if (!isDbReady() || !isRememberable(result)) return;
  try {
    await AiIdentificationCache.updateOne(
      { key: keyFor(input) },
      {
        $set: {
          data: result.data ?? null,
          debugRaw: typeof result.debugRaw === 'string' ? result.debugRaw.slice(0, MAX_RAW) : null,
          debugReason: result.debugReason ?? null,
          expiresAt: new Date(Date.now() + RETENTION_DAYS * 86400000),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    // A concurrent upsert of the same key (E11000) already stored the answer.
    if (err && err.code === 11000) return;
    console.warn('[aiIdentificationCache] remember failed (non-fatal):', err.message);
  }
}

/** Test hook — replace the database-readiness check. */
function _setDbReadyCheckForTests(fn) {
  isDbReady = fn;
}

module.exports = { lookupIdentification, rememberIdentification, keyFor, _setDbReadyCheckForTests };
