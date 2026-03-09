const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Extract the wine name and producer from a base64-encoded bottle label image
 * using Claude vision. Returns the query string to use for searching, or throws.
 *
 * @param {string} image     Base64-encoded image data
 * @param {string} mediaType MIME type (default 'image/jpeg')
 * @returns {Promise<string>} Search query string
 */
async function scanLabel(image, mediaType = 'image/jpeg') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error('Label scan is not configured on this server');
    err.status = 503;
    throw err;
  }

  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    const err = new Error('Unsupported image type');
    err.status = 400;
    throw err;
  }

  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk;
  const client = new Anthropic({ apiKey });

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

module.exports = { scanLabel };
