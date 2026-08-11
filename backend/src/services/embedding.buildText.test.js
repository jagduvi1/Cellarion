/**
 * buildEmbeddingText golden-string test — the property the whole "verification
 * costs zero re-embeds" claim rests on.
 *
 * textHash = sha256(buildEmbeddingText(...)) is the embedding job's skip key:
 * if a WineDefinition field ever leaks into this text, every registry wine's
 * hash changes and the next job run re-embeds ~4.3k wines against the Voyage
 * API for real money. The function is a closed field whitelist today; this
 * test pins the exact output for a fully-populated wine that ALSO carries the
 * admin-review fields (verifiedChecks / verifiedAt), so a refactor that
 * spreads the doc into the text fails here first.
 */
const { buildEmbeddingText } = require('./embedding');

const FULL_WINE = {
  name: 'Block 3 Pinot Noir',
  producer: 'Felton Road',
  type: 'red',
  region: { name: 'Central Otago' },
  country: { name: 'New Zealand' },
  grapes: [{ name: 'Pinot Noir' }],
  appellation: 'Bannockburn',
  classification: 'Single Vineyard',
  aiProfile: {
    body: 'medium',
    tannin: 'medium',
    acidity: 'high',
    sweetness: 'dry',
    flavors: ['dark cherry', 'thyme'],
    foodPairings: ['duck breast'],
    // Review metadata inside aiProfile — must never reach the embed text.
    producerSuspect: true,
    producerNote: 'Suspect note that must not be embedded',
  },
  // Admin-review metadata — must never reach the embedding text.
  verifiedChecks: ['name-equals-producer.v1'],
  verifiedAt: new Date('2026-07-26T10:00:00Z'),
};

const GOLDEN = [
  'Name: Block 3 Pinot Noir',
  'Producer: Felton Road',
  'Type: red',
  'Vintage: 2019',
  'Region: Central Otago',
  'Country: New Zealand',
  'Grapes: Pinot Noir',
  'Appellation: Bannockburn',
  'Classification: Single Vineyard',
  'Style: medium-bodied, medium tannin, high acidity, dry',
  'Flavours: dark cherry, thyme',
  'Pairs with: duck breast',
].join('\n');

test('output is the exact whitelist — review metadata cannot change textHash', () => {
  expect(buildEmbeddingText(FULL_WINE, '2019')).toBe(GOLDEN);
});

test('adding/removing the review fields produces byte-identical text', () => {
  const { verifiedChecks, verifiedAt, ...withoutReview } = FULL_WINE;
  expect(buildEmbeddingText(withoutReview, '2019')).toBe(buildEmbeddingText(FULL_WINE, '2019'));
});

test('the text never mentions the review fields by name', () => {
  const text = buildEmbeddingText(FULL_WINE, '2019');
  expect(text).not.toMatch(/verified/i);
});

// ── Regional grape display names ─────────────────────────────────────────────
// A grape can carry regionalNames ({ country, region?, name }); when one
// applies to the wine's OWN country/region, the Grapes line shows both forms:
// "Tempranillo (Tinta Roriz)" — additive recall for the label-true name.
// The property these tests pin: a wine the mapping does NOT apply to produces
// BYTE-IDENTICAL text to a mapping-free grape, so adding a regional name to
// the taxonomy never churns textHashes (→ no registry-wide re-embed wave).
// The golden test above is the other half of that pin: FULL_WINE has no
// regionalNames anywhere and its exact output did not move.

const PORTUGAL_ID = 'a'.repeat(24);
const DOURO_ID = 'b'.repeat(24);
const SPAIN_ID = 'c'.repeat(24);

const TEMPRANILLO_MAPPED = {
  name: 'Tempranillo',
  regionalNames: [{ country: PORTUGAL_ID, region: DOURO_ID, name: 'Tinta Roriz' }],
};

const portBase = {
  name: 'Vintage Port',
  producer: 'Quinta do Exemplo',
  type: 'fortified',
  region: { _id: DOURO_ID, name: 'Douro' },
};

test('an applicable regional name joins the canonical on the Grapes line', () => {
  const wine = { ...portBase, country: { _id: PORTUGAL_ID, name: 'Portugal' }, grapes: [TEMPRANILLO_MAPPED] };
  const text = buildEmbeddingText(wine, '2017');
  expect(text).toContain('Grapes: Tempranillo (Tinta Roriz)');
});

test('NO-CHURN PIN: a wine the mapping does not apply to is byte-identical to a mapping-free grape', () => {
  // Same grape doc (mapping present) but the wine sits in another country —
  // the entry cannot apply, so the text must equal the no-regionalNames text.
  const elsewhere = { ...portBase, country: { _id: SPAIN_ID, name: 'Spain' } };
  const withMapping = buildEmbeddingText({ ...elsewhere, grapes: [TEMPRANILLO_MAPPED] }, '2017');
  const withoutMapping = buildEmbeddingText({ ...elsewhere, grapes: [{ name: 'Tempranillo' }] }, '2017');
  expect(withMapping).toBe(withoutMapping);
  expect(withMapping).toContain('Grapes: Tempranillo');
  expect(withMapping).not.toContain('Tinta Roriz');
});
