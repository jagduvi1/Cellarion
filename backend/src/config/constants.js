/**
 * Shared application-wide constants.
 * Import from here instead of re-declaring in each file.
 */

// Bottle statuses that indicate the bottle has been removed from the active cellar
const CONSUMED_STATUSES = ['drank', 'gifted', 'sold', 'other'];

// Milliseconds in a single day — used for drink-window calculations
const MS_PER_DAY = 86400000;

// Standard Mongoose populate shape for WineDefinition — used across bottles, cellars, stats
const WINE_POPULATE = { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] };

module.exports = { CONSUMED_STATUSES, MS_PER_DAY, WINE_POPULATE };
