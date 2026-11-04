// Taxonomy reads for signed-in forms. Mirrors backend routes/taxonomy.js.

// The whole grape vocabulary ({ name, color, synonyms, wineCount }) for the
// grape picker — unlike the public /grapes list it includes rare varieties.
export const getGrapeNames = (apiFetch) => apiFetch('/api/taxonomy/grape-names');

// The classification taxonomy ({ _id, name, kind, system, country, synonyms,
// wineCount }) for the pickers: the only values a classification accepts.
export const getClassifications = (apiFetch) => apiFetch('/api/taxonomy/classifications');

// The label sweetness terms ({ _id, name, scale, band, regulated, system,
// country, synonyms, wineCount }) for the pickers: the only values a label
// sweetness accepts. `scale` narrows to the wine's scale (still | sparkling).
export const getSweetnessTerms = (apiFetch, scale) =>
  apiFetch(`/api/taxonomy/sweetness-terms${scale ? `?scale=${encodeURIComponent(scale)}` : ''}`);
