// Wine names as other apps write them. A file's "Wine" column often carries
// the producer, the classification tier or the appellation inside the name;
// these helpers take each of them out, so a row matches the registry's wine
// instead of minting a near-duplicate of it. utils/importMappers.js
// re-exports the public names.

const CT_PRODUCER_PREFIX_RE =
  /^(Château|Chateau|Domaine|Clos|Castello|Tenuta|Bodegas?|Weingut|Cantina|Quinta|Mas)$/i;

const CT_PRODUCER_PARTICLE_RE =
  /^(de|du|des|la|le|les|di|del|della|dei|degli|do|dos|da|das|y|e|&|van|von|zu|zur)$/i;

/**
 * Best-effort producer guess from CT's "Wine" display name (which leads with
 * the producer) when no Producer column exists. If the name starts with a
 * producer-prefix word (Château/Domaine/…), take the prefix plus any name
 * particles plus one substantive token, so
 *   "Domaine de la Romanée-Conti La Tâche" → "Domaine de la Romanée-Conti"
 *   "Château Margaux"                      → "Château Margaux"
 * Anything else is left EMPTY on purpose. The first word of a longer name is
 * right for "Penfolds Grange" and wrong for "Louis Jadot …", "Kim Crawford …",
 * "19 Crimes …": taking it mints registry wines under one-word producers. The
 * backend splits a producer-less row on a producer the registry already
 * knows, and asks the model for the rest; an empty producer here is what
 * routes it there.
 */
export function guessProducerFromWineName(wineName) {
  if (!wineName) return '';
  const parts = wineName.trim().split(/\s+/);
  if (parts.length < 2) return '';
  if (CT_PRODUCER_PREFIX_RE.test(parts[0])) {
    let end = 1;
    while (end < parts.length && CT_PRODUCER_PARTICLE_RE.test(parts[end])) end++;
    if (end < parts.length) end++; // the substantive token
    return parts.slice(0, end).join(' ');
  }
  return '';
}

/**
 * CT's "Wine" display name includes the producer prefix ("Vega Sicilia
 * Único"). When a real Producer column value is present and the name starts
 * with it, strip the prefix for a cleaner wineName — unless stripping would
 * empty it (wine named exactly after the producer, e.g. "Pétrus").
 */
export function stripProducerPrefix(wineName, producer) {
  if (!wineName || !producer) return wineName;
  if (wineName.toLowerCase().startsWith(producer.toLowerCase())) {
    const rest = wineName.slice(producer.length).replace(/^[\s\-–—:,]+/, '').trim();
    if (rest) return rest;
  }
  return wineName;
}

// ── Classification-in-name guard ────────────────────────────────────────────
//
// Once the producer prefix is stripped, a Bordeaux "Wine" value like
// "Château Talbot Grand Cru Classé" leaves just the CLASSIFICATION tier —
// and that string must not be stored as the wine's NAME: distinct châteaux
// would all mint wines named "Grand Cru Classé", duplicating the
// properly-named record of the same château. A tier is routed
// to `classification`; the name gets whatever substantive part remains, or
// falls back to the producer (the grand-vin convention — Château Margaux's
// wine IS "Château Margaux").
//
// Deliberately requires "classé"/"bourgeois": Burgundy's "1er Cru" alone is
// part of real appellation-carrying names ("Chassagne-Montrachet 1er Cru Les
// Fairendes") and must never trip this.

const TIER_RE = /(premier\s+grand\s+cru\s+class[eé]s?|second\s+grand\s+cru\s+class[eé]s?|deuxi[eè]me\s+cru\s+class[eé]s?|grand\s+cru\s+class[eé]s?|premier\s+cru\s+class[eé]s?|cru\s+class[eé]s?|cru\s+bourgeois(?:\s+sup[eé]rieur)?)/i;

const TIER_CANONICAL = new Map([
  ['premier grand cru classe', 'Premier Grand Cru Classé'],
  ['second grand cru classe', 'Second Grand Cru Classé'],
  ['deuxieme cru classe', 'Deuxième Cru Classé'],
  ['grand cru classe', 'Grand Cru Classé'],
  ['premier cru classe', 'Premier Cru Classé'],
  ['cru classe', 'Cru Classé'],
  ['cru bourgeois', 'Cru Bourgeois'],
  ['cru bourgeois superieur', 'Cru Bourgeois Supérieur'],
]);

const foldAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

const normTier = (s) => TIER_CANONICAL.get(foldAccents(s).toLowerCase().replace(/s$/, '').replace(/\s+/g, ' ').trim()) || null;

// Words that don't make a leftover a real cuvée name: the row's own
// appellation/region tokens, plus label furniture ("Grand Vin", AOC noise).
const NAME_NOISE = new Set(['grand', 'vin', 'cru', 'aoc', 'ac', 'appellation', 'controlee', 'de', 'du', 'la', 'le', 'les', 'des']);

function isAppellationNoise(remainder, appellation, region) {
  const allowed = new Set(NAME_NOISE);
  for (const src of [appellation, region]) {
    for (const t of foldAccents(src).toLowerCase().split(/[^a-z0-9]+/)) if (t) allowed.add(t);
  }
  return foldAccents(remainder).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .every((t) => allowed.has(t));
}

/**
 * Split a classification tier out of a wine name. Returns
 * { wineName, classification } — classification undefined when no tier found.
 */
