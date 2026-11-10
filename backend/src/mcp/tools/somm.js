// Sommelier MCP tools: the queues and the data entry for the SHARED
// recommendation data a somm curates ("anything in my maturity queue?" → set
// the windows → next). This file only registers the tool families, in the
// order the registry lists them. Each family lives in ./somm/<family>.js; a
// new curation tool goes into the family it belongs to, or into a new family
// file required from here at the place it should appear in the tool list.
//
// Role gating is STRUCTURAL: every tool declares requireRole, so the registry
// never even advertises them to non-somm callers (mcp/registry.js). A
// defense-in-depth role re-check runs inside each handler anyway (requireSomm
// in mcp/toolUtil.js) — the two layers can only drift safely.
//
// Audit action strings are IDENTICAL to the REST somm routes (somm.maturity.
// review, somm.price.add) so REST and MCP curation audit identically; where a
// service owns the write (services/*Ops.js) it writes that audit row for both.
//
// A family requires services/search lazily at call time, never at load: it
// pulls in the Meili client and half the model layer, which every consumer of
// the tool registry would then have to stand up (registry.test.js does not).

// list_maturity_queue, set_vintage_maturity, reset_maturity_row, remove_from_maturity_queue
require('./somm/maturity');
// set_wine_profile
require('./somm/wineProfile');
// add_grape, edit_grape
require('./somm/grapes');
// list_price_tracking_requests, set_vintage_price, reject_price_request
require('./somm/prices');
// sample_published_profiles, list_unverified_core_wines, list_pending_corrections, record_profile_audit
require('./somm/profileReads');
// list_held_profiles, review_held_profile, list_profile_audits
require('./somm/heldProfiles');
// propose_wine_correction
require('./somm/corrections');
// ask_bottle_owner, list_owner_inquiries, resolve_owner_inquiry
require('./somm/ownerInquiries');
// list_wine_reports, respond_to_wine_report
require('./somm/wineReports');
// list_pending_wines, get_pending_wine_images, fix_pending_wine
require('./somm/pendingWines');
// list_colour_conflicts, dismiss_colour_conflict, restore_colour_conflict, list_rule_downgrades,
// list_ungrounded_descriptions
require('./somm/recordChecks');
