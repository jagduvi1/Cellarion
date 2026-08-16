/**
 * Enrichment persistence — the markdown boundary (#788).
 *
 * aiProfile.description is served RAW by the MCP tools (get_wine, get_bottle),
 * so emphasis the model emits leaks as literal ** to any consumer that doesn't
 * render markdown. The prompt now forbids it, but the prompt is advisory and a
 * self-hoster can override it via SiteConfig — so the strip at the write point
 * is the load-bearing half and is what these tests pin.
 *
 * Driven through enrichWineById (the exported single-wine path); enrichWine
 * itself is module-private and both entry points share it.
 */

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('./labelScan', () => ({ suggestProfile: jest.fn() }));
jest.mock('./aiProvider', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('./embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./aiBudget', () => ({ tryDebitAi: jest.fn(), isRefundableFailure: jest.fn(() => false) }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ enrichmentModel: 'claude-sonnet-5' })) }));

const WineDefinition = require('../models/WineDefinition');
const { suggestProfile } = require('./labelScan');
const { enrichWineById } = require('./enrichmentJob');

const WINE_ID = 'a'.repeat(24);

const chain = (doc) => {
  const c = {};
  for (const m of ['populate', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(doc));
  return c;
};

// The profile the model returns; description varies per test.
const profile = (description) => ({
  data: {
    body: 'medium', tannin: 'low', acidity: 'medium', sweetness: 'dry',
    flavors: ['cherry'], foodPairings: ['roast chicken'],
    description, confidence: 0.7,
  },
  debugReason: null,
});

// The aiProfile actually handed to the DB.
const persisted = () => WineDefinition.updateOne.mock.calls[0][1].$set.aiProfile;

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Pinot Noir', producer: 'Matua', type: 'red',
    country: { name: 'New Zealand' }, region: { name: 'Marlborough' }, grapes: [{ name: 'Pinot Noir' }],
  }));
  WineDefinition.updateOne.mockResolvedValue({});
});

describe('aiProfile.description is persisted as plain text', () => {
  // Verbatim from the issue: Matua Pinot Noir, enriched by claude-sonnet-5.
  test('strips the bold emphasis the model emits despite the prompt', async () => {
    suggestProfile.mockResolvedValue(profile(
      'An everyday **cherry**-driven pinot rather than a serious cellaring wine.'
    ));
    await enrichWineById(WINE_ID);
    expect(persisted().description)
      .toBe('An everyday cherry-driven pinot rather than a serious cellaring wine.');
    expect(persisted().description).not.toMatch(/\*/);
  });

  test('leaves already-plain prose byte-identical', async () => {
    const plain = 'Bright red fruit and soft tannins. Drink over the next three years.';
    suggestProfile.mockResolvedValue(profile(plain));
    await enrichWineById(WINE_ID);
    expect(persisted().description).toBe(plain);
  });

  test('a description that is pure markup persists as null, not an empty string', async () => {
    // '' would look enriched to the incremental filter and never be retried.
    suggestProfile.mockResolvedValue(profile('****'));
    await enrichWineById(WINE_ID);
    expect(persisted().description).toBeNull();
  });

  test('a non-string description still persists as null', async () => {
    suggestProfile.mockResolvedValue(profile(undefined));
    await enrichWineById(WINE_ID);
    expect(persisted().description).toBeNull();
  });

  test('the structured descriptors are untouched by the strip', async () => {
    suggestProfile.mockResolvedValue(profile('Juicy and **bright**.'));
    await enrichWineById(WINE_ID);
    expect(persisted()).toMatchObject({
      body: 'medium', tannin: 'low', acidity: 'medium', sweetness: 'dry',
      flavors: ['cherry'], foodPairings: ['roast chicken'], confidence: 0.7,
    });
  });
});

/**
 * Sentinel-string coercion (support tickets 2026-07-30 / 2026-08-03).
 *
 * The model sometimes emits the four-character STRING "null" inside a
 * string-typed descriptor instead of the JSON literal — 161 prod profiles
 * carried tannin: "null", which passes every truthiness check and leaks the
 * token into the embedding text. The prompt now forbids it, but the write
 * point is the guarantee: sentinel strings and out-of-enum values collapse
 * to a real null.
 */
