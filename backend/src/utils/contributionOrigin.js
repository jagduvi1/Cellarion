/**
 * Where a contribution came from — recorded ON THE RECORD, not only in the
 * audit log.
 *
 * Until now `via` was passed to logAudit and thrown away, and the bridge key
 * and install host existed nowhere but audit rows that expire after 90 days.
 * That left one question unanswerable: "a rights holder says wine X is theirs
 * — who gave it to us, and what else did they give us?". The audit trail is
 * the wrong place for it, because it is bounded by retention and shaped for
 * incident review, not for grouping a contributor's whole output.
 *
 * These three fields are the minimum that makes that query possible today.
 * They do NOT survive an account erasure (services/userDataRegistry.js follows
 * the same policy it applies everywhere else); the durable, pseudonymous
 * provenance ledger that outlives erasure is a separate piece of work with its
 * own legal basis and its own wording in the terms.
 */

const VIA = ['ui', 'mcp', 'bridge', 'import'];
// The browser routes have always audited themselves as 'web'; the registry's
// own createdVia vocabulary calls the same surface 'ui'. Accept both and store
// the registry's word, so the two provenance fields can be read together.
const ALIASES = { web: 'ui', ui: 'ui' };

/**
 * Derive the origin of a contribution from the request that carried it.
 * `via` is what the caller declares; a request authenticated by a bridge key
 * is 'bridge' whether or not the caller said so, because that is a fact about
 * the credential rather than a claim by the code path.
 *
 * @param {object} req    the Express request (may be undefined: MCP tools and
 *                        scripts call the ops services without one)
 * @param {string} [via]  the declared surface
 * @returns {{via: string|null, bridgeKey: (string|null), instanceHost: (string|null)}}
 */
function originFrom(req, via) {
  const bridge = req && req.bridge && req.bridge.key ? req.bridge.key : null;
  const canonical = ALIASES[via] || via;
  const declared = VIA.includes(canonical) ? canonical : null;
  return {
    via: bridge ? 'bridge' : declared,
    bridgeKey: bridge ? (bridge.id || null) : null,
    instanceHost: bridge ? (bridge.instanceHost || null) : null,
  };
}

/**
 * The same three fields as a Mongoose schema fragment, so every record that
 * can carry a contribution describes it identically.
 *
 * Absence is the honest unknown: rows written before this shipped carry no
 * `via`, and that must never be read as 'ui'.
 */
function originSchemaFields(mongoose) {
  return {
    via: { type: String, enum: [...VIA, null], default: null },
    bridgeKey: { type: mongoose.Schema.Types.ObjectId, ref: 'BridgeKey', default: null },
    instanceHost: { type: String, default: null, maxlength: 120 },
  };
}

module.exports = { originFrom, originSchemaFields, VIA };
