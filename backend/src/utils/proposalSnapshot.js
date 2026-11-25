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
 * A sweetness style as one display string, "feinherb (trade)", or null for
 * none: the same on both sides of a diff. Reads the stored subdocument with
 * its term populated, the shape a read sends ({ name, source }) and a
 * proposed style ({ term: 'feinherb', source }). A term that is not populated
 * contributes nothing, like a grape that does not resolve.
 */
function styleLabel(style) {
  if (!style || typeof style !== 'object') return null;
  const name = typeof style.name === 'string' ? style.name
    : typeof style.term === 'string' ? style.term
      : (style.term && typeof style.term.name === 'string' ? style.term.name : null);
  if (!name) return null;
  return style.source ? `${name} (${style.source})` : name;
}

/**
 * The identity snapshot of a wine loaded with its country, region and grapes
 * populated — and, for the sweetness style row, with sweetnessStyle selected
 * and its term populated. A grape reference that does not resolve to a
 * document (not populated, or a variety since deleted) contributes nothing,
 * so it can never read as a change.
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
    sweetnessStyle: styleLabel(wine.sweetnessStyle),
  };
}

module.exports = { grapeLabel, styleLabel, identitySnapshot };
