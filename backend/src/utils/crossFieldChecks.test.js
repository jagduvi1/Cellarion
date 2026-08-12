/**
 * The cross-field rules are pure functions over a flattened wine row + the
 * preloaded reference maps — no DB, no mocks. What matters most here:
 *   - full-string matching only: an estate NAMED AFTER its place ("Marchesi
 *     di Barolo", "La Rioja Alta") must never flag — the same reasoning the
 *     mint-time place gate documents
 *   - each rule's guarded negative beside its 2026-08-10 evidence positive
 *   - per-rule clearance granularity + the staleness contract, mirrored from
 *     nameChecks: a clearance recorded before a rule existed cannot suppress it
 */
const {
  CROSS_FIELD_CHECKS,
  CROSS_FIELD_CHECK_IDS,
  DEFAULT_CROSS_FIELD_CHECK_IDS,
  CROSS_FIELD_CHECK_SELECT,
  resolveCrossFieldCheck,
  runCrossFieldChecks,
  buildCrossFieldRefs,
} = require('./crossFieldChecks');

const byId = (id) => CROSS_FIELD_CHECKS.find(c => c.id === id);

// Reference maps shaped like the prod taxonomy the evidence rows hit. The
// Châteauneuf doc carries the CURRENT normalizeAppellationKey fold; the
// Monbazillac legacy doc the OLD normalizeString fold — the dual-probe rule
// must hit both (findOrCreateWine's dual-key lookup, mirrored).
const refs = buildCrossFieldRefs({
  appellations: [
    { name: 'Monbazillac', normalizedName: 'monbazillac' },
    { name: 'Châteauneuf-du-Pape', normalizedName: 'chateauneuf du pape' },
    { name: 'Barolo', normalizedName: 'barolo' },
    { name: 'Pauillac', normalizedName: 'pauillac', normalizedSynonyms: ['pavillac'] },
  ],
  regions: [
    { name: 'Drăgășani', normalizedName: 'dragasani' },
    { name: 'Barossa Valley', normalizedName: 'barossa valley', normalizedSynonyms: ['barossa'] },
  ],
  countries: [
    { name: 'Spain', normalizedName: 'spain' },
    { name: 'France', normalizedName: 'france' },
  ],
  grapes: [
    { name: 'Cabernet Sauvignon', normalizedName: 'cabernet sauvignon' },
    { name: 'Syrah', normalizedName: 'syrah', normalizedSynonyms: ['shiraz'] },
    { name: 'Nebbiolo', normalizedName: 'nebbiolo' },
  ],
});

describe('rule registry shape', () => {
  test('every rule has an id, labelKey, field and detect; ids are unique and versioned', () => {
    for (const c of CROSS_FIELD_CHECKS) {
      expect(typeof c.id).toBe('string');
      expect(c.id).toMatch(/\.v\d+$/); // versioned — refinement bumps it
      expect(typeof c.labelKey).toBe('string');
      // 'type' joined with colour-contradiction.v1 — the one rule whose
      // verdict is about the wine's own colour rather than a reference list.
      expect(['name', 'producer', 'appellation', 'region', 'type']).toContain(c.field);
      expect(typeof c.detect).toBe('function');
      expect(typeof c.defaultActive).toBe('boolean');
    }
    expect(new Set(CROSS_FIELD_CHECK_IDS).size).toBe(CROSS_FIELD_CHECK_IDS.length);
  });

  test('no id collides with the nameChecks family (clearance stores must stay disjoint)', () => {
    const { NAME_CHECK_IDS } = require('./nameChecks');
    for (const id of CROSS_FIELD_CHECK_IDS) expect(NAME_CHECK_IDS).not.toContain(id);
  });

  test('CROSS_FIELD_CHECK_SELECT covers every field the rules and the runner read', () => {
    for (const field of ['name', 'producer', 'appellation', 'region', 'country', 'crossChecksCleared']) {
      expect(CROSS_FIELD_CHECK_SELECT.split(' ')).toContain(field);
    }
  });
});

describe('producer-is-appellation.v1', () => {
  const detect = byId('producer-is-appellation.v1').detect;

  test('flags the evidence row: producer "Monbazillac" is an appellation', () => {
    expect(detect({ producer: 'Monbazillac' }, refs)).toBe('Monbazillac');
  });

  test('dual-fold probe: hyphenated producer hits a current-fold doc, and a legacy-fold key still matches', () => {
    // Doc key 'chateauneuf du pape' (current fold); the plain fold of the
    // producer is 'chateauneufdupape', which would miss it.
    expect(detect({ producer: 'Châteauneuf-du-Pape' }, refs)).toBe('Châteauneuf-du-Pape');
    // Legacy doc stored under the OLD normalizeString fold.
    const legacyRefs = buildCrossFieldRefs({
      appellations: [{ name: 'Châteauneuf-du-Pape', normalizedName: 'chateauneufdupape' }],
    });
    expect(detect({ producer: 'Châteauneuf-du-Pape' }, legacyRefs)).toBe('Châteauneuf-du-Pape');
  });

  test('full-string matching only: "Marchesi di Barolo" passes although it CONTAINS an appellation', () => {
    expect(detect({ producer: 'Marchesi di Barolo' }, refs)).toBeNull();
  });

  test('appellation synonyms count', () => {
    expect(detect({ producer: 'Pavillac' }, refs)).toBe('Pauillac');
  });
});