export function splitClassificationFromName(wineName, { producer, appellation, region } = {}) {
  const name = String(wineName || '').trim();
  if (!name) return { wineName, classification: undefined };

  // Trailing parenthesised tier: "Margaux (Grand Cru Classé)". The remainder
  // re-runs through the splitter — "Saint-Émilion Grand Cru (Grand Cru
  // Classé)" still has appellation noise to shed.
  const paren = name.match(/^(.*?)\s*\(\s*([^)]*(?:cru\s+class[eé]|cru\s+bourgeois)[^)]*)\s*\)\s*$/i);
  if (paren) {
    const inner = normTier(paren[2]) || paren[2].trim();
    const again = splitClassificationFromName(paren[1], { producer, appellation, region });
    // The part before the parens gets the same "is it a real name" test as
    // the inline case — "Margaux (Grand Cru Classé)" leaves only appellation.
    const base = again.wineName && !isAppellationNoise(again.wineName, appellation, region)
      ? again.wineName
      : ((producer || '').trim() || name);
    return { wineName: base, classification: again.classification || inner };
  }

  const m = name.match(TIER_RE);
  if (!m) return { wineName: name, classification: undefined };
  const tier = normTier(m[0]) || m[0].trim();
  const remainder = (name.slice(0, m.index) + ' ' + name.slice(m.index + m[0].length))
    .replace(/[\s,;:()–—-]+/g, ' ').trim();
  if (remainder && !isAppellationNoise(remainder, appellation, region)) {
    // A real cuvée survives the strip: "Clos des Jacobins", "Réserve du Château".
    return { wineName: remainder, classification: tier };
  }
  // Nothing substantive left — a designation is not a name; the grand vin
  // carries the estate's own. No producer to fall back on leaves the name
  // unchanged rather than minting an empty one.
  return { wineName: (producer || '').trim() || name, classification: tier };
}

// ── Appellation-first names ────────────────────────────────────────────────
//
// CT composes "Wine" as producer + appellation + designation ("Bodegas Muga
// Rioja Prado Enea Gran Reserva"). After the producer prefix goes, the name
// still leads with the appellation while the registry keeps the designation
// alone ("Prado Enea Gran Reserva"), so a re-import of such a file would
// re-create its whole request queue. When the row's Appellation (or Region) opens the
// name, drop it — unless what is left is a bare style word ("Reserva"), which
// is not a name. CT's own Designation column, when present and matching the
// remainder, is used verbatim so the file's spelling and case survive.
const APPELLATION_TIER_WORDS = /\b(docg|doca|doc|dop|aoc|aop|igt|igp|ava|gi|do|vdp|vdqs)\b/g;

// A remainder made only of styles and grapes is not a name: "Rioja Reserva"
// → "Reserva", and a Mosel row whose CT Appellation is the single vineyard
// ("Wehlener Sonnenuhr Riesling Auslese") must keep the vineyard, because
// that is the wine's name. Mirrors services/wineMatching.js on the server.
const GENERIC_NAME_WORDS = new Set([
  'reserva', 'gran', 'grande', 'riserva', 'reserve', 'crianza', 'joven', 'classico', 'superiore',
  'brut', 'extra', 'sec', 'demi', 'dry', 'trocken', 'feinherb', 'halbtrocken', 'kabinett', 'spatlese',
  'auslese', 'beerenauslese', 'trockenbeerenauslese', 'eiswein', 'gg', 'grosses', 'groes', 'gewachs', 'erstes',
  'rouge', 'blanc', 'rose', 'rosado', 'bianco', 'rosso', 'tinto', 'branco', 'red', 'white', 'sekt',
  'riesling', 'chardonnay', 'pinot', 'noir', 'gris', 'grigio', 'blanco', 'sauvignon', 'merlot', 'cabernet',
  'franc', 'syrah', 'shiraz', 'grenache', 'garnacha', 'tempranillo', 'sangiovese', 'nebbiolo', 'barbera',
  'dolcetto', 'malbec', 'zinfandel', 'gewurztraminer', 'gruner', 'veltliner', 'chenin', 'viognier', 'muscat',
  'moscato', 'mourvedre', 'carignan', 'gamay', 'mencia', 'garganega', 'albarino', 'alvarinho', 'verdejo',
  'godello', 'touriga', 'nacional', 'franca', 'spatburgunder', 'weissburgunder', 'grauburgunder', 'silvaner',
  'sylvaner', 'muller', 'thurgau', 'blaufrankisch', 'zweigelt', 'semillon', 'primitivo', 'aglianico',
  'montepulciano', 'corvina', 'glera', 'trebbiano', 'vermentino', 'verdicchio', 'fiano', 'greco', 'nero',
  'davola', 'carmenere', 'petit', 'verdot', 'roussanne', 'marsanne', 'cinsault', 'furmint', 'assyrtiko',
]);

const foldForPrefix = (s) => foldAccents(String(s || '')).toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();

const isGenericRemainder = (folded) => folded.split(' ').filter(Boolean).every((t) => GENERIC_NAME_WORDS.has(t));

export function stripAppellationPrefixFromName(wineName, { appellation, region, designation } = {}) {
  const name = String(wineName || '').trim();
  if (!name) return wineName;
  const nameWords = name.split(/\s+/);
  for (const hint of [appellation, region]) {
    const head = foldForPrefix(hint).replace(APPELLATION_TIER_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (!head) continue;
    const headWords = head.split(' ');
    if (headWords.length >= nameWords.length) continue;
    const lead = foldForPrefix(nameWords.slice(0, headWords.length).join(' '));
    if (lead !== head) continue;
    const remainderWords = nameWords.slice(headWords.length);
    const remainder = remainderWords.join(' ');
    if (isGenericRemainder(foldForPrefix(remainder))) return name;
    const des = String(designation || '').trim();
    if (des && foldForPrefix(des) === foldForPrefix(remainder)) return des;
    return remainder;
  }
  return name;
}
