/**
 * The classifier is replayed against the REAL curation day it was designed
 * from (2026-08-21, 16 proposals) rather than invented cases — the whole
 * argument for loosening the gate rests on that day's numbers, so the test
 * that guards it should be that day.
 */
const { classifyProposal, appellationImpliedByName, appellationsAgree } = require('./proposalDirectApply');
const Appellation = require('../models/Appellation');

// The curated appellations the day's names actually touch, with the shape the
// real docs have (normalizedName as the resolver keys them).
const CURATED = [
  'Barolo', 'Barbaresco', 'Langhe', 'Chianti', 'Chianti Classico', 'Soave Classico',
  'Rioja', 'Bourgogne Hautes-Côtes de Beaune', 'Saint-Mont', 'Prosecco', 'King Valley',
  'Taurasi', 'Veronese', 'Rosso Veronese', 'Veneto', 'Vino Rosso', 'Barossa', 'Hunter Valley',
];

// The REAL keying function, not a hand-rolled copy: a mock that normalized
// differently from production would let every test here pass while the live
// lookup missed. "Côtes de Saint-Mont" and the hyphen fold make that a live
// risk, not a theoretical one.
const { normalizeAppellationKey: norm } = require('../utils/normalize');

beforeEach(() => {
  jest.spyOn(Appellation, 'find').mockImplementation((query) => {
    const keys = query.$or[0].normalizedName.$in;
    const docs = CURATED
      .filter((name) => keys.includes(norm(name)))
      .map((name) => ({ name, normalizedName: norm(name), normalizedSynonyms: [] }));
    return { lean: async () => docs };
  });
});
afterEach(() => jest.restoreAllMocks());

const wine = (name, over = {}) => ({ name, appellation: null, region: null, classification: null, ...over });

describe('appellationImpliedByName', () => {
  it('takes the LONGEST match so a qualified appellation beats its parent', async () => {
    // "Chianti Classico" contains "Chianti"; picking the shorter one would make
    // a correct "Chianti Classico" proposal look like a contradiction.
    expect((await appellationImpliedByName('Chianti Classico')).name).toBe('Chianti Classico');
  });

  it('finds an appellation embedded mid-name', async () => {
    expect((await appellationImpliedByName('Della Società Taurasi Riserva')).name).toBe('Taurasi');
    expect((await appellationImpliedByName('Langhe Nebbiolo')).name).toBe('Langhe');
  });

  it('returns null when the name states no place', async () => {
    expect(await appellationImpliedByName('Barossa Shiraz Reserve')).toBeTruthy(); // Barossa IS curated
    expect(await appellationImpliedByName('Cask 66')).toBeNull();
    expect(await appellationImpliedByName('')).toBeNull();
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
  const APPLIES = [
    ['Barolo', { appellation: 'Barolo', region: 'Piedmont' }],
    ['Barbaresco', { appellation: 'Barbaresco', region: 'Piedmont' }],
    ['Langhe Nebbiolo', { appellation: 'Langhe', region: 'Piedmont' }],
    ['Chianti Classico', { appellation: 'Chianti Classico', region: 'Tuscany' }],
    ['Chianti', { appellation: 'Chianti', region: 'Tuscany' }],
    ['Soave Classico', { appellation: 'Soave Classico', region: 'Veneto' }],
    ['Rioja Reserva', { appellation: 'Rioja', region: 'Rioja', classification: 'Reserva' }],
    ['Côtes de Saint-Mont', { appellation: 'Saint-Mont', region: 'South West France' }],
    ['Bourgogne Hautes-Côtes de Beaune Rouge', { appellation: 'Bourgogne Hautes-Côtes de Beaune', region: 'Burgundy' }],
    ['Pokolbin Hills Vermentino', { region: 'Hunter Valley' }],
    ['Della Società Taurasi Riserva', { appellation: 'Taurasi', region: 'Campania', classification: 'Riserva' }],
  ];

  it.each(APPLIES)('applies on filing: %s', async (name, fields) => {
    const v = await classifyProposal(wine(name), 'field_correction', fields);
    expect(v).toEqual({ direct: true, reason: expect.any(String) });
  });

  it('ROUTES Rosso Veronese — the one case the human gate actually caught', async () => {
    const v = await classifyProposal(wine('Rosso Veronese'), 'field_correction',
      { appellation: 'Veneto IGT', region: 'Veneto' });
    expect(v.direct).toBe(false);
    expect(v.reason).toContain('Rosso Veronese');
  });

  it('ROUTES the Australian Prosecco — and calls it routing, not rejection', async () => {
    // The curator was RIGHT here: King Valley Glera is a real category and the
    // Italian DOC would have been the error. A rule that BLOCKED this would
    // have blocked the most valuable correction of the day.
    const v = await classifyProposal(wine('Prosecco'), 'field_correction',
      { appellation: 'King Valley', region: 'King Valley' });
    expect(v.direct).toBe(false);
    expect(v.reason).toMatch(/not a rejection/i);
  });

  it('ROUTES a place onto a generic EU designation (the Monatio class)', async () => {
    // "Vino Rosso" is legally defined by carrying NO geographic indication, and
    // it is a curated appellation in its own right — so a proposal writing a
    // place onto it contradicts the name and must be read by a human.
    const v = await classifyProposal(wine('Monatio Vino Rosso Bio'), 'field_correction',
      { appellation: 'Rosso Conero' });
    expect(v.direct).toBe(false);
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
