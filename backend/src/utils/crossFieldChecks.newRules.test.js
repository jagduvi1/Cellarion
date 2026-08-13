/**
 * The two rules from sommelier ticket 3.
 *
 *   colour-contradiction.v2 — Domaine Rolet, name "Rosé Poulsard", type `red`.
 *                             The label says one colour and the record says
 *                             another; a drinker filtering by type gets the
 *                             wrong bottle either way. Pure string test.
 *   cuvee-near-miss.v2      — Frédéric Magnien "Coeur de Roi" beside the real
 *                             "Cœur de Roches": one producer, two names that
 *                             are nearly but not quite the same string — the
 *                             vision-misread signature. Needs the registry, so
 *                             it lives in services/crossFieldScan.
 *
 * Both FLAG ONLY. Nothing here ever changes a wine.
 */
const {
  CROSS_FIELD_CHECKS, DB_BACKED_CROSS_FIELD_CHECKS, CROSS_FIELD_CHECK_IDS,
  DEFAULT_CROSS_FIELD_CHECK_IDS, CROSS_FIELD_CHECK_SELECT,
  CROSS_FIELD_CHECK_LABEL_KEYS, CROSS_FIELD_CHECK_FIELDS,
  resolveCrossFieldCheck, runCrossFieldChecks, buildCrossFieldRefs,
} = require('./crossFieldChecks');
const { detectCuveeNearMiss, CUVEE_NEAR_MISS } = require('../services/crossFieldScan');

const REFS = buildCrossFieldRefs({});
const run = (wine, ids) => runCrossFieldChecks(wine, REFS, { checkIds: ids });
const colour = (wine) => run({ producer: 'X Estate', ...wine }, ['colour-contradiction.v2']);

describe('colour-contradiction.v2', () => {
  test('THE LIVE ROW: name "Rosé Poulsard" stored as red', () => {
    const hits = colour({ name: 'Rosé Poulsard', type: 'red' });
    expect(hits).toHaveLength(1);
    expect(hits[0].check).toBe('colour-contradiction.v2');
    expect(hits[0].detail).toBe('rose → rosé, stored as red');
  });

  test.each([
    ['Blanc de Blancs', 'red'],
    ['Rioja Tinto', 'white'],
    ['Soave Bianco', 'red'],
    ['Côtes du Rhône Rouge', 'white'],
    ['Weiß Cuvée', 'red'],   // ß pre-folded to ss so the vocabulary can see it
    ['White Label', 'red'],
  ])('name %p stored as %p flags', (name, type) => {
    expect(colour({ name, type })).toHaveLength(1);
  });

  test.each([
    ['Rosé Poulsard', 'rosé'],
    ['Côtes du Rhône Rouge', 'red'],
    ['Soave Bianco', 'white'],
    ['Pinot Noir', 'white'],           // 'noir' names the GRAPE — deliberately not vocabulary
    ['Nero d\'Avola', 'red'],
    ['Chardonnay', 'white'],
    ['Rotari Riserva', 'white'],       // whole-token matching: "Rotari" is not "rot"
  ])('name %p stored as %p does NOT flag', (name, type) => {
    expect(colour({ name, type })).toBeNull();
  });

  test('a NON-COLOUR type is never judged — this is where the false positives would be', () => {
    // "Blanc de Blancs" is the archetypal sparkling wine and "Bianco Passito"
    // the archetypal dessert one; neither type says anything about colour.
    for (const type of ['sparkling', 'dessert', 'fortified']) {
      expect(colour({ name: 'Blanc de Blancs', type })).toBeNull();
      expect(colour({ name: 'Rosso Passito', type })).toBeNull();
    }
  });

  test('it reads `type`, so `type` must be in the scan projection', () => {
    expect(CROSS_FIELD_CHECK_SELECT.split(' ')).toContain('type');
  });

  /**
   * v2, audit L-7. v1 flagged some of the most famous wines in the world
   * because their ESTATE is named after a colour.
   */
  describe('v2 exemptions', () => {
    const withProducer = (producer, wine) => run({ producer, ...wine }, ['colour-contradiction.v2']);

    test.each([
      ['Château Cheval Blanc', 'Cheval Blanc', 'red'],
      ['Domaine du Mas Blanc', 'Mas Blanc Collioure', 'red'],
      ['Clos Blanc de Vougeot', 'Clos Blanc', 'red'],
    ])('INVERTED — producer %p, name %p, type %p does NOT flag', (producer, name, type) => {
      // The colour word is the HOUSE's name repeated in the wine name. A house
      // is not evidence about what is in the bottle.
      expect(withProducer(producer, { name, type })).toBeNull();
    });

    test('INVERTED — "White Zinfandel" is a rosé by convention, not a contradiction', () => {
      // The American "White <black grape>" convention. Judged against the live
      // Grape refs, so it widens with the taxonomy.
      const refs = buildCrossFieldRefs({ grapes: [{ name: 'Zinfandel', normalizedName: 'zinfandel' }] });
      expect(runCrossFieldChecks(
        { producer: 'Sutter Home', name: 'White Zinfandel', type: 'rosé' },
        refs, { checkIds: ['colour-contradiction.v2'] },
      )).toBeNull();
    });

    test('…but only when the next token really is a grape', () => {
      // "White Label" is not a grape, so the original true positive survives.
      const refs = buildCrossFieldRefs({ grapes: [{ name: 'Zinfandel', normalizedName: 'zinfandel' }] });
      expect(runCrossFieldChecks(
        { producer: 'Sutter Home', name: 'White Label', type: 'rosé' },
        refs, { checkIds: ['colour-contradiction.v2'] },
      )).toHaveLength(1);
    });

    test('the exemption is per-token — a SECOND contradicting colour still flags', () => {
      // 'blanc' is exempt (it is the producer), 'rouge' is not.
      expect(withProducer('Château Blanc', { name: 'Blanc Cuvée Rouge', type: 'white' })).toHaveLength(1);
    });

    test.each([
      ['Blanc de Blancs', 'sparkling'],
      ['Weissherbst', 'rosé'],
      ['Vinho Verde Branco', 'white'],
      ['Rosso di Montalcino', 'red'],
      ['Rotling', 'rosé'],
      ['Roter Veltliner', 'white'],
    ])('re-verified still clean: %p as %p', (name, type) => {
      expect(withProducer('Weingut Müller', { name, type })).toBeNull();
    });
  });
});

