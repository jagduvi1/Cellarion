/**
 * AI cellar chat — RAG pipeline.
 *
 * Flow
 * ----
 * 1. Embed the user's question with Voyage AI.
 * 2. Query Qdrant for the most similar wine vectors (active index version).
 * 3. Cross-reference with the user's active Bottle collection to keep only
 *    wines they actually own, and enrich with bottle metadata (vintage, notes).
 * 4. Build a grounded prompt and call Claude to generate the recommendation.
 * 5. Return the Claude answer plus the matched wine list.
 *
 * If no matching wines are found in the user's cellar, Claude is told to say
 * so — it never invents wines the user doesn't own.
 */

const aiConfig = require('../config/aiConfig');
const { embedSingle } = require('./embedding');
const vectorStore = require('./vectorStore');
const Bottle = require('../models/Bottle');

// ── Claude client (reuse the @anthropic-ai/sdk already in package.json) ────

function getClaudeClient() {
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default ?? sdk;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Wine matching ──────────────────────────────────────────────────────────

/**
 * Given Qdrant hits (each carrying wineDefinitionId + vintage in payload),
 * return the subset that the user actually owns as active bottles.
 * Preserves Qdrant score ordering.
 *
 * @param {string} userId
 * @param {Array<{ id, score, payload }>} hits
 * @param {number} maxResults
 * @returns {Promise<Array>}
 */
async function filterToUserCellar(userId, hits, maxResults) {
  if (!hits.length) return [];

  // Build lookup: "wineDefinitionId|vintage" → qdrant score
  const scoreMap = new Map();
  const wineDefIds = [];
  for (const hit of hits) {
    const key = `${hit.payload.wineDefinitionId}|${hit.payload.vintage}`;
    if (!scoreMap.has(key)) {
      scoreMap.set(key, hit.score);
      wineDefIds.push(hit.payload.wineDefinitionId);
    }
  }

  // Fetch active bottles the user owns for those wine definitions
  const bottles = await Bottle.find({
    user: userId,
    status: 'active',
    wineDefinition: { $in: wineDefIds }
  })
    .populate('wineDefinition', 'name producer type appellation region country grapes')
    .populate('wineDefinition.region', 'name')
    .populate('wineDefinition.country', 'name')
    .lean();

  if (!bottles.length) return [];

  // Attach Qdrant score and sort by score descending
  const scored = bottles.map(b => {
    const key = `${b.wineDefinition._id}|${b.vintage}`;
    return { bottle: b, score: scoreMap.get(key) ?? 0 };
  });
  scored.sort((a, b) => b.score - a.score);

  // Deduplicate by (wineDefinition, vintage) — keep highest-scored bottle per pair
  const seen = new Set();
  const deduplicated = [];
  for (const { bottle, score } of scored) {
    const key = `${bottle.wineDefinition._id}|${bottle.vintage}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push({ bottle, score });
    }
    if (deduplicated.length >= maxResults) break;
  }

  return deduplicated;
}

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are a sommelier assistant for Cellarion, a personal wine cellar app.
Your job is to recommend wines from the user's own cellar based on their question.

Rules:
- Recommend ONLY wines from the list provided below the user's question.
- If none of the listed wines suit the question, say so clearly and briefly.
- Keep the answer concise: 2–3 sentences per wine, explaining why it matches.
- Do not invent or mention wines that are not in the list.
- Use a friendly, knowledgeable tone — as if speaking to the cellar owner.`;
}

function formatWineList(matches) {
  return matches.map(({ bottle, score }, i) => {
    const w = bottle.wineDefinition;
    const regionStr = w.region?.name || w.appellation || '';
    const grapeStr = (w.grapes || []).filter(g => g.name).map(g => g.name).join(', ');
    const noteStr = bottle.notes ? `\n   Notes: "${bottle.notes}"` : '';
    const scoreStr = `(relevance: ${(score * 100).toFixed(0)}%)`;
    return [
      `${i + 1}. ${w.name} ${bottle.vintage} — ${w.producer}`,
      regionStr ? `   Region: ${regionStr}` : null,
      grapeStr ? `   Grapes: ${grapeStr}` : null,
      w.type ? `   Style: ${w.type}` : null,
      `   ${scoreStr}${noteStr}`
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Answer the user's wine question using only their cellar.
 *
 * @param {string} userId  – MongoDB ObjectId string
 * @param {string} message – natural-language question from the user
 * @returns {Promise<{ answer: string, wines: object[] }>}
 */
async function chat(userId, message) {
  const cfg = aiConfig.get();

  if (!cfg.chatEnabled) {
    throw Object.assign(new Error('AI chat is currently disabled'), { status: 503 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not configured'), { status: 503 });
  }
  if (!process.env.VOYAGE_API_KEY) {
    throw Object.assign(new Error('VOYAGE_API_KEY is not configured'), { status: 503 });
  }

  // 1. Embed the question
  const queryVector = await embedSingle(message, { model: cfg.embeddingModel });

  // 2. Vector search
  const hits = await vectorStore.searchSimilar(cfg.vectorIndex, queryVector, cfg.chatTopK);

  // 3. Filter to user's cellar
  const matches = await filterToUserCellar(userId, hits, cfg.chatMaxResults);

  // 4. Build prompt
  const wineSection = matches.length
    ? `Available wines from the user's cellar:\n\n${formatWineList(matches)}`
    : 'The user has no wines in their cellar that match this query.';

  const userMessage = `${message}\n\n---\n${wineSection}`;

  // 5. Call Claude
  const client = getClaudeClient();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: userMessage }]
  });

  const answer = response.content[0]?.text ?? '';

  // 6. Shape the wine list for the frontend (strip internal score)
  const wines = matches.map(({ bottle }) => ({
    bottleId: bottle._id,
    wineDefinitionId: bottle.wineDefinition._id,
    name: bottle.wineDefinition.name,
    producer: bottle.wineDefinition.producer,
    type: bottle.wineDefinition.type,
    vintage: bottle.vintage,
    region: bottle.wineDefinition.region?.name || bottle.wineDefinition.appellation || null,
    grapes: (bottle.wineDefinition.grapes || []).filter(g => g.name).map(g => g.name),
    notes: bottle.notes || null
  }));

  return { answer, wines };
}

module.exports = { chat };
