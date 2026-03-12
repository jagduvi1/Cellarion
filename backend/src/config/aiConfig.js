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

const DEFAULT_LABEL_SCAN_PROMPT =
`You are a master sommelier with encyclopedic wine knowledge. Examine this wine bottle and identify the wine.

Use all available information — text on the label, your knowledge of real wines, producers, appellations, and grape varieties:
- Read any visible text (name, producer, appellation, vintage, alcohol %, country)
- Cross-reference what you read with your wine knowledge to confirm and fill in gaps
- If you recognize an appellation (e.g. "Pauillac", "Barolo", "Châteauneuf-du-Pape"), use your knowledge of its grapes, country, and region
- If you recognize a producer (e.g. "Chapoutier", "Antinori", "Opus One"), use what you know about them
- Infer the wine type and grapes from all available clues — appellation rules, producer style, label design, bottle shape, language

Respond with ONLY a raw JSON object (no markdown, no code fences, no extra text):
{"name":"wine name without vintage year","producer":"producer or winery name","vintage":"4-digit year or null","country":"country","region":"wine region","appellation":"appellation/AOC/DOC/IGT/AVA or null","type":"red|white|rosé|sparkling|dessert|fortified","grapes":["grape varieties"],"confidence":0.0}

confidence: 1.0 = label clearly readable and matches a wine you know well, 0.7 = some fields inferred from appellation/producer knowledge, 0.4 = mostly inferred from limited clues, 0.2 = very uncertain.

Important rules:
- Never invent a wine that does not exist. If you can read a producer name or label text, use it exactly — do not guess or substitute a similar-sounding wine.
- Do not hallucinate appellation names, producer names, or grape varieties. Only use names you are confident are real and match what is visible on the label or your knowledge of that specific producer/appellation.
- If a field is genuinely unknown and cannot be reliably inferred, set it to null rather than guessing.
- Only return {"error":"cannot read label"} if the image contains no wine label at all.`;

const DEFAULT_IMPORT_LOOKUP_PROMPT =
`You are a master sommelier with encyclopedic wine knowledge. Identify the following wine from your knowledge.

The wine details below come from a user's import file:
Wine: {{name}}
Producer: {{producer}}
{{vintage}}{{country}}
Return ONLY a raw JSON object (no markdown, no code fences):
{"name":"wine name","producer":"producer name","country":"country","region":"region or null","appellation":"appellation or null","type":"red|white|rosé|sparkling|dessert|fortified","grapes":["grape varieties"],"confidence":0.0}

Rules:
- Use the wine name and producer exactly as given (correct only obvious typos)
- Fill in country, region, appellation, type, and grapes from your wine knowledge
- Country is REQUIRED — always provide a country name; it is never acceptable to return null for country
- For any other field you are unsure about, use null — do NOT omit the field
- Grapes: provide an empty array [] if unknown, never null for grapes
- confidence: 1.0 = well-known wine you are certain about, 0.7 = confident from producer knowledge, 0.5 = reasonably sure
- IMPORTANT: if you recognise the producer or the wine name, return a result even if some fields are null — partial information is always better than returning unknown
- Never invent a wine that does not exist in reality
- Return {"error":"unknown"} ONLY if the wine name and producer together are completely unrecognisable and likely do not exist
- Output ONLY the JSON object. No explanations, no reasoning, no extra text before or after`;

const DEFAULT_TEXT_SEARCH_PROMPT =
`You are a master sommelier with encyclopedic wine knowledge. The user has typed this search query to find a wine: "{{query}}"

Identify the wine they are looking for and return complete details.
Return ONLY a raw JSON object (no markdown, no code fences, no extra text):
{"name":"wine name","producer":"producer name","country":"country","region":"region or null","appellation":"appellation or null","type":"red|white|rosé|sparkling|dessert|fortified","grapes":["grape varieties"],"confidence":0.0}

Rules:
- Extract the wine name and producer from the query
- Fill in country, region, appellation, type, and grapes from your wine knowledge
- Country is REQUIRED — always provide a country name; it is never acceptable to return null for country
- For any other unknown field use null; use [] for unknown grapes, never null
- confidence: 1.0 = certain, 0.7 = confident, 0.5 = reasonably sure
- IMPORTANT: if you recognise the producer or wine name, return a result even if some fields are null — partial information is always better than returning unknown
- Never invent a wine that does not exist in reality
- Return {"error":"unknown"} ONLY if the query is completely unrecognisable as a real wine
- Output ONLY the JSON object. No explanations, no extra text before or after`;

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
  labelScanPrompt: DEFAULT_LABEL_SCAN_PROMPT,
  labelScanModel: 'claude-haiku-4-5-20251001',
  importLookupPrompt: DEFAULT_IMPORT_LOOKUP_PROMPT,
  importLookupModel: 'claude-haiku-4-5-20251001',
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
        labelScanPrompt:       doc.value.labelScanPrompt      ?? defaults.labelScanPrompt,
        labelScanModel:        VALID_CHAT_MODELS.includes(doc.value.labelScanModel) ? doc.value.labelScanModel : defaults.labelScanModel,
        importLookupPrompt:    doc.value.importLookupPrompt   ?? defaults.importLookupPrompt,
        importLookupModel:     VALID_CHAT_MODELS.includes(doc.value.importLookupModel) ? doc.value.importLookupModel : defaults.importLookupModel,
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

module.exports = { load, get, set, defaults, DEFAULT_SYSTEM_PROMPT, DEFAULT_LABEL_SCAN_PROMPT, DEFAULT_IMPORT_LOOKUP_PROMPT, DEFAULT_TEXT_SEARCH_PROMPT, VALID_CHAT_MODELS };
