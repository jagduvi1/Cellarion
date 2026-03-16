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
const WineVintagePrice = require('../models/WineVintagePrice');
const { classifyMaturity, buildProfileMap, maturityLabel } = require('../utils/maturityUtils');

// ── Claude client (reuse the @anthropic-ai/sdk already in package.json) ────
// Lazily instantiated so the module can load even when ANTHROPIC_API_KEY is not set yet.

let _claudeClient = null;
function getClaudeClient() {
  if (!_claudeClient) {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default ?? sdk;
    _claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _claudeClient;
}

// ── In-memory event log (ring buffer, survives until restart) ─────────────
const MAX_LOG_ENTRIES = 100;
const _eventLog = [];

function logEvent(entry) {
  _eventLog.push({ ...entry, timestamp: new Date().toISOString() });
  if (_eventLog.length > MAX_LOG_ENTRIES) _eventLog.shift();
}

function getEventLog() {
  return _eventLog.slice().reverse(); // newest first
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
  return aiConfig.get().chatSystemPrompt;
}

function formatWineList(matches, { profileMap, countMap, priceMap } = {}) {
  return matches.map(({ bottle, score }, i) => {
    const w = bottle.wineDefinition;
    const wdId = w._id?.toString();
    const key = `${wdId}:${bottle.vintage}`;
    const regionStr = w.region?.name || w.appellation || '';
    const grapeStr = (w.grapes || []).filter(g => g.name).map(g => g.name).join(', ');
    const noteStr = bottle.notes ? `\n   Notes: "${bottle.notes}"` : '';
    const scoreStr = `(relevance: ${(score * 100).toFixed(0)}%)`;

    // Enrichment: bottle count
    const count = countMap?.get(key);
    const countStr = count ? `   Bottles: ${count}` : null;

    // Enrichment: maturity status
    const profile = profileMap?.get(key);
    const maturityStatus = profileMap ? classifyMaturity(bottle, profileMap) : null;
    const maturityStr = maturityLabel(maturityStatus, profile);

    // Enrichment: user's purchase price
    const purchaseStr = bottle.price ? `   Your price: ${bottle.currency || 'USD'} ${bottle.price}` : null;

    // Enrichment: market price
    const marketPrice = priceMap?.get(key);
    const marketStr = marketPrice ? `   Market value: ${marketPrice.currency} ${marketPrice.price}` : null;

    // Enrichment: user rating
    const ratingStr = bottle.rating ? `   Your rating: ${bottle.rating}/${bottle.ratingScale || '5'}` : null;

    return [
      `${i + 1}. ${w.name} ${bottle.vintage} — ${w.producer}`,
      regionStr ? `   Region: ${regionStr}` : null,
      grapeStr ? `   Grapes: ${grapeStr}` : null,
      w.type ? `   Style: ${w.type}` : null,
      countStr,
      maturityStr ? `   Maturity: ${maturityStr}` : null,
      purchaseStr,
      marketStr,
      ratingStr,
      `   ${scoreStr}${noteStr}`
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

/**
 * Batch-fetch enrichment data for a set of matched wines.
 * Queries profiles, prices, and bottle counts in parallel.
 */
async function fetchEnrichmentData(userId, matches) {
  if (!matches.length) return { profileMap: new Map(), countMap: new Map(), priceMap: new Map() };

  const bottles = matches.map(m => m.bottle);
  const wineDefIds = [...new Set(bottles.map(b => b.wineDefinition._id?.toString()).filter(Boolean))];

  const [profileMap, countResults, priceResults] = await Promise.all([
    // Maturity profiles
    buildProfileMap(bottles),

    // Bottle counts per (wineDefinition, vintage)
    Bottle.aggregate([
      { $match: { user: userId, status: 'active', wineDefinition: { $in: wineDefIds.map(id => require('mongoose').Types.ObjectId.createFromHexString(id)) } } },
      { $group: { _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' }, count: { $sum: 1 } } }
    ]),

    // Latest market prices
    WineVintagePrice.aggregate([
      { $match: { wineDefinition: { $in: wineDefIds.map(id => require('mongoose').Types.ObjectId.createFromHexString(id)) } } },
      { $sort: { setAt: -1 } },
      { $group: { _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' }, price: { $first: '$price' }, currency: { $first: '$currency' } } }
    ]),
  ]);

  // Build count map: "wdId:vintage" → count
  const countMap = new Map();
  for (const r of countResults) {
    countMap.set(`${r._id.wineDefinition.toString()}:${r._id.vintage}`, r.count);
  }

  // Build price map: "wdId:vintage" → { price, currency }
  const priceMap = new Map();
  for (const r of priceResults) {
    priceMap.set(`${r._id.wineDefinition.toString()}:${r._id.vintage}`, { price: r.price, currency: r.currency || 'USD' });
  }

  return { profileMap, countMap, priceMap };
}


// ── Query expansion ────────────────────────────────────────────────────────

/**
 * Rewrites the user's question into rich wine-search terminology using Claude
 * Haiku. This dramatically improves Qdrant embedding matches for vague or
 * food-focused questions.
 *
 * When `hasHistory` is true, also classifies whether the follow-up message
 * requires a new vector search or can reuse the existing wine context.
 *
 * @param {string} message – the user's current message
 * @param {boolean} hasHistory – whether there are prior conversation turns
 * @returns {Promise<{ searchQuery: string, needsNewSearch: boolean }>}
 */
async function expandQuery(message, hasHistory = false) {
  const cfg = aiConfig.get();
  const client = getClaudeClient();

  // First message or no history — always search, use the original expansion prompt
  const systemPrompt = hasHistory
    ? `You are a wine search assistant. Given a conversation follow-up message, do TWO things:
1. Decide if this message requires a NEW wine search (topic change, different wine style/color/food/occasion) or can REUSE the existing wine context (refinement like "cheaper", "tell me more", quantity change like "for more people", follow-up about a previously suggested wine). Output "SEARCH: yes" or "SEARCH: no" on the first line.
2. If SEARCH is yes, rewrite the question into rich wine-search terminology (style, body, tannins, acidity, grape varieties, regions, food context) on the second line. If SEARCH is no, output "REUSE" on the second line.
Reply with ONLY these two lines, no explanation. Always reply in English regardless of the language the user wrote in.`
    : `You are a wine search assistant. Rewrite the user's question into rich wine-search terminology: wine style, body, tannins, acidity, typical grape varieties, regions, and food context. Reply with ONLY the expanded search terms as a single line, no explanation, no labels. Always reply in English regardless of the language the user wrote in.`;

  const callParams = {
    max_tokens: 120,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }]
  };

  try {
    const response = await client.messages.create({ ...callParams, model: cfg.chatModel });
    const text = response.content[0]?.text?.trim();
    if (!text) return { searchQuery: message, needsNewSearch: true };
    return parseExpandResult(text, message, hasHistory);
  } catch (err) {
    // If primary failed and a fallback is configured, try the fallback
    const canFallback = cfg.chatModelFallback && cfg.chatModelFallback !== cfg.chatModel;
    const isRetryable = [429, 500, 502, 503, 529].includes(err.status)
      || err.error?.type === 'overloaded_error';
    logEvent({
      phase: 'query-expansion',
      primaryModel: cfg.chatModel,
      status: err.status || null,
      errorType: err.error?.type || null,
      errorMessage: err.message || null,
      fallbackAttempted: isRetryable && canFallback,
      fallbackModel: canFallback ? cfg.chatModelFallback : null,
    });
    if (isRetryable && canFallback) {
      try {
        const response = await client.messages.create({ ...callParams, model: cfg.chatModelFallback });
        const text = response.content[0]?.text?.trim();
        _eventLog[_eventLog.length - 1].fallbackResult = 'ok';
        if (!text) return { searchQuery: message, needsNewSearch: true };
        return parseExpandResult(text, message, hasHistory);
      } catch (fbErr) {
        _eventLog[_eventLog.length - 1].fallbackResult = 'failed';
        _eventLog[_eventLog.length - 1].fallbackStatus = fbErr.status || null;
        _eventLog[_eventLog.length - 1].fallbackError = fbErr.message || null;
        return { searchQuery: message, needsNewSearch: true };
      }
    }
    // Expansion is best-effort — fall back to original question, always search
    return { searchQuery: message, needsNewSearch: true };
  }
}

/**
 * Parse the expand/classify response. For first messages (no history) the
 * response is a single line (expanded query). For follow-ups it's two lines:
 *   SEARCH: yes/no
 *   <expanded query or REUSE>
 */
function parseExpandResult(text, originalMessage, hasHistory) {
  if (!hasHistory) {
    return { searchQuery: text, needsNewSearch: true };
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const searchLine = (lines[0] || '').toUpperCase();
  const needsNewSearch = !searchLine.includes('SEARCH: NO');
  const searchQuery = needsNewSearch
    ? (lines[1] && lines[1].toUpperCase() !== 'REUSE' ? lines[1] : originalMessage)
    : originalMessage;

  return { searchQuery, needsNewSearch };
}

// ── Shared pipeline (used by both chat and chatStream) ────────────────────

/**
 * Prepare the chat context: expand query, search, filter, enrich.
 * Returns everything needed to call Claude.
 */
async function _prepareChatContext(userId, message, { useQueryExpansion = true, history = [], previousWines = null } = {}) {
  const cfg = aiConfig.get();

  if (!cfg.chatEnabled) {
    throw Object.assign(new Error('AI chat is currently disabled'), { status: 503 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not configured'), { status: 503 });
  }

  const hasHistory = history.length > 0;

  // 1. Expand query and classify whether a new search is needed
  let searchQuery = message;
  let needsNewSearch = true;

  if (useQueryExpansion) {
    const result = await expandQuery(message, hasHistory);
    searchQuery = result.searchQuery;
    needsNewSearch = result.needsNewSearch;
  }

  // If we decided to reuse but have no previous context, force a new search
  if (!needsNewSearch && !previousWines) {
    needsNewSearch = true;
  }

  // 2. Either perform vector search or reuse previous wine context
  let wineSection;
  let matches = [];

  if (needsNewSearch) {
    if (!process.env.VOYAGE_API_KEY) {
      throw Object.assign(new Error('VOYAGE_API_KEY is not configured'), { status: 503 });
    }
    const queryVector = await embedSingle(searchQuery, { model: cfg.embeddingModel });
    const hits = await vectorStore.searchSimilar(cfg.vectorIndex, queryVector, cfg.chatTopK);
    matches = await filterToUserCellar(userId, hits, cfg.chatMaxResults);

    // Enrich matches with maturity, price, and count data
    const enrichment = await fetchEnrichmentData(userId, matches);

    wineSection = matches.length
      ? `Available wines from the user's cellar:\n\n${formatWineList(matches, enrichment)}`
      : 'The user has no wines in their cellar that match this query.';
  } else {
    wineSection = previousWines;
  }

  // 3. Build multi-turn messages array
  const maxTurns = cfg.chatMaxHistoryTurns || 10;
  const trimmedHistory = history.slice(-maxTurns);

  const claudeMessages = [];
  for (const turn of trimmedHistory) {
    claudeMessages.push({ role: turn.role, content: turn.content });
  }
  claudeMessages.push({ role: 'user', content: `${message}\n\n---\n${wineSection}` });

  // 4. Shape the wine list for the frontend (only when a new search was done)
  const wines = needsNewSearch
    ? matches.map(({ bottle }) => ({
        bottleId: bottle._id,
        wineDefinitionId: bottle.wineDefinition._id,
        name: bottle.wineDefinition.name,
        producer: bottle.wineDefinition.producer,
        type: bottle.wineDefinition.type,
        vintage: bottle.vintage,
        region: bottle.wineDefinition.region?.name || bottle.wineDefinition.appellation || null,
        grapes: (bottle.wineDefinition.grapes || []).filter(g => g.name).map(g => g.name),
        notes: bottle.notes || null
      }))
    : [];

  const callParams = {
    max_tokens: cfg.chatMaxTokens || 800,
    system: buildSystemPrompt(),
    messages: claudeMessages,
  };

  return {
    cfg,
    callParams,
    wines,
    searchQuery,
    needsNewSearch,
    wineSection,
    useQueryExpansion,
  };
}

// ── Main entry point (non-streaming) ──────────────────────────────────────

async function chat(userId, message, opts = {}) {
  const { cfg, callParams, wines, searchQuery, needsNewSearch, wineSection, useQueryExpansion } =
    await _prepareChatContext(userId, message, opts);

  const client = getClaudeClient();
  let response;
  try {
    response = await client.messages.create({ ...callParams, model: cfg.chatModel });
  } catch (err) {
    const canFallback = cfg.chatModelFallback && cfg.chatModelFallback !== cfg.chatModel;
    const isRetryable = [429, 500, 502, 503, 529].includes(err.status)
      || err.error?.type === 'overloaded_error';
    logEvent({
      phase: 'chat',
      primaryModel: cfg.chatModel,
      status: err.status || null,
      errorType: err.error?.type || null,
      errorMessage: err.message || null,
      fallbackAttempted: isRetryable && canFallback,
      fallbackModel: canFallback ? cfg.chatModelFallback : null,
    });
    if (isRetryable && canFallback) {
      console.warn(`[aiChat] Primary model failed (${cfg.chatModel}, status ${err.status}), retrying with fallback: ${cfg.chatModelFallback}`);
      try {
        response = await client.messages.create({ ...callParams, model: cfg.chatModelFallback });
        _eventLog[_eventLog.length - 1].fallbackResult = 'ok';
      } catch (fbErr) {
        _eventLog[_eventLog.length - 1].fallbackResult = 'failed';
        _eventLog[_eventLog.length - 1].fallbackStatus = fbErr.status || null;
        _eventLog[_eventLog.length - 1].fallbackError = fbErr.message || null;
        throw fbErr;
      }
    } else {
      throw err;
    }
  }

  const answer = response.content[0]?.text ?? '';
  const usage = {
    inputTokens:  response.usage?.input_tokens  ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };

  return {
    answer,
    wines,
    expandedQuery: useQueryExpansion && needsNewSearch ? searchQuery : null,
    usage,
    searchPerformed: needsNewSearch,
    wineContext: wineSection,
  };
}

// ── Streaming entry point (SSE) ───────────────────────────────────────────

/**
 * Stream the chat response via SSE events written to an Express response.
 *
 * Events sent:
 *   meta  – { wines, expandedQuery, searchPerformed, wineContext }
 *   delta – { text }  (each token as it arrives)
 *   done  – { usage }
 *   error – { error }
 */
async function chatStream(userId, message, opts, res) {
  const { cfg, callParams, wines, searchQuery, needsNewSearch, wineSection, useQueryExpansion } =
    await _prepareChatContext(userId, message, opts);

  // Send metadata before streaming starts
  _sseWrite(res, 'meta', {
    wines,
    expandedQuery: useQueryExpansion && needsNewSearch ? searchQuery : null,
    searchPerformed: needsNewSearch,
    wineContext: wineSection,
  });

  const client = getClaudeClient();

  // Try primary model, fallback if it fails before any tokens
  let stream;
  try {
    stream = client.messages.stream({ ...callParams, model: cfg.chatModel });
  } catch (err) {
    const canFallback = cfg.chatModelFallback && cfg.chatModelFallback !== cfg.chatModel;
    const isRetryable = [429, 500, 502, 503, 529].includes(err.status)
      || err.error?.type === 'overloaded_error';
    if (isRetryable && canFallback) {
      stream = client.messages.stream({ ...callParams, model: cfg.chatModelFallback });
    } else {
      throw err;
    }
  }

  return new Promise((resolve, reject) => {
    let aborted = false;

    res.on('close', () => {
      aborted = true;
      stream.abort?.();
    });

    stream.on('text', (textDelta) => {
      if (!aborted) {
        _sseWrite(res, 'delta', { text: textDelta });
      }
    });

    stream.on('finalMessage', (msg) => {
      if (!aborted) {
        const usage = {
          inputTokens:  msg.usage?.input_tokens  ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
        };
        _sseWrite(res, 'done', { usage });
        res.end();
      }
      resolve({ usage: { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 } });
    });

    stream.on('error', (err) => {
      if (!aborted) {
        _sseWrite(res, 'error', { error: err.message || 'Stream error' });
        res.end();
      }
      reject(err);
    });
  });
}

/** Write a single SSE event to the response. */
function _sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = { chat, chatStream, getEventLog };
