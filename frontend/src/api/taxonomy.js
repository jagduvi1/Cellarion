// Taxonomy reads for signed-in forms. Mirrors backend routes/taxonomy.js.

// The whole grape vocabulary ({ name, color, synonyms, wineCount }) for the
// grape picker — unlike the public /grapes list it includes rare varieties.
export const getGrapeNames = (apiFetch) => apiFetch('/api/taxonomy/grape-names');
