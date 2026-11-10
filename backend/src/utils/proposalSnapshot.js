// A wine's identity as a correction proposal compares it: the fields a
// proposal may change, region and country as display names, the grape list as
// one joined string. Three places must agree on this shape, or the admin
// review shows drift that is not there:
//   - the snapshot the sommelier's propose_wine_correction records
//     (mcp/tools/somm/corrections.js);
//   - the snapshot a member's correction records (services/wineProposalOps);
//   - the live values the admin review compares both with
//     (routes/admin/wineProposals.js).
// The not-wine flag (services/nonWineOps) records a smaller snapshot of its
// own: it proposes no field.
//
// Require-free on purpose: route, service, MCP tool and test code all read it.

/** Grape names as one display string, or null for none: the same join on both sides of a diff. */
const grapeLabel = (names) => (Array.isArray(names) && names.length ? names.join(', ') : null);

/**
 * The identity snapshot of a wine loaded with its country, region and grapes
 * populated. A grape reference that does not resolve to a document (not
 * populated, or a variety since deleted) contributes nothing, so it can never
 * read as a change.
 */
function identitySnapshot(wine) {
  return {
    producer: wine.producer || null,
    name: wine.name || null,
    appellation: wine.appellation || null,
    region: wine.region?.name || null,
    country: wine.country?.name || null,
    classification: wine.classification || null,
    type: wine.type || null,
    colour: wine.colour || null,
    grapes: grapeLabel((wine.grapes || []).map((g) => g && g.name).filter(Boolean)),
  };
}

module.exports = { grapeLabel, identitySnapshot };
