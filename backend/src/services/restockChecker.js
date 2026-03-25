const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const RestockAlert = require('../models/RestockAlert');
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
async function checkRestockGap(userId, bottleId, cellarId) {
  try {
    // Check if embedding infra is available
    if (!embedding || !vectorStore) return;
    if (!process.env.VOYAGE_API_KEY) return;

    // Check user plan and preferences
    const user = await User.findById(userId).select('plan planExpiresAt username displayName preferences.restockScope').lean();
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

    const aiConfig = require('../config/aiConfig');
    const cfg = aiConfig.get();
    const indexVersion = cfg.vectorIndex || 'v1';

    // Try to reuse existing embedding vector from Qdrant (no API call needed)
    const existingEmb = await WineEmbedding.findOne({
      wineDefinition: wine._id,
      vintage,
      status: 'ok'
    }).lean();

    let queryVector;

    if (existingEmb?.qdrantPointId) {
      // Retrieve stored vector from Qdrant — free, no Voyage AI call
      try {
        const points = await vectorStore.getPoints(indexVersion, [existingEmb.qdrantPointId]);
        if (points.length > 0 && points[0].vector) {
          queryVector = points[0].vector;
        }
      } catch {
        // Qdrant retrieval failed — fall through to Voyage AI
      }
    }

    if (!queryVector) {
      // No cached vector — call Voyage AI to create one
      const searchText = embedding.buildEmbeddingText(wine, vintage);
      queryVector = await embedding.embedSingle(searchText);
    }

    if (!queryVector) return;

    const hits = await vectorStore.searchSimilar(indexVersion, queryVector, TOP_K);
    if (!hits || hits.length === 0) return;

    // Get wine definition IDs from similar results (above threshold)
    const similarWineIds = hits
      .filter(h => h.score >= SIMILARITY_THRESHOLD)
      .map(h => h.payload?.wineDefinitionId)
      .filter(Boolean);

    if (similarWineIds.length === 0) return;

    // Check if user still has active bottles of any similar wine.
    // Scope: 'cellar' = only check the cellar the bottle came from;
    //        'all' (default) = check across all user's cellars.
    const scope = user.preferences?.restockScope || 'all';
    const activeQuery = {
      user: userId,
      wineDefinition: { $in: similarWineIds },
      status: { $nin: CONSUMED_STATUSES }
    };
    if (scope === 'cellar' && cellarId) {
      activeQuery.cellar = cellarId;
    }

    const activeCount = await Bottle.countDocuments(activeQuery);

    if (activeCount > 0) return; // User still has similar wines — no alert needed

    // Check if there's already an active alert for this wine
    const existingAlert = await RestockAlert.findOne({
      user: userId,
      wine: wine._id,
      status: 'active'
    });
    if (existingAlert) return; // Don't duplicate

    // Persist the restock alert
    const wineName = wine.name || 'a wine';
    const producer = wine.producer || '';

    await RestockAlert.create({
      user: userId,
      wine: wine._id,
      wineName,
      wineProducer: producer,
      wineType: wine.type || '',
      vintage: vintage,
      similarWineIds
    });

    // Also send a notification pointing to the restock page
    const producerSuffix = producer ? ` by ${producer}` : '';
    createNotification(
      userId,
      'restock_alert',
      'Restock Suggestion',
      `You just finished your last bottle similar to ${wineName}${producerSuffix}. Time to restock?`,
      '/restock'
    );

  } catch (err) {
    console.error('[restockChecker] Error:', err.message);
  }
}

/**
 * Called when a new bottle is added to a cellar.
 * Checks if any active restock alerts should be auto-resolved because
 * the new wine is similar to what was flagged.
 */
async function resolveRestockAlerts(userId, wineDefinitionId, bottleId) {
  try {
    // Find active alerts where the new wine is in the similarWineIds list
    // OR where the new wine is the exact wine that triggered the alert
    const alerts = await RestockAlert.find({
      user: userId,
      status: 'active',
      $or: [
        { similarWineIds: wineDefinitionId },
        { wine: wineDefinitionId }
      ]
    });

    if (alerts.length === 0) return;

    for (const alert of alerts) {
      alert.status = 'resolved';
      alert.resolvedAt = new Date();
      alert.resolvedByBottle = bottleId;
      await alert.save();
    }
  } catch (err) {
    console.error('[restockChecker] resolveRestockAlerts error:', err.message);
  }
}

module.exports = { checkRestockGap, resolveRestockAlerts };
