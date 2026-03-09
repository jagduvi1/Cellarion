/**
 * Feature flags and operational settings for the AI chat pipeline.
 *
 * Persisted in SiteConfig (key: 'aiConfig') so admins can change them at
 * runtime without a restart. Kept in an in-memory cache — same pattern as
 * rateLimits.js.
 *
 * Fields
 * -------
 * chatEnabled          – master switch; false blocks POST /api/chat
 * embeddingModel       – Voyage AI model name used for new embeddings
 * vectorIndex          – active Qdrant collection version suffix ('v1', 'v2', …)
 * chatTopK             – how many Qdrant results to retrieve before filtering to user's cellar
 * chatMaxResults       – max wines shown in the final AI answer
 * embeddingBatchDelayMs– ms to sleep between embedding calls during batch jobs
 *                        (helps stay within Voyage free-tier 3 RPM)
 * chatDailyLimits      – max questions per user per day, keyed by plan name
 * chatSystemPrompt     – system prompt sent to Claude on every chat request
 * chatModelFallback    – model to retry with on 529 overloaded (null = no fallback)
 */

// Models that are known to work reliably for text chat.
// Any value stored in DB that isn't in this list falls back to the default.
const VALID_CHAT_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
];

const DEFAULT_SYSTEM_PROMPT =
`You are a sommelier assistant for Cellarion, a personal wine cellar app.
Your job is to recommend wines from the user's own cellar based on their question.

Rules:
- Recommend ONLY wines from the list provided below the user's question.
- If none of the listed wines suit the question, say so clearly and briefly.
- Keep the answer concise: 2–3 sentences per wine, explaining why it matches.
- Do not invent or mention wines that are not in the list.
- Use a friendly, knowledgeable tone — as if speaking to the cellar owner.
- If the question is not about wine, food pairing, or the user's cellar, politely decline and redirect to cellar-related topics.
- Always reply in the same language the user wrote in.`;

const defaults = {
  chatEnabled: true,
  embeddingModel: 'voyage-4-lite',
  vectorIndex: 'v1',
  chatTopK: 50,
  chatMaxResults: 5,
  embeddingBatchDelayMs: 500,
  chatDailyLimits: { free: 4, basic: 20, premium: 50 },
  chatModel: 'claude-haiku-4-5-20251001',
  chatModelFallback: null,
  chatSystemPrompt: DEFAULT_SYSTEM_PROMPT,
};

let cache = { ...defaults };

async function load() {
  try {
    const SiteConfig = require('../models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'aiConfig' });
    if (doc && doc.value) {
      cache = {
        chatEnabled:           doc.value.chatEnabled          ?? defaults.chatEnabled,
        embeddingModel:        doc.value.embeddingModel       ?? defaults.embeddingModel,
        vectorIndex:           doc.value.vectorIndex          ?? defaults.vectorIndex,
        chatTopK:              doc.value.chatTopK             ?? defaults.chatTopK,
        chatMaxResults:        doc.value.chatMaxResults       ?? defaults.chatMaxResults,
        embeddingBatchDelayMs: doc.value.embeddingBatchDelayMs ?? defaults.embeddingBatchDelayMs,
        chatDailyLimits:       doc.value.chatDailyLimits      ?? defaults.chatDailyLimits,
        chatModel:             VALID_CHAT_MODELS.includes(doc.value.chatModel) ? doc.value.chatModel : defaults.chatModel,
        chatModelFallback:     VALID_CHAT_MODELS.includes(doc.value.chatModelFallback) ? doc.value.chatModelFallback : defaults.chatModelFallback,
        chatSystemPrompt:      doc.value.chatSystemPrompt     ?? defaults.chatSystemPrompt,
      };
    }
  } catch (err) {
    console.warn('[aiConfig] Could not load from DB, using defaults:', err.message);
  }
}

function get() {
  return cache;
}

function set(value) {
  cache = { ...defaults, ...value };
}

module.exports = { load, get, set, defaults, DEFAULT_SYSTEM_PROMPT, VALID_CHAT_MODELS };
