/**
 * The name-check rules are pure functions over { name, producer,
 * verifiedChecks } — no DB, no mocks. What matters most here:
 *   - per-rule clearance granularity (cleared for one rule ≠ cleared for all)
 *   - the contract that a rule NOT in a wine's verifiedChecks always surfaces,
 *     even when every OTHER rule is cleared — the design's whole guarantee
 *     against the bare-boolean staleness trap
 *   - the estate cohort staying out of the default queue
 */
const {
  NAME_CHECKS,
  NAME_CHECK_IDS,
  DEFAULT_CHECK_IDS,
  NAME_CHECK_SELECT,
  resolveCheck,
  runNameChecks,
} = require('./nameChecks');

const byId = (id) => NAME_CHECKS.find(c => c.id === id);

describe('rule registry shape', () => {
  test('every rule has an id, a labelKey and a detect function; ids are unique', () => {
    for (const c of NAME_CHECKS) {
      expect(typeof c.id).toBe('string');
      expect(c.id).toMatch(/\.v\d+$/); // versioned — refinement bumps it
      expect(typeof c.labelKey).toBe('string');
      expect(typeof c.detect).toBe('function');
      expect(typeof c.defaultActive).toBe('boolean');
    }
    expect(new Set(NAME_CHECK_IDS).size).toBe(NAME_CHECK_IDS.length);
  });

  test('the estate rule is NOT in the default queue (reachable only via ?check=)', () => {
    expect(byId('name-equals-producer-estate.v1').defaultActive).toBe(false);
    expect(DEFAULT_CHECK_IDS).not.toContain('name-equals-producer-estate.v1');
    expect(NAME_CHECK_IDS).toContain('name-equals-producer-estate.v1');
  });

  test('NAME_CHECK_SELECT covers every field the rules read', () => {
    for (const field of ['name', 'producer', 'verifiedChecks']) {
      expect(NAME_CHECK_SELECT.split(' ')).toContain(field);
    }
  });
});

describe('producer-in-name.v1', () => {
  const detect = byId('producer-in-name.v1').detect;

  test('flags an exact producer prefix and proposes the stripped name', () => {
    expect(detect({ name: 'Meerlust Chardonnay', producer: 'Meerlust' })).toBe('Chardonnay');
  });

  test('flags the key-token variant (producer "… Wines Ltd")', () => {
    expect(detect({ name: 'Felton Road Block 3 Pinot Noir', producer: 'Felton Road Wines Ltd' }))
      .toBe('Block 3 Pinot Noir');
  });

  test('does not flag a producer-free name', () => {
    expect(detect({ name: 'Chardonnay', producer: 'Meerlust' })).toBeNull();
  });
});

describe('dangling-name-tail.v1', () => {
  const detect = byId('dangling-name-tail.v1').detect;

  test('flags the ticket row and its class', () => {
    expect(detect({ name: 'La Viña de', producer: 'Madaras' })).toBe('La Viña de');
    expect(detect({ name: 'Clos de', producer: 'X' })).toBe('Clos de');
    expect(detect({ name: 'Re di', producer: 'Renieri' })).toBe('Re di');
  });

  test('does not flag names that merely CONTAIN connectives', () => {
    // Suffix producer names ending in real words stay untouched
    expect(detect({ name: 'Les Forts de Latour', producer: 'Château Latour' })).toBeNull();
    expect(detect({ name: 'Cheval des Andes', producer: 'Cheval des Andes' })).toBeNull();
    expect(detect({ name: 'Barolo', producer: 'Boroli' })).toBeNull();
  });

  test('never flags a one-word name (protects Yquem\'s "Y")', () => {
    expect(detect({ name: 'Y', producer: "Château d'Yquem" })).toBeNull();
    expect(detect({ name: 'de', producer: 'X' })).toBeNull(); // degenerate, still one word
  });
});

describe('name-equals-producer.v1 and its estate twin', () => {
  const plain = byId('name-equals-producer.v1').detect;
  const estate = byId('name-equals-producer-estate.v1').detect;

  test('non-estate equality flags on the plain rule only', () => {
    const w = { name: 'Opus One', producer: 'Opus One' };
    expect(plain(w)).toBe('Opus One');
    expect(estate(w)).toBeNull();
  });

  test('estate equality flags on the estate rule only (Château Latour is legitimate)', () => {
    const w = { name: 'Château Latour', producer: 'Chateau Latour' }; // accent variant on purpose
    expect(plain(w)).toBeNull();
    expect(estate(w)).toBe('Château Latour');
  });

  test('comparison is normalizeString-based (case/diacritics/punctuation immune)', () => {
    expect(plain({ name: 'ANNAPURNA', producer: 'Annapurna' })).toBe('ANNAPURNA');
  });

  test('does not flag when name and producer differ', () => {
    expect(plain({ name: 'Chardonnay', producer: 'Meerlust' })).toBeNull();
    expect(estate({ name: 'Chardonnay', producer: 'Meerlust' })).toBeNull();
  });

  test('empty name never flags', () => {
    expect(plain({ name: '', producer: '' })).toBeNull();
    expect(plain({ name: null, producer: null })).toBeNull();
  });
});

