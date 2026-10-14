/**
 * The SuperAdmin maturity figure joins bottles to their reviewed drink windows.
 * Its first form ran a let/$expr sub-pipeline per BOTTLE and was the slowest
 * query in the Mongo profiler (2026-10-14: 3.3 s on 19,851 bottles, growing
 * with every bottle). It now counts bottles per (wine, vintage) first and joins
 * once per pair (0.9 s, the same count in every phase on prod data).
 *
 * Aggregations need a real MongoDB, so the shape is pinned here as data, built
 * from the REAL source the way the other stats tests do: the two properties
 * that make it fast (group first, a plain indexed join) and the one that keeps
 * it right (the final $group sums the per-pair count, not 1 per row).
 */
const fs = require('fs');

const src = fs.readFileSync(require.resolve('./globalStatsService'), 'utf8');

function maturityPipeline() {
  const start = src.indexOf('const maturityRaw = await safeAggregate(Bottle, [');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('[', start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) break; }
  }
  // The pipeline literal reads two locals from its surroundings.
  const bottleMatch = { user: { $nin: [] } };
  const currentYear = 2026;
  // eslint-disable-next-line no-eval
  return eval(src.slice(open, i + 1));
}

describe('stats maturity join (Mongo profiler 2026-10-14)', () => {
  const p = maturityPipeline();
  const stage = (name) => p.findIndex((s) => Object.keys(s)[0] === name);

  it('keeps the bottle filter: active, dated vintages, the stats exclusions', () => {
    expect(p[0].$match).toMatchObject({ status: 'active', vintage: { $nin: ['NV', null, ''] }, user: { $nin: [] } });
  });

  it('counts bottles per wine + vintage BEFORE joining, so the join runs once per pair', () => {
    expect(p[1]).toEqual({ $group: { _id: { wd: '$wineDefinition', v: '$vintage' }, n: { $sum: 1 } } });
    expect(stage('$group')).toBeLessThan(stage('$lookup'));
  });

  it('joins with a plain localField/foreignField lookup (indexed), no per-row sub-pipeline', () => {
    const lookup = p[stage('$lookup')].$lookup;
    expect(lookup).toMatchObject({ from: 'winevintageprofiles', localField: '_id.wd', foreignField: 'wineDefinition' });
    expect(lookup.pipeline).toBeUndefined();
    expect(lookup.let).toBeUndefined();
  });

  // Release audit 2026-10-14: a substring check here stayed green with $or in
  // place of $and, $ne in place of $eq, and the $project dropping `profiles`
  // before the pick (each measured on Mongo 7: noProfile 12017 → 348, or
  // everything noProfile). The whole condition and the stage order are pinned.
  it('picks the REVIEWED profile of the SAME vintage, exactly', () => {
    const pickIdx = p.findIndex((s) => s.$addFields && s.$addFields.profile);
    expect(p[pickIdx].$addFields.profile).toEqual({ $first: { $filter: {
      input: '$profiles',
      cond: { $and: [{ $eq: ['$$this.vintage', '$_id.v'] }, { $eq: ['$$this.status', 'reviewed'] }] },
    } } });
  });

  it('runs join → pick → drop the array → classify → tally, in that order', () => {
    const lookupIdx = stage('$lookup');
    const pickIdx = p.findIndex((s) => s.$addFields && s.$addFields.profile);
    const dropIdx = p.findIndex((s) => s.$project && s.$project.profiles === 0);
    const classifyIdx = p.findIndex((s) => s.$addFields && s.$addFields.maturity);
    expect(lookupIdx).toBeGreaterThan(-1);
    expect(pickIdx).toBe(lookupIdx + 1);
    expect(dropIdx).toBe(pickIdx + 1);
    expect(classifyIdx).toBe(dropIdx + 1);
    expect(classifyIdx).toBe(p.length - 2);
  });

  it('sums the per-pair bottle count in the final tally (not 1 per row, which would count pairs)', () => {
    expect(p[p.length - 1]).toEqual({ $group: { _id: '$maturity', count: { $sum: '$n' } } });
  });
});
