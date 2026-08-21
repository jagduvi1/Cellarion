/**
 * The classifier is replayed against the REAL curation day it was designed
 * from (2026-08-21, 16 proposals) rather than invented cases — the whole
 * argument for loosening the gate rests on that day's numbers, so the test
 * that guards it should be that day.
 */
const {
  classifyProposal, appellationImpliedByName, proposedAppellationCountryConflict, appellationsAgree,
} = require('./proposalDirectApply');
const Appellation = require('../models/Appellation');

// The REAL keying function, not a hand-rolled copy: a mock that normalized
// differently from production would let every test here pass while the live
// lookup missed. "Côtes de Saint-Mont" and the hyphen fold make that a live
// risk, not a theoretical one.
const { normalizeAppellationKey: norm } = require('../utils/normalize');

const IT = 'country-italy';
const FR = 'country-france';
const AU = 'country-australia';
const NZ = 'country-newzealand';
const ES = 'country-spain';

// The curated appellations the day's names actually touch, each with the
// country the real doc carries — the model's unique index is country + name,
// so country is part of an appellation's identity, not decoration.
const CURATED = [
  ['Barolo', IT], ['Barbaresco', IT], ['Langhe', IT], ['Chianti', IT], ['Chianti Classico', IT],
  ['Soave Classico', IT], ['Taurasi', IT], ['Veronese', IT], ['Rosso Veronese', IT],
  ['Veneto', IT], ['Vino Rosso', IT], ['Prosecco', IT],
  ['Bourgogne Hautes-Côtes de Beaune', FR], ['Saint-Mont', FR], ['Palette', FR],
  ['King Valley', AU], ['Barossa', AU], ['Hunter Valley', AU],
  ['Marlborough', NZ],
  ['Rioja', ES],
];

beforeEach(() => {
  jest.spyOn(Appellation, 'find').mockImplementation((query) => {
    const clause = query.$or[0].normalizedName;
    const keys = clause.$in ? clause.$in : [clause];
    const docs = CURATED
      .filter(([name]) => keys.includes(norm(name)))
      .map(([name, country]) => ({ name, country, normalizedName: norm(name), normalizedSynonyms: [] }));
    return { lean: async () => docs };
  });
});
afterEach(() => jest.restoreAllMocks());

const wine = (name, over = {}) => ({
  name, appellation: null, region: null, classification: null, country: IT, ...over,
});

describe('appellationImpliedByName', () => {
  it('takes the LONGEST match so a qualified appellation beats its parent', async () => {
    // "Chianti Classico" contains "Chianti"; picking the shorter one would make
    // a correct "Chianti Classico" proposal look like a contradiction.
    expect((await appellationImpliedByName('Chianti Classico', IT)).name).toBe('Chianti Classico');
  });

  it('finds an appellation embedded mid-name', async () => {
    expect((await appellationImpliedByName('Della Società Taurasi Riserva', IT)).name).toBe('Taurasi');
    expect((await appellationImpliedByName('Langhe Nebbiolo', IT)).name).toBe('Langhe');
  });

  it('returns null when the name states no place', async () => {
    expect(await appellationImpliedByName('Barossa Shiraz Reserve', AU)).toBeTruthy();
    expect(await appellationImpliedByName('Cask 66', AU)).toBeNull();
    expect(await appellationImpliedByName('', IT)).toBeNull();
  });

  // Found live 2026-08-21 dry-running a backfill over 237 rows: it offered
  // exactly 3 writes and 2 were Provence onto the southern hemisphere.
  it('ignores a name-derived appellation from ANOTHER country', async () => {
    // Nockie's "Palette" is a range name. The Pinot is from New Zealand, the
    // Rosé from South Africa, and Palette is an AOC in Provence.
    expect(await appellationImpliedByName('Palette Pinot Noir', NZ)).toBeNull();
    // …and still resolves for a wine that really is French.
    expect((await appellationImpliedByName('Palette Rouge', FR)).name).toBe('Palette');
  });

  it('keeps the match when the wine has no country — cannot check, so stay conservative', async () => {
    expect((await appellationImpliedByName('Palette Pinot Noir', null)).name).toBe('Palette');
  });
});

