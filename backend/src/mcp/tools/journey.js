// case_journey (plan Phase 3): the story of a multi-bottle holding. Cellarion
// has no "case" entity — a case is simply several bottles of the same wine +
// vintage. The lot computation lives in services/insightsService.js
// (buildCaseJourneys — one impl for MCP and any future UI page); this adapter
// only resolves the focus argument with MCP access semantics and wraps the
// envelope. Pure read, $0.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { cachedResult } = require('../resultCache');
const { isValidId } = require('../../utils/validation');
const { ok, fail, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');

const MAX_LOTS = 15;

registerTool({
  name: 'case_journey',
  title: 'Case journey (multi-bottle lots over time)',
  description:
    'How the user\'s multi-bottle holdings evolve: bottles of the same wine + vintage grouped into a lot, with when ' +
    'they were acquired, every bottle drunk so far (date, rating, tasting note), how many remain, the drink window, ' +
    'the rating trend across the case, and whether the current pace finishes the lot before its window closes. ' +
    'Call for "how is my case of X developing", "which cases should I start drinking", or cellar-plan reviews. ' +
    'Pass wine_id or bottle_id to focus one lot; otherwise all lots with at least min_count bottles are returned.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: z.string().optional().describe('Focus on one registry wine (all its vintages)'),
    bottle_id: z.string().optional().describe('Alternatively: focus the lot this bottle belongs to'),
    min_count: z.number().int().min(2).max(24).default(3).describe('List mode: only lots with at least this many bottles (all time)'),
    limit: z.number().int().min(1).max(MAX_LOTS).default(8),
  },
  handler: (args, ctx) => cachedResult(
    'journey', String(ctx.user.id),
    JSON.stringify([args.wine_id, args.bottle_id, args.min_count, args.limit]),
    async () => {
    let focusWineId = null;
    let focusVintage = null; // only set via bottle_id — wine_id covers all vintages
    if (args.bottle_id) {
      const access = await resolveBottleAccess(ctx.user.id, args.bottle_id);
      if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
      if (!access.bottle.wineDefinition) {
        return fail('not_found', 'That bottle has no registry wine yet (pending review) — journeys group by registry wine.');
      }
      focusWineId = String(access.bottle.wineDefinition);
      focusVintage = access.bottle.vintage;
    } else if (args.wine_id) {
      if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
      focusWineId = args.wine_id;
    }

    const { buildCaseJourneys } = require('../../services/insightsService');
    const result = await buildCaseJourneys(ctx.user.id, {
      focusWineId,
      focusVintage,
      minCount: Math.min(Math.max(parseInt(args.min_count, 10) || 3, 2), 24),
      limit: Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_LOTS),
    });
    return ok(result.summary, result.data, result.warnings ? { warnings: result.warnings } : {});
  }),
});
