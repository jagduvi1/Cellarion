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

const mongoose = require('mongoose');
const aiConfig = require('../config/aiConfig');
const { textFromResponse, thinkingOff } = require('../utils/aiResponse');
const { embedSingle, isEmbeddingConfigured } = require('./embedding');
const vectorStore = require('./vectorStore');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineVintagePrice = require('../models/WineVintagePrice');
const { classifyMaturity, buildProfileMap, maturityLabel } = require('../utils/maturityUtils');

// ── LLM client ──────────────────────────────────────────────────────────────
// Provider-selected (Anthropic by default, OpenAI-compatible for self-hosters
// via AI_PROVIDER=openai) — see services/aiProvider.js. Both providers expose
// the same messages.create / messages.stream surface used below.

const aiProvider = require('./aiProvider');

// aiConfig.get() returns provider-resolved model names (in openai mode the
// fallback resolves to the same AI_MODEL as the primary), so comparing the
// cfg values directly is enough to disable a pointless same-model "fallback".
function canFallbackTo(cfg) {
  return !!cfg.chatModelFallback && cfg.chatModelFallback !== cfg.chatModel;
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
/**
 * The cellars that ARE the user's cellar right now.
 *
 * Deleting a cellar is a SOFT delete — the bottles keep `deletedAt: null` so a
 * restore can bring them back — so scoping bottles by `user` alone counts wine
 * the user believes they threw away. Support ticket 6a86268f (2026-08-20): a
 * user with 71 bottles was told they owned 779, because four deleted cellars
 * still held 708. On prod that day: 8 deleted cellars, 1,266 live bottles, 4
 * users, one of whom has an EMPTY cellar and was being quoted 132.
 *
 * Every sibling surface already does this (insightsService, mcp/tools/stats,
 * routes/stats, the analytics engine's deriveScope); the chat was the one that
 * did not. Members are included because a bottle can live in a cellar shared
 * with the user, exactly as deriveScope treats it.
 *
 * @returns {Promise<Array>} always an ARRAY — an empty one means "no live
 *   cellars", which must still filter everything out rather than mean "no
 *   filter". Callers therefore test `Array.isArray`, never truthiness.
 */
async function liveCellarIds(userId, requested) {
  const live = await Cellar.find({
    deletedAt: null,
    $or: [{ user: userId }, { 'members.user': userId }],
  }).distinct('_id');
  if (!requested?.length) return live;
  const liveSet = new Set(live.map(String));
  return requested.filter((id) => liveSet.has(String(id)));
}

async function filterToUserCellar(userId, hits, maxResults, { cellarIds } = {}) {
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
  const bottleFilter = {
    user: userId,
    status: 'active',
    wineDefinition: { $in: wineDefIds }
  };
  // Array.isArray, not truthiness: an EMPTY list means the user has no live
  // cellars and must match nothing. Treating it as "no filter" would list
  // bottles from cellars they deleted (ticket 6a86268f).
  if (Array.isArray(cellarIds)) {
    bottleFilter.cellar = { $in: cellarIds };
  }
  // Region/country/grapes are refs on the wine definition, so they must be
  // populated through it — dotted top-level populate paths ('wineDefinition.
  // region') can't cross the ref boundary and silently assign nothing.
  const bottles = await Bottle.find(bottleFilter)
    .populate({
      path: 'wineDefinition',
      select: 'name producer type appellation region country grapes',
      populate: [
        { path: 'region', select: 'name' },
        { path: 'country', select: 'name' },
        { path: 'grapes', select: 'name' }
      ]
    })
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

    // Enrichment: maturity status. Pass the bottle so the label quotes the
    // PERSONAL drink-window years when that window governs the status (else the
    // profile years would contradict a personal not-ready/peak/declining).
    const profile = profileMap?.get(key);
    const maturityStatus = profileMap ? classifyMaturity(bottle, profileMap) : null;
    const maturityStr = maturityLabel(maturityStatus, profile, bottle);

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
// scopedCellarIds: the caller's live-cellar list. The per-wine "you have N
// bottles" counts below must be scoped the same way as everything else, or a
// wine shown once would report the total including deleted cellars.
async function fetchEnrichmentData(userId, matches, scopedCellarIds = null) {
  if (!matches.length) return { profileMap: new Map(), countMap: new Map(), priceMap: new Map() };

  const bottles = matches.map(m => m.bottle);
  const wineDefIds = [...new Set(bottles.map(b => b.wineDefinition._id?.toString()).filter(Boolean))];
  // Aggregation pipelines are not casted by Mongoose — every id (including
  // the JWT-string userId) must be an ObjectId or the $match finds nothing.
  const wineDefObjectIds = wineDefIds.map(id => mongoose.Types.ObjectId.createFromHexString(id));

  const [profileMap, countResults, priceResults] = await Promise.all([
    // Maturity profiles
    buildProfileMap(bottles),

    // Bottle counts per (wineDefinition, vintage)
    Bottle.aggregate([
      { $match: {
        user: new mongoose.Types.ObjectId(String(userId)),
        status: 'active',
        wineDefinition: { $in: wineDefObjectIds },
        ...(Array.isArray(scopedCellarIds) ? { cellar: { $in: scopedCellarIds } } : {}),
      } },
      { $group: { _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' }, count: { $sum: 1 } } }
    ]),

    // Latest market prices
    WineVintagePrice.aggregate([
      { $match: { wineDefinition: { $in: wineDefObjectIds } } },
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
  const client = aiProvider.getChatClient();

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
    const response = await client.messages.create({ ...callParams, model: cfg.chatModel, ...thinkingOff(cfg.chatModel) });
    const text = textFromResponse(response);
    if (!text) return { searchQuery: message, needsNewSearch: true };
    return parseExpandResult(text, message, hasHistory);
  } catch (err) {
    // If primary failed and a fallback is configured, try the fallback
    const canFallback = canFallbackTo(cfg);
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
        const response = await client.messages.create({ ...callParams, model: cfg.chatModelFallback, ...thinkingOff(cfg.chatModelFallback) });
        const text = textFromResponse(response);
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
async function _prepareChatContext(userId, message, { useQueryExpansion = true, history = [], previousWines = null, cellarIds = null } = {}) {
  const cfg = aiConfig.get();

  if (!cfg.chatEnabled) {
    throw Object.assign(new Error('AI chat is currently disabled'), { status: 503 });
  }
  aiProvider.assertConfigured(); // throws 503 when the active AI provider lacks config

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
    if (!isEmbeddingConfigured()) {
      throw Object.assign(new Error('Embeddings are not configured on this server'), { status: 503 });
    }

    // Restrict Qdrant search to wines the user actually owns. Without this,
    // top-K is pulled from the global catalogue and small cellars get filtered
    // out entirely (see issue #386).
    // Resolved ONCE and threaded through everything below, so the count, the
    // vector pre-filter and the wine list cannot disagree with each other —
    // which is the same invariant the HONEST SCOPING note further down cares
    // about, just applied to which cellars exist rather than how many wines
    // are shown.
    const scopedCellarIds = await liveCellarIds(userId, cellarIds);
    const bottleScope = { user: userId, status: 'active', cellar: { $in: scopedCellarIds } };
    const userWineDefIds = await Bottle.distinct('wineDefinition', bottleScope);

    let hits = [];
    if (userWineDefIds.length) {
      const queryVector = await embedSingle(searchQuery, { model: cfg.embeddingModel });
      hits = await vectorStore.searchSimilar(cfg.vectorIndex, queryVector, cfg.chatTopK, {
        filter: {
          must: [{
            key: 'wineDefinitionId',
            match: { any: userWineDefIds.map(id => id.toString()) }
          }]
        }
      });
    }
    matches = await filterToUserCellar(userId, hits, cfg.chatMaxResults, { cellarIds: scopedCellarIds });

    // Enrich matches with maturity, price, and count data
    const enrichment = await fetchEnrichmentData(userId, matches, scopedCellarIds);

    // HONEST SCOPING (support ticket 2026-08-12 "IA bottles known false"): the
    // model only ever sees the chatMaxResults most relevant bottles, and
    // without the cellar's true size it presents that selection AS the cellar
    // — a user with 71 bottles concluded the AI "has knowledge only on 11".
    // State the total inside the context itself, counted on the SAME scope as
    // the search (user + active + optional cellar selection) so the number can
    // never contradict the list. The line lives in wineSection, so a reused
    // context (previousWines) carries it forward without re-counting.
    const totalActive = await Bottle.countDocuments(bottleScope);
    const scopeLine = `The user's cellar holds ${totalActive} active bottle(s)${cellarIds?.length ? ' in the selected cellar(s)' : ''} in total.`;

    if (matches.length) {
      wineSection = `${scopeLine} The ${matches.length} wine(s) below are only the most relevant to this question — NOT the whole cellar. If the user asks about their full collection (totals, inventory, "what do you know about my cellar"), quote the total above and explain you are shown a relevant selection.\n\nAvailable wines from the user's cellar:\n\n${formatWineList(matches, enrichment)}`;
    } else if (totalActive === 0) {
      wineSection = 'The user has no active bottles in their cellar.';
    } else {
      // Empty SEARCH, non-empty CELLAR — without the distinction the model
      // told users their cellar had nothing in it.
      wineSection = `${scopeLine} None of them matched this question semantically — the cellar is not empty, this search just surfaced no relevant bottles.`;
    }
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
        cellarId: bottle.cellar,
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

  const client = aiProvider.getChatClient();
  let response;
  try {
    response = await client.messages.create({ ...callParams, model: cfg.chatModel, ...thinkingOff(cfg.chatModel) });
  } catch (err) {
    const canFallback = canFallbackTo(cfg);
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
        response = await client.messages.create({ ...callParams, model: cfg.chatModelFallback, ...thinkingOff(cfg.chatModelFallback) });
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

  const answer = textFromResponse(response);
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

  const client = aiProvider.getChatClient();

  // messages.stream() returns synchronously and reports HTTP failures via the
  // 'error' event (never by throwing), so the model fallback has to live in
  // the error handler: retry once on the fallback model if the primary fails
  // before any tokens were emitted.
  const canFallback = canFallbackTo(cfg);

  return new Promise((resolve, reject) => {
    let aborted = false;
    let receivedText = false;
    let stream;

    const runStream = (model, allowFallback) => {
      stream = client.messages.stream({ ...callParams, model, ...thinkingOff(model) });

      stream.on('text', (textDelta) => {
        receivedText = true;
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
        const isRetryable = [429, 500, 502, 503, 529].includes(err.status)
          || err.error?.type === 'overloaded_error';
        if (allowFallback && isRetryable && !receivedText && !aborted) {
          runStream(cfg.chatModelFallback, false);
          return;
        }
        if (!aborted) {
          _sseWrite(res, 'error', { error: err.message || 'Stream error' });
          res.end();
        }
        reject(err);
      });

      // An aborted stream emits 'abort' — NOT 'error' — and with no listener
      // the SDK turns it into an unhandled promise rejection (process-fatal
      // under Node's default policy). It also means neither 'finalMessage'
      // nor 'error' fires, so without this the promise never settles and the
      // caller's finally (concurrency-slot release) never runs.
      stream.on('abort', () => {
        resolve({ usage: null, aborted: true });
      });
    };

    res.on('close', () => {
      aborted = true;
      stream?.abort?.();
    });

    runStream(cfg.chatModel, canFallback);
  });
}

/** Write a single SSE event to the response. */
function _sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

module.exports = { chat, chatStream, getEventLog };