describe('proposedAppellationCountryConflict — the dangerous direction', () => {
  it('flags a curated appellation from the wrong country', async () => {
    // The curator's own warning: Italy registered Prosecco as an EU GI, and it
    // is exactly what a careless rule stamps onto a King Valley wine.
    const hit = await proposedAppellationCountryConflict('Prosecco', AU);
    expect(hit && hit.name).toBe('Prosecco');
  });

  it('allows an appellation curated in the wine\'s own country', async () => {
    expect(await proposedAppellationCountryConflict('King Valley', AU)).toBeNull();
    expect(await proposedAppellationCountryConflict('Barolo', IT)).toBeNull();
  });

  it('stays silent on free text — an uncurated name has no country to disagree with', async () => {
    // Appellations are deliberately open-ended; silence here is honest.
    expect(await proposedAppellationCountryConflict('Terra Alta', ES)).toBeNull();
  });

  it('stays silent when the wine has no country', async () => {
    expect(await proposedAppellationCountryConflict('Prosecco', null)).toBeNull();
  });
});

describe('appellationsAgree — a rename is not a contradiction', () => {
  it('accepts the containing form (Côtes de Saint-Mont / Saint-Mont, renamed 2011)', () => {
    expect(appellationsAgree({ normalizedName: 'cotes de saint mont' }, 'Saint-Mont')).toBe(true);
  });
  it('rejects a different denomination', () => {
    expect(appellationsAgree({ normalizedName: 'rosso veronese' }, 'Veneto IGT')).toBe(false);
  });
});