describe('descriptor sanitization at the write point', () => {
  test('the string "null" persists as a real null (the Fino/Dives case)', async () => {
    const p = profile('A pale, bone-dry fino style.');
    p.data.tannin = 'null';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().tannin).toBeNull();
  });

  test.each([['None'], ['N/A'], ['n/a'], ['undefined'], ['unknown'], [''], ['-']])(
    'sentinel %p collapses to null', async (val) => {
      const p = profile('Fine.');
      p.data.sweetness = val;
      suggestProfile.mockResolvedValue(p);
      await enrichWineById(WINE_ID);
      expect(persisted().sweetness).toBeNull();
    });

  test('an out-of-enum value collapses to null rather than persisting', async () => {
    const p = profile('Fine.');
    p.data.body = 'muscular';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().body).toBeNull();
  });

  test('valid values case-fold onto the enum', async () => {
    const p = profile('Fine.');
    p.data.tannin = 'High';
    p.data.sweetness = ' Off-Dry ';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().tannin).toBe('high');
    expect(persisted().sweetness).toBe('off-dry');
  });

  test('sentinel entries are dropped from flavors/foodPairings, real ones kept', async () => {
    const p = profile('Fine.');
    p.data.flavors = ['cherry', 'null', 'N/A', '  ', 'tar'];
    p.data.foodPairings = ['None', 'roast chicken'];
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().flavors).toEqual(['cherry', 'tar']);
    expect(persisted().foodPairings).toEqual(['roast chicken']);
  });

  test('a producerNote of "null" persists as a real null', async () => {
    const p = profile('Fine.');
    p.data.producerSuspect = true;
    p.data.producerNote = 'null';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().producerNote).toBeNull();
    expect(persisted().producerSuspect).toBe(true);
  });
});

/**
 * Bounds on model output (security audit 2026-08-03, M-2 and L-4).
 *
 * Two different failures, both silent. The confidence number decides whether a
 * row is ever reviewed — the low-confidence queue filters on `$lte: threshold`,
 * so a model persuaded to answer 1.0 makes its own row invisible to the humans
 * meant to check it. And the list/prose fields were capped by COUNT but not by
 * LENGTH, so unbounded strings reached the shared registry, the embedding text
 * and the MCP tools, while a curator editing the same field was held to 40/60.
 */
describe('bounds on model output', () => {
  test('confidence above 1 clamps to 1', async () => {
    // Note this does NOT put the row in the review queue — a clamped 1.0 is
    // still above any sane threshold. Queue visibility for unusable values is
    // the query's job (routes/admin/wines.js), not the clamp's; an earlier
    // version of this test claimed otherwise and was wrong.
    const p = profile('Fine.');
    p.data.confidence = 7;
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().confidence).toBe(1);
  });

  test('Infinity from a 1e400 in the model JSON does not persist as a number', async () => {
    // JSON.parse('{"confidence":1e400}') yields Infinity without throwing, and
    // Infinity survived the old `typeof === 'number'` check.
    const p = profile('Fine.');
    p.data.confidence = JSON.parse('{"c":1e400}').c;
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().confidence).toBeNull();
  });

  test('a negative confidence clamps to 0', async () => {
    const p = profile('Fine.');
    p.data.confidence = -3;
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().confidence).toBe(0);
  });

  test('a numeric string is accepted and clamped, not stored as a string', async () => {
    const p = profile('Fine.');
    p.data.confidence = '0.4';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().confidence).toBe(0.4);
  });

  // These persist as null — "we don't know" — which is honest. What makes that
  // safe is that the admin queue and the registry watchdog now MATCH null
  // instead of excluding it with `$ne: null`. Storing null without that change
  // is what made the first version of this fix cosmetic: every unusable value
  // was routed into the one state guaranteed to hide the row.
  test.each([['high'], [NaN], [null], [undefined], [{}]])(
    'an unusable confidence %p persists as null rather than a junk number', async (val) => {
      const p = profile('Fine.');
      p.data.confidence = val;
      suggestProfile.mockResolvedValue(p);
      await enrichWineById(WINE_ID);
      expect(persisted().confidence).toBeNull();
    });

  test('list entries are truncated to the same length the curator path enforces', async () => {
    const p = profile('Fine.');
    p.data.flavors = ['x'.repeat(500), 'tar'];
    p.data.foodPairings = ['y'.repeat(500)];
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().flavors[0]).toHaveLength(40);
    expect(persisted().flavors[1]).toBe('tar');
    expect(persisted().foodPairings[0]).toHaveLength(60);
  });

  test('an unbounded description is truncated before it reaches the shared registry', async () => {
    const p = profile('z'.repeat(9000));
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().description).toHaveLength(1000);
  });
});

