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
// The note-vs-record check (6a870531) loads the curated grape vocabulary; an
// unmocked model would buffer on the missing test DB for 10s per suite.
jest.mock('../models/Grape', () => ({
  find: jest.fn(() => ({
    select: () => ({
      lean: () => Promise.resolve([
        { name: 'Pinot Noir' }, { name: 'Chardonnay' },
        { name: 'Cabernet Sauvignon' }, { name: 'Tempranillo' },
        { name: 'Muscat Blanc à Petits Grains', synonyms: ['Moscato', 'Moscato Bianco'] },
      ]),
    }),
  })),
}));
jest.mock('./labelScan', () => ({ suggestProfile: jest.fn() }));
jest.mock('./aiProvider', () => ({ isConfigured: jest.fn(() => true), effectiveModels: jest.fn(() => null) }));
jest.mock('./embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./aiBudget', () => ({ tryDebitAi: jest.fn(), isRefundableFailure: jest.fn(() => false) }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({
  enrichmentModel: 'claude-sonnet-5',
  // Default policy for the per-add hook; individual tests override.
  enrichmentOnAdd: 'always',
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
    // A grapeless wine for this one, so the case-folding assertion cannot be
    // perturbed by the 6a8464ea taxonomy cross-check whatever the table holds.
    // (It was originally grapeless because high tannin on the default Pinot
    // Noir fixture tripped the conflict hold — that entry was the ticket
    // 6a896b7e false positive and is gone; the isolation is still worth it.)
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
 * Staleness (somm 6a86bb3b). reenrichAfterRecordEdit covers the three curation
 * surfaces, but a bulk script writing straight to the collection reaches none
 * of them — which is how two Friuli benchmarks ended up flagged over a note
 * about "Giuli Ballarin", the wine those rows used to be. Comparing stored
 * inputs against current ones makes that a property of the data instead.
 */
describe('isProfileStale', () => {
  const { profileInputsSnapshot, isProfileStale } = require('./enrichmentJob');
  const wine = { name: 'Ronco delle Mele', producer: 'Venica & Venica', country: 'c1', type: 'white' };

  test('a profile generated from the current record is not stale', () => {
    expect(isProfileStale({ ...wine, aiProfile: { inputsSnapshot: profileInputsSnapshot(wine) } })).toBe(false);
  });

  test('a producer rewritten underneath the profile is stale', () => {
    const snap = profileInputsSnapshot({ ...wine, producer: 'Alberto Ballarin' });
    expect(isProfileStale({ ...wine, aiProfile: { inputsSnapshot: snap } })).toBe(true);
  });

  // Every row enriched before the field shipped has no snapshot. Reporting
  // those stale would queue the entire registry for a re-spend on no evidence.
  test('a profile with no stored snapshot is unknown, not stale', () => {
    expect(isProfileStale({ ...wine, aiProfile: { inputsSnapshot: null } })).toBe(false);
    expect(isProfileStale({ ...wine, aiProfile: {} })).toBe(false);
    expect(isProfileStale({ ...wine })).toBe(false);
    expect(isProfileStale(null)).toBe(false);
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

  // Ticket 6a855285: the bar applies only to DATA-INSUFFICIENT identities —
  // "you can know Pommard perfectly well and have never heard of the grower".
  test('a DATA-SUFFICIENT unknown-producer record publishes at the base floor as a labelled estimate', () => {
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: 0.45, dataSufficient: true }, GATE)).toBeNull();
    // …but the junk floor still holds it regardless of richness.
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: clean, confidence: 0.3, dataSufficient: true }, GATE)).toBe('low_confidence');
    // …and the prose backstop still applies to rich records too.
    expect(shouldHoldProfile({ producerSuspect: false, producerUnknown: true, description: 'The family has farmed this estate for generations.', confidence: 0.6, dataSufficient: true }, GATE)).toBe('producer_claim');
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

  // The epistemic downgrade rule and its blockers, end to end (v1.145 rule,
  // v1.146 blockers from the somm's full-population audit 6a86dad6).
  test('an epistemic note grounded in the record\'s own region downgrades to producerUnknown, tagged', async () => {
    suggestProfile.mockResolvedValue(withFlags({
      producerSuspect: true, confidence: 0.7,
      producerNote: 'Matua is not a producer I can verify; this profile is based on the Marlborough region and grape typicity.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.producerSuspect).toBe(false);
    expect(p.producerUnknown).toBe(true);
    expect(p.suspectDowngradedBy).toBe('note_epistemic_only');
    expect(p.heldAt).toBeNull(); // published — that is the point of the rule
  });

  test('an epistemic note grounded in a CONTRADICTING place blocks the downgrade — row stays held suspect', async () => {
    // Audit class 1: the profile describes a different wine's geography.
    // Downgrading would publish that fabrication with its caveat removed.
    suggestProfile.mockResolvedValue(withFlags({
      producerSuspect: true, confidence: 0.7,
      producerNote: 'Matua is not a producer I can verify; this profile is estimated from the Champagne appellation and style.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.producerSuspect).toBe(true);
    expect(p.suspectDowngradedBy).toBeNull();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('producer_suspect');
  });

  test('a placeholder producer field blocks the downgrade — nothing to verify', async () => {
    // Audit class 3: producer repeats the wine name as a bare word.
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Increíble', producer: 'Increíble', type: 'red',
      country: { name: 'Spain' }, region: null, grapes: [],
    }));
    suggestProfile.mockResolvedValue(withFlags({
      producerSuspect: true, confidence: 0.7,
      producerNote: 'The producer name is unfamiliar and could not be verified as an established winery, so this is an estimate based on style.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.producerSuspect).toBe(true);
    expect(p.suspectDowngradedBy).toBeNull();
  });

  // Somm 6a870531 (HIGH): Les Gaudrettes published a Chardonnay profile while
  // its own producerNote said the cuvée is documented as a Pinot Noir — the
  // model recorded a record-contradiction in the one field nothing read.
  test('a note naming a variety the record does not carry HOLDS the row', async () => {
    // Fixture record carries Pinot Noir; the note asserts Chardonnay.
    suggestProfile.mockResolvedValue(withFlags({
      confidence: 0.6,
      producerNote: 'The Les Gaudrettes cuvée is more commonly documented as a Chardonnay, so this profile is inferred from the producer\'s general style.',
    }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('note_record_conflict');
    expect(p.description).toBeNull();
    // The note IS the evidence and stays for the curator.
    expect(p.producerNote).toMatch(/Chardonnay/);
  });

  test('a producer-bio mention is not an assertion about this bottling', async () => {
    // Prod scan: "Braida is a known Barbera producer" on a Moscato — the note
    // describes the HOUSE, not the wine, and must not hold.
    suggestProfile.mockResolvedValue(withFlags({
      confidence: 0.6,
      producerNote: 'Matua is primarily known for Chardonnay and single-vineyard bottlings.',
    }));
    await enrichWineById(WINE_ID);
    expect(persisted().heldAt).toBeNull();
  });

  test('a note naming the record\'s OWN grape does not hold', async () => {
    suggestProfile.mockResolvedValue(withFlags({
      confidence: 0.6,
      producerNote: 'A benchmark Pinot Noir house; this bottling follows their usual style.',
    }));
    await enrichWineById(WINE_ID);
    expect(persisted().heldAt).toBeNull();
  });

  test('on a GRAPELESS record a named variety is information, not conflict', async () => {
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Red Blend', producer: 'Matua', type: 'red',
      country: { name: 'New Zealand' }, region: { name: 'Marlborough' }, grapes: [],
    }));
    suggestProfile.mockResolvedValue(withFlags({
      confidence: 0.6,
      producerNote: 'Likely a Chardonnay-led blend based on the producer range.',
    }));
    await enrichWineById(WINE_ID);
    expect(persisted().heldAt).toBeNull();
  });

  // ── Generation gate (6a82bfb7's last open build, 2026-08-20) ──────────────
  // On a record with NO region and NO appellation, an assertion-grade draft
  // gets one corrective retry; a second violation holds. Disclosure prose
  // passes by design.
  describe('the ungrounded-description generation gate', () => {
    const placeless = (over = {}) => chain({
      _id: WINE_ID, name: "Maureen's", producer: 'Petersons', type: 'red',
      country: { name: 'Australia' }, region: null, appellation: null, grapes: [],
      ...over,
    });

    test('an assertion-grade draft is retried once, and a clean second draft publishes', async () => {
      WineDefinition.findById.mockReturnValue(placeless());
      suggestProfile
        .mockResolvedValueOnce(withFlags({
          description: 'A soft, approachable red blend from the Hunter Valley with plum fruit.',
        }))
        .mockResolvedValueOnce(withFlags({
          description: 'A soft, approachable red. The region could not be identified from this record.',
        }));
      await enrichWineById(WINE_ID);
      expect(suggestProfile).toHaveBeenCalledTimes(2);
      // The retry names exactly what the first draft asserted.
      expect(suggestProfile.mock.calls[1][0].retryDirective).toMatch(/Hunter Valley/);
      const p = persisted();
      expect(p.heldAt).toBeNull();
      expect(p.description).toMatch(/could not be identified/);
    });

    test('a persistent violation HOLDS as ungrounded_description', async () => {
      WineDefinition.findById.mockReturnValue(placeless());
      suggestProfile.mockResolvedValue(withFlags({
        description: 'A soft, approachable red blend from the Hunter Valley with plum fruit.',
      }));
      await enrichWineById(WINE_ID);
      expect(suggestProfile).toHaveBeenCalledTimes(2);
      const p = persisted();
      expect(p.heldAt).toBeInstanceOf(Date);
      expect(p.heldReason).toBe('ungrounded_description');
      expect(p.description).toBeNull();
      expect(p.producerNote).toMatch(/Hunter Valley/);
    });

    test('disclosure prose passes without a retry — silence is not the goal', async () => {
      WineDefinition.findById.mockReturnValue(placeless());
      suggestProfile.mockResolvedValue(withFlags({
        description: 'This bottling could not be identified. They draw fruit from the Hunter as well as Barossa, so the region is genuinely open.',
      }));
      await enrichWineById(WINE_ID);
      expect(suggestProfile).toHaveBeenCalledTimes(1);
      expect(persisted().heldAt).toBeNull();
    });

    test('a grounded record is out of the gate\'s scope entirely', async () => {
      // The default fixture carries Marlborough — finer-grained prose is
      // legitimate there and judging it needs a gazetteer (the 1,612 lesson).
      suggestProfile.mockResolvedValue(withFlags({
        description: 'A Wairau Valley Pinot Noir with bright cherry fruit.',
      }));
      await enrichWineById(WINE_ID);
      expect(suggestProfile).toHaveBeenCalledTimes(1);
      expect(persisted().heldAt).toBeNull();
    });

    test('the record\'s own grape under a synonym is not an assertion', async () => {
      WineDefinition.findById.mockReturnValue(placeless({
        grapes: [{ name: 'Muscat Blanc à Petits Grains' }],
      }));
      suggestProfile.mockResolvedValue(withFlags({
        description: 'A gently sparkling white in the classic Moscato style, light and grapey.',
      }));
      await enrichWineById(WINE_ID);
      expect(suggestProfile).toHaveBeenCalledTimes(1);
      expect(persisted().heldAt).toBeNull();
    });
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

  test('an unknown producer under the bar is HELD — when the identity is data-INSUFFICIENT', async () => {
    // A thin record: no appellation, no region → the bar applies.
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Mystery Red', producer: 'Unknown House', type: 'red',
      country: { name: 'Australia' }, region: null, appellation: null, grapes: [],
    }));
    suggestProfile.mockResolvedValue(withFlags({ producerUnknown: true, confidence: 0.45 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('unknown_low_confidence');
    expect(p.producerUnknown).toBe(true);
  });

  test('the SAME unknown producer at the same confidence PUBLISHES on the data-rich default fixture (6a855285)', async () => {
    // Default fixture: region Marlborough + grapes + type → sufficient.
    suggestProfile.mockResolvedValue(withFlags({ producerUnknown: true, confidence: 0.45 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeNull();
    expect(p.description).toMatch(/Riesling/);
    expect(p.producerUnknown).toBe(true); // the doubt stays recorded on the row
  });

  // 6a8464ea phase 2. These used the default Pinot Noir fixture with high
  // tannin, which stopped being a conflict when the pinot-noir entry came out
  // of the table (somm ticket 6a896b7e — Pommard is legitimately tannic).
  // Nebbiolo carries the surviving direction: thick skins put a FLOOR under
  // tannin, so a low-tannin Nebbiolo is the regional-prior hallucination the
  // cross-check exists for. No flag, high confidence — only a factual check
  // can catch it.
  const nebbioloWine = () => WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Barolo', producer: 'Cà di Bruno', type: 'red',
    country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
  }));

  test('a profile at the OPPOSITE structural extreme of the grape is HELD as taxonomy_conflict', async () => {
    nebbioloWine();
    suggestProfile.mockResolvedValue(withFlags({ tannin: 'low', confidence: 0.8 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.heldReason).toBe('taxonomy_conflict');
    expect(p.producerNote).toMatch(/nebbiolo is defined by high tannin/);
  });

  test('the agreeing extreme and medium never conflict — the check is one-sided', async () => {
    nebbioloWine();
    for (const tannin of ['high', 'medium']) {
      jest.clearAllMocks();
      nebbioloWine();
      WineDefinition.updateOne.mockResolvedValue({});
      suggestProfile.mockResolvedValue(withFlags({ tannin, confidence: 0.8 }));
      await enrichWineById(WINE_ID);
      expect(persisted().heldAt).toBeNull();
    }
  });

  test('a firm Pommard no longer conflicts — the variety is not in the table at all', async () => {
    // The regression the somm reported: the default fixture IS a Pinot Noir,
    // and high tannin on it used to hold the row and stamp an owner-visible
    // note saying the correct value was wrong.
    suggestProfile.mockResolvedValue(withFlags({ tannin: 'high', confidence: 0.8 }));
    await enrichWineById(WINE_ID);
    const p = persisted();
    expect(p.heldAt).toBeNull();
    // Coalesced: the note is null here, and toMatch throws on null rather
    // than passing, so a bare .not.toMatch would fail for the wrong reason.
    expect(p.producerNote ?? '').not.toMatch(/Style conflict/);
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
    // Ticket 6a84c8dc (Vignoble Guillaume ×5): the flag fired on
    // obscure-but-real houses. Suspicion now requires naming the alternative.
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/producerSuspect requires EVIDENCE, not unfamiliarity/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/"Vignoble X", "Cave de X"/);
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

  // Ticket 6a855285: confidence must score writability, not bottle recognition.
  test('the prompt scores confidence on truth-given-data, not producer recognition', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/NOT whether you recognise this specific bottling/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/never having heard of the grower merits 0\.5-0\.6/);
  });

  // Curator audit 2026-08-19: notes NAMING the actual entity were 6/6 right;
  // "appears to be a negociant/private-label" category guesses were 0/3 —
  // and the specific-sounding wording made the wrong ones look evidenced.
  test('a suspect note must name the entity or say "cannot verify" — never speculate a category', () => {
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/never dress a guess as a finding/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/no negociant\/private-label\/generic\/novelty speculation/);
    expect(DEFAULT_ENRICHMENT_PROMPT).toMatch(/an unspecific claim in specific costume misleads/);
  });
});

/**
 * Web-search rescue (pilot 2026-08-19) — a generation that would HOLD for a
 * confidence reason gets ONE search-assisted retry. The gate is the difficulty
 * detector: ordinary wines never reach the retry, so the daily cap is spent
 * only on the rows a search can actually save. What's pinned here:
 *
 *  - only low_confidence / unknown_low_confidence retry (a suspect field or a
 *    taxonomy conflict is not a knowledge gap a search fixes)
 *  - the searched result replaces the first WHATEVER its outcome, and
 *    searchUsed records the attempt on hit and miss alike — the pilot's
 *    rescue-rate numbers depend on misses being counted
 *  - kill-switch, cap 0, cap exhaustion, and non-Anthropic provider all mean
 *    a single un-searched attempt (web_search is an Anthropic server tool)
 */
describe('web-search rescue on confidence holds', () => {
  const aiConfig = require('../config/aiConfig');
  const aiProvider = require('./aiProvider');
  const { _resetSearchSlots } = require('./enrichmentJob');

  const BASE = {
    enrichmentModel: 'claude-sonnet-5',
    enrichmentHoldConfidenceFloor: 0.4,
    enrichmentHoldUnknownConfidenceBar: 0.55,
  };
  // High cap by default so slot availability never depends on test order.
  const searchCfg = (over) => ({ ...BASE, enrichmentSearchEnabled: true, enrichmentSearchDailyCap: 50, ...over });

  const attempt = (confidence, over = {}) => ({
    data: {
      body: 'medium', tannin: 'low', acidity: 'medium', sweetness: 'dry',
      flavors: ['plum'], foodPairings: ['stew'],
      producerSuspect: false, producerUnknown: false,
      description: 'A structured red with dark plum fruit.',
      confidence,
      ...over,
    },
    debugReason: null,
  });

  beforeEach(() => {
    // clearAllMocks (outer beforeEach) does NOT undo mockImplementation /
    // mockReturnValue set inside a test — re-set both shared knobs here so
    // each test starts from search-enabled Anthropic, whatever ran before.
    _resetSearchSlots();
    aiConfig.get.mockImplementation(() => searchCfg());
    aiProvider.effectiveModels.mockReturnValue(null);
  });
  afterAll(() => {
    aiConfig.get.mockImplementation(() => BASE);
  });

  test('a low_confidence hold retries WITH search; a clearing second attempt publishes with searchUsed', async () => {
    suggestProfile
      .mockResolvedValueOnce(attempt(0.2))
      .mockResolvedValueOnce(attempt(0.8, { description: 'Verified: an old-vine Carignan from Maury.' }));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(2);
    // The first attempt is search-less; the retry — and only the retry — asks.
    expect(suggestProfile.mock.calls[0][0].allowSearch).toBeUndefined();
    expect(suggestProfile.mock.calls[1][0]).toMatchObject({ allowSearch: true, name: 'Pinot Noir', producer: 'Matua' });
    const p = persisted();
    expect(p.heldAt).toBeNull();
    expect(p.searchUsed).toBe(true);
    expect(p.confidence).toBe(0.8);
    expect(p.description).toMatch(/Maury/);
  });

  test('a searched result that still fails the gate holds — searchUsed records the spent miss', async () => {
    suggestProfile.mockResolvedValue(attempt(0.2));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(2);
    const p = persisted();
    expect(p.heldReason).toBe('low_confidence');
    expect(p.heldAt).toBeInstanceOf(Date);
    expect(p.searchUsed).toBe(true);
  });

  test('unknown_low_confidence is rescue-eligible — the search finding the producer publishes the row', async () => {
    // Thin record (no region/appellation) so the unknown bar applies.
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Mystery Red', producer: 'Unknown House', type: 'red',
      country: { name: 'Australia' }, region: null, appellation: null, grapes: [],
    }));
    suggestProfile
      .mockResolvedValueOnce(attempt(0.45, { producerUnknown: true }))
      .mockResolvedValueOnce(attempt(0.7, { producerUnknown: false }));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(2);
    expect(persisted().heldAt).toBeNull();
    expect(persisted().searchUsed).toBe(true);
  });

  test('producer_suspect never spends a search — a wrong FIELD is not a knowledge gap', async () => {
    suggestProfile.mockResolvedValue(attempt(0.7, {
      producerSuspect: true, producerNote: 'Fabelhaft is a Niepoort label, not an estate.',
    }));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    const p = persisted();
    expect(p.heldReason).toBe('producer_suspect');
    expect(p.searchUsed).toBe(false);
  });

  test('taxonomy_conflict never spends a search — the model already believes its hallucination', async () => {
    // Nebbiolo fixture: LOW tannin is the opposite structural extreme. (The
    // fixture was a high-tannin Pinot Noir until ticket 6a896b7e established
    // that firm Pinot is Pommard, not a hallucination.)
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Barolo', producer: 'Cà di Bruno', type: 'red',
      country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
    }));
    suggestProfile.mockResolvedValue(attempt(0.8, { tannin: 'low' }));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    expect(persisted().heldReason).toBe('taxonomy_conflict');
  });

  // -------------------------------------------------------------------------
  // Somm ticket 6a894676. Frogtown Cellars carried a search-assisted profile
  // at 0.6 with the producer identified. A curator filled in the correct
  // appellation; the forced re-enrich could not get a search slot (the rescue
  // is capped per UTC day and a curation session burns the cap in minutes)
  // and the search-less rerun landed 0.4 with producerUnknown true. Filling
  // in a CORRECT field made the record worse.
  // -------------------------------------------------------------------------
  describe('a regen may not trade a better profile for a worse one', () => {
    const searched = (over = {}) => ({
      confidence: 0.6, searchUsed: true, description: 'A search-verified Georgia red.',
      producerUnknown: false, generatedAt: new Date('2026-08-21T10:00:00Z'), ...over,
    });
    const wineWith = (aiProfile) => WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Disclosure Reserve', producer: 'Frogtown', type: 'red',
      country: { name: 'United States' }, region: { name: 'Georgia' },
      appellation: 'Dahlonega Plateau', grapes: [], aiProfile,
    }));

    // Asserted on the DB WRITE rather than the return value: enrichWineById
    // hands back the bare outcome string, and what actually matters is whether
    // the stored profile was replaced.
    const wroteProfile = () => WineDefinition.updateOne.mock.calls
      .some((c) => c[1] && c[1].$set && c[1].$set.aiProfile);

    test('the reported case: lost search AND lower confidence keeps the old profile', async () => {
      wineWith(searched());
      aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchEnabled: false })); // no slot
      suggestProfile.mockResolvedValue(attempt(0.4));
      const out = await enrichWineById(WINE_ID, { force: true });
      expect(out).toBe('kept');
      // The profile itself is untouched; only the review stamp is cleared, so
      // the row returns to a human worklist.
      expect(wroteProfile()).toBe(false);
      expect(WineDefinition.updateOne.mock.calls[0][1].$set.profileReviewedAt).toBeNull();
    });

    test('an honest re-assessment that lowers confidence on its OWN merits still lands', async () => {
      // Search was KEPT — the model simply became less sure. That is a real
      // signal and must not be suppressed.
      wineWith(searched());
      suggestProfile
        .mockResolvedValueOnce(attempt(0.2))
        .mockResolvedValueOnce(attempt(0.45, { description: 'Searched, and still thin.' }));
      await enrichWineById(WINE_ID, { force: true });
      expect(wroteProfile()).toBe(true);
      expect(persisted().searchUsed).toBe(true);
      expect(persisted().confidence).toBe(0.45);
    });

    test('losing search but coming back MORE confident still lands', async () => {
      wineWith(searched());
      aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchEnabled: false }));
      suggestProfile.mockResolvedValue(attempt(0.8));
      await enrichWineById(WINE_ID, { force: true });
      expect(wroteProfile()).toBe(true);
      expect(persisted().confidence).toBe(0.8);
    });

    test('a row that never used search is unaffected — the guard is not a general confidence ratchet', async () => {
      wineWith(searched({ searchUsed: false }));
      aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchEnabled: false }));
      suggestProfile.mockResolvedValue(attempt(0.4));
      await enrichWineById(WINE_ID, { force: true });
      expect(wroteProfile()).toBe(true);
      expect(persisted().confidence).toBe(0.4);
    });

    test('a searched row with no description yet cannot be "kept" — there is nothing to keep', async () => {
      wineWith(searched({ description: null }));
      aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchEnabled: false }));
      suggestProfile.mockResolvedValue(attempt(0.4));
      await enrichWineById(WINE_ID, { force: true });
      expect(wroteProfile()).toBe(true);
    });
  });

  test('kill-switch: enrichmentSearchEnabled=false means a single attempt and a plain hold', async () => {
    aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchEnabled: false }));
    suggestProfile.mockResolvedValue(attempt(0.2));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    expect(persisted().searchUsed).toBe(false);
  });

  test('a cap of 0 disables the rescue', async () => {
    aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchDailyCap: 0 }));
    suggestProfile.mockResolvedValue(attempt(0.2));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(1);
  });

  test('the cap is consumed per rescued wine — the wine after the last slot holds without a search', async () => {
    aiConfig.get.mockImplementation(() => searchCfg({ enrichmentSearchDailyCap: 1 }));
    suggestProfile.mockResolvedValue(attempt(0.2));
    await enrichWineById(WINE_ID); // spends the only slot: 2 model calls
    await enrichWineById(WINE_ID); // no slot left: 1 model call
    expect(suggestProfile).toHaveBeenCalledTimes(3);
  });

  test('a non-Anthropic provider never gets the tool — web_search is an Anthropic server tool', async () => {
    aiProvider.effectiveModels.mockReturnValue({ text: 'gpt-4o', vision: 'gpt-4o' });
    suggestProfile.mockResolvedValue(attempt(0.2));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    expect(persisted().searchUsed).toBe(false);
  });

  test('a clean publish records searchUsed:false — the pilot flag never lies', async () => {
    suggestProfile.mockResolvedValue(attempt(0.8));
    await enrichWineById(WINE_ID);
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    expect(persisted().searchUsed).toBe(false);
  });
});

