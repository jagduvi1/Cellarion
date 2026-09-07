/**
 * splitPradikatFromAppellation — the one Prädikat rule for every mint
 * (findOrCreateWine and the two admin routes that build a WineDefinition
 * themselves; audit 2026-09-07).
 */
const { splitPradikatFromAppellation } = require('./styleTerms');

test('a bare Prädikat leaves the appellation and becomes the classification', () => {
  expect(splitPradikatFromAppellation('Kabinett', undefined, 'Riesling Kabinett')).toEqual({ appellation: null, classification: 'Kabinett' });
});

test('a classification the caller typed is kept', () => {
  expect(splitPradikatFromAppellation('Spätlese', 'Grosses Gewächs', 'Riesling')).toEqual({ appellation: null, classification: 'Grosses Gewächs' });
});

test('a Prädikat the name contradicts is dropped, not rescued', () => {
  const out = splitPradikatFromAppellation('Trockenbeerenauslese', undefined, 'Riesling Trocken');
  expect(out.appellation).toBeNull();
  expect(out.classification).toBeNull();
});

test('a real appellation passes through untouched', () => {
  expect(splitPradikatFromAppellation(' Mosel ', null, 'Riesling')).toEqual({ appellation: 'Mosel', classification: null });
  expect(splitPradikatFromAppellation(undefined, 'Reserva', 'X')).toEqual({ appellation: null, classification: 'Reserva' });
});
