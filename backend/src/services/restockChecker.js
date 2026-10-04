const Bottle = require('../models/Bottle');
const RestockAlert = require('../models/RestockAlert');
const User = require('../models/User');
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
 *  1. Get the consumed wine's embedding
 *  2. Check whether the user still has a similar wine in their cellar
 *  3. If not, find the registry's closest wines (they resolve the alert later)
 *  4. Save the alert and send a notification suggesting they restock
 *
 * Fire-and-forget — errors are caught and logged, never thrown.
 */
async function runCheck(userId, bottleId, cellarId) {
  try {
    // Check if embedding infra is available
    if (!embedding || !vectorStore) return;
    if (!embedding.isEmbeddingConfigured()) return;

    const user = await User.findById(userId).select('username displayName preferences.restockScope').lean();
    if (!user) return;

    // Get the consumed bottle with wine definition
    const bottle = await Bottle.findById(bottleId)
      .populate({ path: 'wineDefinition', populate: ['country', 'region', 'grapes'] })
      .lean();

    if (!bottle?.wineDefinition) return;

    const wine = bottle.wineDefinition;
    const vintage = bottle.vintage || 'NV';

    const aiConfig = require('../config/aiConfig');
    const cfg = aiConfig.get();
    const model = cfg.embeddingModel;
    const indexVersion = cfg.vectorIndex || 'v1';

    // The drunk wine's stored vector (free), else embed it (one Voyage call).
    let queryVector = await vectorStore.getVector(wine._id, vintage, { model, indexVersion });
    if (!queryVector) {
      const searchText = embedding.buildEmbeddingText(wine, vintage);
      queryVector = await embedding.embedSingle(searchText, { model });
    }
    if (!queryVector) return;

    // 1. Does the user still have something similar? Compare with every wine
    //    left in their cellar(s) — not only the registry's ten closest, which
    //    are mostly this wine's other vintages, so a similar bottle the user
    //    did own could be missed and the alert fired anyway.
    // Scope: 'cellar' = only check the cellar the bottle came from;
    //        'all' (default) = check across all user's cellars.
    const scope = user.preferences?.restockScope || 'all';
    // Bottles on order count here on purpose: a similar wine already bought
    // and on its way is no reason to suggest restocking.
    const activeQuery = {
      user: userId,
      wineDefinition: { $ne: null },
      status: { $nin: CONSUMED_STATUSES }
    };
    if (scope === 'cellar' && cellarId) {
      activeQuery.cellar = cellarId;
    }
    const ownedWineIds = await Bottle.distinct('wineDefinition', activeQuery);
    if (ownedWineIds.length) {
      const owned = await vectorStore.search(queryVector, {
        model, indexVersion, wineIds: ownedWineIds, limit: 1, minScore: SIMILARITY_THRESHOLD,
      });
      if (owned.length) return; // User still has a similar wine — no alert needed
    }

    // 2. The registry's closest wines (one per wine): what resolves the alert
    //    again when the user adds one of them. None above the threshold means
    //    nothing is really like it — no alert, as before.
    const hits = await vectorStore.search(queryVector, {
      model, indexVersion, limit: TOP_K, minScore: SIMILARITY_THRESHOLD, distinctWines: true,
    });
    const similarWineIds = hits.map(h => h.wineDefinitionId);
    if (similarWineIds.length === 0) return;

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

// Checks run one at a time, in order. Each one compares vectors, and a bulk
// "mark as drunk" (the REST bulk route, or an agent consuming bottle after
// bottle) must not start dozens at once — 60 in parallel once ran the
// process out of memory (review 2026-09-27). A best-effort notification, so
// a runaway queue sheds new checks instead of growing without bound.
const MAX_QUEUED = 500;
let queue = Promise.resolve();
let queued = 0;

function checkRestockGap(userId, bottleId, cellarId) {
  if (queued >= MAX_QUEUED) return Promise.resolve();
  queued += 1;
  const run = queue.then(() => runCheck(userId, bottleId, cellarId)).finally(() => { queued -= 1; });
  queue = run.catch(() => {});
  return run;
}

module.exports = { checkRestockGap, resolveRestockAlerts };