describe('cuvee-near-miss.v2', () => {
  const wine = (id, producer, name) => ({ _id: id, producer, name });

  test('THE LIVE ROW: one producer, two names one misread apart', () => {
    const hits = detectCuveeNearMiss([
      wine('a', 'Frédéric Magnien', 'Nuits-Saint-Georges Premier Cru Coeur de Roi'),
      wine('b', 'Frédéric Magnien', 'Nuits-Saint-Georges Premier Cru Cœur de Roches'),
    ]);

    // BOTH rows flag, each naming the other — from one row alone a curator
    // cannot tell which of the two is the misread.
    expect(hits.get('a')).toBe('Nuits-Saint-Georges Premier Cru Cœur de Roches');
    expect(hits.get('b')).toBe('Nuits-Saint-Georges Premier Cru Coeur de Roi');
  });

  test.each([
    ['Cuvée Alexandre', 'Cuvée Alexandra'],
    ['Vieilles Vignes Sélection', 'Vielles Vignes Sélection'],
  ])('a one-character misread flags: %p / %p', (a, b) => {
    const hits = detectCuveeNearMiss([wine('a', 'Magnien', a), wine('b', 'Magnien', b)]);
    expect(hits.size).toBe(2);
  });

  test('DIFFERENT producers are never compared — a near miss is only suspicious inside one range', () => {
    const hits = detectCuveeNearMiss([
      wine('a', 'Magnien', 'Cuvée Alexandre'),
      wine('b', 'Drouhin', 'Cuvée Alexandra'),
    ]);
    expect(hits.size).toBe(0);
  });

  test('producer SPELLING VARIANTS are still one range (grouped on the producer key)', () => {
    const hits = detectCuveeNearMiss([
      wine('a', 'Felton Road', 'Cuvée Alexandre'),
      wine('b', 'Felton Road Wines Limited', 'Cuvée Alexandra'),
    ]);
    expect(hits.size).toBe(2);
  });

  test.each([
    ['Gran Reserva', 'Gran Reserva 904'],        // containment: a range, not a misread
    ['Chardonnay Estate', 'Chardonnay Estate Reserve'],
    ['Barolo Cannubi', 'Barolo Brunate'],        // two real crus
    ['Brut Nature', 'Brut Réserve'],
  ])('does NOT flag %p / %p', (a, b) => {
    expect(detectCuveeNearMiss([wine('a', 'Magnien', a), wine('b', 'Magnien', b)]).size).toBe(0);
  });

  test('IDENTICAL names are the duplicate scanner\'s problem, not this rule\'s', () => {
    const hits = detectCuveeNearMiss([
      wine('a', 'Magnien', 'Clos du Marquis'),
      wine('b', 'Magnien', 'Clos du Marquis'),
    ]);
    expect(hits.size).toBe(0);
  });

  test('producerless rows are skipped — they would all group together', () => {
    const hits = detectCuveeNearMiss([
      wine('a', '', 'Cuvée Alexandre'),
      wine('b', '', 'Cuvée Alexandra'),
    ]);
    expect(hits.size).toBe(0);
  });

  test('short names are skipped — they hit high edit ratios by accident', () => {
    expect(detectCuveeNearMiss([wine('a', 'M', 'Brut'), wine('b', 'M', 'Brun')]).size).toBe(0);
  });

  /**
   * v2, audit M-6. The threshold dropped 0.85 → 0.78, which is only safe
   * because a purely NUMERIC difference is now disqualified: a vintage or a lot
   * number IS the distinction between two real wines, never a misread.
   */
  describe('v2 — the numeric-token guard', () => {
    test.each([
      ['Reserva 2010', 'Reserva 2011'],   // vintage in the name
      ['Valbuena 5', 'Valbuena 3'],       // años / lot number
      ['Vega 10 Selección', 'Vega 12 Selección'],
    ])('does NOT flag %p / %p — digits are a real distinction', (a, b) => {
      expect(detectCuveeNearMiss([wine('a', 'Vega Sicilia', a), wine('b', 'Vega Sicilia', b)]).size).toBe(0);
    });

    test('a LETTER difference alongside digits is still a near miss', () => {
      // The guard requires EVERY differing token to be numeric; one misread
      // word is enough to keep the pair in scope.
      const hits = detectCuveeNearMiss([
        wine('a', 'Vega Sicilia', 'Valbuena Reserva 5'),
        wine('b', 'Vega Sicilia', 'Valbuena Reserba 5'),
      ]);
      expect(hits.size).toBe(2);
    });

    test('the looser threshold catches a pair 0.85 refused', () => {
      // 'clos du marquis' ~ 'clos des marquis' = 0.875 — above the old bar too;
      // this one is about the band the change opened: ~0.78–0.85.
      const hits = detectCuveeNearMiss([
        wine('a', 'Magnien', 'Chambolle Musigny Les Sentiers'),
        wine('b', 'Magnien', 'Chambolle Musigny Les Sentieres'),
      ]);
      expect(hits.size).toBe(2);
    });
  });
});

