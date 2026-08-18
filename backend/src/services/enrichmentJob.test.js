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
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({
  enrichmentModel: 'claude-sonnet-5',
  // The publication gate's calibrated defaults (ticket 6a83e765) — the
  // end-to-end tests below exercise holds on both sides of them.
  enrichmentHoldConfidenceFloor: 0.4,
  enrichmentHoldUnknownConfidenceBar: 0.55,
})) }));

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
    // A grapeless wine for this one: high tannin on the default Pinot Noir
    // fixture now trips the 6a8464ea taxonomy_conflict hold (by design), and
    // this test is about case-folding, not the cross-check.
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Red Blend', producer: 'Matua', type: 'red',
      country: { name: 'New Zealand' }, region: { name: 'Marlborough' }, grapes: [],
    }));
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
 * WHICH DOUBT WITHHOLDS A PROFILE (flag split 2026-08-17, gate 2026-08-18).
 *
 * One boolean used to answer two questions, and the hold fired on both:
 *   producerSuspect  — the Producer FIELD is wrong (Fabelhaft, a Niepoort
 *                      label sold as a house). The record is not a real
 *                      producer, so the profile is fiction. HOLD.
 *   producerUnknown  — a real winery name the model cannot place (Chateau
 *                      Hautes Graves, Thomas Allen). The record is FINE and
 *                      an appellation-level note is honest. PUBLISH.
 *
 * Measured cost of conflating them: ~47% of a 250-wine run withheld, almost
 * all of it the second kind, and the held rows then blocked the sommelier's
 * maturity queue because a held profile shows no tasting note.
 *
 * The day after the split, confidence was read by NOBODY: profiles published
 * at 0.2 while a held row sat at 0.3 (ticket 6a83e765). Confidence rejoined
 * as a calibrated FLOOR plus an unknown-producer bar — thresholds passed in
 * from aiConfig, missing thresholds disable the check (degrade open). The
 * function now returns the hold REASON (stored as aiProfile.heldReason) or
 * null to publish.
 */
describe('shouldHoldProfile — which doubt withholds the profile', () => {
  const { shouldHoldProfile } = require('./enrichmentJob');
  const clean = 'Bright red fruit and soft tannins, made for early drinking.';
  const GATE = { floor: 0.4, unknownBar: 0.55 };

  test('a wrong producer FIELD holds, at any confidence and with clean prose', () => {
    expect(shouldHoldProfile({ producerSuspect: true, producerUnknown: false, description: clean, confidence: 0.9 }, GATE)).toBe('producer_suspect');
  });

  test('a merely UNPLACEABLE producer with solid confidence publishes — the case that was over-held', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: 0.6 }, GATE)).toBeNull();
  });

  test('no doubt at all publishes', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: false, description: clean, confidence: 0.7 }, GATE)).toBeNull();
  });

  test('an unplaceable producer whose PROSE talks about the house still holds (the backstop)', () => {
    for (const d of [
      'A négociant label known for sourcing well-priced wines from established regions.',
      'The family has farmed this estate for four generations.',
      'Made at the winery in Mendoza by a respected producer.',
    ]) {
      expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: d, confidence: 0.8 }, GATE)).toBe('producer_claim');
    }
  });

  // Gate 2026-08-18 (ticket 6a83e765): the floor is strict-below, so the
  // calibrated boundary value itself publishes.
  test('below the floor holds regardless of flags; at the floor publishes', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: false, description: clean, confidence: 0.2 }, GATE)).toBe('low_confidence');
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: false, description: clean, confidence: 0.39 }, GATE)).toBe('low_confidence');
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: false, description: clean, confidence: 0.4 }, GATE)).toBeNull();
  });

  test('an unknown producer holds below the higher bar — weak confidence there is regional guesswork', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: 0.5 }, GATE)).toBe('unknown_low_confidence');
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: 0.55 }, GATE)).toBeNull();
    // The same 0.5 with a KNOWN producer publishes — the bar is unknown-only.
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: false, description: clean, confidence: 0.5 }, GATE)).toBeNull();
  });

  test('a null confidence skips both checks — degrade open, like the flags', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: null }, GATE)).toBeNull();
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: false, description: null, confidence: null }, GATE)).toBeNull();
  });

  test('missing thresholds disable the confidence gate — never a spurious hold', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: 0.1 })).toBeNull();
  });

  test('an empty description cannot trip the prose backstop', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: null, confidence: 0.8 }, GATE)).toBeNull();
  });
});

