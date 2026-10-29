/**
 * The classification taxonomy's operations (models/Classification):
 *
 *   - splitClassificationString: a legacy free-text value into its parts
 *     ("Spätlese, VDP.Grosse Lage" → two)
 *   - stripNoise: the words that ride along in a legacy value without being
 *     a tier ("Kabinett trocken" → "kabinett"; "Qualitätswein" → nothing)
 *   - resolveClassifications: names or synonyms → taxonomy rows (and what
 *     could not be resolved), preferring the row of the wine's country when
 *     a word is a tier in two systems ("Erste Lage": VDP in Germany, ÖTW in
 *     Austria)
 *   - assignClassification: THE write rule — every path that stores a
 *     classification calls it with the string a form, a scan, an import or
 *     an API client sent (or the rows a picker chose) and it sets both the
 *     rows and the derived string on the wine
 *   - classificationString: the array → the derived legacy string every
 *     reader still shows
 *   - detectFromName: the tiers a wine's NAME states, by the country whose
 *     law or custom defines the word — the rule-based backfill, never a guess
 *   - seedClassifications: data/classifications.json → taxonomy rows
 *
 * The taxonomy is small (under a hundred rows) and read on every wine write,
 * so it is held in memory for a minute at a time; the admin routes that
 * change it call invalidateClassificationCache() (single-process, like the
 * other in-memory caches). Without a database connection (unit tests, a boot
 * before the seed) the taxonomy reads as empty and every write path keeps
 * the string it was given, exactly as before the taxonomy existed.
 */
const mongoose = require('mongoose');
const Classification = require('../models/Classification');
const { normalizeString, normalizeClassification } = require('../utils/normalize');

const KIND_ORDER = { vineyard_rank: 0, ripeness: 1, ageing: 2, other: 3 };

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The separators imports and members used inside one value. A dash splits
// only with spaces around it, so "Saint-Émilion" stays whole; parentheses
// split too ("VDP.Grosse Lage (Grosses Gewächs)" is two tiers).
const SPLIT_RX = /\s*(?:,|;|\/|\+|\||:|·|\(|\)| - | – | — | and | und )\s*/i;

