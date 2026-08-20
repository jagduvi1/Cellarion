const { gradeDescription, extractClaims } = require('./descriptionGrounding');

// The two load-bearing fixtures are one row, both sides of the line: the same
// Petersons record carried both descriptions two days apart (somm 6a82bfb7).
const PETERSONS_RECORD = { region: null, appellation: null, country: 'Australia', grapes: [] };

const PETERSONS_DISCLOSURE =
  "Petersons is a well-regarded family winery founded at Mount View in the Hunter Valley in 1971, first vintage 1981, " +
  "and named Champion Small Winery of Australia in 2001. This particular bottling could not be identified. Petersons " +
  "name a number of wines after family members — Russell's Vat 18 Shiraz is among their most highly rated — so a " +
  "possessive name here says nothing about whether the wine is an everyday red or a premium single parcel. They also " +
  "draw fruit from across the Hunter, Mudgee, Armidale and New England as well as Barossa, McLaren Vale, Eden Valley " +
  "and Clare Valley, so the region is genuinely open. Grape, region and tier are all unconfirmed, and no drink window " +
  "has been set for that reason. If your label names the variety or region, that correction would be valuable here.";

const PETERSONS_ASSERTION =
  "Maureen's is a soft, approachable red blend from the Hunter Valley, showing plum and red berry fruit with gentle tannins.";