describe('producer-is-region.v1', () => {
  const detect = byId('producer-is-region.v1').detect;

  test('flags the evidence row: producer "Dragasani" is a region (diacritic-immune)', () => {
    expect(detect({ producer: 'Dragasani' }, refs)).toBe('Drăgășani');
  });

  test('region synonyms count; a real producer passes', () => {
    expect(detect({ producer: 'Barossa' }, refs)).toBe('Barossa Valley');
    expect(detect({ producer: 'Torbreck' }, refs)).toBeNull();
  });
});

describe('producer-is-country.v1', () => {
  const detect = byId('producer-is-country.v1').detect;

  test('flags a producer that is a Country doc, through the alias map', () => {
    expect(detect({ producer: 'Spain' }, refs)).toBe('Spain');
    expect(detect({ producer: 'Spanien' }, refs)).toBe('Spain'); // sv/de alias
  });

  test('falls back to the recognized-country list for countries without a doc yet', () => {
    expect(detect({ producer: 'India' }, refs)).toBe('India');
  });

  test('a place-flavoured estate passes (full-string only)', () => {
    expect(detect({ producer: 'Bodegas España Real' }, refs)).toBeNull();
  });
});

describe('producer-is-grape.v1', () => {
  const detect = byId('producer-is-grape.v1').detect;

  test('flags a bare variety, including via curated doc synonyms and the static synonym map', () => {
    expect(detect({ producer: 'Cabernet Sauvignon' }, refs)).toBe('Cabernet Sauvignon');
    expect(detect({ producer: 'Shiraz' }, refs)).toBe('Syrah');      // doc synonym
    expect(detect({ producer: 'Spätburgunder' }, refs)).toBeNull();  // resolves to Pinot Noir — no doc in refs
    expect(detect({ producer: 'Brunello' }, refs)).toBeNull();       // resolves to Sangiovese — no doc in refs
  });

  test('an estate containing a variety word passes', () => {
    expect(detect({ producer: 'Casa Nebbiolo di Sotto' }, refs)).toBeNull();
  });
});

describe('producer-is-style-term.v2', () => {
  const detect = byId('producer-is-style-term.v2').detect;

  test('flags the evidence row "Roșu Demidulce" (every token is style vocabulary)', () => {
    expect(detect({ producer: 'Roșu Demidulce' })).toBe('rosu demidulce');
  });

  test('flags single style words and filler+style shapes', () => {
    expect(detect({ producer: 'Brut' })).toBe('brut');
    expect(detect({ producer: 'Halbtrocken' })).toBe('halbtrocken');
    expect(detect({ producer: 'Vin Demisec' })).toBe('demisec'); // 'vin' is filler, not evidence
  });

  test('v2: ß spellings reach the vocabulary (normalizeString alone deletes ß)', () => {
    expect(detect({ producer: 'Süß' })).toBe('suss');
    expect(detect({ producer: 'Weiß' })).toBe('weiss');
    expect(detect({ producer: 'Süß Rot' })).toBe('suss rot');
  });

  test('one real word disarms it: "Château Doux Rivage" must not flag', () => {
    expect(detect({ producer: 'Château Doux Rivage' })).toBeNull();
  });

  test('all-filler with no style evidence does not flag', () => {
    expect(detect({ producer: 'Le Vin' })).toBeNull();
  });
});

describe('producer-placeholder.v1', () => {
  const detect = byId('producer-placeholder.v1').detect;

  test('flags the evidence row and the blocklist shapes', () => {
    expect(detect({ producer: 'Domaine unknown' })).toBe('Domaine unknown');
    expect(detect({ producer: 'Unknown' })).toBe('Unknown');
    expect(detect({ producer: 'unknown producer' })).toBe('unknown producer');
    expect(detect({ producer: 'N/A' })).toBe('N/A');
    expect(detect({ producer: 'none' })).toBe('none');
    expect(detect({ producer: 'TBD' })).toBe('TBD');
    expect(detect({ producer: '-' })).toBe('-'); // normalizes to '' → unknown shape
    expect(detect({ producer: '?' })).toBe('?');
  });

  test('a real domaine passes', () => {
    expect(detect({ producer: 'Domaine de la Romanée-Conti' })).toBeNull();
  });
});

