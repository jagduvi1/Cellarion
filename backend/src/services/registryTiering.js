/**
 * What an ANONYMOUS caller gets of a wine's tasting profile (registry lockdown
 * 2026-09-06, layer L3: "findable, not harvestable").
 *
 * The public wine page and the no-signup registry MCP exist so that a wine is
 * readable and citable — one wine at a time, in prose. The structured profile
 * (body / tannin / acidity / sweetness, the flavour and pairing arrays) is the
 * machine-usable dataset a copier wants and the app's own filters need; it
 * stays with signed-in members, the bottle page and bridge clients. Anonymous
 * callers get the description, one style sentence derived from the structure,
 * and the provenance flag the page shows next to it.
 */

/** "full-bodied, firm tannin, high acidity" — the structure as one line. */
function styleSentence(ap) {
  if (!ap || typeof ap !== 'object') return null;
  const parts = [];
  if (ap.body) parts.push(`${ap.body}-bodied`);
  if (ap.tannin) parts.push(`${ap.tannin} tannin`);
  if (ap.acidity) parts.push(`${ap.acidity} acidity`);
  if (ap.sweetness) parts.push(String(ap.sweetness));
  return parts.length ? parts.join(', ') : null;
}

/**
 * The prose-only profile. Null when there is no description — a profile with
 * structure but no prose is not shown publicly today either (the page keys on
 * the description), so nothing is lost.
 */
function publicProfileSummary(ap) {
  if (!ap || typeof ap !== 'object') return null;
  const description = typeof ap.description === 'string' && ap.description.trim() ? ap.description : null;
  if (!description) return null;
  return {
    description,
    style: styleSentence(ap),
    source: ap.source === 'curator' ? 'curator' : 'ai',
  };
}

/**
 * Apply the tier to a wine payload in place of its aiProfile. `full` callers
 * (a signed-in member, the personal MCP surface) keep the profile untouched.
 */
function tierWinePayload(wine, { full }) {
  if (!wine || full) return wine;
  return { ...wine, aiProfile: publicProfileSummary(wine.aiProfile) };
}

module.exports = { styleSentence, publicProfileSummary, tierWinePayload };
