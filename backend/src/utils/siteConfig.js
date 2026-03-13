const SiteConfig = require('../models/SiteConfig');

/**
 * Upsert a SiteConfig document by key.
 * Centralises the repeated findOneAndUpdate pattern used across admin routes.
 *
 * @param {string}   key       - The config key (e.g. 'aiConfig', 'rateLimits')
 * @param {*}        value     - The value to store
 * @param {string}   updatedBy - The user ID performing the update
 * @returns {Promise<Document>} The updated (or created) SiteConfig document
 */
async function updateSiteConfig(key, value, updatedBy) {
  return SiteConfig.findOneAndUpdate(
    { key },
    { $set: { value, updatedAt: new Date(), updatedBy } },
    { upsert: true, new: true }
  );
}

module.exports = { updateSiteConfig };
