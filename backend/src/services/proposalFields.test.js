/**
 * services/proposalFields — how a proposed field value is read, for both
 * doors that file a field correction. The doors' own suites
 * (services/wineProposalOps.test.js, mcp/sommProposals.*.test.js,
 * mcp/sommTools.test.js) pin what each one SAYS; this file pins the rules and
 * the codes they answer with, and the two things a door passes in: how long a
 * grape list may be, and the varieties a caller may declare as new.
 *
 * The classification list is primed in memory; the grape taxonomy is a mock.
 */
jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));

const Grape = require('../models/Grape');
const { primeClassificationCache } = require('./classificationOps');
const {
  TEXT_FIELDS, EXTRA_FIELDS, readProposedFields, settleClassificationByCountry,
} = require('./proposalFields');

const AUSTRIA = 'a'.repeat(24);
const GERMANY = 'b'.repeat(24);
const KNOWN_GRAPES = { merlot: 'Merlot', syrah: 'Syrah' };
const read = (src, opts = {}) => readProposedFields(src, { grapesMax: 12, ...opts });

beforeEach(() => {
  jest.clearAllMocks();
  Grape.findOne.mockImplementation((q) => {
    const name = KNOWN_GRAPES[q.$or[0].normalizedName];
    return { select: () => ({ lean: async () => (name ? { _id: `g-${name}`, name } : null) }) };
  });
  primeClassificationCache([
    { _id: 'c-riserva', name: 'Riserva', kind: 'ageing', country: null, synonyms: ['Reserva'] },
    { _id: 'c-ort-at', name: 'Ortswein', kind: 'vineyard_rank', country: AUSTRIA, synonyms: [] },
    { _id: 'c-ort-de', name: 'VDP.Ortswein', kind: 'vineyard_rank', country: GERMANY, synonyms: ['Ortswein'] },
  ]);
});

afterAll(() => primeClassificationCache(null));

test('the nine proposable fields are six of plain text and three structural ones', () => {
  expect(TEXT_FIELDS).toEqual(['producer', 'name', 'appellation', 'region', 'country', 'classification']);
  expect(EXTRA_FIELDS).toEqual(['type', 'colour', 'grapes']);
});

test('text fields are read as plain text; a blank one is a field left alone', async () => {
  expect(await read({ producer: ' <b>Ch. X</b> ', name: '   ', appellation: null, region: '<i></i>' })).toEqual({
    ok: true, proposedFields: { producer: 'Ch. X' }, classificationTier: null, newGrapeNames: [],
  });
  expect(await read({ producer: 'x'.repeat(201) })).toEqual({ ok: false, code: 'field_too_long', field: 'producer' });
  expect(await read({ name: '  ' })).toEqual({ ok: false, code: 'no_fields' });
  expect(await read({})).toEqual({ ok: false, code: 'no_fields' });
});

test('a classification is a tier on the registry list, recorded under its canonical name', async () => {
  expect(await read({ classification: 'DOCG' })).toEqual({ ok: false, code: 'regulatory_mark', value: 'DOCG' });
  const unknown = await read({ classification: 'Extra Special Selection' });
  expect(unknown).toMatchObject({ ok: false, code: 'unknown_tier' });
  expect(unknown.message).toMatch(/not in the registry's classification list/);
  expect(await read({ classification: 'reserva' })).toMatchObject({
    ok: true, proposedFields: { classification: 'Riserva' }, classificationTier: 'reserva',
  });
});

test("a tier two systems share is settled by the wine's country, in place", async () => {
  for (const [country, expected] of [[GERMANY, 'VDP.Ortswein'], [AUSTRIA, 'Ortswein']]) {
    const { proposedFields, classificationTier } = await read({ classification: 'Ortswein' });
    await settleClassificationByCountry(proposedFields, classificationTier, { country: { _id: country } });
    expect(proposedFields.classification).toBe(expected);
  }
  // Nothing to settle when no classification was proposed.
  const fields = { producer: 'X' };
  await settleClassificationByCountry(fields, null, { country: { _id: GERMANY } });
  expect(fields).toEqual({ producer: 'X' });
});

test('type and colour are read in any letter case and checked against their lists', async () => {
  expect(await read({ type: ' Sparkling ', colour: 'ROSÉ' })).toMatchObject({ ok: true, proposedFields: { type: 'sparkling', colour: 'rosé' } });
  expect(await read({ type: 'orange' })).toEqual({ ok: false, code: 'bad_type' });
  expect(await read({ colour: 'pink' })).toEqual({ ok: false, code: 'bad_colour' });
});

test('a grape list is cleaned, bounded by what the door allows, and resolved to canonical names', async () => {
  expect(await read({ grapes: ['<b>merlot</b>', ' Syrah ', '<i></i>'] })).toMatchObject({ ok: true, proposedFields: { grapes: ['Merlot', 'Syrah'] } });
  expect(await read({ grapes: [] })).toEqual({ ok: false, code: 'grapes_list' });
  expect(await read({ grapes: 'Merlot' })).toEqual({ ok: false, code: 'grapes_list' });
  expect(await read({ grapes: ['<i></i>'] })).toEqual({ ok: false, code: 'grape_name' });
  expect(await read({ grapes: ['x'.repeat(61)] })).toEqual({ ok: false, code: 'grape_name' });
  // The same list passes one door and not the other: the limit is the door's.
  const thirteen = Array(13).fill('Merlot');
  expect(await read({ grapes: thirteen }, { grapesMax: 12 })).toEqual({ ok: false, code: 'grapes_list' });
  expect(await read({ grapes: thirteen }, { grapesMax: 20 })).toMatchObject({ ok: true, proposedFields: { grapes: ['Merlot'] } });
});

test('a variety the taxonomy lacks is refused unless the caller declared it new, and then only if it reads as a name', async () => {
  expect(await read({ grapes: ['Merlot', 'Solaris'] })).toEqual({ ok: false, code: 'unknown_grapes', names: ['Solaris'] });
  expect(await read({ grapes: ['Merlot', 'Solaris'] }, { declaredNew: ['solaris'] })).toMatchObject({
    ok: true, proposedFields: { grapes: ['Merlot', 'Solaris'] }, newGrapeNames: ['Solaris'],
  });
  expect(await read({ grapes: ['Solaris & Rondo'] }, { declaredNew: ['Solaris & Rondo'] })).toEqual({ ok: false, code: 'implausible_grapes', names: ['Solaris & Rondo'] });
  expect(await read({ grapes: ['Solaris'] }, { declaredNew: 'Solaris' })).toEqual({ ok: false, code: 'new_grapes_list' });
});
