// The new_wine path of the MCP write tools that take one wine: add_bottle
// (mcp/tools/write.js) and add_to_wishlist (mcp/tools/personal.js).
// bulk_add keeps its own loop (mcp/tools/bulk.js): it previews and reports per row.
//
// Every wine minted here goes through findOrCreateWine — the same chokepoint
// every other surface uses — and MCP is deliberately STRICTER than REST:
// sibling matching stays ON even for a confirmed create (an exact
// producer+name sibling IS the same wine), and the mint is stamped
// createdVia:'mcp' and audited (wine.create), so admins can review the wines
// AI assistants created as a class.
const { logAudit } = require('../services/audit');
const { announceMintedWine } = require('../services/wineCommit');
const { fail } = require('./toolUtil');

/**
 * Resolve new_wine against the registry, minting it when the registry does
 * not hold it. Used by add_bottle and add_to_wishlist.
 * Returns { wine, created } | { failure } — the tool returns
 * `failure` as it is (invalid_input, conflict with the close candidates, unavailable).
 */
async function resolveOrMintMcpWine(ctx, newWine, { confirm = false, draft = false, nonWine = false } = {}) {
  if (!newWine.type && !nonWine) {
    return { failure: fail('invalid_input', 'new_wine.type is required unless category is "other" (a drink that is not wine).') };
  }
  // Lazy: findOrCreateWine top-requires services/search → the ESM-only
  // meilisearch package, which jest cannot parse; a top-level require here
  // breaks every suite that loads the tool registry.
  const { findOrCreateWine } = require('../services/findOrCreateWine');
  let result;
  try {
    result = await findOrCreateWine(newWine, ctx.user.id, {
      confirmCreate: !!confirm,
      skipSiblingMatch: false,
      createdVia: 'mcp',
      // Commit path: an unreadable/absent producer files a pending row
      // instead of refusing the write. The strict gates still apply to the
      // deliberate registry-curation tool (admin_add_registry_wine), which
      // never passes this.
      allowPending: true,
      // PRIVATE DRAFT: the row stays the user's until publish_wine. Strictly boolean true.
      draft: draft === true,
      // The Other category: born outside the shared wine registry.
      nonWine,
    });
  } catch (err) {
    if (err?.status === 400) return { failure: fail('invalid_input', err.message) };
    throw err;
  }
  if (!result.wine && result.candidates?.length) {
    return {
      failure: fail('conflict',
        'Very similar wines already exist — use one of these wine_ids, or call again with confirm_new_wine:true ONLY if the user confirms it is genuinely different: ' +
        result.candidates.map((c) => `${c.wine.name} — ${c.wine.producer} (wine_id ${c.wine._id}, score ${c.score})`).join('; ')),
    };
  }
  // No wine and no candidates either: a failure to report, never a crash on
  // `wine.name` (bulk.js handles the same case per row).
  if (!result.wine) {
    return { failure: fail('unavailable', 'The registry could not resolve or create that wine — retry, or pick a wine_id with resolve_wine.') };
  }
  const wine = result.wine;
  const created = !!result.created;
  if (created) {
    logAudit(ctx.req, 'wine.create',
      { type: 'wine', id: wine._id },
      { via: 'mcp', name: wine.name, producer: wine.producer || null,
        // A draft is pending by invariant; for the audit "pendingIdentity"
        // keeps meaning "the producer was missing".
        ...(wine.pendingIdentity && !wine.draft ? { pendingIdentity: true } : {}),
        ...(wine.draft ? { draft: true } : {}),
        // The refused producer string survives ONLY here — the pending row
        // stores '', and a curator needs what the caller actually said.
        ...(result.producerRejected
          ? { rejectedProducer: result.producerRejected.producer, rejectedByCheck: result.producerRejected.check }
          : {}) });
    // The REST mint's IndexNow rule (pending rows and drafts excluded).
    announceMintedWine(wine);
  }
  return { wine, created };
}

module.exports = { resolveOrMintMcpWine };