describe('gradeDescription', () => {
  describe('the fixture pair — same record, opposite shapes', () => {
    it('the curator disclosure paragraph grades disclosure, never assertion', () => {
      const r = gradeDescription(PETERSONS_DISCLOSURE, PETERSONS_RECORD);
      expect(r.grade).toBe('disclosure');
      // Ungrounded places, every one framed — including the producer-biography
      // sentence AHEAD of the disclosure markers, which is why a strong marker
      // frames the whole document.
      const places = r.claims.map((c) => c.claim);
      expect(places).toEqual(expect.arrayContaining(['Mount View', 'Hunter Valley']));
      expect(r.claims.every((c) => c.framed)).toBe(true);
    });

    it('the 17 Aug AI line grades assertion — the class the check exists for', () => {
      const r = gradeDescription(PETERSONS_ASSERTION, PETERSONS_RECORD);
      expect(r.grade).toBe('assertion');
      expect(r.claims.some((c) => /hunter valley/i.test(c.claim) && !c.framed)).toBe(true);
    });
  });

  describe('grounded mentions are the description doing its job', () => {
    it('the record\'s own appellation grounds the prose', () => {
      expect(gradeDescription(
        'This Barolo shows classic tar and roses over firm Nebbiolo tannins.',
        { appellation: 'Barolo', country: 'Italy', grapes: ['Nebbiolo'] }
      ).grade).toBe('ok');
    });

    it('adjective forms ground via substring both ways (Spanish / Spain)', () => {
      expect(gradeDescription(
        'A mellow, oak-aged Spanish red in the traditional Reserva style.',
        { country: 'Spain' }
      ).grade).toBe('ok');
    });

    it('a grape on the record grounds a varietal mention', () => {
      expect(gradeDescription(
        'Built from Tempranillo with a year in barrel.',
        { country: 'Spain', grapes: ['Tempranillo'] }
      ).grade).toBe('ok');
    });
  });

  describe('claims and their framing', () => {
    it('a country adjective grounds via the demonym map', () => {
      // "American style" on a United States record, "Canadian climates" on a
      // Canada record — substring covered Spanish/Spain by spelling luck and
      // missed these two in the prod dry run.
      expect(gradeDescription(
        'A red blend crafted in a bold, fruit-forward American style.',
        { country: 'United States' }
      ).grade).toBe('ok');
      expect(gradeDescription(
        'A hybrid grape that shines in Canadian climates.',
        { country: 'Canada' }
      ).grade).toBe('ok');
    });

    it('a speculative grape on a grapeless record is a claim — framed by its hedge', () => {
      const r = gradeDescription(
        'The blend is likely built from Tempranillo.',
        { country: 'United States', grapes: [] }
      );
      expect(r.grade).toBe('disclosure');
      expect(r.claims).toEqual([{ claim: 'Tempranillo', framed: true }]);
    });

    it('a weak hedge frames only its own sentence, not the paragraph', () => {
      const r = gradeDescription(
        'A rich red from the Hunter Valley. The blend may be Shiraz-led.',
        { region: null, appellation: null, country: 'Australia' }
      );
      expect(r.grade).toBe('assertion'); // sentence 1 asserts, unframed
    });

    it('barrel materials and techniques are not origin claims', () => {
      expect(gradeDescription(
        'Aged eighteen months in French oak, in the Champagne method.',
        { country: 'Spain' }
      ).grade).toBe('ok');
    });

    it('empty and non-string descriptions grade ok', () => {
      expect(gradeDescription('', {}).grade).toBe('ok');
      expect(gradeDescription(null, {}).grade).toBe('ok');
    });
  });

  // Every case below is from the somm's full read of the v1.147 worklist
  // (all 25 rows, not a sample). Items are numbered as in their ticket.
  describe('the v1.147 extractor audit', () => {
    // Item 1, their top priority: span-substring grounding let the record's
    // country swallow the finer place — the row was flagged only on a grape,
    // and a curator who fixed that claim would believe the row finished.
    // Under-reporting on a flagged row is false assurance.
    it('the record\'s country must not ground the finer place beside it (Peñalolen)', () => {
      const r = gradeDescription(
        "This is a Cabernet Sauvignon-led red from Chile's Maipo Valley, typically blended with small amounts of Cabernet Franc, Petit Verdot and Merlot.",
        { country: 'Chile', grapes: ['Cabernet Sauvignon'] }
      );
      const claims = r.claims.map((c) => c.claim);
      expect(claims).toEqual(expect.arrayContaining(['Maipo Valley', 'Cabernet Franc']));
      expect(r.grade).toBe('assertion');
    });

    // Item 2: three of four disclosure rows were the producer's own name —
    // the entire disclosure bucket was extraction noise wearing a calibrated
    // look. The producer's tokens are subtracted like the record's own.
    it('the producer\'s own name is never a place claim', () => {
      expect(gradeDescription(
        "Grown at altitude in Bodega Fernando Dupont's Jujuy vineyards, this Syrah shows dark fruit.",
        { country: 'Argentina', producer: 'Bodega Fernando Dupont', grapes: ['Syrah'] }
      ).claims.map((c) => c.claim)).toEqual(['Jujuy']);

      expect(gradeDescription(
        'Château Bois d\'Arlène is likely a small estate; this is an approachable southern French red.',
        { country: 'France', producer: 'Château Bois d\'Arlène' }
      ).claims.map((c) => c.claim)).toEqual([]);
    });

    // Item 5: a place after a creation verb is where the VARIETY was bred,
    // not where this wine is from.
    it('a breeding location is not an origin claim (Minnesota)', () => {
      expect(gradeDescription(
        'Made from Marquette — a cold-hardy hybrid grape bred in Minnesota — this is a juicy red.',
        { country: 'France', grapes: ['Marquette'] }
      ).grade).toBe('ok');
    });

    // Item 6: "Castilla y León" split at the conjunction and reported a
    // truncated claim; possessives kept their apostrophe-s.
    it('conjunction connectors and possessives keep spans whole and clean', () => {
      expect(gradeDescription(
        'A fresh, pale rosado from Castilla y León, made mainly from Tempranillo.',
        { country: 'Spain', grapes: ['Tempranillo'] }
      ).claims.map((c) => c.claim)).toEqual(['Castilla y León']);

      expect(gradeDescription(
        "Old vines at altitude near Vistalba in Mendoza's oldest district.",
        { country: 'Argentina' }
      ).claims.map((c) => c.claim)).toEqual(expect.arrayContaining(['Vistalba', 'Mendoza']));
    });
  });
});

describe('extractClaims', () => {
  it('captures prepositional and keyword forms, drops years and stopwords', () => {
    const claims = extractClaims('Founded at Mount View in the Hunter Valley in 1971, in the classic Barossa style.');
    expect(claims).toEqual(expect.arrayContaining(['Mount View', 'Hunter Valley', 'Barossa']));
    expect(claims.join(' ')).not.toMatch(/1971/);
  });

  it('ordinary capitalised sentence-starts never capture', () => {
    expect(extractClaims('This wine shows bright fruit. Expect gentle tannins.')).toEqual([]);
  });
});
