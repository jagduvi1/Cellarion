/**
 * Parse pagination parameters from a request query string.
 *
 * Supports three addressing modes:
 *   - **offset-based**: `?limit=50&offset=0`
 *   - **skip-based**:   `?limit=50&skip=0`   (alias for offset)
 *   - **page-based**:   `?limit=50&page=1`   (offset is derived automatically)
 *
 * Priority: `page` > `offset` > `skip`.
 *
 * @param {object} query       - `req.query` object
 * @param {object} [defaults]
 * @param {number} [defaults.limit=50]    - default items per page
 * @param {number} [defaults.maxLimit=200] - upper bound for limit
 * @param {number} [defaults.maxOffset=100000] - upper bound for offset/skip
 * @returns {{ limit: number, offset: number, page: number }}
 */
function parsePagination(query, defaults = {}) {
  const {
    limit: defaultLimit = 50,
    maxLimit = 200,
    maxOffset = 1000000,
  } = defaults;

  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || defaultLimit, 1),
    maxLimit
  );

  let page;
  let offset;

  // Clamp offset to maxOffset so a hostile `?page=99999999` / `?offset=2e11`
  // can't force MongoDB into a multi-billion-doc .skip() scan. The cap is far
  // above any realistic browse depth, so legitimate pagination is unaffected.
  if (query.page != null) {
    page   = Math.max(parseInt(query.page, 10) || 1, 1);
    offset = Math.min((page - 1) * limit, maxOffset);
  } else {
    // Accept both "offset" and "skip" as query param names
    const rawOffset = query.offset != null ? query.offset : query.skip;
    offset = Math.min(Math.max(parseInt(rawOffset, 10) || 0, 0), maxOffset);
    page   = Math.floor(offset / limit) + 1;
  }

  return { limit, offset, page };
}

module.exports = { parsePagination };