/**
 * M-3 (pending-identity security audit) — a pendingIdentity row is never
 * enriched. embeddingJob was gated for exactly this in the same PR and
 * enrichmentJob was not, so the AI was asked to describe a wine whose producer
 * is '' and whose region is often the misplaced string that made it pending.
 * Worse, services/bottleOps fires enrichWineById on EVERY bottle add with the
 * adder as budgetUserId — so the very add that MINTED the pending row spent
 * that user's daily AI budget on it, and the output would have surfaced as the
 * registry's tasting note the moment a curator promoted the wine.
 */
describe('pendingIdentity rows are never enriched', () => {
  const { tryDebitAi } = require('./aiBudget');

  test('enrichWineById returns before calling the model or debiting the budget', async () => {
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Kaefferkopf', producer: '', pendingIdentity: true,
      country: { name: 'France' }, region: null, grapes: [],
    }));
    tryDebitAi.mockResolvedValue({ ok: true, refund: jest.fn() });

    await enrichWineById(WINE_ID, { budgetUserId: 'b'.repeat(24) });

    expect(suggestProfile).not.toHaveBeenCalled();
    expect(tryDebitAi).not.toHaveBeenCalled();
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });

  test('the gate is narrow: an ordinary unenriched wine is still processed', async () => {
    tryDebitAi.mockResolvedValue({ ok: true, refund: jest.fn() });
    suggestProfile.mockResolvedValue(profile('Bright and fresh.'));

    await enrichWineById(WINE_ID, { budgetUserId: 'b'.repeat(24) });

    expect(suggestProfile).toHaveBeenCalled();
    expect(WineDefinition.updateOne).toHaveBeenCalled();
  });
});

/**
 * Producer-suspect profiles are HELD, not published (ticket 6a8162c5).
 *
 * "Fabelhaft" — a Niepoort brand minted as a producer — got a confident
 * négociant biography from the generator, which FLAGGED producerSuspect:true
 * in the same response… and the flag sat in a passive queue while the fiction
 * served on the bottle page. A suspect profile now stores only the doubt
 * (confidence/flag/note + heldAt); the null description keeps every read
 * surface naturally silent, and the guards keep the per-add hook and
 * incremental batches from re-spending on a row that is waiting for a human.
 */
