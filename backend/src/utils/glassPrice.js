// Suggested by-the-glass price from a wine list's glass-pricing rule.
//
// SINGLE SOURCE on the backend (MCP-audit M4). The web editor applies the same
// rule in frontend/src/pages/WineListEditor.js (suggestGlassPrice); the two are
// separate npm packages so the formula can't be physically shared, but it MUST
// stay identical or the same "add by the glass" action produces a different
// menu depending on surface. The rule: listPrice / glassesPerBottle × (1 +
// markup%), rounded to the nearest `glassRounding` step, and FLOORED at one step
// so a glass is never free (a cheap wine used to suggest 0 on the backend and 1
// on the web). Returns null when there is no list price to derive from.
function suggestGlassPrice(listPrice, layout = {}) {
  if (listPrice == null) return null;
  const glasses = layout.glassesPerBottle || 6;
  const markup = layout.glassMarkup || 0;
  const step = parseInt(layout.glassRounding || '1', 10) || 1;
  const raw = (listPrice / glasses) * (1 + markup / 100);
  return Math.max(step, Math.round(raw / step) * step);
}

module.exports = { suggestGlassPrice };
