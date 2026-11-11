// What the entries of the user-data registry share (services/userDataRegistry.js
// and the entry modules beside this file): the caps of the data export, the
// helper that records a list cut at its cap, and the note the Registry Bridge
// writes on what it brings in.

// Rows read per exported list, and per activity log.
const EXPORT_MAX = 50000;
const AUDIT_MAX = 1000;

// Record that an export array hit its cap so the payload's _truncated map flags it.
function markTrunc(ctx, key, arr, cap = EXPORT_MAX) {
  if (arr.length >= cap) ctx.truncated[key] = cap;
  return arr;
}

// Kept in step with REGISTRY_NOTE in services/registryBridge.js. A literal on
// purpose: requiring the bridge service would pull its taxonomy and
// search dependencies into every erasure run.
const BRIDGE_REGISTRY_NOTE = 'From the shared registry (cellarion.app)';

module.exports = { EXPORT_MAX, AUDIT_MAX, markTrunc, BRIDGE_REGISTRY_NOTE };