/**
 * The reviewed-profile guard (somm report 2026-08-19): an automated
 * regeneration — proposal approval via reenrichAfterRecordEdit, or a full
 * batch — must never NULL a profile a human attested. A would-hold regen on
 * a reviewed published row keeps the old profile and clears only the review
 * stamp (back into the worklists, a human decides again); a publishing regen
 * writes the fresh content but also clears the stamp, because the review
 * attested the OLD prose and carrying it forward would fake the audit trail.
 * Unreviewed rows keep the original behavior in full.
 */
describe('regeneration never destroys a reviewed published profile', () => {
  const reviewedWine = (over = {}) => ({
    _id: WINE_ID, name: 'Encore Zinfandel', producer: 'Thomas Allen', type: 'red',
    country: { name: 'Australia' }, region: { name: 'Hunter Valley' }, grapes: [],
    profileReviewedAt: new Date('2026-08-18T10:00:00Z'),
    aiProfile: { description: 'The curator-attested prose.', generatedAt: new Date('2026-08-18T09:00:00Z'), source: 'ai' },
    ...over,
  });
  const regen = (confidence) => ({
    data: {
      body: 'medium', tannin: 'medium', acidity: 'medium', sweetness: 'dry',
      flavors: ['plum'], foodPairings: ['stew'],
      producerSuspect: false, producerUnknown: false,
      description: 'Fresh regenerated prose.', confidence,
    },
    debugReason: null,
  });

  test('a would-hold regen KEEPS the old profile and clears only the stamp', async () => {
    WineDefinition.findById.mockReturnValue(chain(reviewedWine()));
    suggestProfile.mockResolvedValue(regen(0.2)); // under the floor → would hold
    await enrichWineById(WINE_ID, { force: true });
    expect(WineDefinition.updateOne).toHaveBeenCalledTimes(1);
    const $set = WineDefinition.updateOne.mock.calls[0][1].$set;
    expect($set.profileReviewedAt).toBeNull();
    expect($set.aiProfile).toBeUndefined(); // the attested profile is untouched
  });

  test('a publishing regen writes the fresh profile AND clears the stamp', async () => {
    WineDefinition.findById.mockReturnValue(chain(reviewedWine()));
    suggestProfile.mockResolvedValue(regen(0.8));
    await enrichWineById(WINE_ID, { force: true });
    const $set = WineDefinition.updateOne.mock.calls[0][1].$set;
    expect($set.aiProfile.description).toBe('Fresh regenerated prose.');
    expect($set.aiProfile.heldAt).toBeNull();
    expect($set.profileReviewedAt).toBeNull();
  });

  test('an UNREVIEWED published row still holds the old way — the gate is for unattested content', async () => {
    WineDefinition.findById.mockReturnValue(chain(reviewedWine({ profileReviewedAt: null })));
    suggestProfile.mockResolvedValue(regen(0.2));
    await enrichWineById(WINE_ID, { force: true });
    const $set = WineDefinition.updateOne.mock.calls[0][1].$set;
    expect($set.aiProfile.description).toBeNull();
    expect($set.aiProfile.heldReason).toBe('low_confidence');
  });

  test('a reviewed row whose profile is HELD (no prose) has nothing to preserve — normal hold write', async () => {
    WineDefinition.findById.mockReturnValue(chain(reviewedWine({
      aiProfile: { description: null, generatedAt: new Date(), heldAt: new Date(), source: 'ai' },
    })));
    suggestProfile.mockResolvedValue(regen(0.2));
    await enrichWineById(WINE_ID, { force: true });
    const $set = WineDefinition.updateOne.mock.calls[0][1].$set;
    expect($set.aiProfile.heldReason).toBe('low_confidence');
  });

  test('a publish on a row with NO stamp does not touch profileReviewedAt at all', async () => {
    WineDefinition.findById.mockReturnValue(chain(reviewedWine({ profileReviewedAt: null, aiProfile: null })));
    suggestProfile.mockResolvedValue(regen(0.8));
    await enrichWineById(WINE_ID);
    const $set = WineDefinition.updateOne.mock.calls[0][1].$set;
    expect('profileReviewedAt' in $set).toBe(false);
  });
});