/** "Spätlese, VDP.Grosse Lage" → ["Spätlese", "VDP.Grosse Lage"]; blanks and repeats dropped. */
function splitClassificationString(value) {
  if (value == null) return [];
  const parts = String(value).split(SPLIT_RX).map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  return parts.filter((p) => { const k = normalizeString(p); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

// Words that ride along in a legacy value without being a tier: the German
// and Austrian legal category the tier sits in, sweetness, bottling notes,
// the year of the Médoc classification, a Burgundy monopole mark. They are
// stripped before the lookup; a value that is nothing but these is not a
// classification at all.
const NOISE = [
  'deutscher prädikatswein', 'deutscher qualitätswein', 'qualitätswein aus österreich', 'qualitätswein aus deutschland',
  'österreichischer qualitätswein', 'prädikatswein', 'qualitätswein', 'qba', 'qmp', 'deutscher', 'österreichischer',
  'trocken', 'halbtrocken', 'feinherb', 'lieblich', 'süß', 'edelsüß', 'gutsabfüllung', 'erzeugerabfüllung',
  'monopole', 'en 1855', '1855',
];
const NOISE_KEYS = [...new Set(NOISE.map(normalizeString).filter(Boolean))].sort((a, b) => b.length - a.length);
const NOISE_RX = NOISE_KEYS.map((k) => new RegExp(`(^|\\s)${escapeRx(k)}(?=\\s|$)`, 'g'));

/** The normalised value with the ride-along words removed; '' when nothing else was there. */
function stripNoise(value) {
  let key = normalizeString(value == null ? '' : String(value));
  if (!key) return '';
  for (const rx of NOISE_RX) key = key.replace(rx, '$1');
  return key.replace(/\s+/g, ' ').trim();
}

/** Among rows sharing a name or synonym, the wine's country's own row first, then a country-less one. */
function pickForCountry(rows, countryId) {
  if (!rows || !rows.length) return null;
  if (countryId) {
    const own = rows.find((r) => r.country && String(r.country._id || r.country) === String(countryId));
    if (own) return own;
  }
  return rows.find((r) => !r.country) || rows[0];
}

// ── The in-memory taxonomy ────────────────────────────────────────────────
const TAXONOMY_TTL_MS = 60 * 1000;
const TAXONOMY_SELECT = 'name kind system country synonyms normalizedName normalizedSynonyms';
let cache = null; // { at, pinned, rows, byId, byKey, empty }

function indexTaxonomy(rows, { pinned = false } = {}) {
  const byId = new Map();
  const byKey = new Map();
  const add = (k, row) => { if (!k) return; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(row); };
  for (const r of rows) {
    const row = {
      ...r,
      normalizedName: r.normalizedName || normalizeString(r.name),
      normalizedSynonyms: r.normalizedSynonyms || (r.synonyms || []).map(normalizeString).filter(Boolean),
    };
    byId.set(String(row._id), row);
    add(row.normalizedName, row);
    for (const s of row.normalizedSynonyms) add(s, row);
  }
  return { at: Date.now(), pinned, rows, byId, byKey, empty: rows.length === 0 };
}

/**
 * The taxonomy, cached for a minute. Without a live connection (tests, a
 * boot before the seed ran) it is empty and the write rule keeps strings.
 */
async function loadTaxonomy() {
  if (cache && (cache.pinned || Date.now() - cache.at < TAXONOMY_TTL_MS)) return cache;
  if (mongoose.connection.readyState !== 1) return indexTaxonomy([]);
  const rows = await Classification.find({}).select(TAXONOMY_SELECT).lean();
  cache = indexTaxonomy(rows);
  return cache;
}

/** Admin taxonomy writes call this so the next wine write sees the change. */
function invalidateClassificationCache() { cache = null; }

/** Tests: a fixed taxonomy, no database. Pass null to clear. */
function primeClassificationCache(rows) { cache = rows ? indexTaxonomy(rows, { pinned: true }) : null; }

/** Resolve display names or synonyms against a loaded taxonomy (sync). */
function resolveLoaded(tax, names, countryId = null) {
  const wanted = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  const rows = []; const unresolved = []; const dropped = []; const taken = new Set();
  for (const n of wanted) {
    const key = normalizeString(n);
    const stripped = stripNoise(n);
    const keys = [...new Set([key, stripped].filter(Boolean))];
    const row = keys.map((k) => pickForCountry(tax.byKey.get(k), countryId)).find(Boolean);
    if (!row) { (stripped ? unresolved : dropped).push(n); continue; }
    if (taken.has(String(row._id))) continue;
    taken.add(String(row._id)); rows.push(row);
  }
  return { rows, unresolved, dropped };
}

/**
 * Resolve display names or synonyms to taxonomy rows, case- and
 * accent-insensitively, with the ride-along words stripped when the plain
 * value matches nothing. Returns { rows, unresolved, dropped }: rows in the
 * order asked, unresolved the inputs no row answers, dropped the inputs that
 * were nothing but ride-along words ("trocken"). `countryId` breaks ties
 * between systems that share a word.
 */
async function resolveClassifications(names, { countryId = null } = {}) {
  const wanted = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!wanted.length) return { rows: [], unresolved: [], dropped: [] };
  return resolveLoaded(await loadTaxonomy(), wanted, countryId);
}

const byKind = (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);

/** The legacy string: names in kind order (rank, ripeness, ageing, other), joined; null when empty. */
function classificationString(rows) {
  const list = (rows || []).filter((r) => r && r.name);
  list.sort(byKind);
  return list.length ? list.map((r) => r.name).join(', ') : null;
}

/**
 * The rows a wine carries, shaped for an API answer: [{ name, kind }], only
 * when they were populated (an id-only array answers []). The joined string
 * stays beside it for older clients.
 */
function classificationsOut(wd) {
  if (!wd || !Array.isArray(wd.classifications)) return [];
  return wd.classifications
    .filter((c) => c && typeof c === 'object' && c.name)
    .map((c) => ({ name: c.name, kind: c.kind || null }));
}

/** The tiers the taxonomy knows for a country (its own rows and the country-less ones), for an error message. */
function knownTiersHint(tax, countryId, limit = 30) {
  const names = tax.rows
    .filter((r) => !r.country || (countryId && String(r.country._id || r.country) === String(countryId)))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name))
    .map((r) => r.name);
  const shown = names.slice(0, limit);
  return `${shown.join(', ')}${names.length > limit ? ', …' : ''}`;
}

