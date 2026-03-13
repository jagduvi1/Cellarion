/**
 * Parse pagination parameters from a request query string.
 *
 * Supports two addressing modes:
 *   - **offset-based**: `?limit=50&offset=0`
 *   - **page-based**:   `?limit=50&page=1`  (offset is derived automatically)
 *
 * When both `offset` and `page` are supplied, `page` takes precedence.
 *
 * @param {object} query       - `req.query` object
 * @param {object} [defaults]
 * @param {number} [defaults.limit=50]    - default items per page
 * @param {number} [defaults.maxLimit=200] - upper bound for limit
 * @returns {{ limit: number, offset: number, page: number }}
 */
function parsePagination(query, defaults = {}) {
  const {
    limit: defaultLimit = 50,
    maxLimit = 200,
  } = defaults;

  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || defaultLimit, 1),
    maxLimit
  );

  let page;
  let offset;

  if (query.page != null) {
    page   = Math.max(parseInt(query.page, 10) || 1, 1);
    offset = (page - 1) * limit;
  } else {
    offset = Math.max(parseInt(query.offset, 10) || 0, 0);
    page   = Math.floor(offset / limit) + 1;
  }

  return { limit, offset, page };
}

module.exports = { parsePagination };