/**
 * The per-add enrichment policy (Johan 2026-08-21).
 *
 * Adding a bottle fires an enrichment per newly-minted wine — ~120 a day, and
 * the steady API spend once batch runs stop. It is also the least reliable
 * population: a freshly scanned label often has no region, which is where the
 * generation gate spends two calls and publishes nothing. The policy gates
 * ONLY that automatic hook; deliberate calls are never gated.
 */
describe('enrichmentOnAdd policy', () => {
  const aiConfig = require('../config/aiConfig');
  const base = {
    enrichmentModel: 'claude-sonnet-5',
    enrichmentHoldConfidenceFloor: 0.4,
    enrichmentHoldUnknownConfidenceBar: 0.55,
  };
  const setMode = (enrichmentOnAdd) => aiConfig.get.mockReturnValue({ ...base, enrichmentOnAdd });

  const thin = { _id: WINE_ID, name: 'Mystery', producer: 'Someone', type: 'red', country: { name: 'France' }, region: null, appellation: null, grapes: [] };
  const rich = { ...thin, region: { name: 'Marlborough' }, grapes: [{ name: 'Pinot Noir' }] };

  const profile = () => ({
    data: { body: 'medium', tannin: 'low', acidity: 'medium', sweetness: 'dry', flavors: ['cherry'], foodPairings: ['duck'], description: 'A bright, easy red.', confidence: 0.7 },
    debugReason: null,
  });

  afterEach(() => setMode('always'));

  test("'off' skips the add hook entirely — no model call, no write", async () => {
    setMode('off');
    WineDefinition.findById.mockReturnValue(chain(rich));
    suggestProfile.mockResolvedValue(profile());
    await enrichWineById(WINE_ID, { trigger: 'add' });
    expect(suggestProfile).not.toHaveBeenCalled();
    expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  });

  test("'sufficient' skips a record that cannot support a true statement", async () => {
    setMode('sufficient');
    WineDefinition.findById.mockReturnValue(chain(thin)); // no region, no appellation
    suggestProfile.mockResolvedValue(profile());
    await enrichWineById(WINE_ID, { trigger: 'add' });
    expect(suggestProfile).not.toHaveBeenCalled();
  });

  test("'sufficient' still enriches a well-identified wine — the add stays instant", async () => {
    setMode('sufficient');
    WineDefinition.findById.mockReturnValue(chain(rich));
    suggestProfile.mockResolvedValue(profile());
    await enrichWineById(WINE_ID, { trigger: 'add' });
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    expect(persisted().description).toMatch(/bright/);
  });

  // The policy is about incidental spend, never about deliberate curation:
  // a release, an identity-edit follow-through or a batch run must always run.
  test('a DELIBERATE call is never gated, even with the policy off', async () => {
    setMode('off');
    WineDefinition.findById.mockReturnValue(chain(thin));
    suggestProfile.mockResolvedValue(profile());
    await enrichWineById(WINE_ID); // no trigger — batch / release / re-enrich
    expect(suggestProfile).toHaveBeenCalledTimes(1);
  });

  test("'always' preserves the legacy behaviour on a thin record", async () => {
    setMode('always');
    WineDefinition.findById.mockReturnValue(chain(thin));
    suggestProfile.mockResolvedValue(profile());
    await enrichWineById(WINE_ID, { trigger: 'add' });
    expect(suggestProfile).toHaveBeenCalledTimes(1);
  });
});