describe('the split flags end-to-end through enrichWine', () => {
  const withFlags = (over) => ({
    data: {
      body: 'medium', tannin: 'medium', acidity: 'medium', sweetness: 'dry',
      flavors: ['plum'], foodPairings: ['stew'],
      producerSuspect: false, producerUnknown: false,
      description: 'An off-dry German Riesling with orchard fruit and bright acidity.',
      confidence: 0.6,
      ...over,
    },
    debugReason: null,
  });

  test('an UNPLACEABLE producer is published, with both flags recorded on the row', async () => {
    suggestProfile.mockResolvedValue(withFlags({
      // 0.6 clears the unknown bar (0.55) — the honest appellation-level
      // majority the split released stays released under the gate.
      producerUnknown: true, confidence: 0.6,
      producerNote: 'Chateau Hautes Graves is not a producer I can place.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeNull();
    expect(p.description).toMatch(/Riesling/);
    expect(p.producerUnknown).toBe(true);
    expect(p.producerSuspect).toBe(false);
    // The doubt is recorded, not erased, so a curator still has the context.
    expect(p.producerNote).toMatch(/cannot place|can place/);
  });

  test('a WRONG producer field is still held, exactly as before', async () => {
    suggestProfile.mockResolvedValue(withFlags({
      producerSuspect: true, confidence: 0.7,
      producerNote: 'Fabelhaft is a Niepoort label, not an estate.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.description).toBeNull();
    expect(p.producerSuspect).toBe(true);
    expect(p.heldReason).toBe('producer_suspect');
  });

  // Gate 2026-08-18 (ticket 6a83e765): the two confidence holds, end to end,
  // with the reason persisted where the release queue reads it.
  test('a below-floor profile is HELD with heldReason low_confidence', async () => {
    suggestProfile.mockResolvedValue(withFlags({ confidence: 0.2 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('low_confidence');
    expect(p.description).toBeNull();
    // The number that fired the hold is preserved for the reviewer.
    expect(p.confidence).toBe(0.2);
  });

  test('an unknown producer under the bar is HELD as unknown_low_confidence', async () => {
    suggestProfile.mockResolvedValue(withFlags({ producerUnknown: true, confidence: 0.45 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('unknown_low_confidence');
    expect(p.producerUnknown).toBe(true);
  });

  // 6a8464ea phase 2: the fixture wine is a Pinot Noir — a grape DEFINED by
  // low tannin. The regional-prior hallucination carries no flag and high
  // confidence, so only the factual cross-check can catch it.
  test('a profile at the OPPOSITE structural extreme of the grape is HELD as taxonomy_conflict', async () => {
    suggestProfile.mockResolvedValue(withFlags({ tannin: 'high', confidence: 0.8 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('taxonomy_conflict');
    expect(p.producerNote).toMatch(/pinot noir is defined by low tannin/);
  });

  test('the agreeing extreme and medium never conflict — the check is one-sided', async () => {
    suggestProfile.mockResolvedValue(withFlags({ tannin: 'low', confidence: 0.8 }));
    await enrichWineById(WINE_ID);
    expect(persisted().heldAt).toBeNull();
  });

  test('a missing producerUnknown on an old/custom prompt degrades to "no doubt", never to a hold', async () => {
    const r = withFlags({});
    delete r.data.producerUnknown;
    delete r.data.producerSuspect;
    suggestProfile.mockResolvedValue(r);
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeNull();
    expect(p.producerUnknown).toBe(false);
    expect(p.producerSuspect).toBe(false);
  });
});

/**
 * releaseHeldProfile — the review override with the stamp INSIDE the success
 * path (audit 2026-08-16: stamping before the AI call hid a still-held row
 * from the queue forever when the call failed).
 */
describe('releaseHeldProfile', () => {
  const { releaseHeldProfile } = require('./enrichmentJob');
  const heldWine = () => ({
    _id: WINE_ID, name: 'Douro Tinto', producer: 'Fabelhaft', type: 'red',
    country: { name: 'Portugal' }, region: null, grapes: [],
    aiProfile: { generatedAt: new Date(), heldAt: new Date(), description: null, source: 'ai' },
  });

  test('publishes and THEN stamps the review — returns true', async () => {
    WineDefinition.findById.mockReturnValue(chain(heldWine()));
    suggestProfile.mockResolvedValue(profile('Now a real profile.'));

    await expect(releaseHeldProfile(WINE_ID)).resolves.toBe(true);
    // Two writes, in order: the published profile, then the review stamp.
    expect(WineDefinition.updateOne).toHaveBeenCalledTimes(2);
    expect(persisted().description).toBe('Now a real profile.');
    const [, stamp] = WineDefinition.updateOne.mock.calls[1];
    expect(stamp.$set.profileReviewedAt).toBeInstanceOf(Date);
  });

  test('a failed regeneration stamps NOTHING — the row stays in the queue for another click', async () => {
    WineDefinition.findById.mockReturnValue(chain(heldWine()));
    suggestProfile.mockResolvedValue({ data: null, debugReason: 'rate_limit_exceeded' });

    await expect(releaseHeldProfile(WINE_ID)).resolves.toBe(false);
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });
});

/**
 * A hold that replaces a previously PUBLISHED profile must re-embed too —
 * otherwise the old description keeps living in the Qdrant vectors and cellar
 * chat retrieves the wine by the very claims the hold silenced
 * (audit 2026-08-16).
 */
describe('the hold path re-embeds', () => {
  const { embedSinglePair } = require('./embeddingJob');
  const Bottle = require('../models/Bottle');

  test('holding triggers embedSinglePair for each active vintage', async () => {
    Bottle.distinct.mockResolvedValue(['2019', '2020']);
    suggestProfile.mockResolvedValue({
      data: {
        body: 'medium', tannin: 'medium', acidity: 'medium', sweetness: 'dry',
        flavors: ['plum'], foodPairings: ['stew'],
        description: 'A generic guess.', confidence: 0.4,
        producerSuspect: true, producerNote: 'Cannot place this producer.',
      },
      debugReason: null,
    });

    await enrichWineById(WINE_ID);
    expect(persisted().heldAt).toBeInstanceOf(Date);
    expect(embedSinglePair).toHaveBeenCalledWith(WINE_ID, '2019');
    expect(embedSinglePair).toHaveBeenCalledWith(WINE_ID, '2020');
  });
});

/**
 * The prompt must not assert what the record leaves blank (somm ticket
 * 6a82bfb7, 2026-08-17). The field-level fix worked — unverifiable region and
 * grapes are stored NULL rather than guessed — but the generator then wrote
 * "from the Hunter Valley" into the first sentence of a region-null record and
 * "a GSM blend" onto a record with no grapes. Same fabrication, one layer down,
 * and a curator reading the maturity queue takes prose as established fact.
 *
 * The rule lives in the PROMPT (a model writes the prose, not this module), so
 * what is pinned here is that the rule is present and specific — the same
 * stance the markdown-strip tests take: the prompt is advisory, the guarantee
 * is elsewhere, but the wording is load-bearing enough to protect.
 */
describe('the enrichment prompt forbids asserting unstated facts', () => {
  // aiConfig is mocked at the top of this file for the job's own use — the
  // prompt text itself has to come from the real module.
  const { DEFAULT_ENRICHMENT_PROMPT } = jest.requireActual('../config/aiConfig');

  test('it names the three blank fields the prose must not fill', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/NEVER assert in the prose a fact the record above leaves blank/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/If Region is blank, do not name a region/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/If Grapes is empty, do not name grape varieties/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/If Classification is blank, do not describe a quality tier/);
  });

  test('it keeps the legally-defined-grape exception, so Barolo can still say Nebbiolo', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/appellation that legally defines its own grapes/i);
  });

  test('it tells the model a thin description is the CORRECT output, not a failure', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/is the correct output, even when that is little/);
  });

  test('the two producer doubts are defined apart, and only the wrong-field one is a claim about the record', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/producerSuspect: true ONLY when the Producer value is not a winery at all/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/producerUnknown: true ONLY when you cannot place the PRODUCER ITSELF/);
    // The 2026-08-18 defect report: known house + unverified bottling was
    // being flagged producerUnknown and held. The distinction is now explicit.
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/Knowing the house but not this specific bottling or cuvée is NOT producerUnknown/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/honest, publishable estimate, not a reason to withhold/);
    // Ticket 6a6f94e5's requirement (flag and prose must agree) must survive
    // the split — pointed at producerUnknown now, which is where it belongs.
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/Set producerUnknown, NOT producerSuspect, whenever your description would call the PRODUCER undocumented/);
  });

  // Ticket 6a8464ea phase 1: the anti-regional-prior instruction. Ashes &
  // Diamonds got the blockbuster Napa profile the winery was founded to
  // reject; Ganevat's ouillé whites were described as oxidative from the
  // Jura prior. The prompt must name the failure mode directly.
  test('the prompt forbids substituting the regional flagship style for producer knowledge', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/A region's dominant or most famous style is NOT evidence about this producer/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/two established house styles .*describe what is common to both/);
  });
});
