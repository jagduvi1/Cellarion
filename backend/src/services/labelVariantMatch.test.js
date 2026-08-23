/**
 * The label-variant detector, tested against the REAL pairs a curator merged
 * by hand on 2026-08-23 (somm ticket e9b346ba) and the ones they explicitly
 * ruled out. Every "should match" case below is a duplicate that actually
 * existed in the production registry; every "must not" is a pair of genuinely
 * different wines that a naive rule would have destroyed.
 *
 * Why a bespoke detector at all: all 17 merged pairs scored BELOW 0.85 on the
 * existing fuzzy scorer — the floor of even the "did you mean?" soft zone —
 * spread 0.58 to 0.85. No threshold change could reach them without folding
 * unrelated wines together.
 */
const { isLabelVariant, reduceName, grapeTokenSet } = require('./labelVariantMatch');

// Stand-in taxonomy: the varieties these fixtures actually name.
const FORMS = [
  'cabernet sauvignon', 'cabernet franc', 'shiraz', 'syrah', 'chardonnay',
  'grenache', 'malbec', 'tempranillo', 'garnacha', 'pinot noir', 'pinot gris',
  'riesling', 'pinot blanc', 'sangiovese', 'gewurztraminer',
].map((form) => ({ form }));
const G = grapeTokenSet(FORMS);

const match = (a, b, ap, extra = {}) =>
  isLabelVariant({ name: a, appellation: ap, ...extra.a }, { name: b, appellation: ap, ...extra.b }, G);

describe('real duplicates from the 2026-08-23 curation sweep', () => {
  test.each([
    ['variety suffix', 'Bin 389', 'Bin 389 Cabernet Shiraz', null],
    ['variety suffix, reversed argument order', 'Bin 407 Cabernet Sauvignon', 'Bin 407', null],
    ['initialism plus variety', 'RWT', 'RWT Shiraz', null],
    ['lowercase cuvée plus variety', 'pHat', 'pHat Chardonnay', null],
    ['pure word order', 'Shiraz Cask 66', 'Cask 66 Shiraz', null],
    ['word order around a tier word', 'Chardonnay Reserve', 'Reserve Chardonnay', null],
    ['two-letter cuvée', 'LJ', 'LJ Shiraz', null],
    ['variety PREFIX', 'Malbec Finca Altamira', 'Finca Altamira', null],
    ['word order plus dropped variety', 'Marananga Bin 150', 'Bin 150 Marananga Shiraz', null],
    ['old-vines prefix and variety', 'Kangarilla', 'Old Vines Grenache Kangarilla', 'Kangarilla'],
    ['old-vines with variety on both', 'Kangarilla Grenache', 'Old Vines Grenache Kangarilla', 'Kangarilla'],
    ['multi-word vineyard, old-vines', 'Blewitt Springs Grenache', 'Old Vines Blewitt Springs Grenache', 'Blewitt Springs'],
    ['variety suffix with appellation set', 'El Cuidador', 'El Cuidador Tempranillo', 'Rioja'],
  ])('%s: "%s" is "%s"', (_label, a, b, ap) => {
    expect(match(a, b, ap).match).toBe(true);
  });
});

describe('the guard: a range bottled in several varietals is NOT a duplicate', () => {
  // Each of these was raised by a token-set scan and ruled out by the curator.
  test.each([
    ['Q Cabernet Franc', 'Q Malbec'],
    ['Ghost Town Syrah', 'Ghost Town Pinot Noir'],
    ['Halbstuck Riesling', 'Halbstuck Pinot Blanc'],
  ])('"%s" vs "%s" — each names a DIFFERENT variety', (a, b) => {
    const v = match(a, b, null);
    expect(v.match).toBe(false);
    expect(v.reason).toMatch(/different variety/);
  });

  test('a name that is ONLY a variety has nothing identifying left', () => {
    const v = match('Chardonnay', 'Shiraz', null);
    expect(v.match).toBe(false);
    expect(v.reason).toMatch(/no identifying tokens/);
  });

  test('stored grape lists that disagree veto a name match', () => {
    const v = isLabelVariant(
      { name: 'Cuvee One', grapes: ['aaa'] },
      { name: 'Cuvee One', grapes: ['bbb'] },
      G
    );
    expect(v.match).toBe(false);
    expect(v.reason).toMatch(/grape lists disagree/);
  });

  test('a missing grape list is silence, not disagreement', () => {
    expect(isLabelVariant({ name: 'RWT' }, { name: 'RWT Shiraz', grapes: ['aaa'] }, G).match).toBe(true);
  });

  test('genuinely different cuvées of one producer stay apart', () => {
    expect(match('Bin 389', 'Bin 407', null).match).toBe(false);
    expect(match('Brut', 'Brut Rose', null).match).toBe(false);
    expect(match('Cies', 'Cies Tinto', null).match).toBe(false);
  });
});

describe('the documented non-goal: a dropped vineyard token', () => {
  // Penfolds labelled this "Kalimna Bin 28" for decades, then simplified to
  // "Bin 28 Shiraz". It IS the same wine — and this detector must NOT claim
  // it, because vineyard names cannot join the strip list: for Clarendon
  // Hills the vineyard IS the wine, so stripping site names would collapse
  // Kangarilla, Blewitt Springs and Brookman into one row. Curator territory.
  test('"Kalimna Bin 28" does not match "Bin 28 Shiraz" — by design', () => {
    expect(match('Kalimna Bin 28', 'Bin 28 Shiraz', null).match).toBe(false);
  });

  test('…and the reason it cannot be fixed by stripping sites: Clarendon Hills still separate', () => {
    // If vineyard tokens were stripped, these three would collapse together.
    expect(match('Kangarilla', 'Blewitt Springs', null).match).toBe(false);
    expect(match('Kangarilla', 'Brookman', null).match).toBe(false);
  });
});

describe('reduceName', () => {
  test('drops varieties and label furniture, keeps identity', () => {
    const r = reduceName('Old Vines Grenache Kangarilla', { grapeTokens: G });
    expect([...r.core]).toEqual(['kangarilla']);
    expect([...r.varieties]).toEqual(['grenache']);
  });

  test('strips appellation tokens repeated inside the name', () => {
    const r = reduceName('Margaux Reserve', { grapeTokens: G, appellation: 'Margaux' });
    expect([...r.core]).toEqual(['reserve']);
  });

  test('…but keeps them when the appellation is ALL the name has', () => {
    // Clarendon Hills: name and appellation are both the vineyard. Stripping
    // would leave nothing and break the pair the detector exists for.
    const r = reduceName('Kangarilla', { grapeTokens: G, appellation: 'Kangarilla' });
    expect([...r.core]).toEqual(['kangarilla']);
  });

  test('short tokens survive — a two-letter cuvée is not a variety fragment', () => {
    expect([...reduceName('LJ Shiraz', { grapeTokens: G }).core]).toEqual(['lj']);
    expect([...reduceName('MC Shiraz', { grapeTokens: G }).core]).toEqual(['mc']);
  });

  test('accents and punctuation fold', () => {
    expect([...reduceName('Château Bel-Air', { grapeTokens: G }).core].sort()).toEqual(['air', 'bel', 'chateau']);
  });
});
