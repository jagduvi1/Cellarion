/**
 * Issue #1134 regression — a producer's range must not collapse onto one row.
 *
 * The reporter's registry rows and the identities the label scanner read off
 * their bottles, scored with the real composite. These numbers are the point
 * of the file: they are all comfortably above the scan path's old 0.75 match
 * floor, so every bottle in the range was filed under whichever sibling
 * happened to be in the registry first. If the scorer moves, this fires — and
 * whoever moved it has to decide again whether 0.75 can carry a commit.
 */
const { scoreWineMatch } = require('./wineMatching');
const { conflictingStyleTerms } = require('../utils/styleTerms');

const PRODUCER = 'Weingut Schiffmann-Junk';
const APPELLATION = 'Brauneberger Juffer-Sonnenuhr';
const V = 'Brauneberger Juffer-Sonnenuhr Riesling ';

// The row everything landed on.
const REGISTRY_ROW = {
  name: V + 'Spätlese Feinherb',
  producer: PRODUCER,
  appellation: APPELLATION,
};

const SCANNED = [
  { label: 'Spätlese Alte Reben',      name: V + 'Spätlese Alte Reben', producer: PRODUCER,           score: 0.8749, rejected: false },
  { label: 'Auslese',                  name: V + 'Auslese',             producer: PRODUCER,           score: 0.8457, rejected: true },
  { label: 'Kabinett',                 name: V + 'Kabinett',            producer: PRODUCER,           score: 0.8339, rejected: true },
  // The one bottle that escaped and became its own registry row — not because
  // anything protected it, but because the model misspelled the producer.
  { label: 'Spätlese Trocken (producer misread)', name: V + 'Spätlese Trocken', producer: 'Schiffmann-Jonk', score: 0.7034, rejected: true },
  { label: 'Spätlese Trocken (producer read right)', name: V + 'Spätlese Trocken', producer: PRODUCER, score: 0.8962, rejected: true },
];

describe('Schiffmann-Junk range — measured composite scores', () => {
  it.each(SCANNED)('$label scores $score against the Feinherb row', ({ name, producer, score }) => {
    const actual = scoreWineMatch(
      REGISTRY_ROW,
      { name, producer, appellation: APPELLATION },
      { redistribute: false }
    );
    expect(actual).toBeCloseTo(score, 4);
  });

  it('every sibling clears the old 0.75 scan floor except the misread one', () => {
    // Producer is 45% of the composite and appellation another 10%: one estate,
    // one vineyard, so 0.55 is settled before the name is read. The only bottle
    // that survived as its own wine is the one whose producer came back wrong.
    const cleared = SCANNED.filter((s) => s.score >= 0.75).map((s) => s.label);
    expect(cleared).toHaveLength(4);
    expect(cleared).not.toContain('Spätlese Trocken (producer misread)');
  });

  it('none of them reaches the resolver auto-link threshold', () => {
    // 0.95 is where findOrCreateWine links without asking. Nothing in a range
    // gets near it, which is why the resolver never had this bug and the scan
    // path did.
    for (const s of SCANNED) expect(s.score).toBeLessThan(0.95);
  });
});

describe('style guard on the same range', () => {
  it.each(SCANNED)('$label — rejected: $rejected', ({ name, rejected }) => {
    expect(Boolean(conflictingStyleTerms(name, REGISTRY_ROW.name))).toBe(rejected);
  });

  it('leaves the Alte Reben bottle to the soft zone', () => {
    // Both are Spätlesen and only the registry row states a sweetness, so the
    // guard stays silent by design. At 0.8749 the resolver puts it in the
    // 0.85–0.95 band, where the user is ASKED — which is the answer for a pair
    // no rule can separate.
    const alteReben = SCANNED.find((s) => s.label === 'Spätlese Alte Reben');
    expect(conflictingStyleTerms(alteReben.name, REGISTRY_ROW.name)).toBeNull();
    expect(alteReben.score).toBeGreaterThanOrEqual(0.85);
    expect(alteReben.score).toBeLessThan(0.95);
  });

  it('the two Trocken readings are rejected on sweetness, whatever the producer', () => {
    // The guard reads names only, so the misread producer changes nothing —
    // the bottle that escaped by accident would now be kept apart on purpose.
    for (const s of SCANNED.filter((x) => x.label.startsWith('Spätlese Trocken'))) {
      expect(conflictingStyleTerms(s.name, REGISTRY_ROW.name)).toMatch(/different sweetness/);
    }
  });
});
