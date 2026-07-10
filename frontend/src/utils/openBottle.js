/**
 * Open-bottle (Coravin / preservation) helpers — pure derivations from the
 * bottle's openedAt / preservationMethod / pours / bottleSize fields.
 *
 * Freshness windows are honest rules of thumb per preservation method, not
 * science: Coravin (argon through the cork) keeps wine for months, inert-gas
 * spray about a week, vacuum pumps a few days, sparkling stoppers and plain
 * recorking a day or two.
 */

export const GLASS_ML = 125;

export const PRESERVATION_METHODS = [
  { id: 'coravin', freshnessDays: 90 },
  { id: 'inert-gas', freshnessDays: 7 },
  { id: 'vacuum', freshnessDays: 4 },
  { id: 'sparkling-stopper', freshnessDays: 2 },
  { id: 'recorked', freshnessDays: 2 },
];

export function methodMeta(id) {
  return PRESERVATION_METHODS.find(m => m.id === id) || null;
}

/** Bottle volume in ml from the canonical '<ml>ml' size code (750 fallback). */
export function bottleSizeMl(bottle) {
  const m = /^(\d+)ml$/.exec(bottle?.bottleSize || '');
  return m ? parseInt(m[1], 10) : 750;
}

export function pouredMl(bottle) {
  return (bottle?.pours || []).reduce((sum, p) => sum + (Number(p.ml) || 0), 0);
}

export function remainingMl(bottle) {
  return Math.max(0, bottleSizeMl(bottle) - pouredMl(bottle));
}

/** Remaining volume in glasses, half-glass precision. */
export function glassesLeft(bottle) {
  return Math.round((remainingMl(bottle) / GLASS_ML) * 2) / 2;
}

/** Drink-by deadline: openedAt + the method's freshness window. Null when unopened. */
export function drinkByDate(bottle) {
  if (!bottle?.openedAt) return null;
  const days = methodMeta(bottle.preservationMethod)?.freshnessDays ?? 2;
  const d = new Date(bottle.openedAt);
  d.setDate(d.getDate() + days);
  return d;
}

/** Whole days until the drink-by deadline (negative = past it). Null when unopened. */
export function daysLeft(bottle, now = new Date()) {
  const deadline = drinkByDate(bottle);
  if (!deadline) return null;
  return Math.ceil((deadline.getTime() - now.getTime()) / 86400000);
}

/** 'ok' | 'soon' (≤3 days) | 'past' — drives badge colors. Null when unopened. */
export function freshnessStatus(bottle, now = new Date()) {
  const d = daysLeft(bottle, now);
  if (d === null) return null;
  if (d <= 0) return 'past';
  if (d <= 3) return 'soon';
  return 'ok';
}