/**
 * producer-echoes-name.v1 — the rule that took over the "Increíble" case from
 * the BLOCKING predicate (audit H-1/H-2), because that predicate could not tell
 * the echo from Château Margaux and refused both.
 */
describe('producer-echoes-name.v1', () => {
  const echo = (wine) => run(wine, ['producer-echoes-name.v1']);

  test('the prod row: producer and name are the same string', () => {
    const hits = echo({ producer: 'Increíble', name: 'Increíble' });
    expect(hits).toHaveLength(1);
    expect(hits[0].check).toBe('producer-echoes-name.v1');
    expect(hits[0].detail).toContain('Increíble');
  });

  test('a single-wine estate flags TOO — and that is correct, because it is a FLAG', () => {
    // A curator clears it once (crossChecksCleared) and it never asks again.
    // Blocking it, as the old predicate did, trapped the wine forever instead.
    expect(echo({ producer: 'Petrus', name: 'Petrus' })).toHaveLength(1);
    expect(echo({ producer: 'Château Margaux', name: 'Château Margaux' })).toHaveLength(1);
  });

  test('containment that leaves no distinct remainder', () => {
    expect(echo({ producer: 'Domaine Leflaive', name: 'Leflaive' })).toHaveLength(1);
    expect(echo({ producer: 'Duckhorn', name: 'Duckhorn Vineyards' })).toHaveLength(1);
    expect(echo({ producer: 'Increíble Wines', name: 'Increíble' })).toHaveLength(1);
  });

  test('a real remainder is NOT an echo', () => {
    expect(echo({ producer: 'Cloudy Bay', name: 'Cloudy Bay Sauvignon Blanc' })).toBeNull();
    expect(echo({ producer: 'Château Margaux', name: 'Pavillon Rouge' })).toBeNull();
  });

  test('an empty side is never an echo — a pending row must not flood the queue', () => {
    expect(echo({ producer: '', name: 'Kaefferkopf' })).toBeNull();
    expect(echo({ producer: 'Domaine', name: 'Les Pucelles' })).toBeNull();
  });

  test('it FLAGS, it never blocks — it is not in the enforced set', () => {
    const { IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS } = require('./crossFieldChecks');
    expect(IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS).not.toContain('producer-echoes-name.v1');
  });

  test('it is a first-class, default-active queue member', () => {
    expect(CROSS_FIELD_CHECK_IDS).toContain('producer-echoes-name.v1');
    expect(DEFAULT_CROSS_FIELD_CHECK_IDS).toContain('producer-echoes-name.v1');
    expect(CROSS_FIELD_CHECK_LABEL_KEYS['producer-echoes-name.v1']).toBe('producerEchoesName');
    expect(CROSS_FIELD_CHECK_FIELDS['producer-echoes-name.v1']).toBe('producer');
  });
});