describe('runNameChecks — per-rule clearance semantics', () => {
  // Trips producer-in-name (prefix) AND dangling tail ("… de" after strip? no —
  // build a row tripping exactly two known rules): name "Madaras La Viña de",
  // producer "Madaras" trips producer-in-name (prefix strip → "La Viña de")
  // and dangling-name-tail (raw name ends in "de").
  const doubleHit = { name: 'Madaras La Viña de', producer: 'Madaras' };

  test('reports every tripped rule and the strip proposal', () => {
    const hit = runNameChecks(doubleHit);
    expect(hit.checks).toEqual(
      expect.arrayContaining(['producer-in-name.v1', 'dangling-name-tail.v1'])
    );
    expect(hit.proposedName).toBe('La Viña de');
  });

  test('a rule listed in verifiedChecks is skipped; others still report (per-rule granularity)', () => {
    const hit = runNameChecks({ ...doubleHit, verifiedChecks: ['producer-in-name.v1'] });
    expect(hit.checks).toEqual(['dangling-name-tail.v1']);
    expect(hit.proposedName).toBeNull(); // the proposing rule was cleared
  });

  test('all tripped rules cleared → null (row leaves the queue)', () => {
    expect(runNameChecks({
      ...doubleHit,
      verifiedChecks: ['producer-in-name.v1', 'dangling-name-tail.v1'],
    })).toBeNull();
  });

  test('undefined verifiedChecks (the .lean() legacy-row case) and [] mean nothing cleared', () => {
    expect(runNameChecks({ ...doubleHit, verifiedChecks: undefined })).not.toBeNull();
    expect(runNameChecks({ ...doubleHit, verifiedChecks: [] })).not.toBeNull();
  });

  test('ignoreCleared reports everything (the audit view)', () => {
    const hit = runNameChecks(
      { ...doubleHit, verifiedChecks: ['producer-in-name.v1', 'dangling-name-tail.v1'] },
      { ignoreCleared: true }
    );
    expect(hit.checks).toHaveLength(2);
  });

  test('checkIds scopes the run (the ?check= path)', () => {
    const hit = runNameChecks(doubleHit, { checkIds: ['dangling-name-tail.v1'] });
    expect(hit.checks).toEqual(['dangling-name-tail.v1']);
  });

  test('a clean wine returns null', () => {
    expect(runNameChecks({ name: 'Chardonnay', producer: 'Meerlust' })).toBeNull();
  });

  test('THE CONTRACT: clearances for every KNOWN rule cannot suppress a rule added later', () => {
    // Simulate tomorrow's rule arriving: a wine cleared for EVERY id that
    // exists today must still surface for the new rule — and its existing
    // clearances stay honoured for their own rules. This single test is the
    // design's guarantee against the bare-boolean staleness trap.
    const futureRule = {
      id: 'always-fires.v1',
      labelKey: 'test',
      defaultActive: true,
      detect: () => 'hit',
    };
    NAME_CHECKS.push(futureRule);
    try {
      // Cleared for all of today's ids — exactly like a prod row reviewed
      // before the new rule shipped.
      const wine = { ...doubleHit, verifiedChecks: [...NAME_CHECK_IDS] };
      const hit = runNameChecks(wine, { checkIds: [...NAME_CHECK_IDS, futureRule.id] });
      expect(hit).not.toBeNull();
      expect(hit.checks).toEqual(['always-fires.v1']); // new rule fires; cleared rules stay suppressed
    } finally {
      NAME_CHECKS.pop();
    }
  });
});

describe('resolveCheck — untrusted-input gate', () => {
  test('returns the rule for a known id', () => {
    expect(resolveCheck('producer-in-name.v1').id).toBe('producer-in-name.v1');
  });

  test('rejects operator-injection shapes and unknowns', () => {
    expect(resolveCheck({ $gt: '' })).toBeNull();
    expect(resolveCheck(null)).toBeNull();
    expect(resolveCheck(42)).toBeNull();
    expect(resolveCheck('bogus.v9')).toBeNull();
    expect(resolveCheck(['producer-in-name.v1'])).toBeNull();
  });
});