describe('producer-parenthetical.v1', () => {
  const detect = byId('producer-parenthetical.v1').detect;

  test('flags the evidence row and reports the parenthetical part', () => {
    expect(detect({ producer: "Trader Joe's (Bersano Estate)" })).toBe('(Bersano Estate)');
  });

  test('no parenthesis, no flag', () => {
    expect(detect({ producer: "Trader Joe's" })).toBeNull();
  });
});

describe('name-in-producer.v1', () => {
  const detect = byId('name-in-producer.v1').detect;

  test('flags the evidence row: name "Wines" ⊂ producer "The Freaky Wines"', () => {
    expect(detect({ name: 'Wines', producer: 'The Freaky Wines' })).toBe('Wines');
    expect(detect({ name: 'Freaky Wines', producer: 'The Freaky Wines' })).toBe('Freaky Wines');
  });

  test('a shorter side that is ONLY house words never flags (the estate-word guard)', () => {
    expect(detect({ name: 'Domaine', producer: 'Domaine Leflaive' })).toBeNull();
    expect(detect({ name: 'Bodegas', producer: 'Bodegas Muga' })).toBeNull();
  });

  test('equality is nameChecks\' territory: "Château Latour" = "Château Latour" must NOT hit', () => {
    expect(detect({ name: 'Château Latour', producer: 'Château Latour' })).toBeNull();
    expect(detect({ name: 'Château Latour', producer: 'Chateau Latour' })).toBeNull(); // normalized-equal too
  });

  test('containment must align on whole tokens: "Rioja"/"Riojanas" never pairs', () => {
    expect(detect({ name: 'Rioja', producer: 'Bodegas Riojanas' })).toBeNull();
  });

  test('a remainder under 3 chars is fuzzy-duplicate territory, not a split', () => {
    expect(detect({ name: 'Opus', producer: 'Opus 1' })).toBeNull();
  });

  test('catches the producer-inside-name direction too (mid-name embeds the strip scan cannot see)', () => {
    expect(detect({ name: 'Grand Vin de Margaux Rouge', producer: 'Margaux Rouge' })).toBe('Margaux Rouge');
  });
});

describe('appellation-is-grape.v1', () => {
  const detect = byId('appellation-is-grape.v1').detect;

  test('flags the evidence row: appellation "Cabernet Sauvignon" is a grape', () => {
    expect(detect({ appellation: 'Cabernet Sauvignon' }, refs)).toBe('Cabernet Sauvignon');
  });

  test('a real appellation passes; an empty appellation never flags', () => {
    expect(detect({ appellation: 'Barolo' }, refs)).toBeNull();
    expect(detect({ appellation: '' }, refs)).toBeNull();
    expect(detect({ appellation: null }, refs)).toBeNull();
  });

  test('curated doc synonyms count, but NOT the static grape-synonym map (Muscadet stays legitimate)', () => {
    expect(detect({ appellation: 'Shiraz' }, refs)).toBe('Syrah');
    // resolveGrapeName maps 'muscadet' → Melon de Bourgogne, but Muscadet is a
    // real appellation — this rule must not consult that map.
    expect(detect({ appellation: 'Muscadet' }, refs)).toBeNull();
  });
});

describe('region-is-country.v1', () => {
  const detect = byId('region-is-country.v1').detect;

  test('flags the evidence row: region "Spain" resolved from a junk Region doc', () => {
    expect(detect({ region: 'Spain' }, refs)).toBe('Spain');
  });

  test('a real region passes; no region never flags', () => {
    expect(detect({ region: 'Barossa Valley' }, refs)).toBeNull();
    expect(detect({ region: null }, refs)).toBeNull();
  });
});

