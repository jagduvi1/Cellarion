const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const aiConfig = require('../config/aiConfig');
const { extractFirstJsonObject } = require('../utils/jsonExtract');
const { textFromResponse, thinkingOff } = require('../utils/aiResponse');

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('Label scan is not configured on this server');
    err.status = 503;
    throw err;
  }
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk;
  // maxRetries lets the SDK transparently wait out 429 / 529 (overloaded) /
  // 5xx with exponential backoff that honors the `retry-after` header, instead
  // of failing the call. This is what keeps a large bottle import (1000+) going
  // when Anthropic briefly rate-limits us — each AI call waits and continues
  // rather than aborting. The per-call wait stays bounded so a single import
  // chunk request can't hang indefinitely.
  return new Anthropic({ apiKey, maxRetries: 4 });
}

/**
 * Derive a quality tier from the wine name and appellation.
 * Used by the maturity suggest prompt to give the AI a baseline signal.
 */
const PRESTIGE_KEYWORDS = /grand\s*cru|1er\s*cru|premier\s*cru|cru\s*class[eé]|gran\s*reserva|riserva|grosses?\s*gew[aä]chs|erste\s*lage/i;
const MID_TIER_KEYWORDS = /cru\s*bourgeois|village|communale?|reserva|classico|sup[eé]rieur|old\s*vine/i;
const ENTRY_KEYWORDS = /g[eé]n[eé]rique|vin\s*de\s*(pays|france|table)|igp|igt|landwein|tafelwein|joven|crianza/i;

function classifyQualityTier({ name, appellation } = {}) {
  const combined = [name, appellation].filter(Boolean).join(' ');
  if (!combined) return 'unclassified';
  if (PRESTIGE_KEYWORDS.test(combined)) return 'prestige';
  if (MID_TIER_KEYWORDS.test(combined)) return 'mid-tier';
  if (ENTRY_KEYWORDS.test(combined)) return 'entry-level';
  return 'unclassified';
}

function validateMediaType(mediaType) {
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    const err = new Error('Unsupported image type');
    err.status = 400;
    throw err;
  }
}

/**
 * Extract full structured wine data from a label image using Claude vision.
 *
 * Returns an object with: name, producer, vintage, country, region,
 * appellation, type, grapes[].
 * The vintage is part of the bottle (not the wine definition) and is
 * returned separately so the caller can pre-fill the bottle form.
 *
 * @param {string} image     Base64-encoded image data
 * @param {string} mediaType MIME type (default 'image/jpeg')
 * @returns {Promise<Object>} Extracted wine data
 */
async function scanLabelFull(image, mediaType = 'image/jpeg') {
  validateMediaType(mediaType);
  const client = getClient();

  const response = await client.messages.create({
    model: aiConfig.get().labelScanModel,
    max_tokens: 600,
    ...thinkingOff(aiConfig.get().labelScanModel),
    messages: [
      // Prime the assistant to start with '{' so it can't add preamble
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: image }
          },
          {
            type: 'text',
            text: aiConfig.get().labelScanPrompt
          }
        ]
      }
    ]
  });

  const raw = textFromResponse(response);

  // Strip any accidental markdown fences just in case
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let data;
  try {
    data = JSON.parse(stripped);
  } catch {
    console.error('labelScan JSON parse failed, raw response:', raw);
    const err = new Error('Could not read label');
    err.status = 422;
    // Debug raw logged server-side only
    console.error('[labelScan] raw AI response:', raw);
    throw err;
  }

  if (data.error) {
    const err = new Error('Could not read label');
    err.status = 422;
    // Debug raw logged server-side only
    console.error('[labelScan] raw AI response:', raw);
    throw err;
  }

  if (!data.name || !data.producer) {
    const err = new Error('Could not identify wine from label');
    err.status = 422;
    // Debug raw logged server-side only
    console.error('[labelScan] raw AI response:', raw);
    throw err;
  }

  // Ensure grapes is always an array
  if (!Array.isArray(data.grapes)) data.grapes = [];

  return data;
}

/**
 * Shared engine for the JSON-returning Claude text helpers below
 * (identifyWineFromText / identifyWineFromQuery / suggestDrinkWindow /
 * suggestPrice / suggestProfile).
 *
 * Sends `prompt` as a single user message and returns
 * { data, debugRaw, debugReason }:
 *   data        – parsed object, or null if not usable
 *   debugRaw    – raw string from the model (or error message)
 *   debugReason – short explanation when data is null
 *
 * `validate(parsed)` (optional) may normalise fields in place; it returns an
 * error-reason string to reject the payload, or null to accept it.
 * On 429 the call is retried once after waiting out the retry-after header.
 */