describe('producer-suspect profiles are held, not published', () => {
  const suspectProfile = () => ({
    data: {
      body: 'medium', tannin: 'medium', acidity: 'medium', sweetness: 'dry',
      flavors: ['plum'], foodPairings: ['stew'],
      description: 'A juicy regional blend from a négociant label.',
      confidence: 0.5,
      producerSuspect: true,
      producerNote: 'Fabelhaft is a Niepoort label, not an estate.',
    },
    debugReason: null,
  });

  test('suspect=true writes the doubt only: no description/axes, heldAt stamped', async () => {
    suggestProfile.mockResolvedValue(suspectProfile());
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.description).toBeNull();
    expect(p.body).toBeNull();
    expect(p.flavors).toEqual([]);
    expect(p.foodPairings).toEqual([]);
    expect(p.producerSuspect).toBe(true);
    expect(p.producerNote).toMatch(/Niepoort/);
    expect(p.confidence).toBe(0.5);
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.generatedAt).toBeInstanceOf(Date);
  });

  test('a held wine is not re-enriched by the per-add hook', async () => {
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Douro Tinto', producer: 'Fabelhaft', type: 'red',
      country: { name: 'Portugal' }, region: null, grapes: [],
      aiProfile: { heldAt: new Date(), description: null },
    }));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).not.toHaveBeenCalled();
  });

  test('force + publishSuspect publishes past the doubt (the review override)', async () => {
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Douro Tinto', producer: 'Fabelhaft', type: 'red',
      country: { name: 'Portugal' }, region: null, grapes: [],
      aiProfile: { heldAt: new Date(), description: null },
    }));
    suggestProfile.mockResolvedValue(suspectProfile());
    await enrichWineById(WINE_ID, { force: true, publishSuspect: true });
    const p = persisted();
    expect(p.description).toMatch(/juicy/);
    expect(p.heldAt).toBeNull();
    expect(p.producerSuspect).toBe(true); // provenance survives the override
  });

  test('curator profiles are never regenerated, force or not', async () => {
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Douro Tinto', producer: 'Niepoort',
      aiProfile: { source: 'curator', description: 'hand-written' },
    }));
    await enrichWineById(WINE_ID, { force: true, publishSuspect: true });
    expect(suggestProfile).not.toHaveBeenCalled();
  });

  test('a clean profile publishes with heldAt null and suspect false', async () => {
    suggestProfile.mockResolvedValue(profile('Plain prose.'));
    await enrichWineById(WINE_ID);
    expect(persisted().heldAt).toBeNull();
    expect(persisted().producerSuspect).toBe(false);
    expect(persisted().description).toBe('Plain prose.');
  });
});

/**
 * The record-edit follow-through (parity gap found live 2026-08-16: approving
 * "Fabelhaft" → "Niepoort" left the négociant-fiction profile attached until
 * a manual force re-enrich). The helper regenerates ONLY on a real change,
 * never over curator work, and treats HELD as enriched-and-regenerable —
 * an identity fix is exactly what resolves a hold.
 */
describe('reenrichAfterRecordEdit — the record-edit follow-through', () => {
  const { reenrichAfterRecordEdit } = require('./enrichmentJob');
  const enriched = (over = {}) => ({ _id: WINE_ID, aiProfile: { generatedAt: new Date(), source: 'ai', ...over } });

  test('a real change on an ai-sourced profile regenerates (force path reaches the model)', async () => {
    suggestProfile.mockResolvedValue(profile('Regenerated prose.'));
    await reenrichAfterRecordEdit(enriched(), true);
    expect(suggestProfile).toHaveBeenCalled();
    expect(persisted().description).toBe('Regenerated prose.');
  });

  test('no change → nothing happens, not even a wine read', async () => {
    await reenrichAfterRecordEdit(enriched(), false);
    expect(WineDefinition.findById).not.toHaveBeenCalled();
    expect(suggestProfile).not.toHaveBeenCalled();
  });

  test('a never-enriched wine has nothing stale → no call (the add hook covers fresh rows)', async () => {
    await reenrichAfterRecordEdit({ _id: WINE_ID, aiProfile: {} }, true);
    expect(suggestProfile).not.toHaveBeenCalled();
  });

  test('curator profiles are never regenerated from an edit', async () => {
    await reenrichAfterRecordEdit(enriched({ source: 'curator' }), true);
    expect(suggestProfile).not.toHaveBeenCalled();
  });

  test('a HELD profile counts as enriched — an identity fix regenerates it', async () => {
    suggestProfile.mockResolvedValue(profile('Clean profile under the fixed identity.'));
    await reenrichAfterRecordEdit(enriched({ heldAt: new Date(), description: null }), true);
    expect(suggestProfile).toHaveBeenCalled();
  });
});

