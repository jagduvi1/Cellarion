/**
 * The transport translation for the shared service-result shape
 * ({ ok: false, code, message }) the ops services speak
 * (personalData, wineProposalOps, registryDataOps, …).
 *
 * One full map, one owner — the 2026-08-17 audit found four hand-copied
 * partial maps, one of which had already diverged (an admin router that
 * would have turned a future `conflict` into a generic 400).
 */
const CODE_STATUS = {
  invalid: 400,
  limit: 429,
  banned: 403,
  not_found: 404,
  conflict: 409,
  type_conflict: 409,
};

/** Send a failed service result as its HTTP equivalent. */
function sendServiceFail(res, result) {
  return res.status(CODE_STATUS[result.code] || 400).json({ error: result.message });
}

module.exports = { CODE_STATUS, sendServiceFail };
