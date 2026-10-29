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
 *   - classificationString: the array → the derived legacy string every
 *     reader still shows
 *   - detectFromName: the tiers a wine's NAME states, by the country whose
 *     law or custom defines the word — the rule-based backfill, never a guess
 *   - seedClassifications: data/classifications.json → taxonomy rows
 *
 * One rule for every write path and for the migration
 * (scripts/migrate-classification-taxonomy.js).
 */
const Classification = require('../models/Classification');
const { normalizeString } = require('../utils/normalize');

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
  const probes = wanted.map((n) => {
    const key = normalizeString(n);
    const stripped = stripNoise(n);
    return { n, keys: [...new Set([key, stripped].filter(Boolean))], noise: !stripped };
  });
  const keys = [...new Set(probes.flatMap((p) => p.keys))];
  const found = keys.length
    ? await Classification.find({ $or: [{ normalizedName: { $in: keys } }, { normalizedSynonyms: { $in: keys } }] }).lean()
    : [];
  const byKey = new Map();
  const add = (k, row) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(row); };
  for (const row of found) {
    add(row.normalizedName, row);
    for (const s of row.normalizedSynonyms || []) add(s, row);
  }
  const rows = []; const unresolved = []; const dropped = []; const taken = new Set();
  for (const p of probes) {
    const row = p.keys.map((k) => pickForCountry(byKey.get(k), countryId)).find(Boolean);
    if (!row) { (p.noise ? dropped : unresolved).push(p.n); continue; }
    if (taken.has(String(row._id))) continue;
    taken.add(String(row._id)); rows.push(row);
  }
  return { rows, unresolved, dropped };
}

/** The legacy string: names in kind order (rank, ripeness, ageing, other), joined; null when empty. */
function classificationString(rows) {
  const list = (rows || []).filter((r) => r && r.name);
  list.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  return list.length ? list.map((r) => r.name).join(', ') : null;
}

// ── Rule-based detection from the wine name ────────────────────────────────
// Only where the word is a legal or customary tier in that country. Burgundy,
// Alsace and Saint-Émilion keep "Premier Cru" / "Grand Cru" in the
// appellation's legal name (registry rule), so France is handled per system:
// Bordeaux's classed growths and the Champagne village ranking only. Port
// and Madeira categories apply to a fortified wine, or one named as Port;
// the Portuguese still-wine tiers to the rest.
const GERMAN_PRADIKAT = ['Trockenbeerenauslese', 'Beerenauslese', 'Auslese', 'Spätlese', 'Kabinett', 'Eiswein'];
const WACHAU = ['Smaragd', 'Federspiel', 'Steinfeder'];
const isPort = ({ name, type }) => type === 'fortified' || /(^|[^\p{L}])(port|porto)(?=$|[^\p{L}])/iu.test(name || '');
const ageStatement = (n) => [`${n} Years Old`, [`${n} Years Old`, `${n} Year Old`, `${n} Anos`, `${n} Years`, `${n} Year`]];
const RULES = [
  { countries: ['Germany', 'Austria', 'Luxembourg'], names: GERMAN_PRADIKAT.map((n) => [n, [n, n.replace('ä', 'a')]]) },
  { countries: ['Austria'], names: [...WACHAU.map((n) => [n, [n]]), ['ÖTW Erste Lage', ['1ÖTW', 'Erste Lage', 'ÖTW']]] },
  { countries: ['Germany'], names: [['Grosses Gewächs', ['Grosses Gewächs', 'Großes Gewächs', 'Grosses Gewaechs', 'GG']], ['Erstes Gewächs', ['Erstes Gewächs']], ['VDP Grosse Lage', ['Grosse Lage', 'Große Lage', 'VDP.Grosse Lage', 'VDP Grosse Lage']], ['VDP Erste Lage', ['VDP.Erste Lage', 'VDP Erste Lage']], ['Hochgewächs', ['Hochgewächs', 'Hochgewachs']]] },
  { countries: ['Hungary'], names: [['6 Puttonyos', ['6 Puttonyos']], ['5 Puttonyos', ['5 Puttonyos']]] },
  { countries: ['Italy'], names: [['Gran Selezione', ['Gran Selezione']], ['Riserva', ['Riserva']]] },
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
  { countries: ['France'], appellations: ['Champagne'], names: [['Grand Cru', ['Grand Cru']], ['Premier Cru', ['Premier Cru', '1er Cru']]] },
];
const wordRx = (word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRx(word)}(?=$|[^\\p{L}\\p{N}])`, 'iu');

/**
 * The tiers a wine's name states, by that wine's country (and, for France,
 * its region or appellation; for Portugal, whether it is a Port). Longer
 * phrases win over their parts ("Gran Reserva" is not also "Reserva").
 * Returns taxonomy display names.
 */
function detectFromName({ name, countryName, regionName, appellation, type }) {
  const text = String(name || '');
  if (!text.trim() || !countryName) return [];
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
  return out;
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
  return { created, updated };
}

module.exports = { splitClassificationString, stripNoise, resolveClassifications, pickForCountry, classificationString, detectFromName, seedClassifications, KIND_ORDER };