describe('profileInputsSnapshot — the before/after comparison the routes use', () => {
  const { profileInputsSnapshot } = require('./enrichmentJob');

  test('folds populated docs and raw ids identically; grape order-insensitive', () => {
    const a = profileInputsSnapshot({ name: 'X', producer: 'Y', country: 'c1', region: 'r1', grapes: ['g1', 'g2'], type: 'red' });
    const b = profileInputsSnapshot({ name: 'X', producer: 'Y', country: { _id: 'c1' }, region: { _id: 'r1' }, grapes: [{ _id: 'g2' }, { _id: 'g1' }], type: 'red' });
    expect(a).toBe(b);
  });

  test('differs when any profile-feeding field changes', () => {
    const base = { name: 'X', producer: 'Y', country: 'c1', type: 'red' };
    for (const change of [
      { producer: 'Z' }, { name: 'X2' }, { country: 'c2' }, { region: 'r9' },
      { appellation: 'Margaux' }, { classification: 'Grand Cru Classé en 1855' },
      { type: 'white' }, { grapes: ['g1'] },
    ]) {
      expect(profileInputsSnapshot({ ...base, ...change })).not.toBe(profileInputsSnapshot(base));
    }
  });
});

/**
 * The NARROWED hold (2026-08-16). v1.116.0 held every producer-suspect
 * profile; measured against the 390 suspect rows that predate it, only ~2
 * were genuinely misleading and 370 were attached to real users' bottles —
 * a large user-visible cost for a small harm. The doubt now withholds only
 * when it could make the PROSE misleading: the model is also unsure of the
 * wine, or the prose talks about the producer as an entity.
 *
 * The 0.45 line is the enrichment prompt's own scale: 0.5 = "grape/region
 * knowledge only" (an honest appellation-level note, exactly right for a
 * brand-labelled wine), 0.4 = "mostly inferred from limited clues".
 */
describe('suspectHoldsProfile — which suspicions withhold the profile', () => {
  const { suspectHoldsProfile } = require('./enrichmentJob');
  const clean = 'Bright red fruit and soft tannins, made for early drinking.';

  test('unknown confidence holds — nobody can vouch for it', () => {
    expect(suspectHoldsProfile({ confidence: null, description: clean })).toBe(true);
  });

  test('low confidence holds regardless of prose (the Epiphany shape)', () => {
    expect(suspectHoldsProfile({ confidence: 0.4, description: clean })).toBe(true);
    expect(suspectHoldsProfile({ confidence: 0.45, description: clean })).toBe(true); // boundary is inclusive
  });

  test('grape/region-level confidence with clean prose PUBLISHES (the brand-wine case)', () => {
    expect(suspectHoldsProfile({ confidence: 0.5, description: clean })).toBe(false);
    expect(suspectHoldsProfile({ confidence: 0.6, description: clean })).toBe(false);
  });

  test('prose that talks about the PRODUCER holds even at high confidence (the Fabelhaft harm)', () => {
    for (const d of [
      'A négociant label known for sourcing well-priced wines from established regions.',
      'The family has farmed this estate for four generations.',
      'Made at the winery in Mendoza by a respected producer.',
    ]) {
      expect(suspectHoldsProfile({ confidence: 0.8, description: d })).toBe(true);
    }
  });

  test('an empty description with good confidence does not hold on the prose rule', () => {
    expect(suspectHoldsProfile({ confidence: 0.7, description: null })).toBe(false);
  });
});

describe('the narrowed hold end-to-end through enrichWine', () => {
  const suspectWith = (over) => ({
    data: {
      body: 'medium', tannin: 'medium', acidity: 'medium', sweetness: 'dry',
      flavors: ['plum'], foodPairings: ['stew'],
      producerSuspect: true,
      producerNote: 'Aldi is a supermarket retailer, not an estate.',
      ...over,
    },
    debugReason: null,
  });

  test('a suspect producer with an honest grape/region note is PUBLISHED with the doubt recorded', async () => {
    suggestProfile.mockResolvedValue(suspectWith({
      confidence: 0.6,
      description: 'An off-dry German Riesling with orchard fruit and bright acidity.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeNull();
    expect(p.description).toMatch(/Riesling/);
    // The doubt is not erased by publishing — the queue still lists it.
    expect(p.producerSuspect).toBe(true);
    expect(p.producerNote).toMatch(/supermarket/);
  });

  test('a suspect producer the model also cannot place is still HELD', async () => {
    suggestProfile.mockResolvedValue(suspectWith({
      confidence: 0.4,
      description: 'A red wine, probably in a modern international style.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.description).toBeNull();
    expect(p.producerSuspect).toBe(true);
  });
});
