/**
 * Identity provenance for AI-identified import rows.
 *
 * WHY THIS EXISTS (somm ticket 6a958dbc, 2026-08-31):
 * A 205-row import carried appellation on every row and grapes on none. The
 * identifier duly supplied grapes — by reasoning FROM the appellation — and
 * all eight Montlouis-sur-Loire wines came out Chenin Blanc, including a
 * pétillant naturel that is mostly Menu Pineau, and a Coteaux d'Ancenis red
 * Pinot Noir came out white Malvoisie. The values were wrong, mutually
 * consistent, and indistinguishable from researched ones, so the curator
 * stopped work: a profile written onto a misidentified record marks it
 * verified forever.
 *
 * The fix is not better guessing — it is saying which values were guesses.
 * These tests pin the rule that a field the FILE stated is never labelled
 * 'model', and that grapes with no file behind them always are.
 */

// Requiring the route pulls its whole dependency tree; meilisearch ships ESM
// that jest does not transform, so the module boundary is stubbed exactly as
// the other import suites do. Nothing below touches any of it — this is a pure
// function test.
jest.mock('../services/search', () => ({
  indexWine: jest.fn(), bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn(), findOrCreateRegion: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const { computeIdentityProvenance } = require('./import');

// The real shape of the failing rows: identity columns, no type, no grapes.
const loireRow = (over = {}) => ({
  wineName: 'Sans Pagne', producer: 'Ludovic Chanson', vintage: '2021',
  country: 'France', region: 'Vallée de la Loire', appellation: 'Montlouis sur Loire',
  bottleSize: '750 ml', ...over,
});

const identified = (over = {}) => ({
  name: 'Sans Pagne', producer: 'Ludovic Chanson', country: 'France',
  region: 'Vallée de la Loire', appellation: 'Montlouis sur Loire',
  type: 'white', grapes: ['Chenin Blanc'], ...over,
});

describe('computeIdentityProvenance — the ticket 6a958dbc row', () => {
  test('appellation and region are the FILE; type and grapes are the MODEL', () => {
    const p = computeIdentityProvenance(loireRow(), identified());
    expect(p.appellation).toBe('file');
    expect(p.region).toBe('file');
    // The two fields nobody stated — and the two the curator found wrong.
    expect(p.type).toBe('model');
    expect(p.grapes).toBe('model');
  });

  test('name and producer are always the model on this path (it canonicalises them)', () => {
    const p = computeIdentityProvenance(loireRow(), identified());
    expect(p.name).toBe('model');
    expect(p.producer).toBe('model');
  });
});

describe('a field the file DID state is never labelled model', () => {
  test('a stated type is file, even when the model also had one', () => {
    const p = computeIdentityProvenance(loireRow({ type: 'sparkling' }), identified({ type: 'white' }));
    expect(p.type).toBe('file');
  });

  test('an INVALID file type falls through to the model, matching the merge', () => {
    // The merge only accepts a value the schema allows; anything else must not
    // be credited to the file, or provenance would vouch for a discarded value.
    const p = computeIdentityProvenance(loireRow({ type: 'purple' }), identified({ type: 'red' }));
    expect(p.type).toBe('model');
  });

  test('blank and whitespace columns are not "stated"', () => {
    const p = computeIdentityProvenance(
      loireRow({ appellation: '', region: '   ', classification: undefined }),
      identified({ appellation: 'Vouvray', region: 'Loire', classification: 'AOC' }),
    );
    expect(p.appellation).toBe('model');
    expect(p.region).toBe('model');
    expect(p.classification).toBe('model');
  });
});

describe('grapes — the field with a real file fallback', () => {
  test('grapes the file supplied are credited to the file', () => {
    // /validate supplements the model's EMPTY grape list from the row, so a
    // grape list genuinely can be the file's.
    const p = computeIdentityProvenance(
      loireRow({ grapes: ['Menu Pineau', 'Chardonnay'] }),
      identified({ grapes: ['Menu Pineau', 'Chardonnay'] }),
    );
    expect(p.grapes).toBe('file');
  });

  test('a model list that merely OVERLAPS the file is still the model', () => {
    const p = computeIdentityProvenance(
      loireRow({ grapes: ['Chenin Blanc'] }),
      identified({ grapes: ['Chenin Blanc', 'Chardonnay'] }),
    );
    expect(p.grapes).toBe('model');
  });

  test('spelling and case differences do not break the file credit', () => {
    const p = computeIdentityProvenance(
      loireRow({ grapes: ['chenin blanc'] }),
      identified({ grapes: ['Chenin Blanc'] }),
    );
    expect(p.grapes).toBe('file');
  });

  test('no grapes anywhere is still labelled model, but the mint drops it', () => {
    // computeIdentityProvenance labels intent; findOrCreateWine's pickProvenance
    // discards labels for fields that ended up empty, so no wine claims a
    // source for a grape list it does not have.
    const p = computeIdentityProvenance(loireRow(), identified({ grapes: [] }));
    expect(p.grapes).toBe('model');
  });
});

describe('country keeps the merge\'s inverted precedence', () => {
  test('the model wins when it identified one (it normalises local names)', () => {
    const p = computeIdentityProvenance(loireRow({ country: 'Frankreich' }), identified({ country: 'France' }));
    expect(p.country).toBe('model');
  });

  test('the file is the fallback when the model returned none', () => {
    const p = computeIdentityProvenance(loireRow(), identified({ country: null }));
    expect(p.country).toBe('file');
  });
});

describe('robustness', () => {
  test('a missing row or identification does not throw', () => {
    expect(() => computeIdentityProvenance(undefined, identified())).not.toThrow();
    expect(() => computeIdentityProvenance(loireRow(), undefined)).not.toThrow();
    expect(() => computeIdentityProvenance(undefined, undefined)).not.toThrow();
  });

  test('a non-string column is not mistaken for a stated value', () => {
    const p = computeIdentityProvenance(loireRow({ appellation: { $ne: null } }), identified());
    expect(p.appellation).toBe('model');
  });
});

/**
 * Provenance follows the VALUE, not the column it was typed in.
 *
 * When a Prädikat is routed out of the appellation column (somm ticket
 * 6a966386), the appellation the wine ends up with came from the model even
 * though the file's column was filled — and the classification came from the
 * file even though its column was empty. Reporting the columns would tell the
 * curator the exact opposite of the truth on both fields, which matters
 * because provenance is what they reason from when deciding whom to believe.
 */
describe('a Prädikat routed out of the appellation column', () => {
  const molitorRow = () => ({
    wineName: 'Riesling Auslese Bernkasteler Badstube', producer: 'Markus Molitor',
    country: 'Allemagne', region: 'Moselle', appellation: 'Auslese',
  });
  const molitorAi = (over = {}) => ({
    name: 'Riesling Auslese Bernkasteler Badstube', producer: 'Markus Molitor',
    country: 'Germany', region: 'Mosel', appellation: 'Mosel', classification: null,
    type: 'white', grapes: ['Riesling'], ...over,
  });

  test(`the appellation is the MODEL's, even though the file's column was filled`, () => {
    expect(computeIdentityProvenance(molitorRow(), molitorAi()).appellation).toBe('model');
  });

  test("the classification is the FILE's, even though the file's column was empty", () => {
    expect(computeIdentityProvenance(molitorRow(), molitorAi()).classification).toBe('file');
  });

  test(`a contradicted Prädikat is nobody's classification but the model's`, () => {
    // Dropped rather than rescued (see buildProposedWine), so the file did not
    // supply the value that survived — claiming it did would credit the owner
    // with a statement we deliberately threw away.
    const row = { wineName: 'Riesling Troken', producer: 'Dönnhoff', country: 'Allemagne', appellation: 'Trokenbeerenauslese' };
    const p = computeIdentityProvenance(row, molitorAi({ name: 'Riesling Trocken', appellation: 'Nahe' }));
    expect(p.classification).toBe('model');
    expect(p.appellation).toBe('model');
  });

  test(`an ordinary appellation is still the file's`, () => {
    const p = computeIdentityProvenance(molitorRow({}), molitorAi());
    expect(p.region).toBe('file');
    expect(computeIdentityProvenance({ ...molitorRow(), appellation: 'Bernkasteler Badstube' }, molitorAi()).appellation).toBe('file');
  });
});