async function callClaudeJson({ client, model, maxTokens, prompt, validate }) {
  const apiParams = {
    model,
    max_tokens: maxTokens,
    ...thinkingOff(model),
    messages: [
      { role: 'user', content: prompt }
    ]
  };

  let raw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Only the Anthropic call itself is inside the transport try: a failure
    // HERE never produced a billable completion, so its reason is refundable.
    let response;
    try {
      response = await client.messages.create(apiParams);
    } catch (err) {
      if (err.status === 429 && attempt === 1) {
        // Rate limited — wait for retry-after header (or 15 s) then retry once.
        // The SDK exposes err.headers as a fetch Headers instance, so read it
        // via .get(); keep the plain-object lookup as a fallback for SDK
        // versions/errors that attach a plain map.
        const retryAfter = err.headers?.get?.('retry-after') ?? err.headers?.['retry-after'];
        const waitMs = (parseInt(retryAfter ?? '15', 10) + 1) * 1000;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      const reason = err.status === 429 ? 'rate_limit_exceeded' : `exception: ${err.message}`;
      return { data: null, debugRaw: raw || err.message, debugReason: reason };
    }

    // The Claude call COMPLETED and is billed. Every failure from here on is
    // NON-refundable — a completed-but-unparseable/invalid response must stay
    // debited, exactly like ai_unknown (audit EXTRA-A: a post-completion parse
    // failure used to return an `exception:` reason and get wrongly refunded).
    raw = textFromResponse(response);
    try {
      // Strip code fences, then extract only the first balanced {...} so any
      // trailing explanation text from the model doesn't break JSON.parse.
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(extractFirstJsonObject(stripped));
      if (parsed.error) return { data: null, debugRaw: raw, debugReason: `ai_unknown: ${parsed.error}` };
      const invalidReason = validate ? validate(parsed) : null;
      if (invalidReason) return { data: null, debugRaw: raw, debugReason: invalidReason };
      return { data: parsed, debugRaw: raw, debugReason: null };
    } catch (err) {
      // Parse of a billed completion failed → non-refundable `parse_error`
      // (isRefundableFailure only refunds no_api_key/rate_limit/exception).
      return { data: null, debugRaw: raw, debugReason: `parse_error: ${err.message}` };
    }
  }
}

/** Wine-identification responses must include both name and producer. */
function validateWineIdentity(parsed) {
  if (!parsed.name || !parsed.producer) return 'missing_name_or_producer_in_response';
  if (!Array.isArray(parsed.grapes)) parsed.grapes = [];
  return null;
}

/**
 * Identify a wine from text data (name, producer, etc.) using Claude.
 * Used by the bottle import flow when no match is found in the library.
 *
 * Non-fatal: returns null if the API key is missing, Claude can't identify
 * the wine, or any error occurs — callers should fall back to 'no_match'.
 *
 * @param {Object} opts
 * @param {string} opts.name     Wine name from the import row
 * @param {string} opts.producer Producer / winery name
 * @param {string} [opts.vintage]
 * @param {string} [opts.country] Optional country hint from the import data
 * @returns {Promise<Object|null>} Extracted wine data or null
 */
/**
 * Returns { data, debugRaw, debugReason } so callers always get full visibility.
 *   data        – parsed wine object, or null if not identified
 *   debugRaw    – raw string from the model (or error message)
 *   debugReason – short explanation when data is null
 */
async function identifyWineFromText({ name, producer, vintage, country }) {
  if (!name || !producer) return { data: null, debugRaw: null, debugReason: 'missing_fields' };

  let client;
  try { client = getClient(); } catch { return { data: null, debugRaw: null, debugReason: 'no_api_key' }; }

  const vintageHint = vintage && vintage !== 'NV' ? `Vintage: ${vintage}\n` : '';
  const countryHint = country ? `Country hint: ${country}\n` : '';

  const prompt = aiConfig.get().importLookupPrompt
    .replace('{{name}}', name)
    .replace('{{producer}}', producer)
    .replace('{{vintage}}', vintageHint)
    .replace('{{country}}', countryHint);

  return callClaudeJson({
    client,
    model: aiConfig.get().importLookupModel,
    maxTokens: 800,
    prompt,
    validate: validateWineIdentity,
  });
}

/**
 * Identify a wine from a free-text user query (e.g. "Albert Bichot Fixin 2019").
 * Returns { data, debugRaw, debugReason } — same shape as identifyWineFromText.
 */
async function identifyWineFromQuery(query) {
  if (!query || !query.trim()) return { data: null, debugRaw: null, debugReason: 'missing_query' };

  let client;
  try { client = getClient(); } catch { return { data: null, debugRaw: null, debugReason: 'no_api_key' }; }

  const { DEFAULT_TEXT_SEARCH_PROMPT } = require('../config/aiConfig');
  const prompt = DEFAULT_TEXT_SEARCH_PROMPT.replace('{{query}}', query.trim());

  return callClaudeJson({
    client,
    model: aiConfig.get().importLookupModel,
    maxTokens: 800,
    prompt,
    validate: validateWineIdentity,
  });
}