describe('both rules are first-class members of the queue', () => {
  test('they are known, default-active ids', () => {
    for (const id of ['colour-contradiction.v2', CUVEE_NEAR_MISS]) {
      expect(CROSS_FIELD_CHECK_IDS).toContain(id);
      expect(DEFAULT_CROSS_FIELD_CHECK_IDS).toContain(id);
      expect(resolveCrossFieldCheck(id)).toBeTruthy();
      expect(CROSS_FIELD_CHECK_LABEL_KEYS[id]).toBeTruthy();
      expect(CROSS_FIELD_CHECK_FIELDS[id]).toBeTruthy();
    }
  });

  test('the DB-backed rule has no detect, and runCrossFieldChecks skips it silently', () => {
    expect(CROSS_FIELD_CHECKS.some(c => c.id === CUVEE_NEAR_MISS)).toBe(false);
    expect(DB_BACKED_CROSS_FIELD_CHECKS.map(c => c.id)).toContain(CUVEE_NEAR_MISS);
    expect(run({ name: 'Anything', producer: 'Anyone' }, [CUVEE_NEAR_MISS])).toBeNull();
  });

  test('every pure rule still has a detect — a DB-backed one must not slip into that list', () => {
    for (const c of CROSS_FIELD_CHECKS) expect(typeof c.detect).toBe('function');
  });
});

// ── producer-place-plus-filler.scan (v1.111.0, SCAN-ONLY) ───────────────────
// THE INCIDENT (prod 2026-08-13): producer "Pays d'Oc Organic Wine" — an
// appellation padded with marketing words. The six blocking rules are
// full-string matches and let it through to a published mint.
describe('detectPlacePlusFillerProducer', () => {
  const { detectPlacePlusFillerProducer } = require('./crossFieldChecks');
  const refs = buildCrossFieldRefs({
    appellations: [
      { name: "Pays d'Oc", normalizedName: 'pays doc' },
      { name: 'Margaux', normalizedName: 'margaux' },
      { name: 'Toro', normalizedName: 'toro' },
      { name: 'Vino de la Tierra de Castilla', normalizedName: 'vino de la tierra de castilla' },
    ],
    regions: [{ name: 'Rioja', normalizedName: 'rioja' }],
    countries: [{ name: 'France', normalizedName: 'france' }],
  });

  test("THE INCIDENT: 'Pays d'Oc Organic Wine' → place + filler", () => {
    const hit = detectPlacePlusFillerProducer("Pays d'Oc Organic Wine", refs);
    expect(hit).toEqual({ place: "Pays d'Oc", filler: 'organic wine' });
  });

  test('Château Margaux DOES hit at the pure level — the ROUTE suppresses it behind a registry match (#942)', () => {
    expect(detectPlacePlusFillerProducer('Château Margaux', refs))
      .toEqual({ place: 'Margaux', filler: 'chateau' });
  });

  test('a real producer containing a place plus a NON-filler token is clean', () => {
    // Toro is a DO; Albalá is nobody's filler word.
    expect(detectPlacePlusFillerProducer('Bodegas Toro Albalá', refs)).toBeNull();
  });

  test('single-token producers are the exact rules\' turf — skipped here', () => {
    expect(detectPlacePlusFillerProducer('Margaux', refs)).toBeNull();
  });

  test('longest place window wins — a multi-word VT is matched whole', () => {
    expect(detectPlacePlusFillerProducer('Vino de la Tierra de Castilla Organic', refs))
      .toEqual({ place: 'Vino de la Tierra de Castilla', filler: 'organic' });
  });

  test('country + filler is caught too', () => {
    expect(detectPlacePlusFillerProducer('Organic Wine of France', refs))
      .toEqual({ place: 'France', filler: 'organic wine of' });
  });

  test('no place anywhere → null, whatever the filler', () => {
    expect(detectPlacePlusFillerProducer('Organic Natural Wine', refs)).toBeNull();
  });
});
