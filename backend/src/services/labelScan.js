const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const aiConfig = require('../config/aiConfig');

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('Label scan is not configured on this server');
    err.status = 503;
    throw err;
  }
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk;
  return new Anthropic({ apiKey });
}

function validateMediaType(mediaType) {
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    const err = new Error('Unsupported image type');
    err.status = 400;
    throw err;
  }
}

/**
 * Extract the wine name and producer from a label image.
 * Returns a search query string (legacy — used by older callers).
 *
 * @param {string} image     Base64-encoded image data
 * @param {string} mediaType MIME type (default 'image/jpeg')
 * @returns {Promise<string>} Search query string
 */
async function scanLabel(image, mediaType = 'image/jpeg') {
  validateMediaType(mediaType);
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: image }
        },
        {
          type: 'text',
          text: 'Look at this wine bottle label. Extract the wine name and producer. Return ONLY a short search string like "wine name producer" with no explanation, punctuation, or extra words — just the key identifying text from the label.'
        }
      ]
    }]
  });

  const query = (response.content[0]?.text ?? '').trim();
  if (!query) {
    const err = new Error('Could not read label');
    err.status = 422;
    throw err;
  }

  return query;
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
      },
      // Prefill the assistant turn to force it to start with '{'
      {
        role: 'assistant',
        content: '{'
      }
    ]
  });

  // The model continues from the '{' prefill — prepend it back
  const raw = ('{' + (response.content[0]?.text ?? '')).trim();

  // Strip any accidental markdown fences just in case
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let data;
  try {
    data = JSON.parse(stripped);
  } catch {
    console.error('labelScan JSON parse failed, raw response:', raw);
    const err = new Error('Could not read label');
    err.status = 422;
    err._debugRaw = raw; // DEBUG — remove before release
    throw err;
  }

  if (data.error) {
    const err = new Error('Could not read label');
    err.status = 422;
    err._debugRaw = raw; // DEBUG — remove before release
    throw err;
  }

  if (!data.name || !data.producer) {
    const err = new Error('Could not identify wine from label');
    err.status = 422;
    err._debugRaw = raw; // DEBUG — remove before release
    throw err;
  }

  // Ensure grapes is always an array
  if (!Array.isArray(data.grapes)) data.grapes = [];

  data._debugRaw = raw; // DEBUG — remove before release
  return data;
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

  let raw = '';
  try {
    const response = await client.messages.create({
      model: aiConfig.get().importLookupModel,
      max_tokens: 400,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    raw = ('{' + (response.content[0]?.text ?? '')).trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped);

    if (parsed.error) return { data: null, debugRaw: raw, debugReason: `ai_unknown: ${parsed.error}` };
    if (!parsed.name || !parsed.producer) return { data: null, debugRaw: raw, debugReason: 'missing_name_or_producer_in_response' };
    if (!Array.isArray(parsed.grapes)) parsed.grapes = [];
    return { data: parsed, debugRaw: raw, debugReason: null };
  } catch (err) {
    return { data: null, debugRaw: raw || err.message, debugReason: `exception: ${err.message}` };
  }
}

module.exports = { scanLabel, scanLabelFull, identifyWineFromText };