/**
 * Suggest drink window / maturity phases for a wine+vintage using AI.
 * Returns { data, debugRaw, debugReason } — same shape as identifyWineFromText.
 *   data — { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil, sommNotes, confidence }
 */
async function suggestDrinkWindow({ name, producer, vintage, country, region, appellation, type, grapes }) {
  if (!name || !vintage) return { data: null, debugRaw: null, debugReason: 'missing_fields' };

  let client;
  try { client = getClient(); } catch { return { data: null, debugRaw: null, debugReason: 'no_api_key' }; }

  const qualityTier = classifyQualityTier({ name, appellation });

  // NV wines have no vintage to anchor calendar years to — their window is
  // stored as offsets after each bottle's purchase year. Use the offset-based
  // prompt so the suggestion matches the NV form (years after purchase), not
  // absolute calendar years. The {{vintage}} token is absent from the NV
  // template, so leaving it in the replace chain is a harmless no-op.
  const isNv = vintage === 'NV';
  const template = isNv ? aiConfig.get().maturitySuggestPromptNv : aiConfig.get().maturitySuggestPrompt;

  const prompt = template
    .replace('{{name}}', name || '')
    .replace('{{producer}}', producer || '')
    .replace('{{vintage}}', vintage || '')
    .replace('{{country}}', country || '')
    .replace('{{region}}', region || '')
    .replace('{{appellation}}', appellation || '')
    .replace('{{type}}', type || '')
    .replace('{{grapes}}', Array.isArray(grapes) ? grapes.join(', ') : (grapes || ''))
    .replace('{{qualityTier}}', qualityTier);

  return callClaudeJson({
    client,
    model: aiConfig.get().maturitySuggestModel,
    maxTokens: 1200,
    prompt,
  });
}

/**
 * Suggest market price for a wine+vintage using AI.
 * Returns { data, debugRaw, debugReason }.
 *   data — { price (number|null), currency, source, reasoning, sommNotes, confidence }
 */
async function suggestPrice({ name, producer, vintage, country, region, appellation, classification, type, grapes }) {
  if (!name || !vintage) return { data: null, debugRaw: null, debugReason: 'missing_fields' };

  let client;
  try { client = getClient(); } catch { return { data: null, debugRaw: null, debugReason: 'no_api_key' }; }

  const qualityTier = classifyQualityTier({ name, appellation });

  const prompt = aiConfig.get().priceSuggestPrompt
    .replace('{{name}}', name || '')
    .replace('{{producer}}', producer || '')
    .replace('{{vintage}}', vintage || '')
    .replace('{{country}}', country || '')
    .replace('{{region}}', region || '')
    .replace('{{appellation}}', appellation || '')
    .replace('{{classification}}', classification || '')
    .replace('{{type}}', type || '')
    .replace('{{grapes}}', Array.isArray(grapes) ? grapes.join(', ') : (grapes || ''))
    .replace('{{qualityTier}}', qualityTier);

  return callClaudeJson({
    client,
    model: aiConfig.get().priceSuggestModel,
    maxTokens: 800,
    prompt,
  });
}

/**
 * Generate an AI tasting/style profile for a wine (vintage-neutral character).
 * Returns { data, debugRaw, debugReason }.
 *   data — { body, tannin, acidity, sweetness, flavors[], foodPairings[],
 *            description, confidence }
 * Used by the enrichment job to populate WineDefinition.aiProfile, which then
 * feeds both the embedding text and the bottle-page display.
 */
async function suggestProfile({ name, producer, vintage, country, region, appellation, classification, type, grapes }) {
  if (!name) return { data: null, debugRaw: null, debugReason: 'missing_fields' };

  let client;
  try { client = getClient(); } catch { return { data: null, debugRaw: null, debugReason: 'no_api_key' }; }

  const prompt = aiConfig.get().enrichmentPrompt
    .replace('{{name}}', name || '')
    .replace('{{producer}}', producer || '')
    .replace('{{vintage}}', vintage || 'NV')
    .replace('{{country}}', country || '')
    .replace('{{region}}', region || '')
    .replace('{{appellation}}', appellation || '')
    .replace('{{classification}}', classification || '')
    .replace('{{type}}', type || '')
    .replace('{{grapes}}', Array.isArray(grapes) ? grapes.join(', ') : (grapes || ''));

  return callClaudeJson({
    client,
    model: aiConfig.get().enrichmentModel,
    maxTokens: 1400,
    prompt,
    validate: (parsed) => {
      // Normalise arrays so the caller can store them directly.
      if (!Array.isArray(parsed.flavors)) parsed.flavors = [];
      if (!Array.isArray(parsed.foodPairings)) parsed.foodPairings = [];
      return null;
    },
  });
}

module.exports = { scanLabelFull, identifyWineFromText, identifyWineFromQuery, suggestDrinkWindow, suggestPrice, suggestProfile };
