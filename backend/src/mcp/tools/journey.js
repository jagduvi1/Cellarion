// case_journey (plan Phase 3): the story of a multi-bottle holding. Cellarion
// has no "case" entity — a case is simply several bottles of the same wine +
// vintage — so this groups the user's bottles (active AND consumed) into lots
// and reports each lot's trajectory: acquisitions, every bottle drunk with its
// rating and note, what remains, the drink window, and whether the drinking
// pace will finish the lot before the window closes. Pure read, $0.
const { z } = require('zod');
const Cellar = require('../../models/Cellar');
const Bottle = require('../../models/Bottle');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../../config/constants');
const { classifyMaturity, buildProfileMap, maturityLabel } = require('../../utils/maturityUtils');
const { toNormalized } = require('../../utils/ratingUtils');
const { isValidId } = require('../../utils/validation');
const { registerTool } = require('../registry');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');

const MAX_LOTS = 15;
const MAX_EVENTS = 20;

const round1 = (n) => Math.round(n * 10) / 10;

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
  handler: async (args, ctx) => {
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

    const cellars = await Cellar.find({ user: ctx.user.id, deletedAt: null }).select('_id').lean();
    if (cellars.length === 0) return ok('No cellars yet', []);
    const scope = { cellar: { $in: cellars.map((c) => c._id) } };
    if (focusWineId) scope.wineDefinition = focusWineId;
    const bottles = await Bottle.find(scope).populate(WINE_POPULATE_LIST).lean();

    // Group into lots by wine + vintage.
    const lots = new Map();
    for (const b of bottles) {
      if (!b.wineDefinition?._id) continue;
      if (focusVintage && b.vintage !== focusVintage) continue;
      const key = `${b.wineDefinition._id}:${b.vintage}`;
      const lot = lots.get(key) || { wine: b.wineDefinition, vintage: b.vintage, bottles: [] };
      lot.bottles.push(b);
      lots.set(key, lot);
    }

    const minCount = focusWineId ? 1 : Math.min(Math.max(parseInt(args.min_count, 10) || 3, 2), 24);
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_LOTS);
    const eligible = [...lots.values()]
      .filter((l) => l.bottles.length >= minCount)
      .sort((a, b) => b.bottles.length - a.bottles.length)
      .slice(0, limit);
    if (eligible.length === 0) {
      return ok(focusWineId ? 'No bottles of that wine' : `No lots with ${minCount}+ bottles`, [], {
        warnings: focusWineId ? [] : ['Lower min_count to see smaller holdings.'],
      });
    }

    const activeForProfiles = eligible.flatMap((l) => l.bottles.filter((b) => !CONSUMED_STATUSES.includes(b.status)));
    const profileMap = await buildProfileMap(activeForProfiles);
    const currentYear = new Date().getFullYear();

    const data = eligible.map((lot) => {
      const active = lot.bottles.filter((b) => !CONSUMED_STATUSES.includes(b.status));
      const consumed = lot.bottles
        .filter((b) => CONSUMED_STATUSES.includes(b.status) && b.consumedAt)
        .sort((a, b) => new Date(a.consumedAt) - new Date(b.consumedAt));

      const acquiredDates = lot.bottles.map((b) => b.purchaseDate || b.createdAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));

      const events = consumed.slice(-MAX_EVENTS).map((b) => ({
        date: b.consumedAt,
        reason: b.consumedReason || b.status,
        rating: b.consumedRating ?? null,
        rating_scale: b.consumedRating != null ? b.consumedRatingScale || '5' : undefined,
        note: b.consumedNote ? String(b.consumedNote).slice(0, 200) : null,
      }));

      // Rating trend over the drunk bottles (normalized 0–100 for comparability).
      const ratedEvents = consumed.filter((b) => b.consumedRating != null);
      let ratingTrend = null;
      if (ratedEvents.length >= 2) {
        const first = toNormalized(ratedEvents[0].consumedRating, ratedEvents[0].consumedRatingScale || '5');
        const last = toNormalized(ratedEvents[ratedEvents.length - 1].consumedRating, ratedEvents[ratedEvents.length - 1].consumedRatingScale || '5');
        ratingTrend = {
          first_normalized_100: round1(first),
          latest_normalized_100: round1(last),
          direction: last > first + 2 ? 'improving' : last < first - 2 ? 'fading' : 'stable',
        };
      }

      // Window + pace verdict from a representative active bottle.
      const rep = active[0] || null;
      const status = rep ? classifyMaturity(rep, profileMap) : null;
      const wdId = rep?.wineDefinition?._id ? String(rep.wineDefinition._id) : null;
      const vintageProfile = rep && wdId ? profileMap.get(`${wdId}:${rep.vintage}`) : null;
      const windowCloses = rep
        ? (Number.isFinite(rep.drinkTo) ? rep.drinkTo : vintageProfile?.lateUntil || vintageProfile?.peakUntil || null)
        : null;

      let pace = null;
      if (active.length > 0 && consumed.length >= 1 && consumed[0].consumedAt) {
        const yearsDrinking = Math.max((Date.now() - new Date(consumed[0].consumedAt)) / (365.25 * 86400000), 0.5);
        const perYear = consumed.length / yearsDrinking;
        const projectedFinish = perYear > 0 ? Math.round(currentYear + active.length / perYear) : null;
        pace = {
          consumed_per_year: round1(perYear),
          projected_finish_year: projectedFinish,
          window_closes: windowCloses,
          verdict: windowCloses == null || projectedFinish == null
            ? 'no_window'
            : projectedFinish <= windowCloses ? 'on_track' : 'too_slow',
        };
      }

      return {
        wine: {
          wine_id: lot.wine._id,
          name: lot.wine.name,
          producer: lot.wine.producer || null,
          type: lot.wine.type || null,
          region: lot.wine.region?.name || null,
          country: lot.wine.country?.name || null,
        },
        vintage: lot.vintage,
        counts: { total: lot.bottles.length, remaining: active.length, consumed: consumed.length },
        acquired: {
          first: acquiredDates[0] || null,
          last: acquiredDates[acquiredDates.length - 1] || null,
        },
        window: rep ? maturityLabel(status, vintageProfile, rep) : null,
        maturity: status,
        consumed_events: events,
        rating_trend: ratingTrend,
        pace,
      };
    });

    const drinking = data.filter((l) => l.pace?.verdict === 'too_slow').length;
    return ok(
      `${data.length} lot(s)${drinking ? ` — ${drinking} pacing too slow for their window` : ''}`,
      data
    );
  },
});
