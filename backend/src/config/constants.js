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

// List/stats variant of WINE_POPULATE: excludes the heavy fields no list view
// or aggregate reads (aiProfile alone is several KB of prose per wine). A page
// of 30 bottles ships the same card data at a fraction of the payload. Detail
// routes (GET /api/bottles/:id etc.) keep the full WINE_POPULATE — the bottle
// page renders aiProfile.
const WINE_POPULATE_LIST = [
  {
    path: 'wineDefinition',
    select: '-aiProfile -normalizedKey -lwin -productNumber -productNumberShort -createdBy',
    populate: ['country', 'region', 'grapes']
  },
  { path: 'pendingWineRequest', select: 'wineName producer' }
];

// ─── Import thresholds ───────────────────────────────────────────────────────

// Composite similarity score at or above which a match is considered exact
const IMPORT_EXACT_THRESHOLD = 0.95;

// Minimum composite similarity score for a candidate to be considered a fuzzy match
const IMPORT_FUZZY_THRESHOLD = 0.65;

// Maximum number of items allowed in a single import. Validation is chunked
// client-side (VALIDATE_BATCH_SIZE), so this primarily caps the one-shot
// /confirm request, whose batch-wide rack-placement coordination needs the
// full set in a single call. Sized for large real-world cellars (1000+).
const MAX_IMPORT_SIZE = 2000;

// Maximum concurrent AI identification requests during import. Combined with
// the SDK's retry/backoff (see labelScan getClient), this keeps us under
// Anthropic's rate limits while letting throttled calls wait and continue
// rather than aborting the import.
const AI_CONCURRENCY = 5;

// ─── Prompt length limits ────────────────────────────────────────────────────

// Maximum character length for the AI chat system prompt
const SYSTEM_PROMPT_MAX_LENGTH = 4000;

// Maximum character length for the label-scan and import-lookup prompts
const SCAN_PROMPT_MAX_LENGTH = 6000;

// ─── Community / Reviews ────────────────────────────────────────────────────

// Default number of reviews per page
const REVIEWS_PER_PAGE = 20;

// Maximum reviews a client can request per page
const REVIEWS_MAX_PER_PAGE = 50;

// Maximum character lengths for review tasting note fields
const REVIEW_MAX_LENGTHS = { aroma: 1000, palate: 1000, finish: 1000, overall: 2000 };

// ─── Community / Discussions ────────────────────────────────────────────────

// Default number of discussions per page
const DISCUSSIONS_PER_PAGE = 20;

// Maximum discussions a client can request per page
const DISCUSSIONS_MAX_PER_PAGE = 50;

// Maximum character lengths for discussion fields
const DISCUSSION_MAX_LENGTHS = { title: 200, body: 5000, replyBody: 3000 };

// The token scopes that reach the PERSONAL MCP surface (POST /api/mcp) — the
// single source for the JWT-session grant, the OAuth grantable set, and the
// admin usage-view connection filter, so adding a scope can't silently miss
// one of the three (grand-audit M7). NOT the same as ApiToken.TOKEN_SCOPES,
// which also includes 'climate' (device-only, never an MCP connection).
const MCP_PERSONAL_SCOPES = ['read', 'consume', 'write'];

// Support-ticket categories — single source for the model enum, the
// accountOps validation, and the MCP tool's input schema (grand-audit M9).
const SUPPORT_CATEGORIES = ['bug', 'help', 'feature', 'other'];

module.exports = {
  CONSUMED_STATUSES,
  MCP_PERSONAL_SCOPES,
  SUPPORT_CATEGORIES,
  MS_PER_DAY,
  WINE_POPULATE,
  WINE_POPULATE_LIST,
  IMPORT_EXACT_THRESHOLD,
  IMPORT_FUZZY_THRESHOLD,
  MAX_IMPORT_SIZE,
  AI_CONCURRENCY,
  SYSTEM_PROMPT_MAX_LENGTH,
  SCAN_PROMPT_MAX_LENGTH,
  REVIEWS_PER_PAGE,
  REVIEWS_MAX_PER_PAGE,
  REVIEW_MAX_LENGTHS,
  DISCUSSIONS_PER_PAGE,
  DISCUSSIONS_MAX_PER_PAGE,
  DISCUSSION_MAX_LENGTHS,
};