/**
 * THE write rule. Sets `classifications` (taxonomy row ids) and
 * `classification` (the derived string) on `target` from what a caller sent:
 *
 *   classifications — rows a picker chose: ids, or names/synonyms
 *   classification  — a string: one or more tiers, comma-separated, as a
 *                     form, a scan, an import or an API client wrote it
 *
 * The string is first cleaned the way the registry always has (a regulatory
 * mark such as DOCG is no tier and clears the field), then split and
 * resolved; ride-along words ("trocken") are dropped. A part no row answers:
 *   strict (an admin or curator at a form or tool) → { ok: false } with a
 *     message naming the known tiers — nothing is written;
 *   lenient (a member's wine, a scan, an import) → dropped when other parts
 *     resolved, else the cleaned string is kept with no rows, so nothing a
 *     member wrote is lost and the review list still finds it.
 * With no taxonomy loaded (no connection, no seed) every path keeps strings.
 *
 * Returns { ok, changed, rows, unresolved, dropped, classification,
 * classifications } — `changed` false when neither input was given.
 */
async function assignClassification(target, { classification, classifications, countryId = null, strict = false } = {}) {
  const tax = await loadTaxonomy();
  const cid = countryId || (target && target.country && (target.country._id || target.country)) || null;
  let rows = []; let unresolved = []; let dropped = []; let legacy = null;
  if (Array.isArray(classifications)) {
    const taken = new Set();
    for (const c of classifications) {
      const key = String((c && c._id) || c || '').trim();
      if (!key) continue;
      const row = tax.byId.get(key) || pickForCountry(tax.byKey.get(normalizeString(key)), cid);
      if (!row) { unresolved.push(key); continue; }
      if (taken.has(String(row._id))) continue;
      taken.add(String(row._id)); rows.push(row);
    }
  } else if (classification !== undefined) {
    const str = classification == null ? '' : String(classification).trim().replace(/\s+/g, ' ');
    legacy = str ? normalizeClassification(str) : null;
    if (legacy) {
      const res = resolveLoaded(tax, splitClassificationString(legacy), cid);
      rows = res.rows; unresolved = res.unresolved; dropped = res.dropped;
    }
  } else {
    return { ok: true, changed: false, rows: [], unresolved: [], dropped: [] };
  }
  if (unresolved.length && strict && !tax.empty) {
    const list = unresolved.map((u) => `"${u}"`).join(', ');
    return {
      ok: false,
      code: 'invalid_input',
      unresolved,
      message: `${list} ${unresolved.length > 1 ? 'are' : 'is'} not in the registry's classification list. Known tiers here: ${knownTiersHint(tax, cid)}. A tier the list lacks is added under Admin → Taxonomy → Classifications.`,
    };
  }
  rows.sort(byKind); // stored in the order the string shows them
  const ids = rows.map((r) => r._id);
  const string = rows.length ? classificationString(rows) : (unresolved.length ? legacy : null);
  target.classifications = ids;
  target.classification = string;
  return { ok: true, changed: true, rows, unresolved, dropped, classifications: ids, classification: string };
}

