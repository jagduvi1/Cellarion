const { noteAssertsProducer, noteIsEpistemicOnly } = require('./producerSuspectCheck');

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

    // All three were FALSE DOWNGRADES the prod dry run caught on 2026-08-19,
    // before anything was written. 46 rows would have moved; 3 of the first 25
    // shown were wrong.
    it('a capitalised producer noun is part of a proper NAME, not a claim', () => {
      expect(noteAssertsProducer('Davey Estate appears to be a label or tier rather than a well-documented standalone producer.', 'Shingleback')).toBe(false);
      expect(noteAssertsProducer("Domaine des Granges de Mirabel appears to be a Pays d'Oc entry-level label associated with Chapoutier.", 'M. Chapoutier')).toBe(false);
    });

    it('"does not match a known X house" is a denial, not a claim', () => {
      expect(noteAssertsProducer('Carbon does not match a known Champagne house and may be a private label or brand name.', 'Carbon')).toBe(false);
    });

    it('a producer noun describing a NAME is the brand reading', () => {
      expect(noteAssertsProducer('Émeraude appears to be a house or cuvee name rather than a widely recognised Champagne producer.', 'Dominique Crété')).toBe(false);
      expect(noteAssertsProducer('Foo is a bottling name.', 'Foo')).toBe(false);
    });

    // Second prod dry run, 2026-08-19. Both matched "estate" inside a clause
    // that DENIES one, and both are the identity-blocking family — the producer
    // field holds a place or an appellation, which is the flag's core purpose.
    it('a note saying the FIELD holds a place or appellation never downgrades', () => {
      expect(noteAssertsProducer('The producer field simply repeats the appellation name, so no specific estate can be identified; this profile reflects the Monbazillac appellation style.', 'Monbazillac')).toBe(false);
      expect(noteAssertsProducer('Turckheim is also the name of an Alsace village and a well known cooperative (Cave de Turckheim); without a specific cuvée it is unclear.', 'Turckheim')).toBe(false);
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

// Every string below is a real producerNote taken from the prod dry run on
// 2026-08-20, and each was read against its wine before being written down —
// the previous round of this rule shipped five false downgrades precisely
// because its tests were composed from notes rather than measured against them.
describe('noteIsEpistemicOnly', () => {
  describe('DOWNGRADE — the note reports only what the model could not verify', () => {
    const cases = [
      ['Domaine Duffour', 'Domaine Duffour is not a producer I can confidently place; this profile is based on the appellation and grape varieties typical of Côtes de Gascogne.'],
      ['Compañía Uruguaya de Vinos de Mar', 'This producer name is unfamiliar to me, so this profile is based on the grape and Maldonado region generally rather than confirmed knowledge of the specific winery.'],
      ['Ugo Lequio', 'Ugo Lequio is not a producer I can confidently document, so this profile is based on the Barbaresco appellation and Nebbiolo grape.'],
      ['Cagliero', 'Cagliero is not a Barolo producer clearly known to me, so this profile is based on appellation and grape typicity rather than the specific house.'],
      ['Montlobre', 'Montlobre is not a producer I can confidently place; this profile is an appellation and style-level estimate.'],
      ['Vale da Mata', 'Vale da Mata is not a producer I can confidently place, so this profile is based on the region and grape varieties.'],
    ];
    it.each(cases)('%s', (producer, note) => {
      expect(noteIsEpistemicOnly(note, producer)).toBe(true);
    });

    // The fixture that matters most: the sommelier argued the rule FROM this
    // row, and had already cleared it by hand with `confirm` after confirming
    // it is a real Valtellina winery. The rule reproducing an independent
    // human verdict is the strongest evidence it is reading the notes right.
    it('La Spia — the A-path fixture the rule was argued from', () => {
      expect(noteIsEpistemicOnly(
        'La Spia is not a producer I can confidently place, so this profile is based on the Rosso di Valtellina appellation and Nebbiolo grape rather than a verified house style.',
        'La Spia'
      )).toBe(true);
    });

    // The methodology tail is where these notes reach for brand vocabulary
    // while claiming nothing — judging the raw string keeps them suspect.
    it('a brand noun on the negated side of "rather than" is not a claim', () => {
      expect(noteIsEpistemicOnly(
        'Giuli Ballarin is not a producer I can verify, so this profile is based on the grape and region rather than the specific bottling.',
        'Venica & Venica'
      )).toBe(true);
      expect(noteIsEpistemicOnly(
        'Eisenstone is not a producer I can confidently place, so this profile is based on the Marananga sub-region and Shiraz grape rather than a verified house style.',
        'Eisenstone'
      )).toBe(true);
    });
  });

  describe('KEEP — the note names what the field actually is, so the suspicion is real', () => {
    // Caught in the first dry run: cutting the whole "so this profile is…"
    // clause swallowed a genuine brand claim that FOLLOWED it.
    it('a positive brand claim after the methodology clause still counts', () => {
      expect(noteIsEpistemicOnly(
        'Palladium is not a producer I can confidently place for this wine; this profile is based on the McLaren Vale Shiraz style generally, likely a private-label or retailer brand.',
        'Palladium'
      )).toBe(false);
    });

    // Caught in the second dry run: stated outright rather than by comparison.
    it('a note saying the value is an appellation is a claim, however tentative', () => {
      expect(noteIsEpistemicOnly(
        'Chateau Etoile is not a producer I can verify; Château d\'Etoile / L\'Etoile is an appellation in the Jura, so this may be a mislabeling or an unfamiliar small producer.',
        'Chateau Etoile'
      )).toBe(false);
    });

    const cases = [
      ['Aldi', 'Aldi is a supermarket retailer that sources this wine from a contract producer rather than owning an estate itself.'],
      ['Grande Arche', 'Grande Arche appears to be a brand or negociant label rather than an established Saint-Émilion chateau I can confirm.'],
      ['Bodega Catena Zapata', 'DV Catena appears to be a value-tier range associated with Catena, but this specific bottling is not one I can verify in detail.'],
      ['Unknown', "'Merlot' here names the grape variety rather than an actual winery, so the true producer is unidentified."],
      ['Veuve du Vernay', 'Veuve du Vernay is a large-volume sparkling wine brand owned by the Belgian group Compagnie des Vins, not a traditional single estate producer.'],
      ['Domaine de la Gaffeliere', 'Les Hauts de la Gaffeliere is the second wine of Chateau la Gaffeliere, not a separate domaine.'],
    ];
    it.each(cases)('%s', (producer, note) => {
      expect(noteIsEpistemicOnly(note, producer)).toBe(false);
    });

    // The sommelier's own example of the precedence they asked for: a hedged
    // trade classification is still a claim, so B beats A.
    it('"may be a negociant" is a claim even though it is hedged', () => {
      expect(noteIsEpistemicOnly(
        'Jean XXII is not a producer I can confidently place; this may be a negociant or lesser-known bottling.',
        'Jean XXII'
      )).toBe(false);
    });

    it('a note with no epistemic marker at all is not this rule\'s business', () => {
      expect(noteIsEpistemicOnly('Quatre Seigneurs is a négociant brand used within Châteauneuf-du-Pape.', 'Quatre Seigneurs')).toBe(false);
    });
  });

  describe('the two rules stay disjoint, so their tags stay meaningful', () => {
    // Both epistemic AND a producer claim: ASSERTS_PRODUCER owns it, so this
    // rule must decline it or a row would carry the wrong provenance tag.
    it('a note that calls the entity a producer belongs to the sibling rule', () => {
      const note = 'Cascina Ballarin is a small Piedmont producer I cannot confidently verify, so this profile is largely appellation-level.';
      expect(noteAssertsProducer(note, 'Cascina Ballarin')).toBe(true);
      expect(noteIsEpistemicOnly(note, 'Cascina Ballarin')).toBe(false);
    });
  });

  it('empty, missing and non-string notes are no evidence', () => {
    expect(noteIsEpistemicOnly('', 'Foo')).toBe(false);
    expect(noteIsEpistemicOnly(null, 'Foo')).toBe(false);
    expect(noteIsEpistemicOnly(undefined, undefined)).toBe(false);
    expect(noteIsEpistemicOnly('   ', 'Foo')).toBe(false);
  });
});