describe('runCrossFieldChecks — per-rule clearance semantics', () => {
  // Trips producer-is-appellation (Monbazillac) AND appellation-is-grape.
  const doubleHit = { name: 'Sec', producer: 'Monbazillac', appellation: 'Cabernet Sauvignon' };

  test('reports every tripped rule with its detail', () => {
    const hits = runCrossFieldChecks(doubleHit, refs);
    expect(hits.map(h => h.check)).toEqual(
      expect.arrayContaining(['producer-is-appellation.v1', 'appellation-is-grape.v1'])
    );
    expect(hits.find(h => h.check === 'producer-is-appellation.v1').detail).toBe('Monbazillac');
    expect(hits.find(h => h.check === 'appellation-is-grape.v1').detail).toBe('Cabernet Sauvignon');
  });

  test('a rule listed in crossChecksCleared is skipped; others still report', () => {
    const hits = runCrossFieldChecks(
      { ...doubleHit, crossChecksCleared: ['producer-is-appellation.v1'] }, refs);
    expect(hits.map(h => h.check)).not.toContain('producer-is-appellation.v1');
    expect(hits.map(h => h.check)).toContain('appellation-is-grape.v1');
  });

  test('all tripped rules cleared → null (row leaves the queue)', () => {
    expect(runCrossFieldChecks(
      { ...doubleHit, crossChecksCleared: [...CROSS_FIELD_CHECK_IDS] }, refs)).toBeNull();
  });

  test('undefined crossChecksCleared (the .lean() legacy-row case) means nothing cleared', () => {
    expect(runCrossFieldChecks({ ...doubleHit, crossChecksCleared: undefined }, refs)).not.toBeNull();
  });

  test('ignoreCleared reports everything (the audit view)', () => {
    const hits = runCrossFieldChecks(
      { ...doubleHit, crossChecksCleared: [...CROSS_FIELD_CHECK_IDS] }, refs, { ignoreCleared: true });
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test('checkIds scopes the run (the ?check= path)', () => {
    const hits = runCrossFieldChecks(doubleHit, refs, { checkIds: ['appellation-is-grape.v1'] });
    expect(hits.map(h => h.check)).toEqual(['appellation-is-grape.v1']);
  });

  test('a clean wine returns null', () => {
    expect(runCrossFieldChecks(
      { name: 'Albe', producer: 'G.D. Vajra', appellation: 'Barolo', region: 'Barossa Valley' }, refs))
      .toBeNull();
  });

  test('THE CONTRACT: clearances for every KNOWN rule cannot suppress a rule added later', () => {
    const futureRule = {
      id: 'always-fires.v1', labelKey: 'test', field: 'producer',
      defaultActive: true, detect: () => 'hit',
    };
    CROSS_FIELD_CHECKS.push(futureRule);
    try {
      const wine = { ...doubleHit, crossChecksCleared: [...CROSS_FIELD_CHECK_IDS] };
      const hits = runCrossFieldChecks(wine, refs, { checkIds: [...CROSS_FIELD_CHECK_IDS, futureRule.id] });
      expect(hits).not.toBeNull();
      expect(hits.map(h => h.check)).toEqual(['always-fires.v1']);
    } finally {
      CROSS_FIELD_CHECKS.pop();
    }
  });
});

describe('mental dry-run against the 2026-08-10 evidence rows', () => {
  // One assertion per Class-A record shape the ticket names, so the mapping
  // "which rule catches which prod record" is pinned, not folklore.
  const caught = (wine) => (runCrossFieldChecks(wine, refs, { ignoreCleared: true }) || []).map(h => h.check);

  test.each([
    [{ producer: 'Monbazillac', name: 'Sec' }, 'producer-is-appellation.v1'],
    [{ producer: 'Dragasani', name: 'Feteasca' }, 'producer-is-region.v1'],
    [{ producer: 'Domaine unknown', name: 'Rouge' }, 'producer-placeholder.v1'],
    [{ producer: 'Roșu Demidulce', name: 'X' }, 'producer-is-style-term.v2'],
    [{ producer: 'The Freaky Wines', name: 'Wines' }, 'name-in-producer.v1'],
    [{ producer: "Trader Joe's (Bersano Estate)", name: 'Barolo' }, 'producer-parenthetical.v1'],
    [{ producer: 'X', name: 'Y', appellation: 'Cabernet Sauvignon' }, 'appellation-is-grape.v1'],
    [{ producer: 'X', name: 'Y', region: 'Spain' }, 'region-is-country.v1'],
  ])('%j is caught by %s', (wine, ruleId) => {
    expect(caught(wine)).toContain(ruleId);
  });
});

describe('resolveCrossFieldCheck — untrusted-input gate', () => {
  test('returns the rule for a known id', () => {
    expect(resolveCrossFieldCheck('producer-is-appellation.v1').id).toBe('producer-is-appellation.v1');
  });

  test('rejects operator-injection shapes and unknowns', () => {
    expect(resolveCrossFieldCheck({ $gt: '' })).toBeNull();
    expect(resolveCrossFieldCheck(null)).toBeNull();
    expect(resolveCrossFieldCheck(42)).toBeNull();
    expect(resolveCrossFieldCheck('bogus.v9')).toBeNull();
    expect(resolveCrossFieldCheck(['producer-is-appellation.v1'])).toBeNull();
  });

  test('every rule is defaultActive today (no non-default cohort yet)', () => {
    expect(DEFAULT_CROSS_FIELD_CHECK_IDS).toEqual(CROSS_FIELD_CHECK_IDS);
  });
});