describe('the 2026-08-21 curation day, replayed', () => {
  // The eleven that were pure lookups — these are what the change is FOR.
  // Country matters to the rule now, so each row carries the one its wine
  // really has — a fixture that made every wine Italian would have "failed"
  // the French and Spanish rows for a reason that has nothing to do with them.
  const APPLIES = [
    ['Barolo', IT, { appellation: 'Barolo', region: 'Piedmont' }],
    ['Barbaresco', IT, { appellation: 'Barbaresco', region: 'Piedmont' }],
    ['Langhe Nebbiolo', IT, { appellation: 'Langhe', region: 'Piedmont' }],
    ['Chianti Classico', IT, { appellation: 'Chianti Classico', region: 'Tuscany' }],
    ['Chianti', IT, { appellation: 'Chianti', region: 'Tuscany' }],
    ['Soave Classico', IT, { appellation: 'Soave Classico', region: 'Veneto' }],
    ['Rioja Reserva', ES, { appellation: 'Rioja', region: 'Rioja', classification: 'Reserva' }],
    ['Côtes de Saint-Mont', FR, { appellation: 'Saint-Mont', region: 'South West France' }],
    ['Bourgogne Hautes-Côtes de Beaune Rouge', FR, { appellation: 'Bourgogne Hautes-Côtes de Beaune', region: 'Burgundy' }],
    ['Pokolbin Hills Vermentino', AU, { region: 'Hunter Valley' }],
    ['Della Società Taurasi Riserva', IT, { appellation: 'Taurasi', region: 'Campania', classification: 'Riserva' }],
  ];

  it.each(APPLIES)('applies on filing: %s', async (name, country, fields) => {
    const v = await classifyProposal(wine(name, { country }), 'field_correction', fields);
    expect(v).toEqual({ direct: true, reason: expect.any(String) });
  });

  it('ROUTES Rosso Veronese — the one case the human gate actually caught', async () => {
    const v = await classifyProposal(wine('Rosso Veronese', { country: IT }), 'field_correction',
      { appellation: 'Veneto IGT', region: 'Veneto' });
    expect(v.direct).toBe(false);
    expect(v.reason).toContain('Rosso Veronese');
  });

  // The country rule CHANGED this case, and for the better. The curator was
  // right — King Valley Glera is a real category — so their correction now
  // applies instead of waiting on a review round trip. "Prosecco" in an
  // Australian wine's name never implied the Italian DOC in the first place.
  it('APPLIES the Australian Prosecco → King Valley correction', async () => {
    const v = await classifyProposal(wine('Prosecco', { country: AU }), 'field_correction',
      { appellation: 'King Valley', region: 'King Valley' });
    expect(v.direct).toBe(true);
  });

  it('…while still ROUTING the Italian DOC onto that same Australian wine', async () => {
    // The error the curator actually warned about. Scoping the NAME check by
    // country would have let this through on its own; the proposed-appellation
    // check is what catches it.
    const v = await classifyProposal(wine('Prosecco', { country: AU }), 'field_correction',
      { appellation: 'Prosecco' });
    expect(v.direct).toBe(false);
    expect(v.reason).toMatch(/not in this wine's country/);
  });

  it('ROUTES a place onto a generic EU designation (the Monatio class)', async () => {
    // "Vino Rosso" is legally defined by carrying NO geographic indication, and
    // it is a curated appellation in its own right — so a proposal writing a
    // place onto it contradicts the name and must be read by a human.
    const v = await classifyProposal(wine('Monatio Vino Rosso Bio', { country: IT }), 'field_correction',
      { appellation: 'Rosso Conero' });
    expect(v.direct).toBe(false);
  });

  it('APPLIES a correction on a wine whose name names a FOREIGN place', async () => {
    // Nockie's Palette Pinot Noir is from New Zealand. Before the country
    // rule the name "disagreed" with Marlborough and the curator was made to
    // wait for review on a correction that was never in doubt.
    const v = await classifyProposal(wine('Palette Pinot Noir', { country: NZ }), 'field_correction',
      { appellation: 'Marlborough' });
    expect(v.direct).toBe(true);
  });
});

describe('what stays gated, and why', () => {
  it('gates producer and name — dedup key, public URL, measured failure class', async () => {
    for (const f of [{ producer: 'Zarea' }, { name: 'Almodí Petit Blanc' }]) {
      const v = await classifyProposal(wine('Barolo'), 'field_correction', f);
      expect(v.direct).toBe(false);
      expect(v.reason).toMatch(/admin-reviewed/);
    }
  });

  it('gates country', async () => {
    expect((await classifyProposal(wine('Barolo'), 'field_correction', { country: 'Italy' })).direct).toBe(false);
  });

  it('gates type and grapes (they have their own direct path, set_wine_profile)', async () => {
    const v = await classifyProposal(wine('Conte di Valle'), 'field_correction',
      { region: 'Veneto', grapes: ['Corvina'] });
    expect(v.direct).toBe(false);
  });

  it('gates an OVERWRITE even on an otherwise-direct field', async () => {
    // Filling a blank and replacing curated data are different acts.
    const v = await classifyProposal(
      wine('Barolo', { appellation: 'Barbaresco' }), 'field_correction', { appellation: 'Barolo' });
    expect(v.direct).toBe(false);
    expect(v.reason).toMatch(/already has a value/);
  });

  it('treats a POPULATED region ref as set, not blank', async () => {
    const v = await classifyProposal(
      wine('Barolo', { region: { _id: 'r1', name: 'Piedmont' } }), 'field_correction', { region: 'Piedmont' });
    expect(v.direct).toBe(false);
  });

  it('gates merges — performWineMerge deletes the absorbed record', async () => {
    expect((await classifyProposal(wine('X'), 'merge', null)).direct).toBe(false);
  });

  it('gates non_wine quarantines', async () => {
    expect((await classifyProposal(wine('X'), 'non_wine', null)).direct).toBe(false);
  });

  it('refuses an empty payload rather than applying nothing', async () => {
    expect((await classifyProposal(wine('Barolo'), 'field_correction', {})).direct).toBe(false);
  });
});