// ── Rule-based detection from the wine name ────────────────────────────────
// Only where the word is a legal or customary tier in that country. Burgundy,
// Alsace and Saint-Émilion keep "Premier Cru" / "Grand Cru" in the
// appellation's legal name (registry rule), so France is handled per system:
// Bordeaux's classed growths, the Champagne village ranking and Alsace's two
// late-harvest designations only. Port and Madeira categories apply to a
// fortified wine, or one named as Port; the Portuguese still-wine tiers to
// the rest.
const GERMAN_PRADIKAT = ['Trockenbeerenauslese', 'Beerenauslese', 'Auslese', 'Spätlese', 'Kabinett', 'Eiswein'];
const WACHAU = ['Smaragd', 'Federspiel', 'Steinfeder'];
const isPort = ({ name, type }) => type === 'fortified' || /(^|[^\p{L}])(port|porto)(?=$|[^\p{L}])/iu.test(name || '');
const ageStatement = (n) => [`${n} Years Old`, [`${n} Years Old`, `${n} Year Old`, `${n} Anos`, `${n} Years`, `${n} Year`]];
const RULES = [
  { countries: ['Germany', 'Austria', 'Luxembourg'], names: GERMAN_PRADIKAT.map((n) => [n, [n, n.replace('ä', 'a')]]) },
  { countries: ['Austria'], names: [
    ...WACHAU.map((n) => [n, [n]]),
    ['Ausbruch', ['Ausbruch']],
    ['ÖTW Erste Lage', ['1ÖTW', 'Erste Lage', 'ÖTW']],
    ['Riedenwein', ['Riedenwein']], ['Ortswein', ['Ortswein']], ['Gebietswein', ['Gebietswein']],
  ] },
  { countries: ['Germany'], names: [['Grosses Gewächs', ['Grosses Gewächs', 'Großes Gewächs', 'Grosses Gewaechs', 'GG']], ['Erstes Gewächs', ['Erstes Gewächs']], ['VDP Grosse Lage', ['Grosse Lage', 'Große Lage', 'VDP.Grosse Lage', 'VDP Grosse Lage']], ['VDP Erste Lage', ['VDP.Erste Lage', 'VDP Erste Lage']], ['Hochgewächs', ['Hochgewächs', 'Hochgewachs']]] },
  { countries: ['Hungary'], names: [['6 Puttonyos', ['6 Puttonyos']], ['5 Puttonyos', ['5 Puttonyos']], ['4 Puttonyos', ['4 Puttonyos']], ['3 Puttonyos', ['3 Puttonyos']]] },
  { countries: ['Italy'], names: [['Gran Selezione', ['Gran Selezione']], ['Vendemmia Tardiva', ['Vendemmia Tardiva']], ['Riserva', ['Riserva']]] },
  { countries: ['Spain'], names: [
    ['Gran Vinya Classificada', ['Gran Vinya Classificada', 'Gran Viña Clasificada']],
    ['Vinya Classificada', ['Vinya Classificada', 'Viña Clasificada']],
    ['Vi de Paratge', ['Vi de Paratge']],
    ['Vi de Vila', ['Vi de Vila']],
    ['Vi de Finca', ['Vi de Finca Qualificada', 'Vi de Finca']],
    ['Viñedo Singular', ['Viñedo Singular', 'Vinedo Singular']],
    ['Vino de Pago', ['Vino de Pago']],
    ['Gran Reserva', ['Gran Reserva']], ['Reserva', ['Reserva']], ['Crianza', ['Crianza']], ['Roble', ['Roble']], ['Joven', ['Joven']],
  ] },
  { countries: ['Portugal'], when: isPort, names: [
    ['Late Bottled Vintage', ['Late Bottled Vintage', 'LBV']],
    ['Vintage Port', ['Vintage Port', 'Porto Vintage', 'Vintage Porto']],
    ['Crusted Port', ['Crusted Port', 'Crusted']],
    ['Colheita', ['Colheita']],
    ageStatement(40), ageStatement(30), ageStatement(20), ageStatement(15), ageStatement(10), ageStatement(5),
    ['Reserve Port', ['Tawny Reserve', 'Ruby Reserve', 'Reserve Port', 'Reserva', 'Reserve']],
    ['Tawny Port', ['Tawny']], ['Ruby Port', ['Ruby']],
  ] },
  { countries: ['Portugal'], unless: isPort, names: [['Grande Reserva', ['Grande Reserva']], ['Reserva', ['Reserva']], ['Garrafeira', ['Garrafeira']]] },
  { countries: ['France'], regions: ['Bordeaux'], names: [
    ['Premier Grand Cru Classé A', ['Premier Grand Cru Classé A', '1er Grand Cru Classé A']],
    ['Premier Grand Cru Classé B', ['Premier Grand Cru Classé B', '1er Grand Cru Classé B']],
    ['Premier Cru Supérieur', ['Premier Cru Supérieur', '1er Cru Supérieur']],
    ['Premier Cru Classé', ['Premier Cru Classé', '1er Cru Classé', 'Premier Grand Cru Classé en 1855']],
    ['Deuxième Cru Classé', ['Deuxième Cru Classé', '2ème Cru Classé']],
    ['Troisième Cru Classé', ['Troisième Cru Classé', '3ème Cru Classé']],
    ['Quatrième Cru Classé', ['Quatrième Cru Classé', '4ème Cru Classé']],
    ['Cinquième Cru Classé', ['Cinquième Cru Classé', '5ème Cru Classé']],
    ['Cru Classé de Graves', ['Cru Classé de Graves', 'Grand Cru Classé de Graves']],
    ['Grand Cru Classé', ['Grand Cru Classé']],
    ['Cru Bourgeois Exceptionnel', ['Cru Bourgeois Exceptionnel']],
    ['Cru Bourgeois Supérieur', ['Cru Bourgeois Supérieur']],
    ['Cru Bourgeois', ['Cru Bourgeois']],
    ['Cru Artisan', ['Cru Artisan']],
  ] },
  { countries: ['France'], regions: ['Alsace'], names: [
    ['Sélection de Grains Nobles', ['Sélection de Grains Nobles', 'Selection de Grains Nobles', 'SGN']],
    ['Vendange Tardive', ['Vendanges Tardives', 'Vendange Tardive', 'VT']],
  ] },
  { countries: ['France'], appellations: ['Champagne'], names: [['Grand Cru', ['Grand Cru']], ['Premier Cru', ['Premier Cru', '1er Cru']]] },
];
const wordRx = (word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRx(word)}(?=$|[^\\p{L}\\p{N}])`, 'iu');

/**
 * The tiers a wine's name states, by that wine's country (and, for France,
 * its region or appellation; for Portugal, whether it is a Port). Longer
 * phrases win over their parts ("Gran Reserva" is not also "Reserva").
 * Returns taxonomy display names. With `consumed: true` the remaining text
 * is returned too (the migration reads a tier out of an appellation).
 */
function detectFromName({ name, countryName, regionName, appellation, type }, { withRest = false } = {}) {
  const text = String(name || '');
  if (!text.trim() || !countryName) return withRest ? { names: [], rest: text } : [];
  const ctx = { name: text, type: type || null };
  const out = [];
  let consumed = text;
  for (const rule of RULES) {
    if (!rule.countries.includes(countryName)) continue;
    if (rule.regions && !rule.regions.some((r) => String(regionName || '').includes(r))) continue;
    if (rule.appellations && !rule.appellations.some((a) => String(appellation || '').startsWith(a))) continue;
    if (rule.when && !rule.when(ctx)) continue;
    if (rule.unless && rule.unless(ctx)) continue;
    for (const [canonical, spellings] of rule.names) {
      for (const sp of spellings) {
        const rx = wordRx(sp);
        if (rx.test(consumed)) {
          if (!out.includes(canonical)) out.push(canonical);
          consumed = consumed.replace(rx, '$1 ');
          break;
        }
      }
    }
  }
  return withRest ? { names: out, rest: consumed.replace(/\s+/g, ' ').trim() } : out;
}

/** Upsert the seed rows from data/classifications.json; returns { created, updated }. */
async function seedClassifications({ seed = require('../data/classifications.json'), countryIdsByName = null } = {}) {
  const Country = require('../models/Country');
  const countries = countryIdsByName || new Map((await Country.find({}).select('name').lean()).map((c) => [c.name, c._id]));
  let created = 0; let updated = 0;
  for (const s of seed) {
    const normalizedName = normalizeString(s.name);
    const existing = await Classification.findOne({ normalizedName });
    const fields = { name: s.name, kind: s.kind, system: s.system || null, country: s.country ? (countries.get(s.country) || null) : null, synonyms: s.synonyms || [], description: s.description || '', reviewedAt: new Date() };
    if (existing) {
      const merged = [...new Set([...(existing.synonyms || []), ...fields.synonyms])];
      Object.assign(existing, { ...fields, synonyms: merged, reviewedAt: existing.reviewedAt || fields.reviewedAt });
      await existing.save(); updated += 1;
    } else {
      await Classification.create({ ...fields, normalizedName, createdByUser: false });
      created += 1;
    }
  }
  invalidateClassificationCache();
  return { created, updated };
}

/**
 * Boot: a registry with no classification rows at all gets the seed, so a
 * fresh install (or one upgraded past this feature) has the vocabulary the
 * write rule resolves against. Idempotent, cheap when rows exist.
 */
async function ensureClassificationSeed() {
  const n = await Classification.estimatedDocumentCount();
  if (n > 0) return { seeded: false };
  const r = await seedClassifications();
  return { seeded: true, ...r };
}

module.exports = {
  splitClassificationString, stripNoise, resolveClassifications, resolveLoaded, loadTaxonomy, pickForCountry,
  assignClassification, classificationString, classificationsOut, knownTiersHint, detectFromName, seedClassifications,
  ensureClassificationSeed, invalidateClassificationCache, primeClassificationCache, KIND_ORDER,
};
