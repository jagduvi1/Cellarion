/**
 * buildBottleDocument — regional grape display names in the BOTTLES index
 * (audit 2026-08-11: the bottle card shows "Tinta Roriz" while the bottles
 * search document only carried "Tempranillo", so searching what you see
 * missed in cellar search).
 *
 * WHY THIS TEST EXISTS:
 * The bottle document must build its grapeNames with the SAME helper the wine
 * document uses (wineGrapeSearchNames) — canonical names always, plus the
 * regional display name that applies to THIS wine's country/region. For
 * bottles whose wine has no applicable mapping the field must be
 * byte-identical to the old plain join, so the change is pure recall.
 *
 * The builder is pure; meilisearch and the models are mocked so requiring the
 * service performs no I/O.
 */

jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({}));
jest.mock('../models/Bottle', () => ({}));
jest.mock('../models/Discussion', () => ({}));

const { buildBottleDocument } = require('./search');

const PORTUGAL = 'a'.repeat(24);
const DOURO = 'b'.repeat(24);
const ALENTEJO = 'c'.repeat(24);
const TEMPRANILLO_ID = 'd'.repeat(24);
const TOURIGA_ID = 'e'.repeat(24);

const bottle = (wineDefinition) => ({
  _id: { toString: () => 'bottle1' },
  cellar: 'cellar1',
  status: 'active',
  vintage: '2017',
  wineDefinition,
});

const douroWine = (grapes) => ({
  _id: 'wine1',
  name: 'Vintage Port',
  producer: 'Quinta do Exemplo',
  type: 'fortified',
  country: { _id: PORTUGAL, name: 'Portugal' },
  region: { _id: DOURO, name: 'Douro' },
  grapes,
});

describe('buildBottleDocument grapeNames', () => {
  test('appends the regional display name that applies to the wine\'s own place', () => {
    const doc = buildBottleDocument(bottle(douroWine([
      {
        _id: TEMPRANILLO_ID,
        name: 'Tempranillo',
        regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
      },
      { _id: TOURIGA_ID, name: 'Touriga Nacional' },
    ])));
    expect(doc.grapeNames).toBe('Tempranillo, Tinta Roriz, Touriga Nacional');
    // Filters stay on the canonical vocabulary — ids are untouched.
    expect(doc.grapeIds).toEqual([TEMPRANILLO_ID, TOURIGA_ID]);
  });

  test('a mapping for a DIFFERENT place does not leak in', () => {
    const doc = buildBottleDocument(bottle(douroWine([
      {
        _id: TEMPRANILLO_ID,
        name: 'Tempranillo',
        regionalNames: [{ country: PORTUGAL, region: ALENTEJO, name: 'Aragonez' }],
      },
    ])));
    // Region-level Alentejo entry never applies to a Douro wine.
    expect(doc.grapeNames).toBe('Tempranillo');
  });

  test('byte-stability: no applicable mapping → exactly the old plain join', () => {
    const doc = buildBottleDocument(bottle(douroWine([
      { _id: TEMPRANILLO_ID, name: 'Tempranillo' },
      { _id: TOURIGA_ID, name: 'Touriga Nacional' },
    ])));
    // The pre-change builder produced `.filter(g => g.name).map(g => g.name)
    // .join(', ')` — the shared helper must not change a single byte for
    // unmapped wines, or the whole index diffs on the next full sync.
    expect(doc.grapeNames).toBe('Tempranillo, Touriga Nacional');
  });

  test('bottles without a wineDefinition still build (empty grapeNames)', () => {
    const doc = buildBottleDocument(bottle(null));
    expect(doc.grapeNames).toBe('');
    expect(doc.wineName).toBe('');
  });
});
