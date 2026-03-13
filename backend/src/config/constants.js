/**
 * Shared application-wide constants.
 * Import from here instead of re-declaring in each file.
 */

// Bottle statuses that indicate the bottle has been removed from the active cellar
const CONSUMED_STATUSES = ['drank', 'gifted', 'sold', 'other'];

// Milliseconds in a single day — used for drink-window calculations
const MS_PER_DAY = 86400000;

// Standard Mongoose populate shape for WineDefinition — used across bottles, cellars, stats.
// Array form also populates pendingWineRequest so pending bottles show their requested name.
const WINE_POPULATE = [
  { path: 'wineDefinition', populate: ['country', 'region', 'grapes'] },
  { path: 'pendingWineRequest', select: 'wineName producer' }
];

// ─── Import thresholds ───────────────────────────────────────────────────────

// Composite similarity score at or above which a match is considered exact
const IMPORT_EXACT_THRESHOLD = 0.95;

// Minimum composite similarity score for a candidate to be considered a fuzzy match
const IMPORT_FUZZY_THRESHOLD = 0.65;

// Maximum number of items allowed in a single import batch
const MAX_IMPORT_SIZE = 500;

// Maximum concurrent AI identification requests during import (stay under rate limits)
const AI_CONCURRENCY = 5;

// ─── Prompt length limits ────────────────────────────────────────────────────

// Maximum character length for the AI chat system prompt
const SYSTEM_PROMPT_MAX_LENGTH = 4000;

// Maximum character length for the label-scan and import-lookup prompts
const SCAN_PROMPT_MAX_LENGTH = 6000;

module.exports = {
  CONSUMED_STATUSES,
  MS_PER_DAY,
  WINE_POPULATE,
  IMPORT_EXACT_THRESHOLD,
  IMPORT_FUZZY_THRESHOLD,
  MAX_IMPORT_SIZE,
  AI_CONCURRENCY,
  SYSTEM_PROMPT_MAX_LENGTH,
  SCAN_PROMPT_MAX_LENGTH,
};
