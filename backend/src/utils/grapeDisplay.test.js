/**
 * Regional grape display resolution (somm ticket: "Tinta Roriz stored as
 * Tempranillo on a Douro Port").
 *
 * WHY THIS TEST EXISTS:
 * Every read surface (wine/bottle routes, MCP get_wine/resolve_wine, search
 * indexing, embedding text) funnels through these two functions, so the
 * resolution order IS the product behavior: region entry beats country entry
 * beats canonical, ids compare as strings across ObjectId/lean/populated
 * shapes, and a wine with no applicable mapping must come out untouched —
 * that last property is what keeps embedding textHashes stable (no re-embed
 * wave) and every undecorated surface canonical.
 */
const mongoose = require('mongoose');
const { resolveGrapeDisplayName, decorateGrapes } = require('./grapeDisplay');

const oid = (c) => c.repeat(24);
const PORTUGAL = oid('a');
const SPAIN = oid('b');
const DOURO = oid('c');
const ALENTEJO = oid('d');

const tempranillo = (overrides = {}) => ({
  _id: oid('e'),
  name: 'Tempranillo',
  regionalNames: [
    { country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' },
    { country: PORTUGAL, region: ALENTEJO, name: 'Aragonez' },
    { country: PORTUGAL, region: null, name: 'Tinta Roriz (PT)' },
  ],
  ...overrides,
});

describe('resolveGrapeDisplayName', () => {
  test('most-specific wins: the wine\'s region entry beats the country-only entry', () => {
    expect(resolveGrapeDisplayName(tempranillo(), { countryId: PORTUGAL, regionId: DOURO }))
      .toBe('Tinta Roriz');
    expect(resolveGrapeDisplayName(tempranillo(), { countryId: PORTUGAL, regionId: ALENTEJO }))
      .toBe('Aragonez');
  });

  test('country-only fallback: a Portuguese wine from an unmapped region', () => {
    expect(resolveGrapeDisplayName(tempranillo(), { countryId: PORTUGAL, regionId: oid('f') }))
      .toBe('Tinta Roriz (PT)');
    // …and a wine with no region at all.
    expect(resolveGrapeDisplayName(tempranillo(), { countryId: PORTUGAL }))
      .toBe('Tinta Roriz (PT)');
  });

  test('no match → canonical name (different country; entries never leak across borders)', () => {
    expect(resolveGrapeDisplayName(tempranillo(), { countryId: SPAIN, regionId: DOURO }))
      .toBe('Tempranillo');
  });

  test('a region-level entry does NOT apply country-wide (no region on the wine ≠ region match)', () => {
    const grape = tempranillo({
      regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
    });
    expect(resolveGrapeDisplayName(grape, { countryId: PORTUGAL })).toBe('Tempranillo');
  });

  test('ids compare as strings: ObjectId, hex string and populated-doc shapes all match', () => {
    const grape = tempranillo({
      regionalNames: [{
        country: new mongoose.Types.ObjectId(PORTUGAL),
        region: new mongoose.Types.ObjectId(DOURO),
        name: 'Tinta Roriz',
      }],
    });
    // wine ctx as plain hex strings
    expect(resolveGrapeDisplayName(grape, { countryId: PORTUGAL, regionId: DOURO })).toBe('Tinta Roriz');
    // wine ctx as populated docs
    expect(resolveGrapeDisplayName(grape, {
      countryId: { _id: new mongoose.Types.ObjectId(PORTUGAL), name: 'Portugal' },
      regionId: { _id: new mongoose.Types.ObjectId(DOURO), name: 'Douro' },
    })).toBe('Tinta Roriz');
    // entry ids as populated docs, ctx as ObjectIds
    const populatedEntries = tempranillo({
      regionalNames: [{
        country: { _id: PORTUGAL, name: 'Portugal' },
        region: { _id: DOURO, name: 'Douro' },
        name: 'Tinta Roriz',
      }],
    });
    expect(resolveGrapeDisplayName(populatedEntries, {
      countryId: new mongoose.Types.ObjectId(PORTUGAL),
      regionId: new mongoose.Types.ObjectId(DOURO),
    })).toBe('Tinta Roriz');
  });

  test('null-safety: missing grape / regionalNames / wine country all fall back cleanly', () => {
    expect(resolveGrapeDisplayName(null, { countryId: PORTUGAL })).toBeNull();
    expect(resolveGrapeDisplayName({ name: 'Syrah' }, { countryId: PORTUGAL })).toBe('Syrah');
    expect(resolveGrapeDisplayName({ name: 'Syrah', regionalNames: [] }, {})).toBe('Syrah');
    // No wine country: entries always carry one, so nothing can match.
    expect(resolveGrapeDisplayName(tempranillo(), {})).toBe('Tempranillo');
    expect(resolveGrapeDisplayName(tempranillo())).toBe('Tempranillo');
  });

  test('an id-less object never matches — "[object Object]" must not become a shared key', () => {
    // e.g. a projection that dropped _id: two different docs would both
    // stringify to "[object Object]" and falsely "match".
    expect(resolveGrapeDisplayName(tempranillo(), {
      countryId: { name: 'Portugal' }, regionId: { name: 'Douro' },
    })).toBe('Tempranillo');
  });

  test('junk entries (blank name, null entry) are skipped, never returned', () => {
    const grape = tempranillo({
      regionalNames: [
        null,
        { country: PORTUGAL, region: DOURO, name: '   ' },
        { country: PORTUGAL, region: null, name: 'Tinta Roriz (PT)' },
      ],
    });
    expect(resolveGrapeDisplayName(grape, { countryId: PORTUGAL, regionId: DOURO }))
      .toBe('Tinta Roriz (PT)');
  });
});

describe('decorateGrapes', () => {
  const wine = () => ({
    _id: oid('1'),
    name: 'Vintage Port',
    country: { _id: PORTUGAL, name: 'Portugal' },
    region: { _id: DOURO, name: 'Douro' },
    grapes: [tempranillo(), { _id: oid('2'), name: 'Touriga Nacional' }],
  });

  test('each grape gains displayName resolved against the wine\'s own place; name stays canonical', () => {
    const out = decorateGrapes(wine());
    expect(out.grapes[0].displayName).toBe('Tinta Roriz');
    expect(out.grapes[0].name).toBe('Tempranillo');
    // Unmapped grape: displayName present but equal to canonical.
    expect(out.grapes[1].displayName).toBe('Touriga Nacional');
    expect(out.grapes[1].name).toBe('Touriga Nacional');
  });

  test('never mutates the input (wine or grape objects)', () => {
    const input = wine();
    const grapeRef = input.grapes[0];
    const out = decorateGrapes(input);
    expect(out).not.toBe(input);
    expect(grapeRef.displayName).toBeUndefined();
    expect(input.grapes[0]).toBe(grapeRef);
  });

  test('Mongoose docs go through toObject() so displayName survives serialization', () => {
    const plain = wine();
    const doc = { toObject: () => ({ ...plain, grapes: plain.grapes.map((g) => ({ ...g })) }) };
    const out = decorateGrapes(doc);
    expect(out.grapes[0].displayName).toBe('Tinta Roriz');
  });

  test('null-safety: missing wine, missing grapes, unpopulated grape refs', () => {
    expect(decorateGrapes(null)).toBeNull();
    expect(decorateGrapes(undefined)).toBeUndefined();
    expect(decorateGrapes({ name: 'No grapes' }).grapes).toBeUndefined();
    expect(decorateGrapes({ grapes: [] }).grapes).toEqual([]);
    // Bare ObjectId grapes (caller didn't populate) pass through untouched.
    const raw = { grapes: [PORTUGAL, null] };
    expect(decorateGrapes(raw).grapes).toEqual([PORTUGAL, null]);
  });

  test('wine with ids-only country/region (unpopulated) still resolves', () => {
    const out = decorateGrapes({ country: PORTUGAL, region: DOURO, grapes: [tempranillo()] });
    expect(out.grapes[0].displayName).toBe('Tinta Roriz');
  });
});

/**
 * The wine's own name outranks any mapping (somm ticket 6a8c8a68, decided
 * 2026-08-27): Australians write "Syrah" on a label as a deliberate
 * cool-climate style signal, so an Australia-wide "Shiraz" entry must never
 * relabel a wine literally named for the canonical variety. The mapping
 * applies when the name says the regional form or names no variety at all —
 * the somm's conservative option (b), generalized to every variety.
 */
describe('resolveGrapeDisplayName – the wine name outranks the mapping', () => {
  const AUSTRALIA = oid('1');
  const BAROSSA = oid('2');
  const syrah = (overrides = {}) => ({
    _id: oid('3'),
    name: 'Syrah',
    regionalNames: [{ country: AUSTRALIA, region: null, name: 'Shiraz' }],
    ...overrides,
  });

  test('applies when the wine name says the regional form', () => {
    expect(resolveGrapeDisplayName(syrah(), {
      countryId: AUSTRALIA, wineName: 'Jaraman Shiraz',
    })).toBe('Shiraz');
  });

  test('applies when the wine name names no variety at all', () => {
    expect(resolveGrapeDisplayName(syrah(), {
      countryId: AUSTRALIA, wineName: 'Grange',
    })).toBe('Shiraz');
  });

  test('suppressed when the wine name carries the canonical variety', () => {
    expect(resolveGrapeDisplayName(syrah(), {
      countryId: AUSTRALIA, wineName: 'The Factor Syrah',
    })).toBe('Syrah');
  });

  test('whole words only: "Syrahs" and unrelated tokens do not suppress', () => {
    expect(resolveGrapeDisplayName(syrah(), {
      countryId: AUSTRALIA, wineName: 'Old Syrahs Block',
    })).toBe('Shiraz');
  });

  test('hyphenated blend names still carry the variety ("Syrah-Grenache")', () => {
    expect(resolveGrapeDisplayName(syrah(), {
      countryId: AUSTRALIA, wineName: 'Estate Syrah-Grenache',
    })).toBe('Syrah');
  });

  test('case- and diacritics-folded comparison', () => {
    expect(resolveGrapeDisplayName(syrah(), {
      countryId: AUSTRALIA, wineName: 'CUVÉE SYRAH RÉSERVE',
    })).toBe('Syrah');
  });

  test('suppression also beats a REGION-level entry (the label always wins)', () => {
    const grape = syrah({
      regionalNames: [{ country: AUSTRALIA, region: BAROSSA, name: 'Shiraz' }],
    });
    expect(resolveGrapeDisplayName(grape, {
      countryId: AUSTRALIA, regionId: BAROSSA, wineName: 'Single Vineyard Syrah',
    })).toBe('Syrah');
    // …and without the canonical in the name, the region entry still applies.
    expect(resolveGrapeDisplayName(grape, {
      countryId: AUSTRALIA, regionId: BAROSSA, wineName: 'Single Vineyard',
    })).toBe('Shiraz');
  });

  test('no wineName in ctx keeps today\'s behaviour (mapping applies)', () => {
    expect(resolveGrapeDisplayName(syrah(), { countryId: AUSTRALIA })).toBe('Shiraz');
  });

  test('decorateGrapes threads the wine\'s own name into the resolution', () => {
    const base = { country: AUSTRALIA, grapes: [syrah()] };
    expect(decorateGrapes({ ...base, name: 'The Factor Syrah' }).grapes[0].displayName).toBe('Syrah');
    expect(decorateGrapes({ ...base, name: 'Jaraman Shiraz' }).grapes[0].displayName).toBe('Shiraz');
  });
});
