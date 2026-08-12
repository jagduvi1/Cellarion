/**
 * The two rules from sommelier ticket 3.
 *
 *   colour-contradiction.v1 — Domaine Rolet, name "Rosé Poulsard", type `red`.
 *                             The label says one colour and the record says
 *                             another; a drinker filtering by type gets the
 *                             wrong bottle either way. Pure string test.
 *   cuvee-near-miss.v1      — Frédéric Magnien "Coeur de Roi" beside the real
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
const colour = (wine) => run({ producer: 'X Estate', ...wine }, ['colour-contradiction.v1']);

describe('colour-contradiction.v1', () => {
  test('THE LIVE ROW: name "Rosé Poulsard" stored as red', () => {
    const hits = colour({ name: 'Rosé Poulsard', type: 'red' });
    expect(hits).toHaveLength(1);
    expect(hits[0].check).toBe('colour-contradiction.v1');
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
});

describe('cuvee-near-miss.v1', () => {
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
});

describe('both rules are first-class members of the queue', () => {
  test('they are known, default-active ids', () => {
    for (const id of ['colour-contradiction.v1', CUVEE_NEAR_MISS]) {
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
