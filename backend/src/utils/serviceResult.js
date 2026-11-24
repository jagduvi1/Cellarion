/**
 * The transport translation for the shared service-result shape
 * ({ ok: false, code, message }) the ops services speak
 * (personalData, wineProposalOps, registryDataOps, …).
 *
 * One full map, one owner: a hand-copied partial map drifts, and a router
 * missing a code turns it into a generic 400.
 */
const CODE_STATUS = {
  invalid: 400,
  limit: 429,
  banned: 403,
  not_found: 404,
  conflict: 409,
  type_conflict: 409,
  in_use: 409,
};

/** Send a failed service result as its HTTP equivalent. */
function sendServiceFail(res, result) {
  return res.status(CODE_STATUS[result.code] || 400).json({ error: result.message });
}

module.exports = { CODE_STATUS, sendServiceFail };
