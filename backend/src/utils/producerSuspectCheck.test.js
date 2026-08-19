const { noteAssertsProducer } = require('./producerSuspectCheck');

// Every string below is a real producerNote from prod on 2026-08-19.
describe('noteAssertsProducer', () => {
  describe('DOWNGRADE — the note calls the entity a producer while the flag says it is not', () => {
    const cases = [
      ['Cave de Sainte-Marie-La-Blanche', 'Cave de Sainte-Marie-La-Blanche is a cooperative cellar in Burgundy and this profile is based on regional and varietal typicity.'],
      ['Château Jeandeman', 'Château Jeandeman is a small Fronsac estate not well documented in widely available sources, so this profile is based mainly on appellation typicity.'],
      ['Domaine de Pignan', 'Domaine de Pignan is a small, little-documented Châteauneuf-du-Pape estate, so this profile is largely based on appellation typicity.'],
      ['Weingut Dörflinger', 'Dörflinger is a small Baden estate not well documented in wide reference sources, so this profile is largely inferred from the region.'],
      ['Domaine du Logis - Brice et Vincent Fiolleau', 'Domaine du Logis (Brice et Vincent Fiolleau) is a small Muscadet grower not widely documented, so this reflects an appellation view.'],
      ['Cave des Vignerons de Pfaffenheim', "Cave des Vignerons de Pfaffenheim is a cooperative producer; 'Black Tie' appears to be a branded cuvée name whose exact blend is unclear."],
      ['Bodega San Pedro de Yacochuya', "San Pedro de Yacochuya is an established Salta winery; 'The Rolland Collection' appears to be a marketing or retailer range."],
      ['Berthier', 'Berthier is a Loire Valley producer/negociant but this specific cuvee is not well documented to me.'],
      // No "X is a" construction at all — the subject itself is the producer
      // noun. This is the row the somm led the ticket with.
      ['Champagne Tapray Frédéric', 'This small Champagne grower is not one I can verify in detail, so this profile is based on typical regional and varietal style.'],
    ];
    for (const [producer, note] of cases) {
      it(`${producer}`, () => expect(noteAssertsProducer(note, producer)).toBe(true));
    }
  });

  describe('KEEP SUSPECT — the note names a commercial entity, which is the flag working', () => {
    const cases = [
      ['Aldi', 'Aldi is a supermarket retailer that sources this wine from a contract producer rather than owning an estate itself.'],
      ['Veuve du Vernay', 'Veuve du Vernay is a large-volume sparkling wine brand owned by the Belgian group Compagnie des Vins, not a traditional single estate producer.'],
      ['Grande Arche', 'Grande Arche appears to be a brand or negociant label rather than an established Saint-Émilion chateau I can confirm.'],
      ['Unknown', "Cuvée Léonore appears to be a bottler or retailer's own-label cuvée name rather than an identifiable winery."],
      ['Bodega Benegas Lynch', 'La Libertad appears to be a label or line from Bodega Benegas, not a separate producer.'],
      ['Cellier de la Weiss', 'Cellier de la Weiss appears to be a cellar/négociant bottling name rather than an independent estate, likely associated with a cooperative or merchant.'],
      ['Berselli & Gerbino', 'Signature Collection is a label range name often used by importers or negociant bottlers rather than a single estate producer.'],
      ['Amand Chaperon', 'Cheval de Montenac appears to be a négociant or brand bottling rather than an estate wine, and Amand Chaperon is likely a négociant house name.'],
    ];
    for (const [producer, note] of cases) {
      it(`${producer}`, () => expect(noteAssertsProducer(note, producer)).toBe(false));
    }
  });

  describe('LEFT ALONE — the category-only shape, which is genuinely ambiguous', () => {
    const cases = [
      ['La Spia', 'La Spia is not a producer I can confidently place, so this profile is based on the Rosso di Valtellina appellation and Nebbiolo grape rather than a verified house.'],
      ['Thomas Allen', 'Thomas Allen is not a producer I can verify; this profile is based on the grape blend and style rather than a known winemaker.'],
      ['Domaine Duffour', 'Domaine Duffour is not a producer I can confidently place; this profile is based on the appellation and grape varieties instead.'],
      ['Xavier', 'Xavier is not a producer I can confidently place for this appellation, so this reflects typical Muscat de Beaumes style.'],
      ['Increíble', 'The producer name is unfamiliar and could not be verified as an established winery, so this is an estimate based on style.'],
    ];
    for (const [producer, note] of cases) {
      it(`${producer} stays for a human`, () => expect(noteAssertsProducer(note, producer)).toBe(false));
    }
  });

  describe('the narrownesses that keep it honest', () => {
    it('a value cannot classify itself: "Domaine X" in the NAME never votes', () => {
      // Strip the name and nothing producer-ish is left before the contrast.
      expect(noteAssertsProducer('Domaine Duffour is not a producer I can place.', 'Domaine Duffour')).toBe(false);
      // …but a genuine claim about it still counts.
      expect(noteAssertsProducer('Domaine Duffour is a Gascony estate.', 'Domaine Duffour')).toBe(true);
    });

    it('négociant and cellar alone never trigger a downgrade — both sit on the boundary', () => {
      expect(noteAssertsProducer('Foo is a négociant bottling.', 'Foo')).toBe(false);
      expect(noteAssertsProducer('Foo is a cellar name.', 'Foo')).toBe(false);
    });

    it('the bare word "producer" is a field reference, not a claim', () => {
      // The shape the enrichment tests use, and the commonest note in the queue.
      expect(noteAssertsProducer('Cannot place this producer.', 'Foo')).toBe(false);
      expect(noteAssertsProducer('This producer is not one I know.', 'Foo')).toBe(false);
      // …but inside an actual assertion it counts.
      expect(noteAssertsProducer('Foo is a Loire Valley producer.', 'Foo')).toBe(true);
    });

    it('text after "rather than" describes what it is NOT and never counts', () => {
      expect(noteAssertsProducer('Foo appears to be a brand rather than an estate.', 'Foo')).toBe(false);
      expect(noteAssertsProducer('Foo is a label, not an estate.', 'Foo')).toBe(false);
    });

    it('empty, missing and non-string notes are no evidence', () => {
      expect(noteAssertsProducer('', 'Foo')).toBe(false);
      expect(noteAssertsProducer(null, 'Foo')).toBe(false);
      expect(noteAssertsProducer(undefined, undefined)).toBe(false);
      expect(noteAssertsProducer('   ', 'Foo')).toBe(false);
    });

    it('a regex-special producer name does not break the strip', () => {
      expect(noteAssertsProducer('C++ (Wines) is a small estate.', 'C++ (Wines)')).toBe(true);
    });
  });
});
