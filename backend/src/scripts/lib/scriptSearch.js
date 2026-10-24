/**
 * Meilisearch for a standalone script.
 *
 * services/search only talks to Meilisearch after initialize(), which the
 * server runs at boot and a script does not: until then indexWine, removeWine
 * and fullSync return without doing anything, and the script's "reindexed"
 * line is untrue. initSearch() runs it for a script, without the server's
 * boot-time background sync, and waits for it to finish.
 *
 * indexWine and fullSync populate a wine's country, region and grapes, so
 * those models are registered here: a script that requires only
 * WineDefinition would otherwise fail every index call with "Schema hasn't
 * been registered for model Country", logged and swallowed inside indexWine.
 *
 * Usage, after mongoose.connect and before the first index call:
 *   const searchOk = await initSearch({ label: 'my-script' });
 *   ...
 *   if (searchOk) await searchService.indexWine(wine._id);
 */

require('../../models/Country');
require('../../models/Region');
require('../../models/Grape');
const searchService = require('../../services/search');

/**
 * @param {{ label?: string }} [opts] label prefixes the warning (the script's name)
 * @returns {Promise<boolean>} whether Meilisearch is available for index calls
 */
async function initSearch({ label = 'script' } = {}) {
  await searchService.initialize({ sync: false });
  const ok = searchService.getIsAvailable();
  if (!ok) {
    console.warn(`[${label}] Meilisearch unavailable — index updates skipped; run POST /api/admin/search/reindex afterwards.`);
  }
  return ok;
}

module.exports = { initSearch };
