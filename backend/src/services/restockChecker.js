const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const User = require('../models/User');
const { planHasFeature } = require('../config/plans');
const { createNotification } = require('./notifications');
const { CONSUMED_STATUSES } = require('../config/constants');

let embedding, vectorStore;
try {
  embedding = require('./embedding');
  vectorStore = require('./vectorStore');
} catch {
  // Embedding/vector services may not be configured
}

const SIMILARITY_THRESHOLD = 0.78;
const TOP_K = 10;

/**
 * Background check after a bottle is consumed.
 * If the user is on a paid plan with restockAlerts enabled:
 *  1. Get the consumed wine's embedding
 *  2. Search for similar wines in Qdrant
 *  3. Check if the user still has any similar bottles in their cellar
 *  4. If not, send a notification suggesting they restock
 *
 * Fire-and-forget — errors are caught and logged, never thrown.
 */
async function checkRestockGap(userId, bottleId) {
  try {
    // Check if embedding infra is available
    if (!embedding || !vectorStore) return;
    if (!process.env.VOYAGE_API_KEY) return;

    // Check user plan
    const user = await User.findById(userId).select('plan planExpiresAt username displayName').lean();
    if (!user) return;

    const planExpired = user.planExpiresAt && Date.now() > new Date(user.planExpiresAt).getTime();
    const effectivePlan = planExpired ? 'free' : (user.plan || 'free');
    if (!planHasFeature(effectivePlan, 'restockAlerts')) return;

    // Get the consumed bottle with wine definition
    const bottle = await Bottle.findById(bottleId)
      .populate({ path: 'wineDefinition', populate: ['country', 'region', 'grapes'] })
      .lean();

    if (!bottle?.wineDefinition) return;

    const wine = bottle.wineDefinition;
    const vintage = bottle.vintage || 'NV';

    // Check if this wine has an embedding
    const existingEmb = await WineEmbedding.findOne({
      wineDefinition: wine._id,
      vintage,
      status: 'ok'
    }).lean();

    let queryVector;

    if (existingEmb?.qdrantPointId) {
      // Use existing embedding — search Qdrant for similar wines
      const aiConfig = require('../config/aiConfig');
      const cfg = aiConfig.get();
      const indexVersion = cfg.vectorIndex || 'v1';

      // Get the vector from Qdrant
      const searchText = embedding.buildEmbeddingText(wine, vintage);
      queryVector = await embedding.embedSingle(searchText);
    } else {
      // Create embedding on the fly
      const searchText = embedding.buildEmbeddingText(wine, vintage);
      queryVector = await embedding.embedSingle(searchText);
    }

    if (!queryVector) return;

    // Search Qdrant for similar wines
    const aiConfig = require('../config/aiConfig');
    const cfg = aiConfig.get();
    const indexVersion = cfg.vectorIndex || 'v1';

    const hits = await vectorStore.searchSimilar(indexVersion, queryVector, TOP_K);
    if (!hits || hits.length === 0) return;

    // Get wine definition IDs from similar results (above threshold)
    const similarWineIds = hits
      .filter(h => h.score >= SIMILARITY_THRESHOLD)
      .map(h => h.payload?.wineDefinitionId)
      .filter(Boolean);

    if (similarWineIds.length === 0) return;

    // Check if user still has active bottles of any similar wine
    const activeCount = await Bottle.countDocuments({
      user: userId,
      wineDefinition: { $in: similarWineIds },
      status: { $nin: CONSUMED_STATUSES }
    });

    if (activeCount > 0) return; // User still has similar wines — no alert needed

    // No similar wines left — send restock notification
    const wineName = wine.name || 'a wine';
    const producer = wine.producer ? ` by ${wine.producer}` : '';

    createNotification(
      userId,
      'restock_alert',
      'Restock Suggestion',
      `You just finished your last bottle similar to ${wineName}${producer}. Time to restock?`,
      '/restock'
    );

  } catch (err) {
    console.error('[restockChecker] Error:', err.message);
  }
}

module.exports = { checkRestockGap };
